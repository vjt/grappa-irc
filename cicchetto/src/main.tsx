import { registerSW } from "virtual:pwa-register";
import { Route, Router, useNavigate } from "@solidjs/router";
import { type Component, createEffect, createRoot, createSignal, type JSX, Show } from "solid-js";
import { render } from "solid-js/web";
import InstallSplash, { INSTALL_CHOICE_KEY, shouldShowInstallSplash } from "./InstallSplash";
import Login from "./Login";
import { me } from "./lib/api";
import { bootstrapAuth, isAuthenticated, token } from "./lib/auth";
import ShareConsume from "./ShareConsume";
// Side-effect-only: registers the WS subscribe createRoot so per-
// channel join effects fire once `user()` + `channelsBySlug()` resolve.
// Pre-A4 this lifecycle was implicit (Shell imported `lib/networks`,
// which contained the join effect); after the verb-keyed split the
// app entry has to wire the side-effect module explicitly.
import "./lib/subscribe";
import "./lib/userTopic";
import { mountBadgeReconcile, mountBadgeSync } from "./lib/badge";
import { applyCachedCustomTheme, mountCustomThemeSync } from "./lib/customTheme";
import { isDocumentVisible } from "./lib/documentVisibility";
import { applyFontSizeFromStorage } from "./lib/fontSize";
import { installKeyboardPreserve } from "./lib/keepKeyboard";
import { applyIosClass, isStandalonePwa } from "./lib/platform";
import { installPushResubscribe } from "./lib/pushResubscribe";
import { applyPushTargetFromUrl, installPushTargetListener } from "./lib/pushTarget";
import { applySidebarWidthsFromStorage } from "./lib/sidebarWidths";
import { notifyClientClosing, reportVisibility } from "./lib/socket";
import { recordSwRegError, recordSwRegistered } from "./lib/swRegistration";
import { applyTheme } from "./lib/theme";
import { installSmartScrollPin, installViewportHeightTracker } from "./lib/viewportHeight";
import { createVisibilityHeartbeat } from "./lib/visibilityHeartbeat";
import Shell from "./Shell";
import "./themes/default.css";

// Pre-paint the resolved theme on document.documentElement.dataset.theme
// BEFORE render() so the first frame already has the correct theme — no
// FOUC on cold load and no flash on toggle (both themes ship in one CSS
// file via :root[data-theme="..."] blocks).
applyTheme();

// #75 — pre-paint the operator's custom theme (server-owned, cached in
// localStorage) BEFORE render() so the first frame carries their palette
// with no FOUC, exactly like `applyTheme()`. The inline CSS custom
// properties cascade over the base `[data-theme]` blocks. The
// authoritative payload is refreshed from `GET /me/theme` after login via
// `mountCustomThemeSync` below.
applyCachedCustomTheme();

// Same rationale for `--font-size`: write the CSS var on `<html>`
// BEFORE render() so the first frame already has the user's preferred
// size. iOS-4 default = "M" (14px = current behavior).
applyFontSizeFromStorage();

// UX-5 bucket BS — pre-paint sidebar widths from localStorage so the
// first frame already has the operator's preferred grid template. No
// flash from default 16rem/14rem → stored values as Shell mounts.
applySidebarWidthsFromStorage();

// UX-6 D9 — apply `html.is-ios` class so default.css's
// iOS-specific rules (`html.is-ios { position: fixed }` etc.) match.
// Pre-render so the first frame has the correct layout — without
// the pre-paint, iOS shell briefly renders in non-fixed layout
// then reflows.
applyIosClass();

// PWA icon badge (2026-06-21) — wire the `badge` signal to the OS icon
// badge (`navigator.setAppBadge`) + the `document.title` mirror. Own
// root so the createEffect has an app-lifetime owner; the signal is fed
// from the `/me` seed, `read_cursor_set` broadcasts, the SW push, and
// the optimistic foreground mention bump.
createRoot(() => mountBadgeSync());

// #75 — refresh the custom theme from the server on every `token()`
// change: on login apply + cache the resolved `GET /me/theme` payload, on
// logout clear back to the base cascade. Own root (app-lifetime owner for
// the createEffect), alongside the other createRoot-wired effects.
createRoot(() => mountCustomThemeSync());

// PWA icon badge foreground reconcile (#badge-orphan, 2026-06-21) — the
// SW push path (door #1) writes `setAppBadge` directly off-signal while
// the app is backgrounded; `mountBadgeSync` only re-fires on a signal
// *change*, so a warm resume that reads everything (server count 0, signal
// already 0) would orphan the SW-set OS badge. On every visible event,
// re-pull the authoritative `/me` count (same number the cold-load seed
// uses) and force-apply it. `null` (no token / fetch failed) leaves the
// badge as-is and retries on the next visible event.
//
// App-lifetime listener — the returned disposer is intentionally not
// retained (same as the bare `pagehide` / `beforeunload` /
// `beforeinstallprompt` listeners below). A production PWA update does a
// full page reload, so listeners never accumulate; the disposer exists
// for unit-test cleanup. No `createRoot` wrapper: this registers a raw
// `addEventListener`, not a Solid reactive primitive, so there is no
// computation owner to scope.
mountBadgeReconcile(async () => {
  const t = token();
  if (!t) return null;
  return (await me(t)).badge_count ?? 0;
});

