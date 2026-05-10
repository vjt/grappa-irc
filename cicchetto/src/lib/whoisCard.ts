import { createSignal } from "solid-js";
import type { WhoisBundle } from "./api";
import { identityScopedStore } from "./identityScopedStore";

// C2 — WHOIS card store. Holds at most one bundle per network slug.
// Populated by the `whois_bundle` push event on the user-level Phoenix
// Channel topic (sent by Session.Server's apply_effects arm when 318
// RPL_ENDOFWHOIS arrives).
//
// Per spec #2: ephemeral — NOT persisted in scrollback. The bundle
// lives in this signal until replaced by the next /whois on the same
// network OR explicitly dismissed by the user (close button on the
// rendered card). Identity-scoped: cleared on logout / token rotation.
//
// One card per network is enough for the irssi-like UX — the user
// issues /whois, sees the result, dismisses or runs another /whois.
// The card replaces in-place; running /whois twice on the same network
// drops the first bundle silently.

const exports_ = identityScopedStore((onIdentityChange) => {
  const [whoisCardBySlug, setWhoisCardBySlug] = createSignal<Record<string, WhoisBundle>>({});

  onIdentityChange(() => setWhoisCardBySlug({}));

  const setWhoisBundle = (networkSlug: string, bundle: WhoisBundle): void => {
    setWhoisCardBySlug((prev) => ({ ...prev, [networkSlug]: bundle }));
  };

  const dismissWhoisCard = (networkSlug: string): void => {
    setWhoisCardBySlug((prev) => {
      const next = { ...prev };
      delete next[networkSlug];
      return next;
    });
  };

  return { whoisCardBySlug, setWhoisBundle, dismissWhoisCard };
});

export const whoisCardBySlug = exports_.whoisCardBySlug;
export const setWhoisBundle = exports_.setWhoisBundle;
export const dismissWhoisCard = exports_.dismissWhoisCard;
