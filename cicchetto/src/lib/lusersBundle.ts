import { createSignal } from "solid-js";
import { identityScopedStore } from "./identityScopedStore";

// P-0d — LUSERS card store. Holds at most one snapshot per network
// slug. Populated by the `lusers_bundle` push event on the user-level
// Phoenix Channel topic (sent by Session.Server's apply_effects arm
// when 266 RPL_GLOBALUSERS arrives — flushing Bahamut's 7-numeric
// LUSERS sequence).
//
// Ephemeral — NOT persisted, NOT cached in localStorage. The bundle
// lives in this signal until dismissed or the next SOLICITED /lusers
// replaces it. Operator types /lusers to refresh; lost on page
// refresh. Identity-scoped: cleared on logout / token rotation.
//
// One snapshot per network is enough — LUSERS is network state, not
// per-channel state. The card renders pinned at the top of the current
// scrollback window (mirrors WhoisCard/WhowasCard) — #231.
//
// #248 — SOLICITED-REQUEST GATE. Bahamut auto-emits the LUSERS
// 7-numeric sequence at registration (connect-welcome). grappa NEVER
// self-issues LUSERS, so it forwards that unsolicited burst as the SAME
// `lusers_bundle` wire event an operator-issued /lusers produces.
// Pre-#248 the dispatch stored EVERY bundle → the LusersCard
// auto-surfaced on connect, floating over the top of the message view;
// new users read the covered buffer as "my sent messages aren't
// showing" (reported P0). The store now surfaces a bundle ONLY when the
// operator solicited it:
//   - markLusersRequested(slug) — /lusers issued (compose.ts).
//   - applyLusersBundle(slug, snap) — incoming bundle; surfaces ONLY
//     when a request is pending (consume-once), else dropped silently.
// Because grappa never self-issues LUSERS, every solicited bundle is
// preceded by a request and the connect-welcome burst never is.

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

  // #248 — per-network solicited-request flags. Non-reactive (control
  // state, never rendered): a slug is added on /lusers and consumed by
  // the next matching bundle. Cleared on identity rotation alongside the
  // snapshot store so a stale flag can't surface a bundle post-relogin.
  const solicited = new Set<string>();

  onIdentityChange(() => {
    setLusersBundleByNetwork({});
    solicited.clear();
  });

  // #248 — operator issued /lusers for (networkSlug). The NEXT
  // `lusers_bundle` for this network surfaces its card; consume-once.
  const markLusersRequested = (networkSlug: string): void => {
    solicited.add(networkSlug);
  };

  // #248 — apply an incoming `lusers_bundle`, gated on the solicited
  // flag. Solicited → store the snapshot (surfaces the card) and consume
  // the flag (Set.delete returns true iff the slug was present).
  // Unsolicited (the Bahamut connect-welcome auto-emit) → drop silently:
  // the operator lands on the normal message view, not a covering card.
  const applyLusersBundle = (networkSlug: string, snapshot: LusersSnapshot): void => {
    if (!solicited.delete(networkSlug)) return;
    setLusersBundleByNetwork((prev) => ({ ...prev, [networkSlug]: snapshot }));
  };

  // P-0f — close affordance. Mirror of `dismissWhoisCard` /
  // `dismissWhowasCard`. The next SOLICITED /lusers re-populates the
  // snapshot; dismiss is just a local "I'm done looking" action.
  const dismissLusersCard = (networkSlug: string): void => {
    setLusersBundleByNetwork((prev) => {
      const next = { ...prev };
      delete next[networkSlug];
      return next;
    });
  };

  return { lusersBundleByNetwork, markLusersRequested, applyLusersBundle, dismissLusersCard };
});

export const lusersBundleByNetwork = exports_.lusersBundleByNetwork;
export const markLusersRequested = exports_.markLusersRequested;
export const applyLusersBundle = exports_.applyLusersBundle;
export const dismissLusersCard = exports_.dismissLusersCard;
