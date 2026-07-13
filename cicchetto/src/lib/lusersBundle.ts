import { createSignal } from "solid-js";
import { identityScopedStore } from "./identityScopedStore";

// P-0d — LUSERS card store. Holds at most one snapshot per network
// slug. Populated by the `lusers_bundle` push event on the user-level
// Phoenix Channel topic (sent by Session.Server's apply_effects arm
// when 266 RPL_GLOBALUSERS arrives — flushing Bahamut's 7-numeric
// LUSERS sequence).
//
// Ephemeral — NOT persisted, NOT cached in localStorage. The bundle
// lives in this signal until the next /lusers (operator-issued OR
// connect-welcome auto-emit) replaces it. Operator types /lusers to
// refresh; lost on page refresh. Identity-scoped: cleared on logout /
// token rotation.
//
// One snapshot per network is enough — LUSERS is network state, not
// per-channel state. The card renders pinned at the top of the current
// scrollback window (mirrors WhoisCard/WhowasCard) — #231.

export type LusersSnapshot = {
  total_users: number | null;
  invisible: number | null;
  servers: number | null;
  operators: number | null;
  unknown_connections: number | null;
  channels_formed: number | null;
  local_clients: number | null;
  local_servers: number | null;
  current_local: number | null;
  max_local: number | null;
  current_global: number | null;
  max_global: number | null;
};

const exports_ = identityScopedStore((onIdentityChange) => {
  const [lusersBundleByNetwork, setLusersBundleByNetwork] = createSignal<
    Record<string, LusersSnapshot>
  >({});

  onIdentityChange(() => setLusersBundleByNetwork({}));

  const setLusersBundle = (networkSlug: string, snapshot: LusersSnapshot): void => {
    setLusersBundleByNetwork((prev) => ({ ...prev, [networkSlug]: snapshot }));
  };

  // P-0f — close affordance. Mirror of `dismissWhoisCard` /
  // `dismissWhowasCard`. The next /lusers (operator-issued OR connect-
  // welcome auto-emit) re-populates the snapshot; dismiss is just a
  // local "I'm done looking" action.
  const dismissLusersCard = (networkSlug: string): void => {
    setLusersBundleByNetwork((prev) => {
      const next = { ...prev };
      delete next[networkSlug];
      return next;
    });
  };

  return { lusersBundleByNetwork, setLusersBundle, dismissLusersCard };
});

export const lusersBundleByNetwork = exports_.lusersBundleByNetwork;
export const setLusersBundle = exports_.setLusersBundle;
export const dismissLusersCard = exports_.dismissLusersCard;
