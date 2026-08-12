import type {
  AdminSnapshotPayload,
  MessageKind,
  ScrollbackMessage,
  WhoUser,
  WireAdminEvent,
  WireChannelEvent,
} from "./api";
import type { ModesEntry, TopicEntry } from "./channelTopic";
import type { MemberEntry } from "./memberTypes";
// #429 — the generated RUNTIME schemas. `S_*` consts are the same typespecs
// `wireTypes.ts` mirrors at compile time, emitted as data so the boundary can
// enforce them after tsc has erased the types.
import { S_AdminEventsWireEvent, S_AdminOverviewWireT, S_SessionLogWireT } from "./wireSchema";
import type { AdminOverviewWireT, SessionLogWireT, WindowCountsSeverity } from "./wireTypes";
// #410 — the runtime allowlists derive from the codegen-emitted `as const`
// enum arrays, so each closed set has ONE source (the server typespec via
// wireTypes.ts), not a hand copy that can silently drift.
import {
  ADMIN_EVENTS_WIRE_LOGIN_THROTTLE_DOOR,
  ADMIN_EVENTS_WIRE_LOGIN_THROTTLE_SCOPE,
  SCROLLBACK_MESSAGE_KIND,
  WINDOW_COUNTS_SEVERITY,
} from "./wireTypes";
import { validate } from "./wireValidate";

// #267 — narrow the window_counts severity to the closed union, defaulting
// to "none" for an unknown value (defensive: a stale server mid hot-reload
// must never null the whole event for a bad severity — the counts are the
// load-bearing part). #410 — the value set IS the codegen-emitted
// `WINDOW_COUNTS_SEVERITY` const (mirror of `Grappa.WindowCounts.severity/0`),
// not a hand copy.
function narrowSeverity(raw: unknown): WindowCountsSeverity {
  return typeof raw === "string" && (WINDOW_COUNTS_SEVERITY as readonly string[]).includes(raw)
    ? (raw as WindowCountsSeverity)
    : "none";
}

// Bucket G H4+U3 (codebase-review-2026-05-12): runtime narrowing for
// per-channel WS events. Companion to `userTopic.ts`'s
// `narrowUserEvent` (which closed the same gap on the user-topic
// boundary as cic M1).
//
// ## Why this file exists
//
// `WireChannelEvent` (api.ts) is a TypeScript-side discriminated union
// — strong type system contract, ZERO runtime enforcement. A malformed
// server push (kind valid but a required field missing or wrong-typed)
// would let the dispatch arm in `subscribe.ts` read `undefined` from
// the payload and either crash a setter (`seedTopic(key, undefined)`)
// or silently corrupt store state.
//
// Pre-bucket-G the per-channel handlers cast the raw Phoenix payload
// directly: `phx.on("event", (payload: WireChannelEvent) => { ... })`.
// The cast is a *lie*: phoenix.js types the second arg as `unknown`-
// shaped JSON; trusting it as `WireChannelEvent` skips runtime
// validation entirely. `userTopic.ts` already closed the equivalent
// gap (cic M1, CP16-era) for the user-topic; this file is the
// per-channel mirror.
//
// ## Why a separate file (lib/wireNarrow.ts) instead of inlining
//
// The narrower module is a leaf — no SolidJS effects, no module-level
// state, no reactive store imports. Keeping it separate from
// subscribe.ts (which carries the heavy reactive plumbing) makes the
// narrower trivially testable in isolation (vitest exercises each
// arm against valid + malformed shapes without spinning up createRoot).
// Same reason `mentionMatch.ts` and `nickEquals.ts` live as their own
// modules. The cluster-shape note in CP24 specifies a new
// `lib/wireNarrow.ts` module — this is the precedent for future
// per-topic narrowers (e.g. a `narrowAdminEvent` if Phase 5 grows the
// /admin LiveDashboard's WS surface).

