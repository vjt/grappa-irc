// iOS platform detection — boot-time, applies `is-ios` class to
// <html> so CSS can target iOS-specific rules.
//
// Why this exists.
//
// UX-6 D9 (2026-05-21) — the Telegram Web K iOS keyboard pattern
// requires `html.is-ios { position: fixed }` paired with
// `body { height: calc(var(--vh) * 100) }` to pin the layout
// viewport so the iOS on-screen keyboard cannot scroll the chrome
// out of view. The class hook lets CSS scope the rule to iOS only —
// applying `position: fixed` on `<html>` on Android Chrome / desktop
// would break those platforms which don't have the underlying iOS
// auto-scroll-on-focus behavior.
//
// Detection logic: matches Telegram tweb's `IS_APPLE` heuristic —
// user agent contains "iPhone" OR "iPad" OR (Mac OS AND
// MaxTouchPoints > 0). The third clause catches iPadOS in
// desktop-mode (Safari 13+ defaults to "desktop" UA but exposes
// touch — Mac users without touchscreens aren't false-positives
// since macOS Touch Bar reports 0).
//
// Idempotent — main.tsx invokes once at boot before render.
// Pre-paint so the first frame already has the class (no FOUC
// where iOS shell briefly renders in non-fixed layout, then
// reflows when class lands).

export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  // iPadOS 13+ desktop-mode detection.
  if (
    /Mac/.test(ua) &&
    typeof navigator.maxTouchPoints === "number" &&
    navigator.maxTouchPoints > 0
  ) {
    return true;
  }
  return false;
}

export function applyIosClass(): void {
  if (typeof document === "undefined") return;
  if (isIos()) {
    document.documentElement.classList.add("is-ios");
  }
}
