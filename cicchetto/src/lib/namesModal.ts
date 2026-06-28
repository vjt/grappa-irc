import { createSignal } from "solid-js";
import type { NamesReply } from "./api";
import { identityScopedStore } from "./identityScopedStore";

// #140 — /names modal store. Holds at most one roster per network slug.
// Populated by the `names_reply` push event on the user-level Phoenix
// Channel topic (sent by Session.Server's apply_effects arm when 366
// RPL_ENDOFNAMES drains a pending /names request).
//
// Ephemeral — NOT persisted in scrollback (consistent with whois #133 +
// /list #84). The roster lives in this signal until replaced by the next
// /names on the same network OR explicitly dismissed (close button, Esc,
// backdrop, or clicking a nick to open a query). Identity-scoped: cleared
// on logout / token rotation.
//
// One roster per network is enough for the irssi-like UX — the operator
// issues /names, sees the modal, dismisses or clicks through. Running
// /names twice on the same network replaces in-place (last-write-wins).
// Mirrors whoisCard.ts exactly; the only difference is the render surface
// (a centered, scrollable, grouped modal vs the top-pinned whois card).

const exports_ = identityScopedStore((onIdentityChange) => {
  const [namesModalBySlug, setNamesModalBySlug] = createSignal<Record<string, NamesReply>>({});

  onIdentityChange(() => setNamesModalBySlug({}));

  const setNamesReply = (networkSlug: string, reply: NamesReply): void => {
    setNamesModalBySlug((prev) => ({ ...prev, [networkSlug]: reply }));
  };

  const dismissNamesModal = (networkSlug: string): void => {
    setNamesModalBySlug((prev) => {
      const next = { ...prev };
      delete next[networkSlug];
      return next;
    });
  };

  return { namesModalBySlug, setNamesReply, dismissNamesModal };
});

export const namesModalBySlug = exports_.namesModalBySlug;
export const setNamesReply = exports_.setNamesReply;
export const dismissNamesModal = exports_.dismissNamesModal;
