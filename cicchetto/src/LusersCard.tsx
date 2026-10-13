import { type Component, Show } from "solid-js";
import { dismissLusersCard, lusersBundleByNetwork } from "./lib/lusersBundle";
import { createOverlayEscape } from "./lib/overlayScrollLock";

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
// Lifecycle: ephemeral, per network. Surfaced ONLY by an operator
// /lusers (#248 solicited gate in lusersBundle.ts) — the Bahamut
// connect-welcome auto-emit is dropped, so this card never covers the
// message view on connect. Each solicited /lusers replaces the snapshot
// (last-solicited-write-wins). Lost on page refresh — operator types
// /lusers to refresh.

type Props = {
  networkSlug: string;
};

const fmt = (n: number | null): string => (n === null ? "—" : n.toLocaleString());

const LusersCard: Component<Props> = (props) => {
  const snapshot = () => lusersBundleByNetwork()[props.networkSlug];
  // #1199 — Escape dismisses through the shared ordered ESC stack (the same
  // door every modal uses), invoking the SAME verb the × does, so a modal
  // opened over the card still closes first. No COVERING refcount: the card
  // sits IN the scrollback flow, not over it, so the pane behind must not
  // freeze. #1772 — the iOS touch lock is not part of what that gives up.
  createOverlayEscape(
    () => snapshot() !== undefined,
    () => dismissLusersCard(props.networkSlug),
  );

  return (
    <Show when={snapshot()} keyed>
      {(s) => (
        <div class="lusers-card selectable-text" data-testid="lusers-card">
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
              {/* #579 — the one per-SERVER field on the card (RPL_LUSERME's
                  m_client / m_server), so it is what changes when the two-token
                  `/lusers <mask> <server>` form routes the query elsewhere. The
                  e2e reads it by testid rather than by dt/dd adjacency. */}
              <dd data-testid="lusers-card-this-server">
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
