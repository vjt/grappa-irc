import { createRoot, createSignal } from "solid-js";

// #216 — /mode viewer/editor modal open/close store.
//
// Holds the target the modal is open for — `{networkSlug, channel}` —
// or `null` when closed. Three entry points set it: `/mode #chan`
// (explicit) and bare `/mode` (current channel) via compose.ts, and a
// tap on the `.topic-bar-modes` indicator via TopicBar. ModeModal.tsx
// reads `modeModalState()` to decide whether (and for which channel) to
// render, pulling the current modes from `modesByChannel` and the
// available toggles from `isupportForNetwork`.
//
// Module-singleton signal (like TopicBar's own topic-modal state) — the
// modal is transient UI, not identity-scoped survival state. A logout
// unmounts the shell so a stale-open modal disappears with it.

export type ModeModalTarget = { networkSlug: string; channel: string };

const exports_ = createRoot(() => {
  const [modeModalState, setModeModalState] = createSignal<ModeModalTarget | null>(null);

  const openModeModal = (networkSlug: string, channel: string): void => {
    setModeModalState({ networkSlug, channel });
  };

  const closeModeModal = (): void => {
    setModeModalState(null);
  };

  return { modeModalState, openModeModal, closeModeModal };
});

export const modeModalState = exports_.modeModalState;
export const openModeModal = exports_.openModeModal;
export const closeModeModal = exports_.closeModeModal;
