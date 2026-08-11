import type {
  AdminCredential,
  AdminNetwork,
  AdminSession,
  AdminSessionLogEntry,
  AdminVisitor,
  AdminVisitorNetwork,
} from "./api";

// #1157 — the row set behind the unified admin sessions view.
//
// The view lists ACTIVE AND INACTIVE sessions, which forces the grain:
// it is ROW-backed, with live process state joined on top, never the
// other way round. `GET /admin/sessions` is registry-driven — every row
// it returns IS a live pid — so building the list from it would drop
// parked, failed and expired-but-unreaped subjects out of the admin
// console entirely, which is exactly the population an operator opens
// this pane to look at.
//
// So the rows come from the two row-backed endpoints, which between
// them cover every credential in the database and are disjoint by
// construction (`/admin/credentials` filters `user_id IS NOT NULL`;
// `/admin/visitors` walks the visitor rows):
//
//   * `/admin/visitors`    — one row per (visitor, network), flattened
//                            out of the identity-wide `networks[]`
//   * `/admin/credentials` — one row per (user, network) already
//
// `/admin/sessions` is then LEFT-JOINED on, for the two things only it
// knows: the upstream peer triple, and the pid of a session whose DB row
// is gone. Its unmatched entries are appended rather than dropped —
// that is the orphan-pid class (`subject_label: null`), a real
// divergence the operator must be able to see.
//
// The join key is the composite `<kind>:<subject_id>:<network_id>` the
// `/admin/sessions/:id/*` verbs already parse, so the row that renders a
// button is keyed by the very string that button will POST.
//
// #1158 item 4 — a fourth source: `/admin/session_log/sessions`, the
// lifecycle log collapsed to each session's newest event. Its
// `session_id` is that same composite, which is what makes this a join
// and not a new data model.
//
// It earns its place because of a retention asymmetry vjt ruled on
// (2026-08-11, "keep only the event"): an anon/incognito visitor is
// destroyed at logout and again by the TTL reap, and that stays true —
// but `session_log_events` carries NO FK to the subject, so it outlives
// the CASCADE. So the log both enriches rows that exist (what did this
// session last do, and why did it stop) and supplies the ONLY row a
// destroyed subject can ever have.
//
// It is best-effort BY CONSTRUCTION — a bounded global ring, written
// from an async cast on a path that includes `terminate/2`. A session
// missing from it is not evidence it never ran, and nothing here may
// treat absence as a fact.

/** The live-state core the three endpoints agree on. `/admin/sessions`
 * carries a superset (the peer triple); the row-backed pair do not. */
export type CoreLiveState = NonNullable<AdminVisitorNetwork["live_state"]>;

/** Visitor-only identity facts. Identity-wide, so every row flattened
 * out of the same visitor repeats them — and `DELETE /admin/visitors/:id`
 * acts on ALL of them at once, which is why the row carries the flag. */
export type VisitorIdentity = {
  visitor_id: string;
  expires_at: string | null;
  inserted_at: string;
  ip: string | null;
  identified: boolean;
};

/**
 * Which source put this row on the table. Explicit rather than inferred
 * from a pattern of nulls: `credential` and `orphan_pid` were already
 * distinguishable only by `connection_state === null`, and the log-only
 * class shares that null with the orphans while meaning the opposite
 * thing (no pid at all, versus nothing BUT a pid).
 */
export type RowOrigin = "credential" | "orphan_pid" | "session_log";

export type AdminSubjectRow = {
  /** `<kind>:<subject_id>:<network_id>` — the id the admin verbs parse. */
  key: string;
  subject_kind: "user" | "visitor";
  subject_id: string;
  /** Display name: the configured nick, or the user's account name.
   * `null` only on an orphan-pid row whose DB row is gone. */
  label: string | null;
  network_id: number;
  /** `null` when the FK resolves to no known network (deleted-network
   * race). Never blanked silently — the caller renders the raw id. */
  network_slug: string | null;
  /** DB intent. `null` on an orphan-pid row: there is no credential to
   * have an intent. Distinct from `live` per the two-sources rule. */
  connection_state: AdminCredential["connection_state"] | null;
  /** Live BEAM state, `null` = the U-0 honesty signal (DB row exists,
   * no pid). */
  live: CoreLiveState | null;
  /** The upstream peer, known ONLY for rows with a registry entry. */
  upstream: AdminSession["live_state"] | null;
  last_seen_at: string | null;
  /** Present iff `subject_kind === "visitor"`. */
  visitor: VisitorIdentity | null;
  origin: RowOrigin;
  /** The newest lifecycle event the session log remembers for this
   * session. `null` means the log has nothing — which is NOT a claim
   * that the session never ran (bounded ring, best-effort write). */
  last_event: AdminSessionLogEntry | null;
};

