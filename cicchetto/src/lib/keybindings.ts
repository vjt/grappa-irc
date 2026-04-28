// Global keybindings: one window keydown listener dispatching to a
// handler interface. Vanilla — no third-party library; the binding
// surface (Alt+1..9, Ctrl+N/P, /, Esc, Tab, Shift+Tab) is too small
// to justify a dep + bundle weight.
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

export type KeybindingHandlers = {
  selectChannelByIndex: (idx: number) => void; // Alt+1..9 → idx 0..8
  nextUnread: () => void; // Ctrl+N
  prevUnread: () => void; // Ctrl+P
  focusCompose: () => void; // /
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

function onKeydown(e: KeyboardEvent): void {
  if (handlers === null) return;

  // Tab cycle: only fire when the target is a typing surface (compose
  // box). Lets the rest of the page receive native Tab focus traversal.
  if (e.key === "Tab" && isTypingTarget(e.target)) {
    e.preventDefault();
    handlers.cycleNickComplete(!e.shiftKey);
    return;
  }

  // Esc closes any open drawer (Shell.tsx tracks the state); never
  // preventDefault — let any modal/dialog also see it if present.
  if (e.key === "Escape") {
    handlers.closeDrawer();
    return;
  }

  // / focuses the compose box, but ONLY when the user isn't already
  // typing in an input — otherwise typing literal "/" gets eaten.
  if (e.key === "/" && !isTypingTarget(e.target)) {
    e.preventDefault();
    handlers.focusCompose();
    return;
  }

  if (e.altKey && /^[1-9]$/.test(e.key)) {
    e.preventDefault();
    handlers.selectChannelByIndex(Number(e.key) - 1);
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
