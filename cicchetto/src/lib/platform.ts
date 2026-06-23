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

// The composed escape policy — THE meaningful gate, exported as one
// name so call sites can't recompose the halves wrong (review fix):
// the isIos() half is load-bearing because Android/desktop installed
// PWAs are standalone too and an x-safari- URL is inert there.
// Returns the scheme-rewritten href when this platform needs the
// handoff, null when the default anchor behavior already works.
export function escapePwaHref(href: string): string | null {
  if (!isIos() || !isStandalonePwa()) return null;
  const escaped = safariEscapeHref(href);
  return escaped === href ? null : escaped;
}

// Shared click handler for anchors that must LEAVE the PWA on iOS
// standalone (media viewer "open in browser", same-host non-media
// scrollback links). Contract: the anchor keeps its real href —
// copy-link / long-press / middle-click semantics stay intact — and
// only the plain primary click is escaped, same shape as
// ScrollbackPane's media intercept. Navigation is same-window
// location.assign: a scheme handoff needs no new browsing context,
// and the new-window path is the one WebKit popup policy can swallow.
// Returns whether the click was escaped.
export function maybeEscapePwaClick(e: MouseEvent, href: string): boolean {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return false;
  const escaped = escapePwaHref(href);
  if (escaped === null) return false;
  e.preventDefault();
  window.location.assign(escaped);
  return true;
}
