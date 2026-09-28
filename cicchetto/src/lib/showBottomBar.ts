import { createSignal } from "solid-js";
import { moduleRoot } from "./moduleRoot";
import { isNarrowPane } from "./theme";

// #1766 — "show the mobile window bar" display preference. Boolean, ON by
// default: the BottomBar is not deleted, it becomes opt-OUT. That default is
// #174's standing constraint ("the bottom bar must NOT be deleted, it stays
// opt-in from settings") and #71's second ruling, which explicitly reversed
// "kill the mobile bottom bar".
//
// ## Why anyone wants it off
//
// BottomBar is a flat, horizontally-scrolled strip of EVERY window across
// EVERY network. It is O(windows), not O(screens) — at 7 networks the strip is
// longer than the useful scroll distance and the picker stops picking. The
// second door that makes the opt-out survivable is #1041's left-edge swipe
// (plus the ☰ that ships with this toggle); it did not exist when #71 ruled.
//
// ## SYNCED, unlike hideNextActive.ts — and that is the interesting call
//
// This module takes colorNicklist.ts's shape AND its posture: it is one of the
// #449 server-backed display prefs, coordinated by `displayPrefs.ts` over
// `GET/PUT /me/settings/display-prefs`. #914's `hideNextActive` sits right
// next to it in the same settings fieldset and is deliberately per-DEVICE, so
// the divergence needs a reason rather than a coin toss: #914's complaint was
// about a VIEWPORT (a fixed overlay on a phone), and syncing it would have
// blanked a desktop control nobody objected to. The complaint here is "7
// networks", which is a property of the ACCOUNT — the window count is
// identical on the phone and on the tablet, and vjt owns both. A device-local
// toggle would reproduce the #449 bug that started the whole coordinator
// (Hypnotize: set on desktop, invisible on the iOS PWA).
//
// localStorage is the boot/offline cache for a FOUC-free first paint, not the
// source of truth: the server wins on login, or is seeded up once when it has
// never persisted. `setShowBottomBar` stays LOCAL-only (signal + localStorage
// write-through); the coordinator's `syncedSetShowBottomBar` adds the PUT.
//
// ## Why a signal and not a boot-time read
//
// Same argument as colorNicklist.ts / hideNextActive.ts: the flag is consumed
// at RENDER time by Shell's `<Show>` around `<BottomBar />`, so a bare
// `localStorage.getItem` in the render path would never re-run and the bar
// would stay on screen until a reload. It is a JSX gate rather than a
// `display: none` on purpose — BottomBar carries no internal display guard by
// design, and a CSS-hidden bar would keep running #327's double-rAF
// scroll-into-view effect against a strip nobody can see.

const STORAGE_KEY = "cicchetto.showBottomBar";
const DEFAULT_SHOWN = true;

function readStored(): boolean {
  const v = localStorage.getItem(STORAGE_KEY);
  // Anything that is not the literal "false" reads as shown — the default is
  // the safe side here, since the bar is the primary mobile navigation.
  return v === null ? DEFAULT_SHOWN : v !== "false";
}

// Module-singleton signal seeded from storage. createRoot anchors it for the
// app lifetime (same shape as colorNicklist.ts) — the preference is
// identity-agnostic, so no token-rotation reset arm is needed.
const { current, setCurrent } = moduleRoot(() => {
  const [current, setCurrent] = createSignal<boolean>(readStored());
  return { current, setCurrent };
});

export function getShowBottomBar(): boolean {
  return current();
}

export function setShowBottomBar(on: boolean): void {
  localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  setCurrent(on);
}

// issue 2161 — the EFFECTIVE gate, and the ONLY thing the render path may ask.
// `Shell.tsx` reads it twice, on the two halves of one decision: the window bar
// mounts when it is true, and the leading ☰ mounts when it is false. They are
// the same door seen from both sides (#1766: with a picker in flow no second
// opener renders), so they cannot be allowed to disagree — which is why this is
// one function and not the same `||` written twice.
//
// The override is vjt's direction-2 ruling for iPadOS Split View, where the OS
// eats both edge bands and the swipes never arm: below NARROW_PANE_QUERY the
// bar stays in flow WHATEVER the preference says. See theme.ts for why the
// threshold is 383 and for the two things a width cannot tell apart.
//
// 🔴 `getShowBottomBar()` — the RAW preference — stays the reader for the two
// places that must never see the override, and both are load-bearing:
//
//   * `displayPrefs.buildWireMap()`, which is the body of EVERY PUT to
//     `/me/settings/display-prefs`. Routing it through this function would make
//     one toggle-anything from a narrow pane persist `show_bottom_bar: true`
//     onto the account, wiping the preference on every device the user owns —
//     a viewport would be writing an account-scoped setting.
//   * `SettingsDrawer`'s checkbox, which must keep reporting what the user
//     CHOSE rather than what this viewport is currently doing with it.
//
// A grep for `getShowBottomBar` that comes back with a RENDER site is a bug;
// a grep that comes back with those two is the design.
export function windowBarInFlow(): boolean {
  return getShowBottomBar() || isNarrowPane();
}