// #410 — the runtime allowlist derives from the codegen-emitted
// `SCROLLBACK_MESSAGE_KIND` const (mirror of `Grappa.Scrollback.Message`'s
// `kind()` closed set). `MessageKind` (api.ts) is the type alias over the
// SAME const, so the compile-time union and this runtime Set share ONE
// source: a new server kind regenerates the const and flows to both — no
// hand map to keep in sync. (Pre-#410 an exhaustive `Record<MessageKind,
// true>` was hand-maintained and its keys built this Set — S14; the codegen
// const supersedes the hand exhaustiveness guard.)
const VALID_MESSAGE_KINDS: ReadonlySet<MessageKind> = new Set(SCROLLBACK_MESSAGE_KIND);

// S14 — shared runtime guard for the `Message.kind()` closed set. Used
// by `narrowScrollbackMessage` here and `narrowMentionsBundleMessage`
// in `userTopic.ts` so both Message-kind wire projections gate the
// same set (no second hand-maintained kind check).
export function isMessageKind(v: unknown): v is MessageKind {
  return typeof v === "string" && VALID_MESSAGE_KINDS.has(v as MessageKind);
}

function narrowScrollbackMessage(raw: unknown): ScrollbackMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.id !== "number" ||
    typeof r.network !== "string" ||
    typeof r.channel !== "string" ||
    typeof r.server_time !== "number" ||
    !isMessageKind(r.kind) ||
    typeof r.sender !== "string" ||
    (r.body !== null && typeof r.body !== "string") ||
    typeof r.meta !== "object" ||
    r.meta === null
  )
    return null;
  return {
    id: r.id,
    network: r.network,
    channel: r.channel,
    server_time: r.server_time,
    kind: r.kind as MessageKind,
    sender: r.sender,
    body: r.body as string | null,
    meta: r.meta as Record<string, unknown>,
  };
}

function narrowTopicEntry(raw: unknown): TopicEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    (r.text !== null && typeof r.text !== "string") ||
    (r.set_by !== null && typeof r.set_by !== "string") ||
    (r.set_at !== null && typeof r.set_at !== "string")
  )
    return null;
  return {
    text: r.text as string | null,
    set_by: r.set_by as string | null,
    set_at: r.set_at as string | null,
  };
}

function narrowModesEntry(raw: unknown): ModesEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.modes) || typeof r.params !== "object" || r.params === null) return null;
  for (const m of r.modes) {
    if (typeof m !== "string") return null;
  }
  return {
    modes: r.modes as string[],
    params: r.params as Record<string, string | null>,
  };
}

// #216 — a `string[]` (an ISUPPORT CHANMODES class or the like).
function narrowStringArray(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  for (const el of raw) {
    if (typeof el !== "string") return null;
  }
  return raw as string[];
}

// #216 — a `Record<string, string>` (the ISUPPORT PREFIX letter→sigil map).
function narrowStringRecord(raw: unknown): Record<string, string> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val !== "string") return null;
    out[key] = val;
  }
  return out;
}

// #216 — narrows the flat `isupport_changed` payload. Shared by the
// per-channel narrower (cold-WS-subscribe snapshot) AND the user-topic
// narrower (live 005 edge) — the event is dual-topic (see `WireChannelEvent`
// in api.ts). Returns the fully-typed union member or null on any mismatch.
export function narrowIsupportChanged(
  r: Record<string, unknown>,
): Extract<WireChannelEvent, { kind: "isupport_changed" }> | null {
  if (typeof r.network_id !== "number") return null;
  const a = narrowStringArray(r.chanmodes_a);
  const b = narrowStringArray(r.chanmodes_b);
  const c = narrowStringArray(r.chanmodes_c);
  const d = narrowStringArray(r.chanmodes_d);
  const prefix = narrowStringRecord(r.prefix);
  if (a === null || b === null || c === null || d === null || prefix === null) return null;
  return {
    kind: "isupport_changed",
    network_id: r.network_id,
    chanmodes_a: a,
    chanmodes_b: b,
    chanmodes_c: c,
    chanmodes_d: d,
    // #1251 — absent means a server that predates the field (a cic-only
    // bundle deploy is the realistic case), and that server can query
    // exactly one list: `b`. Falling back to the empty set would silently
    // remove /banlist; deriving the set from `chanmodes_a` would offer
    // queries that server cannot answer.
    list_modes_queryable: narrowStringArray(r.list_modes_queryable) ?? ["b"],
    prefix,
    // #1108 — absent or malformed means ABSENT, never a rejected envelope:
    // the /mode toggles this payload seeds must survive a server that
    // predates the budget, and cic's own rule for an unknown budget is to
    // show no warning at all.
    frame_budget_base: typeof r.frame_budget_base === "number" ? r.frame_budget_base : null,
  };
}

