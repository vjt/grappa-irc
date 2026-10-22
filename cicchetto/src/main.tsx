import { registerSW } from "virtual:pwa-register";
import { Route, Router, useNavigate } from "@solidjs/router";
import { type Component, createEffect, createSignal, type JSX, Show } from "solid-js";
import { render } from "solid-js/web";
import BootErrorBoundary from "./BootErrorBoundary";
import InstallSplash, { INSTALL_CHOICE_KEY, shouldShowInstallSplash } from "./InstallSplash";
import Login from "./Login";
import { me } from "./lib/api";
import { bootstrapAuth, isAuthenticated, token } from "./lib/auth";
import { moduleRoot } from "./lib/moduleRoot";
import PairScan from "./PairScan";
import ShareConsume from "./ShareConsume";
// Side-effect-only: registers the WS subscribe createRoot so per-
// channel join effects fire once `user()` + `channelsBySlug()` resolve.
// Pre-A4 this lifecycle was implicit (Shell imported `lib/networks`,
// which contained the join effect); after the verb-keyed split the
// app entry has to wire the side-effect module explicitly.
import "./lib/subscribe";
import "./lib/userTopic";
import { isDiagEnabled } from "./DiagFloat";
import { mountBadgeReconcile, mountBadgeSync } from "./lib/badge";
import { applyBoldMentionsFromStorage } from "./lib/boldMentions";
import { bootBundleHashAccessor, shouldShowRefreshBanner } from "./lib/bundleHash";
import { requestBundleRefresh } from "./lib/bundleRefreshNotice";
import { applyCachedCustomTheme, mountCustomThemeSync } from "./lib/customTheme";
import { diagPush } from "./lib/diagLog";
import { mountDisplayPrefsSync } from "./lib/displayPrefs";
import { isDocumentVisible } from "./lib/documentVisibility";
import { mountIdentitySync } from "./lib/e2e/identity";
import { identitySynced, mountEncryptedChats } from "./lib/encryptedChats";
import { applyFontSizeFromStorage } from "./lib/fontSize";
import { installGlobalPaste } from "./lib/globalPaste";
import { HIDDEN_TICK_MS, installHiddenProbe } from "./lib/hiddenProbe";
import { installKeyboardPreserve } from "./lib/keepKeyboard";
import { refetchChannels, refetchNetworks } from "./lib/networks";
import { installNotificationDismiss } from "./lib/notificationDismiss";
import { applyIos27BandClass, applyIosClass, isStandalonePwa } from "./lib/platform";
import { installPushResubscribe } from "./lib/pushResubscribe";
import { applyDeepLinkFromUrl, installPushTargetListener } from "./lib/pushTarget";
import { browserProbePerformance, installResumeProbe } from "./lib/resumeProbe";
import { installResumeResync } from "./lib/resumeResync";
import { applySharedFilesFromUrl } from "./lib/shareTargetDelivery";
import { applySidebarWidthsFromStorage } from "./lib/sidebarWidths";
import { notifyClientClosing, reportVisibility } from "./lib/socket";
import { socketHealth } from "./lib/socketHealth";
import { installStaleResumeReload } from "./lib/staleResume";
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

// issue 2167 — and for `--mention-font-weight`, the mention-bold opt-out.
// Unlike the two above this pref is SERVER-owned (a #449 synced display pref,
// reconciled by `mountDisplayPrefsSync` below); this write is the FOUC-free
// boot mirror only. The stylesheet's own `var(…, bold)` fallback covers the
// frame before it, so the worst case here is a correct default, never a flash
// of the wrong weight.
applyBoldMentionsFromStorage();

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

// issue 2190 — and, on iOS/iPadOS 27 installed PWAs ONLY, `html.is-ios27-band`
// as well, which buys 16px of clearance under the band the 27 compositor
// paints over the top edge of the web view. Separate call rather than a second
// branch inside `applyIosClass()`: this is a PORKAROUND (vjt, 2026-09-15)
// expected to die the day Apple changes the behaviour, and it has to come out
// in one piece — see the banner comment in `lib/platform.ts`. Pre-paint for
// the same reason as the line above.
applyIos27BandClass();

// PWA icon badge (2026-06-21) — wire the `badge` signal to the OS icon
// badge (`navigator.setAppBadge`) + the `document.title` mirror. Own
// root so the createEffect has an app-lifetime owner; the signal is fed
// from the `/me` seed, `read_cursor_set` broadcasts, the SW push, and
// the optimistic foreground mention bump.
moduleRoot(() => mountBadgeSync());

// #75 — refresh the custom theme from the server on every `token()`
// change: on login apply + cache the resolved `GET /me/theme` payload, on
// logout clear back to the base cascade. Own root (app-lifetime owner for
// the createEffect), alongside the other createRoot-wired effects.
moduleRoot(() => mountCustomThemeSync());

