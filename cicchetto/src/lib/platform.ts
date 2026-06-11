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

// Installed-PWA (standalone display mode) detection. Two probes:
// the standard display-mode media query, plus the proprietary
// `navigator.standalone` boolean that iOS Safari pre-17 exposes
// instead (the cast is intentional — the typedef omits it because
// it's Safari-specific). Read live, not cached at module load:
// callers gate per-interaction (media viewer) and tests stub the
// probes per-case. The mode itself can't change without a reload,
// so live reads cost nothing and never go stale.
export function isStandalonePwa(): boolean {
  if (typeof window === "undefined") return false;
  if (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches
  ) {
    return true;
  }
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

// iOS-standalone escape hatch for same-origin links (media viewer
// dogfood bug, 2026-06-11): in-scope navigation ignores target=_blank,
// so a same-origin anchor can NEVER leave the PWA by itself. The
// x-safari-https:// / x-safari-http:// schemes hand the URL to real
// Safari (iOS 17+; on iOS 16 the tap is inert — acceptable degrade,
// the viewer modal still shows the media). Total function: anything
// that isn't plain http(s) passes through unchanged.
export function safariEscapeHref(href: string): string {
  if (href.startsWith("https://") || href.startsWith("http://")) {
    return `x-safari-${href}`;
  }
  return href;
}
