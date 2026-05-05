import { createRoot, createSignal, on } from "solid-js";
import { token } from "./auth";

// Per-network away state store. Reactive signal keyed by network slug.
// Populated by the `away_confirmed` push event on the user-level Phoenix
// Channel topic (sent by Session.Server.apply_effects/2 on both explicit
// and auto-away set/cancel paths).
//
// `awayByNetwork()[slug] === true` means the user is currently away on
// that network. `false` or missing key means present.
//
// Identity-scoped: on logout / token rotation, all away state is cleared.

const exports_ = createRoot(() => {
  const [awayByNetwork, setAwayByNetwork] = createSignal<Record<string, boolean>>({});

  // Clear on identity change (logout or token rotation).
  on(token, (t, prev) => {
    if (prev != null && t !== prev) setAwayByNetwork({});
  });

  const setAwayState = (networkSlug: string, isAway: boolean): void => {
    setAwayByNetwork((prev) => ({ ...prev, [networkSlug]: isAway }));
  };

  return { awayByNetwork, setAwayState };
});

export const awayByNetwork = exports_.awayByNetwork;
export const setAwayState = exports_.setAwayState;