// #449 — reconcile the server-backed display prefs (presence filter #222, time
// format #217, colored nicklist #443) on every `token()` change: on login apply
// the server's prefs (or seed up the local values if the server never
// persisted), so a single account converges its UI across devices. Boot already
// seeded each owner module's signal from localStorage (FOUC-free). Own root,
// alongside the other createRoot-wired token effects.
moduleRoot(() => mountDisplayPrefsSync());

// Issue 2430 — set up this device's place in each network's E2E identity and
// keep its key bundle on grappa full, so a peer's KEYREQ is answered while
// every tab is closed. Once per page load per (subject, network); the
// vodozemac binding loads on the first sync. What each sync found goes to the
// chat glue, whose windows show an identity held elsewhere. Own root, like the
// token effects above.
moduleRoot(() => mountIdentitySync(identitySynced));
moduleRoot(() => mountEncryptedChats());

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
  // #394 — "shared": this fires on every visibilitychange with no user
  // gesture behind it, so it is exactly the caller that must fan out from a
  // `/me` already on the wire instead of adding one.
  return (await me(t, "shared")).badge_count ?? 0;
});

// UX-3 PENT — VisualViewport-driven height tracking. Writes
// `--viewport-height: <px>` on <html> and re-writes on every
// visualViewport.resize event. `.shell.shell-mobile` reads the var
// (with `100dvh` fallback) so the mobile shell shrinks in lockstep
// with the iOS on-screen keyboard. Without this, iOS scrolls the
// body to keep focused inputs visible and pushes the top bar out
// of view. Boot-time so the first frame already has the var.
// #649 — ALSO re-reads on resume (visibilitychange / pageshow /
// focus), for the app-switch return that restores the viewport
// without firing a resize. issue 2159 adds window `resize` for the
// iPadOS Split View pane drag, which backgrounds nothing and so fires
// none of those three. One writer, more triggers: the window and
// document listeners are installed by the tracker itself, so nothing
// out here (and nothing anywhere else) touches the vars.
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
// (preventDefault on MOUSEDOWN — never pointerdown, which is also
// iOS's gesture-start signal; the module header carries the rule and
// the bugs that wrote it) so iOS doesn't dismiss the
// keyboard. Replaces per-button onPointerDown wiring (UX-3 NON +
// BIS-DEC) — every new tappable surface inherits the behavior
// automatically.
installKeyboardPreserve();

// #352 — global Ctrl/Cmd+V. A single document-level paste listener: when a
// paste fires while focus is off the compose textarea (scrollback / body), it
// focuses the compose bar and routes the payload (text or image) through the
// same shared router the textarea's own onPaste uses. See lib/globalPaste.
installGlobalPaste();

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
// `applyDeepLinkFromUrl` reads them at boot and defers selection
// until `networks()` seeds. Pre-J, the SW's `existing.navigate(url)`
// reloaded the SPA at `/` and dropped the deep-link entirely.
//
// #793 — the same boot reader also consumes an invite link
// (`?go=<network>/<channel>`), which is why it is no longer named after
// push alone. Both shapes are query params on `/`, so neither one needs
// the router's cooperation; the reader captures the target before
// `render()` and holds it until the store it depends on resolves, which
// is what lets an invite survive the login round-trip.
installPushTargetListener();
applyDeepLinkFromUrl();

// #2034 — the OTHER half of the notification lifecycle, mounted next to the
// tap path it completes. A tap has always closed its notification; nothing
// ever closed one because the reader caught up in the app, so the shade kept
// banners for conversations that were read minutes ago and a later tap
// yanked the reader back to them. `installNotificationDismiss` sweeps the
// open notifications whenever a conversation comes into view and closes the
// ones naming it. See `lib/notificationDismiss.ts`.
installNotificationDismiss();

