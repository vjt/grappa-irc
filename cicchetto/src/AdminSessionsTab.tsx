import { type Component, createMemo, createSignal, For, onMount, Show } from "solid-js";
import AdminBadge from "./admin/AdminBadge";
import AdminCard from "./admin/AdminCard";
import AdminDetailPanel from "./admin/AdminDetailPanel";
import AdminFacts from "./admin/AdminFacts";
import AdminRowName from "./admin/AdminRowName";
import { AdminEmpty, AdminError } from "./admin/AdminStatus";
import AdminTable from "./admin/AdminTable";
import { useRefreshSlot } from "./admin/refreshSlot";
import InlineConfirmButton from "./InlineConfirmButton";
import {
  type AdminSubjectRow,
  buildSubjectRows,
  channelCount,
  rowActions,
} from "./lib/adminSubjectRows";
import {
  type AdminCredential,
  type AdminNetwork,
  type AdminSession,
  type AdminSessionLogEntry,
  type AdminVisitor,
  ApiError,
  adminDeleteVisitor,
  adminDisconnectSession,
  adminListCredentials,
  adminListNetworks,
  adminListSessionLogSessions,
  adminListSessions,
  adminListVisitors,
  adminReconnectSession,
  adminTerminateSession,
} from "./lib/api";
import { token } from "./lib/auth";

// #1157 — the unified admin Sessions view. The Visitors tab is gone;
// this one lists ACTIVE AND INACTIVE sessions for both subject kinds.
//
// The row set is built in `lib/adminSubjectRows.ts` — read the reasoning
// there, it is the load-bearing part: the list is ROW-backed with live
// process state joined on top, because a registry-driven list drops
// every parked / failed / expired-but-unreaped subject out of the
// console.
//
// Column shape is dictated (vjt, 2026-08-09):
//   1. two lines — a visitor/user badge (both the SAME width, so the
//      nicks line up into a readable column) + the nick, then the
//      network underneath;
//   2. last seen;  3. channel count;  4. actions.
// Everything else moved into the per-row drill-down rather than being
// deleted: a phone cannot show those columns side by side, and the
// answer to that is fewer columns, not a table the operator has to pan.
//
// Delete lives in the drill-down, NOT in the actions cell, and says so:
// `DELETE /admin/visitors/:id` is identity-wide while a row here is one
// (subject, network) pair, so a visitor on two networks yields two rows
// whose Delete buttons would each nuke both. Behind the disclosure, and
// labelled with what it actually destroys, it stops being a footgun.
//
// #1158 item 4 — a fifth source, `/admin/session_log/sessions`. vjt ruled
// the retention fork "keep only the event" (2026-08-11): an anon visitor
// is still purged at logout and reaped at TTL, so for a session that is
// over the lifecycle log is the ONLY record left — it carries no FK to
// the subject and outlives the CASCADE. It joins on `session_id`, which
// is the row key, so it both fills in "what did this session last do"
// and supplies rows for subjects that no longer exist.
//
// The log is a bounded ring, so those rows are RECENT history, not an
// archive, and the card subtitle says so rather than letting the table
// imply completeness.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT.

// who + last seen + channels + the detail-only columns + actions. Feeds
// the detail row's colspan.
const SESSION_COLUMNS = 4;

type ActionKind = "disconnect" | "reconnect" | "terminate";

const ACTION_FN: Record<ActionKind, (token: string, id: string) => Promise<void>> = {
  disconnect: adminDisconnectSession,
  reconnect: adminReconnectSession,
  terminate: adminTerminateSession,
};

const ACTION_LABEL: Record<ActionKind, string> = {
  disconnect: "Disconnect",
  reconnect: "Reconnect",
  terminate: "Terminate",
};

function confirmKey(key: string, kind: ActionKind | "delete"): string {
  return `${key}:${kind}`;
}

function renderCap(cap: number | null): string {
  // Mirrors the AdminNetworksTab cap-cell convention: `null` is the
  // "unlimited" sentinel per `Networks.update_network_caps/2`.
  return cap === null ? "∞" : String(cap);
}

