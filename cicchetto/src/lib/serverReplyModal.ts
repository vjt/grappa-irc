import { createSignal } from "solid-js";
import type { ServerReply } from "./api";
import { identityScopedStore } from "./identityScopedStore";

// #127 — /info, /version, /motd modal store. Holds at most one server-text
// reply per network slug. Populated by the `server_reply` push event on the
// user-level Phoenix Channel topic (sent by Session.Server's apply_effects
// arm when the reply burst drains: 374 RPL_ENDOFINFO / 351 RPL_VERSION /
// 376 RPL_ENDOFMOTD|422 ERR_NOMOTD).
//
// Ephemeral — NOT persisted in scrollback. The reply lives in this signal
// until replaced by the next /info|/version|/motd on the same network OR
// explicitly dismissed (close button, Esc, backdrop). Identity-scoped:
// cleared on logout / token rotation.
//
// One reply per network, last-write-wins: a `source` discriminant (info /
// version / motd) rides inside the payload, so running /version after /info
// swaps the modal content in-place. One reusable modal surface for all three
// server-text queries — mirrors whoModal.ts (the difference is the render
// surface, ServerReplyModal renders a scrollable line list + retro chrome).

const exports_ = identityScopedStore((onIdentityChange) => {
  const [serverReplyBySlug, setServerReplyBySlug] = createSignal<Record<string, ServerReply>>({});

  onIdentityChange(() => setServerReplyBySlug({}));

  const setServerReply = (networkSlug: string, reply: ServerReply): void => {
    setServerReplyBySlug((prev) => ({ ...prev, [networkSlug]: reply }));
  };

  const dismissServerReplyModal = (networkSlug: string): void => {
    setServerReplyBySlug((prev) => {
      const next = { ...prev };
      delete next[networkSlug];
      return next;
    });
  };

  return { serverReplyBySlug, setServerReply, dismissServerReplyModal };
});

export const serverReplyBySlug = exports_.serverReplyBySlug;
export const setServerReply = exports_.setServerReply;
export const dismissServerReplyModal = exports_.dismissServerReplyModal;