export function narrowMembers(raw: unknown): MemberEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: MemberEntry[] = [];
  for (const m of raw) {
    if (typeof m !== "object" || m === null) return null;
    const e = m as Record<string, unknown>;
    if (typeof e.nick !== "string" || !Array.isArray(e.modes)) return null;
    for (const mode of e.modes) {
      if (typeof mode !== "string") return null;
    }
    out.push({ nick: e.nick, modes: e.modes as string[] });
  }
  return out;
}

// #169 — narrow the `who_reply` per-user rows. Superset of MemberEntry;
// `modes` is a raw WHO flags STRING (not a prefix list). `hops`/`realname`
// are nullable (RFC-violating servers may omit the trailing field). A single
// malformed element drops the whole payload (mirror of narrowMembers) so the
// modal never renders a half-typed row.
export function narrowWhoUsers(raw: unknown): WhoUser[] | null {
  if (!Array.isArray(raw)) return null;
  const out: WhoUser[] = [];
  for (const u of raw) {
    if (typeof u !== "object" || u === null) return null;
    const e = u as Record<string, unknown>;
    if (
      typeof e.nick !== "string" ||
      typeof e.user !== "string" ||
      typeof e.host !== "string" ||
      typeof e.server !== "string" ||
      typeof e.modes !== "string" ||
      typeof e.channel !== "string" ||
      (e.hops !== null && typeof e.hops !== "number") ||
      (e.realname !== null && typeof e.realname !== "string")
    ) {
      return null;
    }
    out.push({
      nick: e.nick,
      user: e.user,
      host: e.host,
      server: e.server,
      modes: e.modes,
      hops: e.hops as number | null,
      realname: e.realname as string | null,
      channel: e.channel,
    });
  }
  return out;
}

// REV-A H1 — shared narrower for the three window-state terminal-event
// arms (joined / join_failed / kicked). F1 (visitor-parity 2026-05-15)
// added a user-topic dual-broadcast of these three arms to close a
// subscribe-then-broadcast race, leaving the byte-identical shape
// narrowing duplicated across `narrowChannelEvent` here and
// `narrowUserEvent` in `userTopic.ts`. A future server-side field add
// to e.g. `Session.Wire.kicked/4` would land at one site and silently
// drift at the other.
//
// Reuses the verb (single source for the wire shape), not the noun:
// the dispatch — routing to `setJoined / setFailed / setKicked` in
// `lib/windowState.ts` — stays at each call site (subscribe.ts +
// userTopic.ts) because the two narrowers feed different store keys
// (per-channel key vs user-topic key carrying the same payload).
//
// Returns the typed window-state union variant on success, `null` on
// any shape mismatch. Caller is expected to early-return on `null`
// (matches the surrounding `narrowChannelEvent` / `narrowUserEvent`
// convention).
export type WireWindowStateEvent =
  | { kind: "joined"; network: string; channel: string; state: "joined" }
  | {
      kind: "join_failed";
      network: string;
      channel: string;
      state: "failed";
      reason: string | null;
      // S13 — mirror the server typespec `join_failed_payload.numeric:
      // pos_integer() | nil`. The cold-subscribe snapshot builds this
      // via `Map.get(failure_numerics, channel)` = nil when the failing
      // numeric was never recorded; typing it non-null made the narrower
      // DROP the whole "failed tab" snapshot on reconnect (CP15-B3).
      numeric: number | null;
    }
  | {
      kind: "kicked";
      network: string;
      channel: string;
      state: "kicked";
      by: string | null;
      reason: string | null;
    };

