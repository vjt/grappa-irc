// Global keybindings: one window keydown listener dispatching to a
// handler interface. Vanilla — no third-party library; the binding
// surface (Alt+1..9, Ctrl+N/P, Esc, Tab, Shift+Tab, irssi-style
// auto-focus) is too small to justify a dep + bundle weight.
//
// Two-stage init:
//   1. registerHandlers(...) — consumers (Shell.tsx) wire their action
//      callbacks
//   2. install() — attaches the window listener; called from main.tsx
//      after registerHandlers
//
// uninstall() removes the listener; used by tests + (in principle)
// for future hot-reload scenarios. Module-singleton pattern: one
// listener globally, never duplicated.
//
// #232 — this single window listener is ALSO the sole ESC authority. On Esc
// it first asks the overlay ESC stack to close the frontmost modal
// (`runTopmostOverlayEscape`); only if no modal is open does it fall back to
// closing an open drawer. One listener, ordered topmost-first — never a
// second global keydown listener racing this one.

import { runTopmostOverlayEscape } from "./overlayScrollLock";

export type KeybindingHandlers = {
  selectChannelByIndex: (idx: number) => void; // Alt+1..9 → idx 0..8
  selectStatusWindow: () => void; // Alt+0
  nextUnread: () => void; // Ctrl+N
  prevUnread: () => void; // Ctrl+P
  insertIntoCompose: (char: string) => void; // any printable key off-compose
  closeDrawer: () => void; // Esc
  cycleNickComplete: (forward: boolean) => void; // Tab (true) / Shift+Tab (false)
};

let handlers: KeybindingHandlers | null = null;
let installedListener: ((e: KeyboardEvent) => void) | null = null;

export function registerHandlers(h: KeybindingHandlers): void {
  handlers = h;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || target.isContentEditable;
}

// #409 — the compose box is the ONLY surface where Tab nick-completes. It
// carries the `data-compose-input` marker (ComposeBox.tsx) — the same stable
// hook lib/globalPaste uses to find the one mounted compose surface. Keying
// the Tab handler off this marker (not off `isTypingTarget`, which matches ANY
// input/textarea/contenteditable) restores native Tab focus traversal in every
// OTHER form (alias settings, admin, login) while compose still completes.
function isComposeInput(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.hasAttribute("data-compose-input");
}

function onKeydown(e: KeyboardEvent): void {
  if (handlers === null) return;

  // Tab cycle: only fire when the target is the compose box itself (#409),
  // NOT any typing surface — so every other form keeps native Tab focus
  // traversal (the alias settings name→expansion move that surfaced this).
  if (e.key === "Tab" && isComposeInput(e.target)) {
    e.preventDefault();
    handlers.cycleNickComplete(!e.shiftKey);
    return;
  }

  // Esc: close the frontmost open modal first (ordered overlay stack), else
  // fall back to closing an open drawer. Topmost-first precedence — a modal
  // opened from the settings drawer closes on the first Esc, the drawer on a
  // second. Never preventDefault (Esc has no default worth suppressing here).
  if (e.key === "Escape") {
    if (runTopmostOverlayEscape()) return;
    handlers.closeDrawer();
    return;
  }

  if (e.altKey && /^[1-9]$/.test(e.key)) {
    e.preventDefault();
    handlers.selectChannelByIndex(Number(e.key) - 1);
    return;
  }

  // GH #359 — Alt+0 jumps to the status/server window (irssi's window 0).
  // A verb of its own, NOT index 0 of the chord above: that index space is
  // channels/queries only, the status window is outside it. Matched on
  // `e.code` for the same reason as the Alt+A chord below — a macOS
  // Option+digit composes `e.key` (US layout: Option+0 → "º"), so a
  // key-based match would miss the chord there.
  if (e.altKey && e.code === "Digit0") {
    e.preventDefault();
    handlers.selectStatusWindow();
    return;
  }

  if (e.ctrlKey && e.key.toLowerCase() === "n") {
    e.preventDefault();
    handlers.nextUnread();
    return;
  }

  if (e.ctrlKey && e.key.toLowerCase() === "p") {
    e.preventDefault();
    handlers.prevUnread();
    return;
  }

  // GH #235 — Alt+A jumps to the next window with unread activity
  // (irssi muscle memory). Dispatches the SAME `nextUnread` verb as
  // Ctrl+N + the on-screen affordance button — one ordering, one code
  // path. Matched on `e.code` (physical KeyA), NOT `e.key`: on macOS
  // Option+A emits the composed char "å", so `e.key` would miss the
  // chord. Fires regardless of the focus target, consistent with the
  // sibling Alt+1..9 navigation chords above.
  if (e.altKey && e.code === "KeyA") {
    e.preventDefault();
    handlers.nextUnread();
    return;
  }

  // irssi-shaped auto-focus: any printable key with no modifiers, fired
  // anywhere except a typing surface, redirects into the compose box.
  // `key.length === 1` filters out named keys (Tab, Escape, Arrow*,
  // F1..) which all have multi-char `key` values; printable chars
  // (letters, digits, punctuation, whitespace) are length 1.
  if (
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !e.isComposing &&
    e.key.length === 1 &&
    !isTypingTarget(e.target)
  ) {
    e.preventDefault();
    handlers.insertIntoCompose(e.key);
    return;
  }
}

export function install(): void {
  if (installedListener !== null) return; // idempotent
  installedListener = onKeydown;
  window.addEventListener("keydown", installedListener);
}

export function uninstall(): void {
  if (installedListener === null) return;
  window.removeEventListener("keydown", installedListener);
  installedListener = null;
  // Drop the handler reference so a stale Shell closure can't survive
  // the unmount. Shell remounts (test setup/teardown, hot-reload) must
  // re-register; production has only one Shell mount per page so the
  // null reset is a hygiene guard.
  handlers = null;
}
