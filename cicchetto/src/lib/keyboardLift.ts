// UX-6 bucket D v5 (2026-05-21) — iOS PWA keyboard pre-lift.
//
// Why this exists.
//
// iOS Safari (including PWA standalone mode) runs a "pre-focus
// visibility check" before showing the soft keyboard. If it decides
// the about-to-be-focused input isn't visible enough, it scrolls the
// LAYOUT viewport up so the input ends above where the keyboard will
// land. This happens BEFORE the focus event fires — `installScrollPin`
// style yank-on-scroll handlers were always too late.
//
// `interactive-widget=resizes-content` (viewport meta directive) is
// supposed to make the browser shrink the layout viewport when the
// keyboard opens. Chrome on Android honors it; Safari/WebKit does
// NOT (https://www.htmhell.dev/adventcalendar/2024/4/). So even
// with the directive set in index.html, iOS PWA scrolls the page.
//
// All-CSS attempts (UX-6 D v2 :has(:focus), v3 fixed-body, v4
// fixed-shell) failed because they fix the SIZE not the ORIGIN. The
// shell IS the right height (570px on iPhone 15 keyboard-up); the
// problem is iOS shifts the visualViewport coordinate origin within
// the layout viewport regardless of how the shell is positioned.
//
// The production fix (used by major PWA chat apps; see
// github.com/Crscristi28/ios-pwa-keyboard-fix for a reference impl)
// is the PRE-LIFT pattern:
//
//   1. Cache the keyboard height the first time we observe one
//      (delta of `visualViewport.height` after the first focus).
//   2. On `pointerdown` for any input/textarea (fires BEFORE focus),
//      apply `transform: translateY(-cachedKeyboardHeight)` to the
//      compose box. Now the input visually sits ABOVE where the
//      keyboard will land.
//   3. Call `focus({ preventScroll: true })`. Safari sees the input
//      "already in the safe zone" and SKIPS its layout-viewport
//      scroll.
//   4. On `focusout`, remove the transform.
//
// Persisting cached height to localStorage makes pre-lift apply on
// the very first focus of every PWA session — only the very first
// focus on a fresh install (no cache yet) shifts.
//
// This module is iOS-PWA-only by intent. Desktop browsers don't have
// the pre-focus scroll issue, and Chrome-Android honors
// `interactive-widget=resizes-content`. On those platforms the
// `pointerdown` handler still runs but the transform is a no-op
// (cachedHeight stays 0 because vv.height delta is 0). No
// regression.

const CACHE_KEY = "cic.keyboard-height-px";
const MIN_KBD_HEIGHT = 150; // address-bar delta is ~80-100; soft kbd 250+
const STABILITY_MS = 80; // ignore mid-animation vv.height samples
const RESET_DELAY_MS = 100; // iOS 26 fixed-elem drift workaround

let cachedHeight = 0;
let isKeyboardVisible = false;
let baselineWinH = 0;
let stabilityTimer: ReturnType<typeof setTimeout> | null = null;
let resetTimer: ReturnType<typeof setTimeout> | null = null;

function readCache(): number {
  if (typeof localStorage === "undefined") return 0;
  const raw = localStorage.getItem(CACHE_KEY);
  if (raw === null) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= MIN_KBD_HEIGHT && n < 800 ? n : 0;
}

function writeCache(px: number): void {
  if (typeof localStorage === "undefined") return;
  if (px < MIN_KBD_HEIGHT || px >= 800) return;
  localStorage.setItem(CACHE_KEY, String(Math.round(px)));
}

/**
 * Returns true if `el` is a text-input surface (textarea or
 * text-shaped <input>). Non-text inputs (checkbox/radio/file) don't
 * trigger the iOS soft keyboard.
 */
function isTextInput(el: EventTarget | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName !== "INPUT") return false;
  const type = (el as HTMLInputElement).type.toLowerCase();
  // The set of input types that show the soft keyboard. `button`,
  // `checkbox`, `radio`, `file`, `submit`, `reset`, `image` do NOT.
  return (
    type === "text" ||
    type === "search" ||
    type === "email" ||
    type === "url" ||
    type === "tel" ||
    type === "number" ||
    type === "password"
  );
}

