import { createSignal } from "solid-js";
import { moduleRoot } from "./moduleRoot";

// #386 — ban-management modal open/close store.
//
// Holds the target the modal is open for — `{networkSlug, channel}` — or
// `null` when closed. Opened by `/banlist` (compose.ts) — which ALSO fires a
// fresh `pushChannelBanlist` re-query so the list reflects the live 367/368
// state on open (the pre-#386 `/banlist` was fire-and-forget; the modal is the
// re-queryable surface that supersedes the #376 inline BanlistCard, mirroring
// how the #169 /who modal replaced the inline WHO dump).
//
// BanlistModal.tsx reads `banlistModalState()` to decide whether (and for
// which channel) to render, pulling the current ban rows from the
// `banlistCard` store (the `banlist_bundle` push, #376) and the op-gate hint
// from `ownHoldsChannelEditorSigil`.
//
// Module-singleton signal (like ModeModal's state) — transient UI, not
// identity-scoped survival state. A logout unmounts the shell so a stale-open
// modal disappears with it.

// #1251 — `mode` is the type-A letter the modal is showing (`b` bans, `e`
// exempts, `I` invex, `z`/`q` restrict/quiet). It lives in the OPEN state
// rather than in the modal component so the switcher, `/banlist e` and
// `/mode #chan +e` all drive the same one source of truth.
export type BanlistModalTarget = { networkSlug: string; channel: string; mode: string };

const exports_ = moduleRoot(() => {
  const [banlistModalState, setBanlistModalState] = createSignal<BanlistModalTarget | null>(null);

  const openBanlistModal = (networkSlug: string, channel: string, mode: string): void => {
    setBanlistModalState({ networkSlug, channel, mode });
  };

  const closeBanlistModal = (): void => {
    setBanlistModalState(null);
  };

  return { banlistModalState, openBanlistModal, closeBanlistModal };
});

export const banlistModalState = exports_.banlistModalState;
export const openBanlistModal = exports_.openBanlistModal;
export const closeBanlistModal = exports_.closeBanlistModal;
