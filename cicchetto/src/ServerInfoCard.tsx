import { type Component, Show } from "solid-js";
import type { Network } from "./lib/api";
import { connectionStateEmoji } from "./lib/connectionStateEmoji";
import { formatDurationSince } from "./lib/duration";
import { MircBody } from "./MircText";

// #474 — the per-network "server info" card that fills the right rail on a
// SERVER window. Pure presentational: it renders ONLY facts already in the
// store (the `Network` resource), passed in by the RailContext container
// along with an injected `now` (epoch ms) so the uptime is deterministic +
// testable and the container owns the ~60s ticker.
//
// Facts-only, sourced from existing session/network state:
//   * slug   — the network label (there is no separate human name)
//   * status — DB-canonical connection_state glyph + word + reason
//   * uptime — how long the LIVE link has been up (#897), read from the
//              `connection` sub-object below, so it is absent exactly when
//              there is no live socket to measure
//   * nick   — own IRC nick on this network
//   * services — which NickServ software (omitted when "unknown")
//
// Scope B — the live upstream connection facts under `network.connection`
// (the additive #447 wire field resolved from Session.connection_info/2):
//   * server — which box the socket dialled (`server:port`), the resolved
//              peer IP, so a round-robin landing is visible (#550 capture)
//   * tls    — a 🔒 lock when the transport is TLS
//   * identified — yes/no, from the +r umode (the #561 identity signal)
//   * connected_at — the instant this socket came up, the uptime anchor (#897)
// `connection` is null whenever there is no live connected session, so
// these rows appear ONLY on a real socket — honesty over a stale value.
//
// No close button: unlike the ephemeral scrollback cards (whois/whowas/
// lusers), this is the rail's persistent per-kind context surface — it is
// present for as long as the server window is focused.

type Props = {
  network: Network;
  /** Epoch ms, injected by the container (ticked ~60s) so the rendered
      uptime stays fresh AND is deterministic under test. */
  now: number;
};

const ServerInfoCard: Component<Props> = (props) => {
  const state = () => connectionStateEmoji(props.network.connection_state);
  // #897 — how long THIS link has been up, from the live `connection`
  // sub-object. Never `connection_state_changed_at`: that is the credential
  // ROW's last state transition, and a bouncer restart leaves the row at
  // `connected` without writing it, so it kept counting across restarts
  // (Mezmerize saw "connected 10d 9h" on a box he power-cycled daily).
  // Sourcing it from `connection` also makes the honest silence automatic:
  // no live pid ⇒ no `connection` ⇒ no duration, rather than a number
  // computed from a DB column that outlived the socket.
  // `?? null` because cic and the server deploy independently — a server
  // that predates the field sends `connection` without it.
  const uptime = () =>
    formatDurationSince(props.network.connection?.connected_at ?? null, props.now);
  const services = () => {
    const flavor = props.network.services_flavor;
    return flavor && flavor !== "unknown" ? flavor : null;
  };

  return (
    <div class="rail-server-info selectable-text" data-testid="rail-server-info">
      <div class="rail-server-info-header">
        <span class="rail-server-info-title">{props.network.slug}</span>
      </div>
      <dl class="rail-server-info-fields">
        <dt>status</dt>
        <dd>
          <span
            class="rail-server-info-glyph"
            role="img"
            title={state().label}
            aria-label={state().label}
          >
            {state().glyph}
          </span>{" "}
          {state().label}
          <Show when={props.network.connection_state_reason}>
            {(reason) => (
              <>
                {" — "}
                <MircBody body={reason()} />
              </>
            )}
          </Show>
        </dd>
        <Show when={uptime()}>
          {(up) => (
            <>
              <dt>connected</dt>
              <dd>{up()}</dd>
            </>
          )}
        </Show>
        <Show when={props.network.connection}>
          {(conn) => (
            <>
              <dt>server</dt>
              <dd>
                {conn().server}:{conn().port}
                <Show when={conn().tls}>
                  {" "}
                  <span class="rail-server-info-tls" role="img" title="TLS" aria-label="TLS">
                    🔒
                  </span>
                </Show>
              </dd>
              <dt>identified</dt>
              <dd data-testid="rail-server-info-identified">{conn().registered ? "yes" : "no"}</dd>
            </>
          )}
        </Show>
        <dt>nick</dt>
        <dd>{props.network.nick}</dd>
        <Show when={services()}>
          {(flavor) => (
            <>
              <dt>services</dt>
              <dd>{flavor()}</dd>
            </>
          )}
        </Show>
      </dl>
    </div>
  );
};

export default ServerInfoCard;