function applyLift(): void {
  if (cachedHeight === 0) return;
  // Target the mobile shell so EVERYTHING inside it (scrollback,
  // compose, bottombar) shifts together — keeps the layout coherent.
  // Desktop has no `.shell-mobile`, query is null, no-op.
  const shell = document.querySelector<HTMLElement>(".shell-mobile");
  if (!shell) return;
  shell.style.transform = `translateY(${-cachedHeight}px)`;
}

function clearLift(): void {
  const shell = document.querySelector<HTMLElement>(".shell-mobile");
  if (!shell) return;
  shell.style.transform = "";
}

/**
 * Pointerdown handler: fires BEFORE focus. If the target is a text
 * input and we have a cached keyboard height, apply the lift
 * pre-emptively + steal focus with preventScroll so iOS skips its
 * own auto-scroll.
 */
function onPointerDown(e: PointerEvent): void {
  if (!isTextInput(e.target)) return;
  if (cachedHeight === 0) return; // first-ever focus — no cache yet
  // Don't preventDefault — that would block legitimate focus. Just
  // apply the lift now, then let the browser focus the element. By
  // the time iOS does its pre-focus visibility check the lift is
  // already in place and the element is "in the safe zone".
  applyLift();
}

/**
 * Learn keyboard height from visualViewport.resize. The first
 * keyboard-up observation seeds the cache; subsequent ones refresh
 * it (the user may have a different keyboard size on iPad / external
 * keyboard / split keyboard).
 *
 * Uses a stability filter — the height is only committed after no
 * further resize for `STABILITY_MS` to avoid sampling mid-animation
 * frames.
 */
function onVisualViewportResize(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  // Baseline = layout viewport height when no keyboard is up.
  // window.innerHeight tracks the layout viewport which iOS leaves
  // unchanged across keyboard open/close on PWA standalone.
  if (window.innerHeight > baselineWinH) baselineWinH = window.innerHeight;

  const delta = baselineWinH - vv.height;

  if (stabilityTimer !== null) clearTimeout(stabilityTimer);
  stabilityTimer = setTimeout(() => {
    stabilityTimer = null;
    if (delta >= MIN_KBD_HEIGHT) {
      // Keyboard up.
      isKeyboardVisible = true;
      if (delta !== cachedHeight) {
        cachedHeight = delta;
        writeCache(delta);
      }
    } else {
      // Keyboard down.
      isKeyboardVisible = false;
    }
  }, STABILITY_MS);
}

/**
 * Focusout handler: clear the lift transform. Uses a small delay to
 * dodge an iOS 26 quirk where the transform can drift if cleared
 * immediately (https://bugs.webkit.org/show_bug.cgi?id=297779).
 */
function onFocusOut(e: FocusEvent): void {
  if (!isTextInput(e.target)) return;
  if (resetTimer !== null) clearTimeout(resetTimer);
  resetTimer = setTimeout(() => {
    resetTimer = null;
    if (!isKeyboardVisible) clearLift();
  }, RESET_DELAY_MS);
}

/**
 * Boot-time install. Idempotent — calling twice attaches duplicate
 * listeners (main.tsx invokes once).
 */
export function installKeyboardLift(): void {
  if (typeof document === "undefined") return;
  cachedHeight = readCache();
  baselineWinH = typeof window !== "undefined" ? window.innerHeight : 0;

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("focusout", onFocusOut, true);
  window.visualViewport?.addEventListener("resize", onVisualViewportResize);
  // Reset baseline on orientation change — landscape vs portrait
  // have different layout viewports + keyboard heights.
  window.addEventListener("orientationchange", () => {
    baselineWinH = window.innerHeight;
    cachedHeight = 0; // re-learn for the new orientation
    clearLift();
  });
}

/**
 * Test seam — reset module-level state so vitest cases don't leak.
 */
export function _resetKeyboardLiftForTest(): void {
  cachedHeight = 0;
  isKeyboardVisible = false;
  baselineWinH = 0;
  if (stabilityTimer !== null) {
    clearTimeout(stabilityTimer);
    stabilityTimer = null;
  }
  if (resetTimer !== null) {
    clearTimeout(resetTimer);
    resetTimer = null;
  }
  if (typeof localStorage !== "undefined") localStorage.removeItem(CACHE_KEY);
}

/**
 * Test seam — peek at the cached height value.
 */
export function _readCachedKeyboardHeightForTest(): number {
  return cachedHeight;
}
