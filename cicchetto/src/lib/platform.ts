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

// ─────────────────────────────────────────────────────────────────────────
// issue 2190 — the iOS/iPadOS 27 compositor band. A PORKAROUND, and it is
// meant to die. Everything between this banner and the closing one below is
// one removable piece; its only other limbs are the `is-ios27-band` rules in
// `themes/default.css` and the `applyIos27BandClass()` call in `main.tsx`.
//
// WHAT IT WORKS AROUND. On iOS 27 and iPadOS 27 Beta an INSTALLED PWA gets a
// system-painted gradient/blur band along the TOP edge of the web view. It
// washes out whatever cicchetto paints there. The blur is not ours —
// cicchetto declares no `backdrop-filter` on any surface — and it is not
// expressed through the safe-area insets either: morph, #grappa 2026-09-15
// 16:14, «il blur su iOS 27 è applicato dal compositor indipendentemente
// dagli inset, succede su qualunque PWA e non solo su cicchetto». So `env()`
// is not the lever (which is also what the `8fc439f5e` iPadOS-pill precedent
// predicted) and the clearance has to be taken by layout, gated.
//
// WHO REPORTED IT: morph, #grappa, 2026-09-14 23:50 (iOS 27, iPhone) and
// 23:52 (iPadOS 27 Beta, iPad). vjt ordered the workaround on 2026-09-15
// 16:16 and named it for what it is at 16:18: «porkaround per ora, magari da
// rimuovere in seguito». The day Apple changes the behaviour, or ships the
// inset the `8fc439f5e` precedent expected, this is a clean revert.
// ─────────────────────────────────────────────────────────────────────────

// The `OS <major>[_<minor>…] like Mac OS X` shape — UNDERSCORES, not dots:
//   "(iPhone; CPU iPhone OS 27_0 like Mac OS X)"
//   "(iPad;   CPU OS 27_0 like Mac OS X)"   ← the iPad spelling drops the word
// The ` like Mac OS X` tail is load-bearing, not decoration: without it the
// pattern also matches the `Intel Mac OS X 10_15_7` of the desktop-mode UA
// below and would read iPadOS 27 as macOS 10.
const IOS_UA_MAJOR = /\bOS (\d+)(?:_\d+)* like Mac OS X\b/;

// iPadOS 13+ in desktop mode — the DEFAULT for iPad Safari — reports
//   "(Macintosh; Intel Mac OS X 10_15_7) … Version/27.0 Safari/605.1.15"
// with NO `iPad` token anywhere. That is precisely why `isIos()` above needs
// its `Mac` + `maxTouchPoints > 0` clause, and on that shape `Version/` is
// the only version signal there is. It is the SAFARI major, not the OS one —
// a PROXY, accepted knowingly: the two have shipped in lockstep (Safari 26
// with iOS 26, Safari 27 with iOS 27).
//
// 🔴 AND ON iOS 27 IT IS NOT A FALLBACK, IT IS THE ONLY TRUE SIGNAL. Measured
// on the staging access log, 293 of 293 requests from the reporter's device,
// one single form:
//   "(iPhone; CPU iPhone OS 18_7 like Mac OS X) … Version/27.0 … Safari/604.1"
// iOS 27 still reports the LEGACY OS token. `18_7` is what the shape above
// captures on a phone that is running 27, and the real major lives only here.
const SAFARI_UA_MAJOR = /\bVersion\/(\d+)/;

/**
 * The major iOS/iPadOS version a user agent claims, or `null` when it does
 * not say. Both UA shapes; when both are present the HIGHEST wins.
 *
 * 🔴 HIGHEST, not first-match — and the difference shipped a dead gate. This
 * used to read `IOS_UA_MAJOR.exec(ua) ?? SAFARI_UA_MAJOR.exec(ua)`, so on the
 * real iOS 27 UA above the OS clause matched, captured 18, and short-circuited
 * `Version/27.0` away. `18 >= 27` is false, `hasIos27Band()` returned false,
 * and every rule gated on the class was dead code on the one device in the
 * world that has the band. The device table was green throughout, because
 * every row in it was constructed from what we believed iOS sends and no row
 * carried two signals that DISAGREE.
 *
 * Taking the max is safe in the other direction too, by construction rather
 * than by luck: a UA cannot understate its major through either token without
 * also being wrong about itself, so the higher of two self-reports is the
 * later OS. Verified a no-op against every pre-existing row of the table.
 *
 * PURE — takes the string rather than reading `navigator`, so the whole
 * device table is one table-driven test (`__tests__/ios27Band.test.ts`).
 *
 * It answers the VERSION question only and says nothing about whether the UA
 * is an Apple mobile one: a macOS Safari 27 UA reads 27 here, byte-identical
 * to an iPad in desktop mode, and `isIos()` is what tells the two apart.
 * Compose, do not conflate — `hasIos27Band()` below is the composition.
 */
