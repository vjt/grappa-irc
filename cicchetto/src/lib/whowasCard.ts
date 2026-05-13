import { createSignal } from "solid-js";
import type { WhowasBundle } from "./api";
import { identityScopedStore } from "./identityScopedStore";

// P-0c — WHOWAS card store. Holds at most one bundle per network slug.
// Populated by the `whowas_bundle` push event on the user-level
// Phoenix Channel topic (sent by Session.Server's apply_effects arm
// when 369 RPL_ENDOFWHOWAS arrives, or with `not_found: true` on 406
// ERR_WASNOSUCHNICK).
//
// Per spec #2: ephemeral — NOT persisted in scrollback. The bundle
// lives in this signal until replaced by the next /whowas on the same
// network OR explicitly dismissed by the user (close button on the
// rendered card). Identity-scoped: cleared on logout / token rotation.
//
// Mirror shape of `whoisCard.ts`. Single-entity historical-user data
// fits the card model (per `feedback_card_vs_scrollback_ux`); the
// most-recent historical entry is projected into the bundle's
// user/host/realname/server/logoff_time fields by the server. The
// `not_found` boolean discriminates the 406 case so cic renders one
// surface — "no history" — instead of two arms.

const exports_ = identityScopedStore((onIdentityChange) => {
  const [whowasCardBySlug, setWhowasCardBySlug] = createSignal<Record<string, WhowasBundle>>({});

  onIdentityChange(() => setWhowasCardBySlug({}));

  const setWhowasBundle = (networkSlug: string, bundle: WhowasBundle): void => {
    setWhowasCardBySlug((prev) => ({ ...prev, [networkSlug]: bundle }));
  };

  const dismissWhowasCard = (networkSlug: string): void => {
    setWhowasCardBySlug((prev) => {
      const next = { ...prev };
      delete next[networkSlug];
      return next;
    });
  };

  return { whowasCardBySlug, setWhowasBundle, dismissWhowasCard };
});

export const whowasCardBySlug = exports_.whowasCardBySlug;
export const setWhowasBundle = exports_.setWhowasBundle;
export const dismissWhowasCard = exports_.dismissWhowasCard;
