import { createSignal } from "solid-js";
import { moduleRoot } from "./moduleRoot";

// #914 — "hide the jump-to-next-active button" display preference. Boolean,
// OFF by default, so the #235 affordance keeps rendering for everyone who
// never opens Settings.
//
// ## PRESENTATIONAL ONLY
//
// This flag gates the BUTTON, never the verb. `jumpToNextActiveWindow()` is
// shared with the Alt+A keybinding and Ctrl+N (#235 keeps one code path), and
// both must still jump while the button is hidden. On mobile that deliberately
// leaves no jump affordance — that IS the request. Nothing here touches
// `activeWindowCount()` / `nextActiveKind()`, so unread accounting is
// unchanged and the count can never disagree with the auto-hide condition.
//
// ## LOCAL, not one of the #449 server-backed display prefs
//
// This diverges from the issue's suggested home (`lib/displayPrefs`). The
// split already documented on `Grappa.UserSettings`'s `display_prefs` typedoc
// is per-DEVICE stays client-local (fontSize.ts) vs device-neutral converges
// across devices (time format, colored nicklist, presence filter). The
// complaint behind #914 is the viewport-fixed MOBILE overlay; the desktop
// sidebar control is not what anyone objected to. Syncing one preference
// across both variants would blank the desktop button on a device the user
// never complained about — a bigger, silent behaviour change than the one
// asked for. Local → synced stays additive if that call is ever reversed;
// synced → local would be a migration.
//
// ## colorNicklist.ts's SHAPE, not fontSize.ts's
//
// fontSize applies itself as a boot-time CSS-var write, so a plain
// localStorage read suffices there. This flag is read at RENDER time inside
// NextActiveButton's `<Show>` gate, so it needs a module-singleton Solid
// signal: a bare `localStorage.getItem` in the render path would not re-run
// when the setting changes and the mounted button would stay stale until a
// reload.

const STORAGE_KEY = "cicchetto.hideNextActive";
const DEFAULT_HIDDEN = false;

function readStored(): boolean {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === null ? DEFAULT_HIDDEN : v === "true";
}

// Module-singleton signal seeded from storage. createRoot anchors it for the
// app lifetime (same shape as colorNicklist.ts) — the preference is
// identity-agnostic, so no token-rotation reset arm is needed.
const { current, setCurrent } = moduleRoot(() => {
  const [current, setCurrent] = createSignal<boolean>(readStored());
  return { current, setCurrent };
});

export function getHideNextActive(): boolean {
  return current();
}

export function setHideNextActive(on: boolean): void {
  localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  setCurrent(on);
}