// UX-3 PENT — VisualViewport-driven height tracking. Writes
// `--viewport-height: <px>` on <html> and re-writes on every
// visualViewport.resize event. `.shell.shell-mobile` reads the var
// (with `100dvh` fallback) so the mobile shell shrinks in lockstep
// with the iOS on-screen keyboard. Without this, iOS scrolls the
// body to keep focused inputs visible and pushes the top bar out
// of view. Boot-time so the first frame already has the var.
installViewportHeightTracker();

// UX-6 D10 (2026-05-21) — smart-pin window scroll. iOS PWA 18.7
// shifts the visual viewport at the WKWebView UIScrollView layer
// even with html { position: fixed } (no DOM element overflows —
// diag confirmed html/body/root scrollHeight === clientHeight,
// yet window.scrollY=324). The only counter-measure is the original
// UX-3 OCT snap-window-back trick. D7 dropped this on a wrong
// hypothesis (claimed pin caused the 1-3s scroll lock); D10 brings
// it back but gates on touch-state so user drag-momentum doesn't
// fight the pin (which WAS the cause of the lock).

installSmartScrollPin();

// UX-3 preserve-keyboard — single document-level capture listener.
// When compose <input> has focus and the user taps anywhere that
// isn't another input/textarea, suppress the implicit focus shift
// (preventDefault on pointerdown) so iOS doesn't dismiss the
// keyboard. Replaces per-button onPointerDown wiring (UX-3 NON +
// BIS-DEC) — every new tappable surface inherits the behavior
// automatically.
installKeyboardPreserve();

// Push notifications cluster B0 (2026-05-14) — capture
// `beforeinstallprompt` early. Chrome fires this event ONCE, very
// shortly after page load, when the engagement heuristic decides
// the site is install-eligible. Listening from inside InstallSplash's
// onMount risks missing the event entirely on fast loads. Capture
// here at module-init, stash on `window.__cicInstallPrompt`,
// InstallSplash reads on mount and also re-listens for late fires.
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  window.__cicInstallPrompt = e as Window["__cicInstallPrompt"];
});

// Wire the api module's 401 → setToken(null) handler exactly once.
// Must run before render() (any API call could 401 before the UI
// fully mounts) and after the module graph has settled (so the
// handler reference is stable for all subsequent api calls). See
// `auth.ts > bootstrapAuth` for the rationale behind the explicit
// bootstrap point.
bootstrapAuth();

// UX-6-J (2026-05-22) — push notification deep-link routing.
// Warm-path: SW posts `{type: "navigate", url}` to the focused client
// from its `notificationclick` handler; this listener parses the URL
// and routes `setSelectedChannel`. Cold-path: when SW opens a fresh
// window via `openWindow(url)`, the URL carries the deep-link params;
// `applyPushTargetFromUrl` reads them at boot and defers selection
// until `networks()` seeds. Pre-J, the SW's `existing.navigate(url)`
// reloaded the SPA at `/` and dropped the deep-link entirely.
installPushTargetListener();
applyPushTargetFromUrl();

// #181 — auto-renew a dropped push subscription on the SW-update /
// app-resume seams. iOS silently drops `pushManager.getSubscription()`
// across a bundle-refresh SW-swap or a backgrounded storage eviction and
// nothing re-subscribed, so push died silently while the row rotted as a
// server-side ghost. RENEW-ONLY (never prompts): a no-op unless the user
// already opted in and the live subscription is gone. See
// `lib/pushResubscribe.ts`.
installPushResubscribe(token);

// S3.3 — pagehide immediate-away hint.
//
// Both `pagehide` and `beforeunload` are registered. `pagehide` is the
// preferred modern event (fires on bfcache entry AND actual unload;
// `beforeunload` does not fire reliably in all browser/mobile scenarios).
// `beforeunload` is the legacy fallback for environments that don't support
// `pagehide` (older Chrome, some WebViews). Both call `notifyClientClosing`
// which is idempotent — the server-side client_closing handler calls
// WSPresence.client_closing/2 which is itself idempotent (MapSet delete
// is a no-op on an already-removed pid). No risk in firing both.
//
// Fire-and-forget: the push is non-blocking. The socket may not have time
// to flush the message before the page tears down, but `pagehide` on modern
// browsers gives the page enough time to enqueue the WS frame. The 30s
// debounce on the server side is the safety net for when the push doesn't
// reach the server.
window.addEventListener("pagehide", notifyClientClosing);
window.addEventListener("beforeunload", notifyClientClosing);

