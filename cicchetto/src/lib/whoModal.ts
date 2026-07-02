import { createSignal } from "solid-js";
import type { WhoReply } from "./api";
import { identityScopedStore } from "./identityScopedStore";

// #169 — /who modal store. Holds at most one roster per network slug.
// Populated by the `who_reply` push event on the user-level Phoenix Channel
// topic (sent by Session.Server's apply_effects arm when 315 RPL_ENDOFWHO
// drains a pending /who request).
//
// Ephemeral — NOT persisted in scrollback (the pre-#169 N+1 :notice dump is
// gone). The roster lives in this signal until replaced by the next /who on
// the same network OR explicitly dismissed (close button, Esc, backdrop, or
// clicking a nick to open a query). Identity-scoped: cleared on logout /
// token rotation.
//
// One roster per network is enough for the irssi-like UX — the operator
// issues /who, sees the modal, dismisses or clicks through. Running /who
// twice on the same network replaces in-place (last-write-wins). Mirrors
// namesModal.ts exactly; the only difference is the render surface (a
// per-user table vs the sigil-grouped names roster).

const exports_ = identityScopedStore((onIdentityChange) => {
  const [whoModalBySlug, setWhoModalBySlug] = createSignal<Record<string, WhoReply>>({});

  onIdentityChange(() => setWhoModalBySlug({}));

  const setWhoReply = (networkSlug: string, reply: WhoReply): void => {
    setWhoModalBySlug((prev) => ({ ...prev, [networkSlug]: reply }));
  };

  const dismissWhoModal = (networkSlug: string): void => {
    setWhoModalBySlug((prev) => {
      const next = { ...prev };
      delete next[networkSlug];
      return next;
    });
  };

  return { whoModalBySlug, setWhoReply, dismissWhoModal };
});

export const whoModalBySlug = exports_.whoModalBySlug;
export const setWhoReply = exports_.setWhoReply;
export const dismissWhoModal = exports_.dismissWhoModal;
