import { createRoot, createSignal } from "solid-js";

// #229 — /mode <nick> (umode) viewer/editor modal open/close store.
//
// Holds the network the modal is open for — `{networkSlug}` — or `null`
// when closed. Two entry points set it: `/mode <ownnick>` / `/umode` via
// compose.ts, and a tap on the umode indicator in the sidebar/bottom-bar.
// UmodeModal.tsx reads `umodeModalState()` to decide whether (and for which
// network) to render, pulling the active umodes from `umodesForNetwork` and
// the available toggles from the static `umodeModes` table.
//
// Sibling of `modeModal.ts` (#216's channel-mode modal): umodes are
// per (subject, network), so the target carries only a network slug — no
// channel. A distinct store (not a param'd ModeModal) because the data
// sources fork completely: no ISUPPORT toggle set, no channel, no edit-gate
// (you always edit your own umodes), no params. Reuse the verb (the modal
// machine + overlay-lock pattern), not the noun (CLAUDE.md
// design-discipline #6).
//
// Module-singleton signal (like modeModal's) — transient UI, not
// identity-scoped survival state. A logout unmounts the shell so a
// stale-open modal disappears with it.

export type UmodeModalTarget = { networkSlug: string };

const exports_ = createRoot(() => {
  const [umodeModalState, setUmodeModalState] = createSignal<UmodeModalTarget | null>(null);

  const openUmodeModal = (networkSlug: string): void => {
    setUmodeModalState({ networkSlug });
  };

  const closeUmodeModal = (): void => {
    setUmodeModalState(null);
  };

  return { umodeModalState, openUmodeModal, closeUmodeModal };
});

export const umodeModalState = exports_.umodeModalState;
export const openUmodeModal = exports_.openUmodeModal;
export const closeUmodeModal = exports_.closeUmodeModal;