export function iosMajorVersion(ua: string): number | null {
  const majors = [IOS_UA_MAJOR, SAFARI_UA_MAJOR].flatMap((pattern) => {
    const captured = pattern.exec(ua)?.[1];
    if (captured === undefined) return [];
    const major = Number.parseInt(captured, 10);
    return Number.isNaN(major) ? [] : [major];
  });
  return majors.length === 0 ? null : Math.max(...majors);
}

/** The first major that paints the band. morph measured 27; 26 is clean. */
const IOS27_BAND_FIRST_MAJOR = 27;

/** The `<html>` class the gated CSS keys on. One spelling, two readers. */
export const IOS27_BAND_CLASS = "is-ios27-band";

/**
 * Does this browsing context get the iOS 27 compositor band?
 *
 * `isIos()` AND `isStandalonePwa()` AND major >= 27. The standalone half is
 * load-bearing, not belt-and-braces: the band is PWA chrome, so Safari in a
 * browser tab must not pay the clearance.
 */
export function hasIos27Band(): boolean {
  if (typeof navigator === "undefined") return false;
  if (!isIos() || !isStandalonePwa()) return false;
  const major = iosMajorVersion(navigator.userAgent);
  // `major !== null` is spelled out rather than left to the comparison. JS
  // would answer this correctly by coercion — `null >= 27` is false — but so
  // is `undefined >= 27`, and a reader cannot tell a deliberate guard from a
  // lucky one. The guard is deliberate.
  return major !== null && major >= IOS27_BAND_FIRST_MAJOR;
}

/**
 * Apply the gating class to `<html>`, pre-paint, from `main.tsx` — same shape
 * as `applyIosClass()` above and for the same reason: the clearance is then a
 * CSS rule that costs no runtime probe per render, and the first frame
 * already has it (no reflow once the class lands).
 */
export function applyIos27BandClass(): void {
  if (typeof document === "undefined") return;
  if (hasIos27Band()) {
    document.documentElement.classList.add(IOS27_BAND_CLASS);
  }
}

// ──────────────────────── end of the issue-2190 porkaround ───────────────

// #2014 — is the PRIMARY pointing device a finger? The context-menu anchor
// asks, because a menu that opens down-and-right of a finger is covered by the
// hand that opened it, while down-and-right is the native convention under a
// mouse.
//
// `(pointer: coarse)` and NOT `isIos()` above, and the precedent is #1869's:
// default.css moved the whole selection/callout policy off `html.is-ios` onto
// exactly this query because it *"keys on the actual pointing device rather
// than a UA sniff"*. Same shape of decision, same query — a second, disagreeing
// notion of "is this touch" is the drift that issue is a record of. iOS reports
// coarse, so the platform the defect was measured on is covered.
//
// KNOWN AND ACCEPTED: `pointer` describes the PRIMARY pointer only, so a hybrid
// whose primary is touch gives its occasional mouse the touch anchor. That is
// the same trade #1869 took, and the alternative — deciding per EVENT at each
// door — buys precision the doors cannot keep: the message menu has two of them
// (touch and `contextmenu`) reaching one opener, and they would then disagree
// about the same press.
//
// Read live, like `isStandalonePwa` above: cheap, and a menu opening is exactly
// when the answer matters. Absent `matchMedia` means "not in the tier" — the
// `sidebarWidths.ts` convention — which lands jsdom on the mouse behaviour.
export function isCoarsePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(pointer: coarse)").matches;
}

// Web Share API feature-detect, read live and guarded for the jsdom path where
// `navigator.share` is absent. One answer for both share doors — the session
// link (ShareSessionModal) and, since issue 2468, the media viewer's file — so
// a platform cannot offer one share sheet and hide the other.
export function canNativeShare(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
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
