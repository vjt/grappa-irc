import { type Component, For } from "solid-js";
import { adminEvents } from "./lib/adminEvents";
import { assertNever, type WireAdminEvent } from "./lib/api";

// M-11 — Admin events tab. Renders the in-memory ring buffer from
// `adminEvents()` newest-first. Per `feedback_no_localized_strings_server_side`,
// the server emits structured data only; this component owns ALL
// human-readable rendering.
//
// Per `feedback_no_silent_drops_closed`, `renderEvent`'s switch is
// exhaustive on `WireAdminEvent["kind"]`. Adding a new server-side
// arm without a case here trips `tsc` via `assertNever`.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT.

const AdminEventsTab: Component = () => {
  return (
    <div class="admin-events-tab" data-testid="admin-events-tab">
      <header class="admin-events-header">
        <span class="muted">last {adminEvents().length} event(s) (newest first)</span>
      </header>
      <ul class="admin-events-list">
        <For each={adminEvents()} fallback={<li class="admin-events-empty">no events yet</li>}>
          {(ev) => (
            <li class="admin-event-row" data-testid={`admin-event-${ev.kind}`}>
              <time class="admin-event-at">{ev.at}</time>
              <span class={`admin-event-kind kind-${ev.kind}`}>{ev.kind}</span>
              <span class="admin-event-summary">{renderEvent(ev)}</span>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
};

function renderEvent(ev: WireAdminEvent): string {
  switch (ev.kind) {
    case "circuit_open":
      return `circuit OPEN for ${networkLabel(ev.network_slug, ev.network_id)} (threshold=${ev.threshold}, cooldown=${ev.cooldown_ms}ms)`;
    case "circuit_close":
      return `circuit closed for ${networkLabel(ev.network_slug, ev.network_id)} (${ev.reason})`;
    case "capacity_reject":
      return `${ev.flow} flow rejected on ${networkLabel(ev.network_slug, ev.network_id)} — ${ev.error}${
        ev.client_id !== null ? ` (client ${ev.client_id})` : ""
      }`;
    case "visitor_deleted":
      return `${visitorLabel(ev.visitor_nick, ev.visitor_id)} deleted${actorSuffix(ev.actor_user_name)}`;
    case "visitor_reaped":
      return `${visitorLabel(ev.visitor_nick, ev.visitor_id)} reaped (TTL expired)`;
    case "reaper_swept":
      return `reaper swept ${ev.count} visitor(s)`;
    case "session_disconnected":
      return `${ev.subject_kind}:${ev.subject_id} @ ${networkLabel(ev.network_slug, ev.network_id)} disconnected${actorSuffix(ev.actor_user_name)}`;
    case "session_terminated":
      return `${ev.subject_kind}:${ev.subject_id} @ ${networkLabel(ev.network_slug, ev.network_id)} terminated${actorSuffix(ev.actor_user_name)}`;
    case "network_caps_updated":
      return `${ev.network_slug} caps: sessions=${capLabel(ev.max_concurrent_sessions)}, perClient=${capLabel(ev.max_per_client)}${actorSuffix(ev.actor_user_name)}`;
    case "circuit_reset":
      return `circuit RESET for ${networkLabel(ev.network_slug, ev.network_id)}${actorSuffix(ev.actor_user_name)}`;
    default:
      return assertNever(ev);
  }
}

function networkLabel(slug: string | null, id: number): string {
  return slug !== null ? slug : `net#${id}`;
}

function visitorLabel(nick: string | null, id: string): string {
  return nick !== null ? nick : id;
}

function capLabel(n: number | null): string {
  return n === null ? "∞" : String(n);
}

function actorSuffix(name: string | null): string {
  return name !== null ? ` by ${name}` : "";
}

export default AdminEventsTab;