// #1103 — the THIRD boot-time shape, and the only one that is not a link: the
// OS share sheet POSTs files at the service worker, which stashes them and
// redirects here with `?shared=1`. Kept out of `applyDeepLinkFromUrl` on
// purpose — the other two shapes name a window to FOCUS, this one carries a
// payload to SEND, and folding a file handover into a target router would
// have made both harder to read. Same deferral discipline though: the reader
// waits for the stores before deciding where the files go.
applySharedFilesFromUrl();

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
// #695 — throw the document away on resume after a prolonged absence (48h by
// default). A long-lived PWA document degrades, and after two days suspended
// it is worth reloading rather than resuming. Measured from a persisted
// stamp — no timer can have run across the suspension — and reloaded through
// `performRefresh`, the SAME SW-aware verb the #674 refresh banner uses,
// never a second reload path beside it.
//
// The heartbeat below runs the returned CHECK, not a bare stamp write: on iOS
// the background transition frequently never fires, so the interval is simply
// frozen with the document and its first tick after the thaw is the only
// trigger that can observe the absence at all. A tick that stamped without
// checking would erase the evidence instead of acting on it.
// #674 — the same check also applies a DEPLOY that landed while nobody was
// looking, gated on a 10-minute dwell of its own. `shouldShowRefreshBanner` is
// the discriminant; below the dwell the refresh banner keeps the case and the
// operator owns the timing. Because that same heartbeat re-stamps every 30s
// while genuinely foreground, "the stamp is old" IS "the document was not
// visible" — the dwell needs no second visibility read.
// #775 — and it announces itself once it lands. The refresh throws this
// document away, so the notice is handed across the navigation: marked HERE as
// the reload is requested, carrying the hash this document is leaving, and
// consumed by the next document when `Toasts` mounts (an `aria-live` region
// only speaks mutations it is already in the tree for). Only the deploy branch
// marks — a document thrown away for age has nothing to tell anyone.
moduleRoot(() => {
  const checkStaleResume = installStaleResumeReload({
    isVisible: isDocumentVisible,
    bundleMismatch: shouldShowRefreshBanner,
    now: () => Date.now(),
    // #1063 — the branch still decides, the notice module still owns the
    // write. `"auto"` announces only when the bundle actually moved (#674
    // unchanged); `"silent"` marks nothing at all, because a document thrown
    // away for AGE (#695) has nothing to tell anyone either way.
    reload: (reason) =>
      void requestBundleRefresh(
        Date.now(),
        bootBundleHashAccessor(),
        reason === "bundle" ? "auto" : "silent",
      ),
    win: window,
  });
  const heartbeat = createVisibilityHeartbeat(() => {
    reportVisibility();
    checkStaleResume();
  });
  createEffect(() => {
    const visible = isDocumentVisible();
    reportVisibility();
    heartbeat.setVisible(visible);
  });
  // #697 — resume-path instrument. Measures the SYMPTOM (frame scheduling
  // delay, plus feature-detected long-task and input-delay observers) rather
  // than wrapping the ten consumers that run on this same transition, so one
  // cheap reading can rule out "our JS blocks the main thread" before anything
  // invasive is added. Gated on `isDiagEnabled` — nothing runs, and no line is
  // recorded, unless the operator turned diagnostics on in Settings.
  installResumeProbe({
    isVisible: isDocumentVisible,
    enabled: isDiagEnabled,
    push: diagPush,
    now: () => performance.now(),
    raf: (cb) => void requestAnimationFrame(cb),
    perf: browserProbePerformance(),
    win: window,
  });
  // #1873 — the THIRD refresh door onto the network/channel tree. The other
  // two are the live `channels_changed` broadcast and `subscribe.ts`'s resync
  // on a non-open → open socket edge; a process the OS froze walks through
  // neither, so a channel joined on another device stayed invisible until a
  // kill-and-reopen. Same resume seam as the two installers above — the
  // visibility SSOT injected as a signal, no parallel listener — and the same
  // pair the socket edge refetches, so the two doors cannot drift.
  installResumeResync({
    isVisible: isDocumentVisible,
    resync: () => {
      refetchNetworks();
      refetchChannels();
    },
    win: window,
  });
  // #1061 — background-burn instrument. The mirror image of the resume probe:
  // that one measures the transition INTO the foreground, this one measures
  // the interval spent OUT of it, which is where the reported full-core drain
  // happens and where neither rAF nor a Web Inspector session can reach
  // without a Mac. Same gate, same one-line-per-episode discipline.
  installHiddenProbe({
    isVisible: isDocumentVisible,
    enabled: isDiagEnabled,
    push: diagPush,
    now: () => performance.now(),
    counters: () => {
      const h = socketHealth();
      return { connectAttempts: h.connectAttempts, errorsTotal: h.errorsTotal };
    },
    startTicker: (onTick) => {
      const id = setInterval(onTick, HIDDEN_TICK_MS);
      return () => clearInterval(id);
    },
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
        {/* Session-sharing landing — outside RequireAuth so
            the link works even when the destination device has no
            existing bearer. The route auto-consumes the one-shot
            signed token and navigates into Shell once localStorage
            is populated.
            No `:token` segment (#1404): the token rides the FRAGMENT,
            which the browser keeps to itself and does not transmit.
            `ShareConsume` reads it from `location.hash`. */}
        <Route path="/share" component={ShareConsume} />
        {/* issue 2430, X1 — where the OS camera lands after scanning another
            device's pairing QR. Outside RequireAuth for the reason /share is:
            a bounce to /login would lose the fragment the code rides. */}
        <Route path="/pair" component={PairScan} />
        {/* #717 — the boundary wraps Shell ONLY, inside RequireAuth. A boot
            fetch that rejects puts its resource in `errored` state and every
            read re-throws (CrtSplash's `!user()` predicate among them); with
            no boundary the throw froze the DOM on the splash forever, which
            is the reported installed-PWA symptom. Scoped to Shell rather than
            the Router so routing survives the crash: RequireAuth's effect
            still bounces to /login if the token is cleared while the failure
            state is up, and /login + /share keep their own error surfaces. */}
        <Route
          path="/"
          component={() => (
            <RequireAuth>
              <BootErrorBoundary>
                <Shell />
              </BootErrorBoundary>
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
