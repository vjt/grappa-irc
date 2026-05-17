import { registerSW } from "virtual:pwa-register";
import { Route, Router, useNavigate } from "@solidjs/router";
import { type Component, createEffect, createSignal, type JSX, Show } from "solid-js";
import { render } from "solid-js/web";
import InstallSplash, { INSTALL_CHOICE_KEY, shouldShowInstallSplash } from "./InstallSplash";
import Login from "./Login";
import { bootstrapAuth, isAuthenticated } from "./lib/auth";
// Side-effect-only: registers the WS subscribe createRoot so per-
// channel join effects fire once `user()` + `channelsBySlug()` resolve.
// Pre-A4 this lifecycle was implicit (Shell imported `lib/networks`,
// which contained the join effect); after the verb-keyed split the
// app entry has to wire the side-effect module explicitly.
import "./lib/subscribe";
import "./lib/userTopic";
import { applyFontSizeFromStorage } from "./lib/fontSize";
import { installKeyboardPreserve } from "./lib/keepKeyboard";
import { notifyClientClosing } from "./lib/socket";
import { applyTheme } from "./lib/theme";
import { installScrollPin, installViewportHeightTracker } from "./lib/viewportHeight";
import Shell from "./Shell";
import "./themes/default.css";

// Pre-paint the resolved theme on document.documentElement.dataset.theme
// BEFORE render() so the first frame already has the correct theme — no
// FOUC on cold load and no flash on toggle (both themes ship in one CSS
// file via :root[data-theme="..."] blocks).
applyTheme();

// Same rationale for `--font-size`: write the CSS var on `<html>`
// BEFORE render() so the first frame already has the user's preferred
// size. iOS-4 default = "M" (14px = current behavior).
applyFontSizeFromStorage();

// UX-3 PENT — VisualViewport-driven height tracking. Writes
// `--viewport-height: <px>` on <html> and re-writes on every
// visualViewport.resize event. `.shell.shell-mobile` reads the var
// (with `100dvh` fallback) so the mobile shell shrinks in lockstep
// with the iOS on-screen keyboard. Without this, iOS scrolls the
// body to keep focused inputs visible and pushes the top bar out
// of view. Boot-time so the first frame already has the var.
installViewportHeightTracker();

// UX-3 OCT — pin window scroll. iOS auto-scrolls on input focus
// even when the input is already visible (the scroll-into-view path
// is programmatic, bypassing body { overflow: hidden }). The
// listener catches every scroll attempt and snaps back to (0, 0)
// before paint, so the app chrome never drifts.
installScrollPin();

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
const isStandalone =
  window.matchMedia("(display-mode: standalone)").matches ||
  // iOS Safari pre-17 exposes standalone mode via this proprietary
  // navigator property instead of the `display-mode` media query.
  // The cast is intentional — the typedef doesn't include it because
  // it's Safari-specific.
  (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
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
registerSW();