const AdminSessionsTab: Component = () => {
  const [visitors, setVisitors] = createSignal<AdminVisitor[] | null>(null);
  const [credentials, setCredentials] = createSignal<AdminCredential[] | null>(null);
  const [sessions, setSessions] = createSignal<AdminSession[] | null>(null);
  const [networks, setNetworks] = createSignal<AdminNetwork[] | null>(null);
  const [logSessions, setLogSessions] = createSignal<AdminSessionLogEntry[] | null>(null);
  const [confirmingKey, setConfirmingKey] = createSignal<string | null>(null);
  const [detailKey, setDetailKey] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  const loaded = (): boolean =>
    visitors() !== null && credentials() !== null && logSessions() !== null;

  const rows = createMemo<AdminSubjectRow[]>(() =>
    loaded()
      ? buildSubjectRows({
          visitors: visitors() ?? [],
          credentials: credentials() ?? [],
          sessions: sessions() ?? [],
          networks: networks() ?? [],
          logSessions: logSessions() ?? [],
        })
      : [],
  );

  const refresh = async (): Promise<void> => {
    const t = token();
    if (t === null) return;
    setLoading(true);
    setError(null);
    setConfirmingKey(null);
    try {
      // Five endpoints, one table. The two row-backed ones supply the
      // rows, /admin/sessions supplies the live join, /admin/networks
      // supplies the capacity summary + the slug for an orphan row, and
      // /admin/session_log/sessions supplies the history join plus the
      // rows of subjects that no longer exist (#1158 item 4).
      // Failure of ANY collapses the whole render to the banner: a
      // half-built merge is worse than no table, because the operator
      // cannot tell which half is missing. That holds hardest for the
      // log: a silently dropped fetch would remove exactly the rows the
      // operator came for, and leave a table that looks complete.
      const [nextVisitors, nextCredentials, nextSessions, nextNetworks, nextLogSessions] =
        await Promise.all([
          adminListVisitors(t),
          adminListCredentials(t),
          adminListSessions(t),
          adminListNetworks(t),
          adminListSessionLogSessions(t),
        ]);
      setVisitors(nextVisitors);
      setCredentials(nextCredentials);
      setSessions(nextSessions);
      setNetworks(nextNetworks);
      setLogSessions(nextLogSessions);
    } catch (e) {
      setVisitors(null);
      setCredentials(null);
      setSessions(null);
      setNetworks(null);
      setLogSessions(null);
      const code = e instanceof ApiError ? e.code : "fetch_failed";
      setError(code);
    } finally {
      setLoading(false);
    }
  };

  const runAction = async (row: AdminSubjectRow, kind: ActionKind): Promise<void> => {
    const t = token();
    if (t === null) return;
    setError(null);
    try {
      await ACTION_FN[kind](t, row.key);
      setConfirmingKey(null);
      // Re-fetch rather than splice: every one of these verbs moves
      // live BEAM state (and disconnect on a user subject also moves
      // the DB connection_state), and the row STAYS either way — only
      // its live/DB columns flip. The server projection is the only
      // honest source for what they flipped to.
      await refresh();
    } catch (e) {
      // Prefix with the verb: three actions share this cell and a bare
      // `cannot_disconnect_self` would not say which one earned it.
      const code = e instanceof ApiError ? e.code : "request_failed";
      setError(`${kind}: ${code}`);
      setConfirmingKey(null);
    }
  };

  const runDelete = async (row: AdminSubjectRow): Promise<void> => {
    const t = token();
    const id = row.visitor?.visitor_id;
    if (t === null || id === undefined) return;
    setError(null);
    try {
      await adminDeleteVisitor(t, id);
      setConfirmingKey(null);
      setDetailKey(null);
      // Refetch, NOT splice: the verb is identity-wide, so it can take
      // sibling rows on other networks with it. Splicing the one row
      // the operator clicked would leave the others on screen as
      // phantoms.
      await refresh();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "delete_failed";
      setError(`delete: ${code}`);
      setConfirmingKey(null);
    }
  };

  useRefreshSlot({
    onRefresh: () => {
      void refresh();
    },
    busy: loading,
    label: "refresh sessions list",
    testId: "admin-sessions-refresh",
  });

  onMount(() => {
    void refresh();
  });

  return (
    <div class="admin-sessions-tab">
      <div class="adm-scroll">
        <Show when={error() !== null}>
          <AdminError message={error() ?? ""} testId="admin-sessions-error" />
        </Show>

        <Show when={networks() !== null && (networks() ?? []).length > 0}>
          <AdminCard
            title="Capacity per network"
            subtitle="live_counts from the Registry — the same projection the admission policy uses"
            data-testid="admin-sessions-network-summary"
          >
            <AdminTable data-testid="admin-sessions-summary-table">
              <thead>
                <tr>
                  <th>network</th>
                  <th>visitors</th>
                  <th>users</th>
                  <th>per-IP cap</th>
                </tr>
              </thead>
              <tbody>
                <For each={networks() ?? []}>
                  {(net) => (
                    <tr
                      class="admin-sessions-summary-row"
                      data-testid={`admin-sessions-summary-row-${net.slug}`}
                    >
                      <td class="adm-cell-title">{net.slug}</td>
                      <td
                        data-label="visitors"
                        data-testid={`admin-sessions-summary-visitors-${net.slug}`}
                      >
                        {net.live_counts.visitors}/{renderCap(net.max_concurrent_visitor_sessions)}
                      </td>
                      <td
                        data-label="users"
                        data-testid={`admin-sessions-summary-users-${net.slug}`}
                      >
                        {net.live_counts.users}/{renderCap(net.max_concurrent_user_sessions)}
                      </td>
                      <td
                        data-label="per-ip"
                        data-testid={`admin-sessions-summary-per-ip-${net.slug}`}
                      >
                        {renderCap(net.max_per_ip)}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </AdminTable>
          </AdminCard>
        </Show>

        <Show when={!loaded() && error() === null}>
          <AdminEmpty message="loading…" />
        </Show>

        <Show when={loaded() && rows().length === 0}>
          <AdminEmpty message="no sessions" testId="admin-sessions-empty" />
        </Show>

        <Show when={loaded() && rows().length > 0}>
          <AdminCard
            hostsRefresh
            title="Sessions"
            subtitle="row-backed — parked and failed subjects are listed too, with live state joined on; rows marked deleted come from the lifecycle log, which keeps recent history only"
            data-testid="admin-sessions-table-card"
          >
            <AdminTable class="admin-sessions-table" data-testid="admin-sessions-table">
              <thead>
                <tr>
                  <th class="adm-table-grow">who</th>
                  <th>last seen</th>
                  <th>channels</th>
                  <th class="adm-table-sticky-actions">actions</th>
                </tr>
              </thead>
              <tbody>
                <For each={rows()}>
                  {(row) => (
                    <>
                      <tr class="admin-sessions-row" data-testid={`admin-session-row-${row.key}`}>
                        <td class="admin-session-who adm-cell-title">
                          <AdminRowName
                            alwaysOpenable
                            open={detailKey() === row.key}
                            onToggle={() => setDetailKey(detailKey() === row.key ? null : row.key)}
                            label={`details for ${renderWho(row)}`}
                            testId={`admin-session-details-${row.key}`}
                          >
                            {/* The two dictated lines are ONE block beside the
                                caret, not two siblings of it. Left as siblings
                                they are flex items of `.adm-row-expand`, and
                                the second line can only be produced by letting
                                that row wrap — which makes the layout depend on
                                nick length: a nick too long to sit beside the
                                caret pushes the whole identity onto its own
                                line, losing the caret's indent and breaking the
                                alignment the fixed-width badge exists to
                                create. Measured at 16px of drift. */}
                            <span class="admin-session-lines">
                              <span class="admin-session-identity">
                                {/* Fixed-width kind badge: "visitor" and
                                    "user" are different lengths, and an
                                    unpadded pair makes every nick start at
                                    a different x. */}
                                <AdminBadge
                                  tone={row.subject_kind === "user" ? "info" : "neutral"}
                                  class="adm-badge--kind"
                                  ariaLabel={row.subject_kind}
                                >
                                  {row.subject_kind}
                                </AdminBadge>
                                <span class="admin-session-nick">{renderLabel(row)}</span>
                                {/* #1158 item 4 — this row exists only
                                    because the lifecycle log outlived the
                                    subject. Say so on the row itself: it
                                    has no state to read and no verb to
                                    press, and without the marker it reads
                                    as a session that merely looks broken. */}
                                <Show when={row.origin === "session_log"}>
                                  <AdminBadge
                                    tone="warn"
                                    ariaLabel="subject deleted, session log only"
                                    testId={`admin-session-gone-${row.key}`}
                                  >
                                    deleted
                                  </AdminBadge>
                                </Show>
                              </span>
                              <span class="admin-session-network">
                                {row.network_slug ?? `network ${row.network_id}`}
                              </span>
                            </span>
                          </AdminRowName>
                        </td>
                        <td
                          class="admin-session-last-seen"
                          data-label="last seen"
                          data-testid={`admin-session-last-seen-${row.key}`}
                          title={row.last_seen_at ?? "no browser session on record"}
                        >
                          {renderLastSeen(row.last_seen_at)}
                        </td>
                        <td data-label="channels" data-testid={`admin-session-channels-${row.key}`}>
                          {renderChannels(row)}
                        </td>
                        <td
                          class="admin-sessions-actions adm-table-sticky-actions"
                          data-label="actions"
                        >
                          <For each={rowActions(row)}>
                            {(kind) => (
                              <InlineConfirmButton
                                idleLabel={ACTION_LABEL[kind]}
                                confirmLabel={`Confirm ${kind}`}
                                armed={confirmingKey() === confirmKey(row.key, kind)}
                                onArm={() => setConfirmingKey(confirmKey(row.key, kind))}
                                onConfirm={() => runAction(row, kind)}
                                testId={`admin-session-${kind}-${row.key}`}
                                extraClass={`${kind}-btn`}
                              />
                            )}
                          </For>
                          {/* An empty cell reads as a rendering bug. The
                              dash says the absence is the answer. */}
                          <Show when={rowActions(row).length === 0}>—</Show>
                        </td>
                      </tr>
                      <Show when={detailKey() === row.key}>
                        <AdminDetailPanel
                          title={renderWho(row)}
                          subtitle="the rest of the record"
                          onClose={() => setDetailKey(null)}
                          closeLabel="close session details"
                          columns={SESSION_COLUMNS}
                          data-testid={`admin-session-detail-${row.key}`}
                        >
                          <AdminFacts facts={detailFacts(row)} />
                          <Show when={row.visitor !== null}>
                            <div class="admin-session-danger">
                              {/* Named for what it destroys. The verb is
                                  identity-wide: it deletes the visitor
                                  and every one of its network rows, not
                                  the row this panel hangs off. */}
                              <span class="admin-session-danger-note">
                                deletes the whole visitor identity, on every network
                              </span>
                              <InlineConfirmButton
                                idleLabel="Delete visitor"
                                confirmLabel="Confirm delete visitor"
                                armed={confirmingKey() === confirmKey(row.key, "delete")}
                                onArm={() => setConfirmingKey(confirmKey(row.key, "delete"))}
                                onConfirm={() => runDelete(row)}
                                testId={`admin-session-delete-${row.key}`}
                                extraClass="delete-btn"
                              />
                            </div>
                          </Show>
                        </AdminDetailPanel>
                      </Show>
                    </>
                  )}
                </For>
              </tbody>
            </AdminTable>
          </AdminCard>
        </Show>
      </div>
    </div>
  );
};

function renderLabel(row: AdminSubjectRow): string {
  if (row.label !== null) return row.label;
  // `null` on an orphan pid whose DB row is gone, or on a log entry the
  // server wrote before the session had a nick. Say which rather than
  // rendering a blank — it is the divergence, not a missing value.
  const why = row.origin === "session_log" ? "no nick logged" : "no DB row";
  return `${row.subject_id.slice(0, 8)} (${why})`;
}

function renderWho(row: AdminSubjectRow): string {
  return `${row.subject_kind}: ${renderLabel(row)}`;
}

// An unknown count is NOT zero. `null` means either no pid or an
// introspection timeout, and "0 chan" would read as a connected session
// sitting in no channels — a different, actionable fact.
function renderChannels(row: AdminSubjectRow): string {
  const n = channelCount(row);
  if (n === null) return row.live === null ? "—" : "?";
  return String(n);
}

// Compact relative time. `null` → em-dash. A future timestamp (host vs
// jail clock skew) renders "now" rather than a negative age.
function renderLastSeen(iso: string | null): string {
  if (iso === null) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "?";
  const deltaMs = Date.now() - then;
  if (deltaMs < 0) return "now";
  const s = Math.floor(deltaMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function renderUpstream(row: AdminSubjectRow): string {
  const up = row.upstream;
  if (up === null || up.peer_address === null) return "—";
  const hostport = up.peer_port === null ? up.peer_address : `${up.peer_address}:${up.peer_port}`;
  return up.peer_name === null ? hostport : `${up.peer_name} (${hostport})`;
}

function renderExpires(row: AdminSubjectRow): string {
  const v = row.visitor;
  if (v === null) return "—";
  if (v.identified) return "indefinite (NickServ)";
  if (v.expires_at === null) return "indefinite (legacy)";
  const at = Date.parse(v.expires_at);
  if (Number.isNaN(at)) return "?";
  const days = Math.ceil((at - Date.now()) / 86_400_000);
  return days <= 0 ? "expired" : `in ${days}d`;
}

// Human duration for a session that has ended. Raw milliseconds are
// unreadable at the scale a bouncer session actually runs for.
function renderDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h${m % 60}m` : `${Math.floor(h / 24)}d${h % 24}h`;
}

// The last thing the lifecycle log saw this session do. `null` is NOT
// "this session never ran": the log is a bounded global ring written
// from an async cast, so it forgets, and saying so is the honest render.
function renderLastEvent(row: AdminSubjectRow): string {
  const e = row.last_event;
  if (e === null) return "nothing logged (bounded ring — not proof it never ran)";
  return `${e.event} · ${e.at}`;
}

// Only meaningful on a disconnect: reason / cleanliness / how long it
// had been up. Each part is dropped when the row does not carry it.
function renderEnded(e: AdminSessionLogEntry): string {
  const clean = e.clean === null ? "" : e.clean ? " (clean)" : " (unclean)";
  const lasted = e.duration_ms === null ? "" : `, lasted ${renderDuration(e.duration_ms)}`;
  return `${e.reason ?? "no reason recorded"}${clean}${lasted}`;
}

function detailFacts(row: AdminSubjectRow): { label: string; value: string }[] {
  const facts: { label: string; value: string }[] = [
    // DB intent and live pid are separate sources of truth and both
    // render — `live: BEAM has no pid` against `connection: connected`
    // IS the U-0 divergence signal, and computing one from the other
    // would erase it.
    { label: "connection", value: row.connection_state ?? "no DB row" },
    { label: "live", value: renderLive(row) },
    // NO `network` fact. #1223 item 1 reported the panel repeating it,
    // and unlike the Users/Credentials repeats this one is not the
    // `.adm-col-detail` specificity defect: Sessions drops no column at
    // any width, and `.admin-session-network` prints the slug under the
    // nick on DESKTOP too. Two defects, one symptom — raising the CSS
    // selector would not have touched this one, and the second line of
    // the identity block is dictated (vjt, 2026-08-09), so the panel is
    // the copy that goes.
    { label: "upstream", value: renderUpstream(row) },
    // #1158 item 4 — the third source, and the only one that says
    // anything at all about a session that is over.
    { label: "last event", value: renderLastEvent(row) },
  ];

  if (row.last_event?.event === "disconnected") {
    facts.push({ label: "ended", value: renderEnded(row.last_event) });
  }

  if (row.origin === "session_log") {
    facts.push({
      label: "record",
      value: "session log only — the subject was deleted, the event outlived it",
    });
  }

  if (row.live !== null) {
    facts.push(
      { label: "mailbox", value: String(row.live.mailbox_len) },
      { label: "memory", value: `${Math.round(row.live.memory_bytes / 1024)} KB` },
    );
    if (row.live.introspection_degraded.length > 0) {
      facts.push({
        label: "degraded",
        value: `⚠ ${row.live.introspection_degraded.join(", ")}`,
      });
    }
  }

  if (row.visitor !== null) {
    facts.push(
      { label: "ip", value: row.visitor.ip ?? "—" },
      { label: "expires", value: renderExpires(row) },
      { label: "joined", value: row.visitor.inserted_at },
    );
  }

  return facts;
}

function renderLive(row: AdminSubjectRow): string {
  if (row.live === null) return "BEAM has no pid";
  return row.live.alive ? "alive" : "pid registered but dead";
}

export default AdminSessionsTab;