/**
 * A row that is nothing BUT the lifecycle record: the subject is gone,
 * no pid is left, and the log entry that produced the row is therefore
 * the only thing it carries. The narrowing is the point — `last_event`
 * is `null`-able on the general row and cannot be here, because the
 * log-only pass builds the row FROM the entry.
 */
export type EndedSessionRow = AdminSubjectRow & {
  origin: "session_log";
  last_event: AdminSessionLogEntry;
};

function isEnded(row: AdminSubjectRow): row is EndedSessionRow {
  return row.origin === "session_log" && row.last_event !== null;
}

/**
 * #1224 — the two populations the admin console shows separately.
 *
 * vjt (2026-08-11): ended sessions move to a sub-page of Sessions and
 * the list that stays is strictly live, with no `deleted` badge. The
 * split is a VIEW concern, so it happens here rather than in the merge:
 * the join is still one row set keyed on one composite, and the log
 * still enriches a live row's drill-down.
 *
 * A partition, not two filters: `liveSessions` is the complement of
 * `endedSessions`, so no row can fall out of both. A log-only row with
 * no entry cannot exist (the pass that builds it needs the entry), but
 * if it ever did it would show up in the live list rather than vanish.
 */
export function endedSessions(rows: AdminSubjectRow[]): EndedSessionRow[] {
  return rows.filter(isEnded);
}

export function liveSessions(rows: AdminSubjectRow[]): AdminSubjectRow[] {
  return rows.filter((row) => !isEnded(row));
}

export function rowKey(kind: "user" | "visitor", subjectId: string, networkId: number): string {
  return `${kind}:${subjectId}:${networkId}`;
}

/** Channel count for the dictated column. `null` (introspection timed
 * out, or no pid) is NOT zero and must not render as zero. */
export function channelCount(row: AdminSubjectRow): number | null {
  return row.live?.joined_channels?.length ?? null;
}

/**
 * Which verbs a row may offer.
 *
 * Reconnect is visitor-only, and deliberately so on the server:
 * `ensure_visitor_subject/1` answers 400 for a user subject, because a
 * user parks and reconnects their OWN sessions through
 * `PATCH /networks/:id`. Offering the button on a user row would render
 * a guaranteed 400.
 *
 * Which of Disconnect / Reconnect a visitor row shows is chosen on LIVE
 * truth, never on `connection_state`: a credential still marked
 * `:connected` whose pid died must offer Reconnect, and that divergence
 * is the whole reason both columns exist.
 *
 * A log-only row offers nothing: there is no credential to park and no
 * pid to stop, so every verb would resolve to a subject that is gone.
 */
export function rowActions(row: AdminSubjectRow): ("disconnect" | "reconnect" | "terminate")[] {
  if (row.origin === "session_log") return [];
  if (row.subject_kind === "visitor") {
    return row.live === null ? ["reconnect"] : ["disconnect"];
  }
  return ["disconnect", "terminate"];
}

function slugOf(networks: AdminNetwork[], networkId: number): string | null {
  return networks.find((n) => n.id === networkId)?.slug ?? null;
}

/**
 * Split a log entry's `session_id` back into the triple the row key is
 * built from. Returns `null` for anything that is not that composite —
 * the log is a free-text-ish store the server writes, and a row keyed on
 * a string we cannot parse would be a row no admin verb could ever act
 * on. Dropping it is honest; guessing is not.
 */
function parseSessionId(
  sessionId: string,
): { kind: "user" | "visitor"; subjectId: string; networkId: number } | null {
  const parts = sessionId.split(":");
  if (parts.length !== 3) return null;
  const [kind, subjectId, rawNetwork] = parts;
  if (kind !== "user" && kind !== "visitor") return null;
  if (subjectId === undefined || subjectId === "") return null;
  if (rawNetwork === undefined || !/^\d+$/.test(rawNetwork)) return null;
  return { kind, subjectId, networkId: Number(rawNetwork) };
}

/**
 * Build the unified row set.
 *
 * Ordering is stable and meaningful rather than incidental: visitors,
 * then users, then the two rows-without-a-credential classes at the
 * bottom — orphan pids (a pid with no DB row), then log-only rows
 * (neither, just an event). The operator scans the populations they came
 * for first, and the divergences sit where they stand out.
 */