export function narrowWindowStateEvent(raw: unknown): WireWindowStateEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== "string") return null;
  switch (r.kind) {
    case "joined":
      if (typeof r.network !== "string" || typeof r.channel !== "string" || r.state !== "joined")
        return null;
      return { kind: "joined", network: r.network, channel: r.channel, state: "joined" };
    case "join_failed":
      if (
        typeof r.network !== "string" ||
        typeof r.channel !== "string" ||
        r.state !== "failed" ||
        (r.reason !== null && typeof r.reason !== "string") ||
        // S13 — accept null (server contract permits it; see the type
        // above). Dropping on null regressed the reconnect "failed tab".
        (r.numeric !== null && typeof r.numeric !== "number")
      )
        return null;
      return {
        kind: "join_failed",
        network: r.network,
        channel: r.channel,
        state: "failed",
        reason: r.reason as string | null,
        numeric: r.numeric as number | null,
      };
    case "kicked":
      if (
        typeof r.network !== "string" ||
        typeof r.channel !== "string" ||
        r.state !== "kicked" ||
        (r.by !== null && typeof r.by !== "string") ||
        (r.reason !== null && typeof r.reason !== "string")
      )
        return null;
      return {
        kind: "kicked",
        network: r.network,
        channel: r.channel,
        state: "kicked",
        by: r.by as string | null,
        reason: r.reason as string | null,
      };
    default:
      return null;
  }
}

/**
 * Runtime narrower for per-channel WS events (`WireChannelEvent`
 * arms). Consumes the raw payload Phoenix.js delivers as `unknown`-
 * shaped JSON; returns the typed union variant on success or `null`
 * on any shape mismatch (kind missing/unknown, required field
 * missing/wrong-typed).
 *
 * Same boundary-validation pattern as `userTopic.ts`'s
 * `narrowUserEvent`. Caller drops + logs on `null` per the
 * `subscribe.ts` per-handler convention.
 */
export function narrowChannelEvent(raw: unknown): WireChannelEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== "string") return null;
  switch (r.kind) {
    case "message": {
      const message = narrowScrollbackMessage(r.message);
      if (message === null) return null;
      return { kind: "message", message };
    }
    case "topic_changed": {
      if (typeof r.network !== "string" || typeof r.channel !== "string") return null;
      const topic = narrowTopicEntry(r.topic);
      if (topic === null) return null;
      return { kind: "topic_changed", network: r.network, channel: r.channel, topic };
    }
    case "channel_modes_changed": {
      if (typeof r.network !== "string" || typeof r.channel !== "string") return null;
      const modes = narrowModesEntry(r.modes);
      if (modes === null) return null;
      return { kind: "channel_modes_changed", network: r.network, channel: r.channel, modes };
    }
    case "isupport_changed":
      // #216 — dual-topic event; the per-channel cold-snapshot pushes it
      // here, the live 005 edge on the user topic. Same flat shape both
      // ways (shared narrower).
      return narrowIsupportChanged(r);
    // UX-5 BJ (2026-05-19) — recognized-but-ignored. JoinBanner was the
    // only consumer; killed in BJ. Server still emits per-channel on
    // every 329 RPL_CREATIONTIME. Narrow + route to a no-op `case` in
    // `subscribe.ts` instead of letting it land in the default-null arm,
    // which would log `[subscribe] dropped malformed payload` on every
    // JOIN. See `WireChannelEvent` in api.ts for the policy.
    case "channel_created": {
      if (
        typeof r.network !== "string" ||
        typeof r.channel !== "string" ||
        typeof r.created_at !== "string"
      )
        return null;
      return {
        kind: "channel_created",
        network: r.network,
        channel: r.channel,
        created_at: r.created_at,
      };
    }
    case "members_seeded": {
      if (typeof r.network !== "string" || typeof r.channel !== "string") return null;
      const members = narrowMembers(r.members);
      if (members === null) return null;
      return { kind: "members_seeded", network: r.network, channel: r.channel, members };
    }
    case "joined":
    case "join_failed":
    case "kicked":
      // REV-A H1 — shared narrower across per-channel topic + user-topic
      // dual-broadcast (see `narrowWindowStateEvent` moduledoc above).
      return narrowWindowStateEvent(r);
    case "read_cursor_set":
      if (typeof r.last_read_message_id !== "number") return null;
      return {
        kind: "read_cursor_set",
        last_read_message_id: r.last_read_message_id,
        // PWA icon badge door #3. Defensive default 0 if a stale server
        // (mid hot-reload) emits the event without it — the cursor sync,
        // the load-bearing part, must never drop for a badge reason.
        badge_count: typeof r.badge_count === "number" ? r.badge_count : 0,
      };
    // #267 — server-authoritative per-window count snapshot.
    case "window_counts": {
      if (
        typeof r.channel !== "string" ||
        typeof r.messages !== "number" ||
        typeof r.mentions !== "number" ||
        typeof r.events !== "number"
      )
        return null;
      return {
        kind: "window_counts",
        channel: r.channel,
        messages: r.messages,
        mentions: r.mentions,
        events: r.events,
        severity: narrowSeverity(r.severity),
      };
    }
    // P-0e + P-0f: invite_ack moved from per-channel topic to
    // user-topic; narrowed in `narrowUserEvent` instead. Channel-
    // topic should never receive invite_ack post-P-0f; default arm
    // returns null to drop any stray.
    default:
      return null;
  }
}