// #182/#192 — foreground push-suppression: report PWA presence to the server
// on every transition. Presence = visibilityState "visible" AND window focus,
// so the report is driven off documentVisibility.ts's isDocumentVisible signal
// (which tracks visibilitychange + window focus/blur — reliable on iOS PWAs,
// unlike the SW's clients.matchAll). #192: a raw `visibilitychange` listener
// missed the "desktop tab on-screen but unfocused" case, so a blurred tab
// pinned presence and #182's per-user gate suppressed Web Push on every
// device. Reusing the signal shares one set of listeners (no parallel
// registration). The initial state is reported on user-channel join (see
// socket.ts joinUser); this effect keeps it live on every focus/visibility
// transition after.
// #318 — plus a foreground HEARTBEAT. The edge report above fires only on
// a visibility TRANSITION; on iOS PWA background the transition often never
// fires (visibilitychange is unreliable), so the server kept reading the
// socket as visible and suppressed push until the zombie socket died
// (~90 min). While genuinely foreground the heartbeat re-reports on a fixed
// interval so the server (WSPresence read-time staleness) can tell a live
// foreground PWA (fresh reports) from a backgrounded one whose JS timers
// suspend OR whose visibilityState silently flips (reportVisibility re-reads
// the live property each tick). Reuses the `visibility` verb — see
// lib/visibilityHeartbeat.ts. Stops the interval when hidden.
createRoot(() => {
  const heartbeat = createVisibilityHeartbeat(reportVisibility);
  createEffect(() => {
    const visible = isDocumentVisible();
    reportVisibility();
    heartbeat.setVisible(visible);
  });
});

const root = document.getElementById("root");
if (!root) throw new Error("#root not found in index.html");

// `RequireAuth` reads `isAuthenticated()` reactively and bounces to
// /login when the token signal goes null. `createEffect` re-runs on every
// signal change, so explicit logouts and 401-driven token clears both
// flow through the same redirect path — no special-case after-logout
// handling needed in the components that drop the token.
const RequireAuth: Component<{ children: JSX.Element }> = (props) => {
  const navigate = useNavigate();
  createEffect(() => {
    if (!isAuthenticated()) navigate("/login", { replace: true });
  });
  return <>{props.children}</>;
};

// Push notifications cluster B0 — install splash visibility.
// Re-evaluated only at boot (no reactive deps). The two gates
// (display-mode + localStorage choice) don't change without a
// reload — Chrome flips display-mode on the install transition,
// which navigates away from the tab anyway; and the localStorage
// choice only changes via the splash's own dismiss path.
const isStandalone = isStandalonePwa();
const storedChoice = localStorage.getItem(INSTALL_CHOICE_KEY);
const [showSplash, setShowSplash] = createSignal(
  shouldShowInstallSplash({ isStandalone, storedChoice }),
);

render(
  () => (
    <>
      <Show when={showSplash()}>
        <InstallSplash onDismiss={() => setShowSplash(false)} />
      </Show>
      <Router>
        <Route path="/login" component={Login} />
        {/* Visitor session-sharing landing — outside RequireAuth so
            the link works even when the destination device has no
            existing bearer. The route auto-consumes the one-shot
            signed token and navigates into Shell once localStorage
            is populated. */}
        <Route path="/share/:token" component={ShareConsume} />
        <Route
          path="/"
          component={() => (
            <RequireAuth>
              <Shell />
            </RequireAuth>
          )}
        />
      </Router>
    </>
  ),
  root,
);

// Workbox-backed service worker compiled from `src/service-worker.ts`
// (push notifications cluster B0 switched vite-plugin-pwa from
// `generateSW` → `injectManifest` so we own the SW source). The
// precache manifest is embedded into the SW bytes at build time, so
// any deploy that bumps an asset hash bumps the SW byte content,
// triggering re-install + cache eviction on the next page load.
// Default registration timing (deferred until `window.load`) avoids
// contending with first-paint asset fetches for bandwidth on slow
// connections — Workbox author flags `immediate: true` as
// not-recommended for exactly this reason.
//
// #120 — pass callbacks so a registration FAILURE is no longer swallowed
// silently (CLAUDE.md no-silent-swallow). `onRegisterError` feeds the
// `swRegistration` signal → the #119 unified stacked error region shows a typed
// `sw-registration` warn entry carrying the error name+message; that captured
// detail is ALSO the #181 push-notification diagnostic lever (read via the
// `window.__cic_swRegistration` hook / the signal accessor). `onRegisteredSW`
// (the non-deprecated success callback) records the healthy outcome for
// devtools/#181 only — no banner. Registration TIMING is unchanged: still the
// default deferred-until-`window.load` behaviour above; only observability is
// added.
registerSW({
  onRegisterError: (error) => recordSwRegError(error),
  onRegisteredSW: (_swScriptUrl, registration) => recordSwRegistered(registration),
});
