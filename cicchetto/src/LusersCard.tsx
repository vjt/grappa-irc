import { type Component, Show } from "solid-js";
import { dismissLusersCard, lusersBundleByNetwork } from "./lib/lusersBundle";

// P-0d — LUSERS card. Renders a structured snapshot of network state
// (clients, operators, channels, servers, local/global counts) folded
// from Bahamut's 7-numeric LUSERS sequence. Server emits typed
// integer fields only — cic owns the human-readable rendering per
// `feedback_no_localized_strings_server_side`.
//
// Mount: pinned at the top of the CURRENT scrollback window (whichever
// window kind is active — channel, query, or $server) for (networkSlug),
// mirroring WhoisCard / WhowasCard. Short-circuits to null when no
// snapshot exists (#231).
//
// Lifecycle: ephemeral, last-write-wins per network. Auto-emitted on
// connect-welcome AND on operator-issued /lusers; the most recent
// snapshot replaces. Lost on page refresh — operator types /lusers
// to refresh.

type Props = {
  networkSlug: string;
};

const fmt = (n: number | null): string => (n === null ? "—" : n.toLocaleString());

const LusersCard: Component<Props> = (props) => {
  const snapshot = () => lusersBundleByNetwork()[props.networkSlug];

  return (
    <Show when={snapshot()} keyed>
      {(s) => (
        <div class="lusers-card" data-testid="lusers-card">
          <div class="lusers-card-header">
            <span class="lusers-card-title">network state</span>
            {/* P-0f — close affordance, mirror of WhoisCard / WhowasCard. */}
            <button
              type="button"
              class="lusers-card-close"
              aria-label="Dismiss LUSERS"
              onClick={() => dismissLusersCard(props.networkSlug)}
            >
              ×
            </button>
          </div>
          <dl class="lusers-card-fields">
            <Show when={s.total_users !== null || s.invisible !== null}>
              <dt>users</dt>
              <dd>
                {fmt(s.total_users)}
                <Show when={s.invisible !== null}>
                  {" "}
                  <span class="lusers-card-muted">({fmt(s.invisible)} invisible)</span>
                </Show>
              </dd>
            </Show>
            <Show when={s.operators !== null}>
              <dt>operators</dt>
              <dd>{fmt(s.operators)}</dd>
            </Show>
            <Show when={s.unknown_connections !== null && s.unknown_connections > 0}>
              <dt>unknown</dt>
              <dd>{fmt(s.unknown_connections)}</dd>
            </Show>
            <Show when={s.channels_formed !== null}>
              <dt>channels</dt>
              <dd>{fmt(s.channels_formed)}</dd>
            </Show>
            <Show when={s.servers !== null}>
              <dt>servers</dt>
              <dd>{fmt(s.servers)}</dd>
            </Show>
            <Show when={s.local_clients !== null || s.local_servers !== null}>
              <dt>this server</dt>
              <dd>
                {fmt(s.local_clients)} clients
                <Show when={s.local_servers !== null}>, {fmt(s.local_servers)} servers</Show>
              </dd>
            </Show>
            <Show when={s.current_local !== null || s.max_local !== null}>
              <dt>local users</dt>
              <dd>
                {fmt(s.current_local)}{" "}
                <span class="lusers-card-muted">(max {fmt(s.max_local)})</span>
              </dd>
            </Show>
            <Show when={s.current_global !== null || s.max_global !== null}>
              <dt>global users</dt>
              <dd>
                {fmt(s.current_global)}{" "}
                <span class="lusers-card-muted">(max {fmt(s.max_global)})</span>
              </dd>
            </Show>
          </dl>
        </div>
      )}
    </Show>
  );
};

export default LusersCard;
