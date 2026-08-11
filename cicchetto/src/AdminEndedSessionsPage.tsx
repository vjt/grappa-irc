import { type Component, For, Show } from "solid-js";
import AdminBadge from "./admin/AdminBadge";
import AdminCard from "./admin/AdminCard";
import { AdminEmpty } from "./admin/AdminStatus";
import AdminTable from "./admin/AdminTable";
import { formatInstant } from "./admin/formatInstant";
import { renderDuration, renderReason } from "./admin/sessionLogFormat";
import type { EndedSessionRow } from "./lib/adminSubjectRows";

// #1224 — sessions that are over, on their own page, with their own
// columns.
//
// vjt, same iPhone dogfood pass as #1223: *"i visitor deleted son utili
// ma vanno su sotto pagina con campi diversi perché son sempre
// offline"*. These rows exist because `session_log_events` carries no FK
// to the subject and outlived the CASCADE (#1158 item 4), so there is no
// process and no DB row behind them — and three of the four columns the
// live list dictates (`last seen`, `channels`, `actions`) were an
// em-dash on every one of them, structurally and forever. The list was
// paying full column width for fields that can never be populated.
//
// vjt's three rulings (2026-08-11):
//   1. a SUB-PAGE of Sessions, not a sixth tab — the tab strip already
//      overflows and scrolls on a phone;
//   2. no `deleted` badge: once these move out, Sessions is strictly
//      live and has nothing to mark;
//   3. the ring caveat is not a blocker — but it is still true, so it
//      travels with the page (see the subtitle).
//
// Built with #1223 item 1 already applied, as the issue asks: the
// columns here are the ones the record actually has, no detail panel
// repeats them, and nothing is dropped at any width — five short fields
// stack into a card without needing a disclosure to get them back.
//
// The rows are PASSED IN, not re-fetched. They come out of the same five
// endpoints the tab already merged, on the same composite key; fetching
// again would show a second snapshot of a list the operator reached from
// the first one.
//
// The identity block reuses the live list's `.admin-session-*` classes
// on purpose: it is the same two-line shape vjt dictated for Sessions
// (2026-08-09) and this page is one of its screens, not another tab.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT.

export type Props = {
  rows: EndedSessionRow[];
  onBack: () => void;
};

const AdminEndedSessionsPage: Component<Props> = (props) => (
  <div class="admin-ended-sessions-page" data-testid="admin-ended-sessions-page">
    <div class="adm-scroll">
      <header class="adm-subpage-head">
        <button
          type="button"
          class="adm-btn"
          onClick={props.onBack}
          aria-label="back to the sessions list"
          data-testid="admin-ended-sessions-back"
        >
          ← Sessions
        </button>
        <h2 class="adm-card-title">Ended sessions</h2>
      </header>

      <AdminCard
        title="From the lifecycle log"
        // The caveat had to survive the move, and it matters MORE here
        // than it did as a badge on an inline row: a page named after a
        // population implies it holds all of it. It does not — the ring
        // is bounded, pruned on write and fed by an async cast from a
        // path that includes `terminate/2`.
        subtitle="a bounded, best-effort ring — an absent row is not evidence the session never ran, and a last event that is not a disconnect means the log never saw the end"
        data-testid="admin-ended-sessions-card"
      >
        <Show
          when={props.rows.length > 0}
          fallback={
            <AdminEmpty
              message="the log remembers no session whose subject is gone"
              testId="admin-ended-sessions-empty"
            />
          }
        >
          <AdminTable data-testid="admin-ended-sessions-table">
            <thead>
              <tr>
                <th class="adm-table-grow">who</th>
                <th>last event</th>
                <th>at</th>
                <th>lasted</th>
                <th>how</th>
              </tr>
            </thead>
            <tbody>
              <For each={props.rows}>
                {(row) => (
                  <tr
                    class="admin-ended-session-row"
                    data-testid={`admin-ended-session-row-${row.key}`}
                  >
                    {/* No `.admin-session-who`: that class exists only to
                        give the live list's disclosure its two-line flex
                        shape, and there is no disclosure here. */}
                    <td class="adm-cell-title">
                      <span class="admin-session-lines">
                        <span class="admin-session-identity">
                          <AdminBadge
                            tone={row.subject_kind === "user" ? "info" : "neutral"}
                            class="adm-badge--kind"
                            ariaLabel={row.subject_kind}
                          >
                            {row.subject_kind}
                          </AdminBadge>
                          <span class="admin-session-nick">{renderLabel(row)}</span>
                        </span>
                        <span class="admin-session-network">
                          {row.network_slug ?? `network ${row.network_id}`}
                        </span>
                      </span>
                    </td>
                    <td
                      data-label="last event"
                      data-testid={`admin-ended-session-event-${row.key}`}
                    >
                      {row.last_event.event}
                    </td>
                    <td data-label="at">{formatInstant(row.last_event.at)}</td>
                    <td data-label="lasted">{renderLasted(row)}</td>
                    <td data-label="how">{renderHow(row)}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </AdminTable>
        </Show>
      </AdminCard>
    </div>
  </div>
);

// The log records the nick the session answered to. `null` means it was
// written before the session had one — say which rather than blanking,
// the same reading the live list gives an unlabelled row.
function renderLabel(row: EndedSessionRow): string {
  if (row.label !== null) return row.label;
  return `${row.subject_id.slice(0, 8)} (no nick logged)`;
}

// Only a disconnect carries a duration. An em-dash here is not the
// structurally-empty cell #1224 is about: it says the log's last word on
// this session was something other than its end.
function renderLasted(row: EndedSessionRow): string {
  const ms = row.last_event.duration_ms;
  return ms === null ? "—" : renderDuration(ms);
}

function renderHow(row: EndedSessionRow): string {
  return row.last_event.event === "disconnected" ? renderReason(row.last_event) : "—";
}

export default AdminEndedSessionsPage;