// ── REV-G H24 (2026-05-22) — admin-channel narrowers ───────────────
//
// `lib/adminEvents.ts` was using `channel.on("snapshot", (payload:
// AdminSnapshotPayload) => ...)` and `channel.on("event", (payload:
// WireAdminEvent) => ...)` direct casts — TypeScript-only contract,
// zero runtime enforcement. Sibling channels adopted `narrowChannelEvent`
// / `narrowUserEvent` for this exact boundary; admin path was missed.
//
// A malformed admin push (kind valid but field missing/wrong-typed) would
// either crash `ingest()` via the missing field read or silently corrupt
// the live `liveCountsByNetworkId` projection. The narrowers gate the
// boundary: shape mismatch → return null → caller drops + logs.
//
// #429 — the 27 arms below used to be transcribed BY HAND from the server's
// `Grappa.AdminEvents.Wire` typespecs: ~420 lines re-stating a shape the
// codegen already reads. They now run off `S_AdminEventsWireEvent`, emitted
// from those same typespecs by `mix grappa.gen_wire_types` and gated by the
// same `--check` drift check as `wireTypes.ts`.
//
// Transcription is not free: the hand version had NO `web_session_severed`
// arm, so every flood-sever audit row was dropped on the live push — and,
// because `narrowAdminSnapshot` is atomic, a single such row in the ring
// blanked the whole Events tab on reconnect. That arm exists on the server,
// in `wireTypes.ts` and in `adminEvents.ts`'s dispatch; only the hand copy
// lost it. Nobody could have noticed by reading the diff that omitted it.
// See the measured before/after in `__tests__/wireAdminBoundary.test.ts`.
//
// Adding a new admin event arm now: declare it in the server typespec, run
// the codegen, add a dispatch case to `ingest()` in adminEvents.ts
// (tsc-enforced via `assertNever`). Nothing to add HERE.

// A closed-set field the server marked `optional(:k)` AND that carries
// attribution DETAIL rather than the substance of the event.
//
// This is the part of a narrower a typespec cannot express, so it stays
// hand-written and named. `optional(:door)` tells the schema the server may
// OMIT the key; it cannot say what to do when a NEWER server sends a member
// this build has never heard of. `login_throttled` is a security alert whose
// door/scope are the attribution: dropping the alert to protect the detail
// inverts the priority, and the admin ring is mirrored to disk and replayed
// at boot, so rows minted by another vintage genuinely do arrive. Strip the
// unrecognised value, keep the alert — the judgement `narrowEnumMember` made
// inline before #429, now stated once.
const ADDITIVE_DETAIL_FIELDS: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>> = new Map(
  [
    [
      "login_throttled",
      new Map([
        ["door", ADMIN_EVENTS_WIRE_LOGIN_THROTTLE_DOOR as readonly string[]],
        ["scope", ADMIN_EVENTS_WIRE_LOGIN_THROTTLE_SCOPE as readonly string[]],
      ]),
    ],
  ],
);

