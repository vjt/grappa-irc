import { createEffect, createRoot, createSignal, on } from "solid-js";
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
//
// Codebase review 2026-05-08 cic H1: cleanup arm MUST be wrapped in
// `createEffect(on(token, …))`. Pre-fix the bare `on(...)` combinator
// was never registered with the reactive system, so rotation cleanup
// never fired — tenant data leaked across logout. Mirrors the
// scrollback.ts / members.ts / selection.ts pattern.

const exports_ = createRoot(() => {
  const [awayByNetwork, setAwayByNetwork] = createSignal<Record<string, boolean>>({});

  // Clear on identity change (logout or token rotation).
  createEffect(
    on(token, (t, prev) => {
      if (prev != null && t !== prev) setAwayByNetwork({});
    }),
  );

  const setAwayState = (networkSlug: string, isAway: boolean): void => {
    setAwayByNetwork((prev) => ({ ...prev, [networkSlug]: isAway }));
  };

  return { awayByNetwork, setAwayState };
});

export const awayByNetwork = exports_.awayByNetwork;
export const setAwayState = exports_.setAwayState;
