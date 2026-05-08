import { createSignal } from "solid-js";
import { identityScopedStore } from "./identityScopedStore";

// Per-network away state store. Reactive signal keyed by network slug.
// Populated by the `away_confirmed` push event on the user-level Phoenix
// Channel topic (sent by Session.Server.apply_effects/2 on both explicit
// and auto-away set/cancel paths).
//
// `awayByNetwork()[slug] === true` means the user is currently away on
// that network. `false` or missing key means present.
//
// Identity-scoped: on logout / token rotation, the registered reset via
// `identityScopedStore` clears all away state (dup-A3 close).

const exports_ = identityScopedStore((onIdentityChange) => {
  const [awayByNetwork, setAwayByNetwork] = createSignal<Record<string, boolean>>({});

  onIdentityChange(() => setAwayByNetwork({}));

  const setAwayState = (networkSlug: string, isAway: boolean): void => {
    setAwayByNetwork((prev) => ({ ...prev, [networkSlug]: isAway }));
  };

  return { awayByNetwork, setAwayState };
});

export const awayByNetwork = exports_.awayByNetwork;
export const setAwayState = exports_.setAwayState;