export function buildSubjectRows(input: {
  visitors: AdminVisitor[];
  credentials: AdminCredential[];
  sessions: AdminSession[];
  networks: AdminNetwork[];
  logSessions: AdminSessionLogEntry[];
}): AdminSubjectRow[] {
  const { visitors, credentials, sessions, networks, logSessions } = input;

  const sessionByKey = new Map<string, AdminSession>();
  for (const s of sessions) {
    sessionByKey.set(rowKey(s.subject_kind, s.subject_id, s.network_id), s);
  }

  const logByKey = new Map<string, AdminSessionLogEntry>();
  for (const e of logSessions) {
    logByKey.set(e.session_id, e);
  }

  const rows: AdminSubjectRow[] = [];
  const claimed = new Set<string>();

  for (const v of visitors) {
    const identity: VisitorIdentity = {
      visitor_id: v.id,
      expires_at: v.expires_at,
      inserted_at: v.inserted_at,
      ip: v.ip,
      identified: v.identified,
    };

    for (const net of v.networks) {
      const key = rowKey("visitor", v.id, net.network_id);
      claimed.add(key);
      rows.push({
        key,
        subject_kind: "visitor",
        subject_id: v.id,
        label: net.nick,
        network_id: net.network_id,
        network_slug: net.network_slug,
        connection_state: net.connection_state,
        live: net.live_state,
        upstream: sessionByKey.get(key)?.live_state ?? null,
        last_seen_at: v.last_seen_at,
        visitor: identity,
        origin: "credential",
        last_event: logByKey.get(key) ?? null,
      });
    }
  }

  for (const c of credentials) {
    const key = rowKey("user", c.user_id, c.network_id);
    claimed.add(key);
    rows.push({
      key,
      subject_kind: "user",
      subject_id: c.user_id,
      label: c.nick,
      network_id: c.network_id,
      network_slug: c.network_slug,
      connection_state: c.connection_state,
      live: c.live_state,
      upstream: sessionByKey.get(key)?.live_state ?? null,
      last_seen_at: c.last_seen_at,
      visitor: null,
      origin: "credential",
      last_event: logByKey.get(key) ?? null,
    });
  }

  // The orphan-pid class: a registered pid with no DB row behind it.
  // Appending these is the point of the union — dropping them would
  // hide precisely the divergence the admin console exists to surface.
  for (const s of sessions) {
    const key = rowKey(s.subject_kind, s.subject_id, s.network_id);
    if (claimed.has(key)) continue;
    // Claim it: the log pass below is keyed on the same composite, and
    // an orphan pid the log also remembers must stay ONE row that keeps
    // the live truth, not two.
    claimed.add(key);
    rows.push({
      key,
      subject_kind: s.subject_kind,
      subject_id: s.subject_id,
      label: s.subject_label,
      network_id: s.network_id,
      network_slug: slugOf(networks, s.network_id),
      connection_state: null,
      live: s.live_state,
      upstream: s.live_state,
      last_seen_at: s.last_seen_at,
      visitor: null,
      origin: "orphan_pid",
      last_event: logByKey.get(key) ?? null,
    });
  }

  // The log-only class: the subject row is gone (a purged visitor, an
  // unbound credential) and no pid is left either, so the lifecycle log
  // is the only place this session still exists. It runs LAST so it can
  // never shadow a row that has live truth behind it — an orphan pid the
  // log also remembers stays an orphan-pid row, enriched, not duplicated.
  for (const e of logSessions) {
    if (claimed.has(e.session_id)) continue;
    const parsed = parseSessionId(e.session_id);
    if (parsed === null) continue;
    claimed.add(e.session_id);
    rows.push({
      key: e.session_id,
      subject_kind: parsed.kind,
      subject_id: parsed.subjectId,
      label: e.nick,
      network_id: parsed.networkId,
      // The log stores the slug it saw at emit time; fall back to the
      // live network list, then to null (the caller renders the raw id).
      network_slug: e.network_slug ?? slugOf(networks, parsed.networkId),
      connection_state: null,
      live: null,
      upstream: null,
      // NOT `e.at`: this column is when a BROWSER last touched the
      // bouncer, and there is no browser session left to have touched it.
      last_seen_at: null,
      visitor: null,
      origin: "session_log",
      last_event: e,
    });
  }

  return rows;
}