function dropUnrecognisedDetails(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;
  const details = typeof r.kind === "string" ? ADDITIVE_DETAIL_FIELDS.get(r.kind) : undefined;
  if (details === undefined) return raw;

  let out: Record<string, unknown> | null = null;
  for (const [field, allowed] of details) {
    const value = r[field];
    if (value === undefined) continue;
    if (typeof value === "string" && allowed.includes(value)) continue;
    out ??= { ...r };
    delete out[field];
  }
  return out ?? raw;
}

/**
 * Runtime narrower for admin-channel events (`WireAdminEvent` arms).
 * Mirror of `narrowChannelEvent` / `narrowUserEvent` for the admin
 * boundary. Returns the typed union variant on success or `null` on
 * any shape mismatch. Caller (adminEvents.ts) drops + logs on null.
 */
export function narrowAdminEvent(raw: unknown): WireAdminEvent | null {
  return validate(S_AdminEventsWireEvent, dropUnrecognisedDetails(raw));
}

/**
 * Runtime narrower for the admin-channel `snapshot` push payload.
 * Validates the `{events: [...]}` outer shape AND every element. Atomic: a
 * single malformed element drops the whole snapshot (avoids corrupting the
 * audit ring with mid-shape rows) — a policy call, not a shape, which is why
 * it is not `{ a: S_AdminEventsWireEvent }`. Caller drops + logs on null.
 */
export function narrowAdminSnapshot(raw: unknown): AdminSnapshotPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.events)) return null;
  const events: WireAdminEvent[] = [];
  for (const el of r.events) {
    const narrowed = narrowAdminEvent(el);
    if (narrowed === null) return null;
    events.push(narrowed);
  }
  return { events };
}

// ── #215 — session-lifecycle-log narrower ──────────────────────────
//
// The session-log rides the SAME admin channel (`grappa:admin:events`)
// as the admin-events audit ring; the live push event name is
// `session_log_event` with payload `{kind, entry: SessionLogWireT}`.
// `sessionLog.ts` extracts `.entry` and narrows it here. Same
// boundary-validation contract as `narrowAdminEvent` — a malformed
// live push (field missing / wrong-typed) drops instead of crashing
// the store setter.

/**
 * Runtime narrower for the admin top bar's projection (`"overview"` push /
 * `GET /admin/overview`). Same REV-G H24 discipline as its siblings: the
 * caller (adminOverview.ts) drops + logs on null rather than trusting a cast.
 *
 * `loadavg` is checked as NULLABLE, and that is the load-bearing line.
 * `Grappa.AdminOverview.Wire` sends `nil` when `:cpu_sup` cannot be reached
 * because "cannot measure" is a different fact from "the box is idle";
 * demanding a number here would drop the whole payload exactly when the
 * sampler is down, blanking a bar whose other four stats are fine. #429 — the
 * typespec already says `integer() | nil`, so the generated schema carries
 * that nullability and no hand check has to remember it.
 */
export function narrowAdminOverview(raw: unknown): AdminOverviewWireT | null {
  return validate(S_AdminOverviewWireT, raw);
}

/**
 * Runtime narrower for a single `SessionLogWireT` row. Mirror of the
 * generated wire shape (`Grappa.SessionLog.Wire.t/0`). Returns the
 * typed row on success or `null` on any shape mismatch. Used by
 * `sessionLog.ts` on the live `session_log_event` push (the REST
 * snapshot trusts the server, same as the other `adminList*` helpers).
 *
 * #618/#429 — `old_nick` is the second policy residue on this boundary (the
 * first is `login_throttled`'s door/scope in `dropUnrecognisedDetails`). The
 * server declares it REQUIRED and always sends it, so the typespec is right
 * and the generated schema is right to demand it. But the field was ADDED
 * after this shape shipped, and cic deploys independently of the server
 * (`deploy-m42.sh --cic`): a cic ahead of its server would drop EVERY
 * session-log row over one field the peer predates. That is the additive-only
 * contract (#447) read from the client side, and no typespec can express it —
 * "required of a current server, tolerated absent from an older one" is a
 * statement about deploy skew, not about the shape. Default it and let the
 * row through.
 */
export function narrowSessionLogEntry(raw: unknown): SessionLogWireT | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return validate(S_SessionLogWireT, r.old_nick === undefined ? { ...r, old_nick: null } : r);
}
