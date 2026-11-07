import { createSignal } from "solid-js";
import { moduleRoot } from "./moduleRoot";

// issue 2584 — the `/` command menu's two settings: whether it opens at all,
// and how many entries it shows. On, five, for anyone who never opens
// Settings.
//
// ## PER-DEVICE, not one of the #449 server-backed display prefs
//
// vjt's ruling (issue 2584, comment 6702171180 Q1): like the font size, these
// live in this device's localStorage. How many lines fit above the compose box
// is a question about the screen, and a phone and a desktop on one account
// answer it differently. The command COUNTS the menu orders by are the other
// half and they ARE synced, server-side (commandUsage.ts).
//
// Turning the menu off turns `/` completion off with it: the compose door
// then hands the engine no commands (compose.ts), the way the services prompt
// does. The counting goes on regardless, because another device on the
// account may have its menu on.
//
// ## hideNextActive.ts's SHAPE, not fontSize.ts's
//
// Both values are read at RENDER time (the menu's `<Show>`, its entry count)
// and inside the Tab door, so they are module-singleton signals: a bare
// localStorage read would not re-run when the setting changes.

const ENABLED_KEY = "cicchetto.commandMenu";
const ENTRIES_KEY = "cicchetto.commandMenuEntries";

const DEFAULT_ENABLED = true;
const DEFAULT_ENTRIES = 5;

// What the settings drawer offers. vjt asked for "max 5 o 7" and then for
// the number to be configurable; 1..10 covers both with room either side,
// and the ten entries of the default list (commandUsage.ts) fill the top.
export const COMMAND_MENU_ENTRY_CHOICES: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

// A stored value this bundle cannot read falls back to the DEFAULT, never to
// "off": an unreadable flag must not silently take the feature away.
function readEnabled(): boolean {
  const v = localStorage.getItem(ENABLED_KEY);
  if (v === "true") return true;
  if (v === "false") return false;
  return DEFAULT_ENABLED;
}

function readEntries(): number {
  const n = Number(localStorage.getItem(ENTRIES_KEY));
  return COMMAND_MENU_ENTRY_CHOICES.includes(n) ? n : DEFAULT_ENTRIES;
}

// Identity-agnostic, like every per-device preference: no reset on logout.
const { enabled, setEnabled, entries, setEntries } = moduleRoot(() => {
  const [enabled, setEnabled] = createSignal<boolean>(readEnabled());
  const [entries, setEntries] = createSignal<number>(readEntries());
  return { enabled, setEnabled, entries, setEntries };
});

export function getCommandMenuEnabled(): boolean {
  return enabled();
}

export function setCommandMenuEnabled(on: boolean): void {
  localStorage.setItem(ENABLED_KEY, on ? "true" : "false");
  setEnabled(on);
}

export function getCommandMenuEntries(): number {
  return entries();
}

// The drawer can only offer the choices above; anything else is a caller bug,
// and it is refused loudly rather than stored and read back as the default.
export function setCommandMenuEntries(n: number): void {
  if (!COMMAND_MENU_ENTRY_CHOICES.includes(n)) {
    throw new RangeError(`command menu entries must be one of 1..10, got ${n}`);
  }
  localStorage.setItem(ENTRIES_KEY, String(n));
  setEntries(n);
}
