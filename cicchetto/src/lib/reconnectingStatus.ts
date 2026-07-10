import { createSignal } from "solid-js";
import { identityScopedStore } from "./identityScopedStore";

// #100 — per-network transient reconnect indicator. Reactive signal keyed
// by network slug, populated by the `connection_progress` push event on the
// user-level Phoenix Channel topic (emitted by Session.Server as it
// (re)establishes the upstream socket: "connecting" on a client-start
// attempt, "connected" on 001 RPL_WELCOME).
//
// `reconnectingByNetwork()[slug] === true` means a (re)connect is in flight
// on that network → the sidebar shows a "reconnecting…" badge. `false` or a
// missing key means connected/idle.
//
// PRESENTATIONAL ONLY. This is deliberately NOT the durable per-network
// `connection_state` (`connected | parked | failed`) carried on the
// networks store — that stays `connected` through a transient reconnect (a
// crashed-then-respawning session is not an operator-intent state change).
// The badge is an ephemeral overlay the server drives; cic never originates
// it (mirrors the windowState invariant — server change first, cic mirrors).
// Modelled on `awayStatus.ts`.
//
// Identity-scoped: on logout / token rotation the registered reset clears
// all reconnect state so a stale badge never survives a subject switch.

const exports_ = identityScopedStore((onIdentityChange) => {
  const [reconnectingByNetwork, setReconnectingByNetwork] = createSignal<
    Record<string, boolean>
  >({});

  onIdentityChange(() => setReconnectingByNetwork({}));

  const setReconnecting = (networkSlug: string, isReconnecting: boolean): void => {
    setReconnectingByNetwork((prev) => ({ ...prev, [networkSlug]: isReconnecting }));
  };

  return { reconnectingByNetwork, setReconnecting };
});

export const reconnectingByNetwork = exports_.reconnectingByNetwork;
export const setReconnecting = exports_.setReconnecting;
