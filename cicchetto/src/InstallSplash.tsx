import { type Component, createSignal, onCleanup, onMount, Show } from "solid-js";
import { isStandalonePwa } from "./lib/platform";

// Push notifications cluster B0 (2026-05-14) — pre-PWA install splash.
//
// Shown only when the page is loaded in browser-tab mode (NOT
// installed-to-home-screen) AND the user hasn't previously chosen
// "Continue from browser". The install affordance is HYBRID per
// platform (#259, 2026-07-16) because the capability differs —
// capability-detection order:
//
//   1. `beforeinstallprompt` fired (Chromium-family: Android + desktop
//      Chrome) → native "Install app" button firing the saved event's
//      `.prompt()`. No arrow, no manual steps.
//   2. else iOS Safari + NOT already standalone → the manual path
//      (iOS exposes no `beforeinstallprompt`): step text + an arrow
//      pointing at Safari's ⋯ (More) menu in the bottom-right browser
//      chrome — the real entry to Share → Add to Home Screen. iOS Web
//      Push only fires for installed-to-home-screen PWAs, so this path
//      is load-bearing on iOS.
//   3. else → graceful hide: a manual-menu hint, never a dead disabled
//      button (Firefox Mobile, Samsung Internet, desktop Firefox/Safari).
//
//   - "Continue from browser" — sets
//     `localStorage["cic.installChoice"] = "browser"` and unmounts
//     so the splash doesn't re-prompt every visit.
//
// The standalone-mode + localStorage guards live in `main.tsx` —
// this component is mounted only when the splash should appear, so
// it doesn't need to re-evaluate the gates.
//
// `beforeinstallprompt` capture: the Window event handler is
// installed at `main.tsx` boot to catch the early-fire window;
// the captured event is exposed via the `window.__cicInstallPrompt`
// global so this component can read it on mount.

declare global {
  interface Window {
    __cicInstallPrompt?: BeforeInstallPromptEvent;
  }
}

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export const INSTALL_CHOICE_KEY = "cic.installChoice";
export const INSTALL_CHOICE_BROWSER = "browser";

// Conservative iOS Safari detector. Only true on actual iOS — desktop
// Safari + Chrome-on-iOS-WebView are out of scope (Chrome-on-iOS uses
// the WKWebView push path, which inherits the Safari install requirement
// just the same; the inline-instruction UX still applies). We don't
// branch on `installPromptAvailable` alone because some Android
// browsers also drop `beforeinstallprompt` (Firefox Mobile, Samsung
// Internet) but DO support PWA install via menu — so on those we
// show the same generic "use your browser's Install option" text.
function isIOSSafari(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) && /Safari/.test(ua) && !/CriOS|FxiOS/.test(ua);
}

const InstallSplash: Component<{ onDismiss: () => void }> = (props) => {
  const [installPrompt, setInstallPrompt] = createSignal<BeforeInstallPromptEvent | null>(
    window.__cicInstallPrompt ?? null,
  );
  const [installing, setInstalling] = createSignal(false);

  // The early prompt event may have fired BEFORE this component
  // mounted (we capture it at boot in main.tsx) OR after — the latter
  // happens on slow loads where the engagement-heuristic fires post-
  // mount. Listen for the second case so the button activates as
  // soon as Chrome decides we're install-eligible.
  const onPrompt = (e: Event) => {
    e.preventDefault();
    setInstallPrompt(e as BeforeInstallPromptEvent);
  };

  onMount(() => {
    window.addEventListener("beforeinstallprompt", onPrompt);
  });

  onCleanup(() => {
    window.removeEventListener("beforeinstallprompt", onPrompt);
  });

  const handleInstall = async () => {
    const evt = installPrompt();
    if (evt === null) return;
    setInstalling(true);
    try {
      await evt.prompt();
      const choice = await evt.userChoice;
      if (choice.outcome === "accepted") {
        // appinstalled fires AFTER this; the splash unmounts via the
        // standalone-mode flip on next render. Eager dismiss here so
        // the splash doesn't linger during the install animation.
        props.onDismiss();
      }
      // If dismissed, leave splash up — user can try again or pick
      // "Continue from browser".
    } finally {
      setInstalling(false);
      // The prompt event is single-use per W3C — clear so the button
      // greys out until Chrome re-fires.
      setInstallPrompt(null);
      window.__cicInstallPrompt = undefined;
    }
  };

  const handleContinueBrowser = () => {
    localStorage.setItem(INSTALL_CHOICE_KEY, INSTALL_CHOICE_BROWSER);
    props.onDismiss();
  };

  const ios = isIOSSafari();
  const promptAvailable = () => installPrompt() !== null;
  // Capability-detection order (#259). A fired `beforeinstallprompt` wins on
  // ANY platform (Android / Chromium / desktop Chrome) — render the native
  // Install button and drop every manual hint there. `installing()` keeps
  // the button mounted while `.prompt()` / `userChoice` resolve (the event
  // is single-use and cleared only in handleInstall's finally). Falling
  // through: iOS Safari (no programmatic install API) gets the manual ⋯
  // path; everything else gracefully hides the CTA (see the three branches).
  const showInstallButton = () => promptAvailable() || installing();

  return (
    <div
      class="install-splash"
      role="dialog"
      aria-modal="true"
      aria-labelledby="install-splash-title"
    >
      <div class="install-splash-card">
        <h1 id="install-splash-title">Install Cicchetto</h1>
        <p class="install-splash-blurb">
          Install the app for the best experience — keeps you logged in and lets you receive
          notifications when channels you watch get a mention.
        </p>
        {/* 1. Native install — Android / Chromium / desktop Chrome fired
            `beforeinstallprompt`. No arrow, no manual steps: the browser
            owns the flow. */}
        <Show when={showInstallButton()}>
          <button
            type="button"
            class="install-splash-primary"
            disabled={!promptAvailable() || installing()}
            onClick={handleInstall}
          >
            {installing() ? "Installing…" : "Install app"}
          </button>
        </Show>
        {/* 2. iOS Safari manual path (#259). iOS exposes NO
            `beforeinstallprompt`, so the manual route is unavoidable — aim
            the user at Safari's ⋯ (More) menu in the bottom-right browser
            chrome, the REAL entry to Share → Add to Home Screen. Pre-#259
            the copy said "tap Share" and a ↓ arrow pointed at the in-page
            "Continue from browser" button (issue #259, IMG_9559) — the
            wrong target. Gate on !standalone: an installed PWA has no Safari
            chrome to point at. The exact arrow-to-⋯ geometry is DEVICE-VERIFY
            (CSS in themes/default.css `.install-a2hs*`). */}
        <Show when={!showInstallButton() && ios && !isStandalonePwa()}>
          <div class="install-splash-ios">
            <p data-testid="install-ios-steps">
              On iOS: tap{" "}
              <span class="install-splash-glyph" aria-hidden="true">
                ⋯
              </span>{" "}
              <strong>More</strong>, then <strong>Share</strong>, then{" "}
              <strong>Add to Home Screen</strong>.
            </p>
          </div>
          <div class="install-a2hs" data-testid="install-a2hs-arrow" aria-hidden="true">
            <span class="install-a2hs-caption">tap ⋯ here</span>
            <span class="install-a2hs-arrow">↘</span>
          </div>
        </Show>
        {/* 3. Graceful hide (#259). Non-iOS with no captured prompt (Firefox
            Mobile, Samsung Internet, desktop Firefox / Safari): no
            programmatic install AND no universal chrome to aim an arrow at.
            Prefer a manual-menu hint over a dead disabled button. */}
        <Show when={!showInstallButton() && !ios}>
          <p class="install-splash-hint">
            Not installable from this browser yet — use your browser menu's "Install" or "Add to
            Home Screen" option.
          </p>
        </Show>
        <button type="button" class="install-splash-secondary" onClick={handleContinueBrowser}>
          Continue from browser
        </button>
      </div>
    </div>
  );
};

export default InstallSplash;

// Test seam: pure predicate exposed for unit-test coverage of the
// "should the splash be shown?" logic. main.tsx reads the same two
// signals (display-mode + localStorage) before mounting the component.
export function shouldShowInstallSplash(args: {
  isStandalone: boolean;
  storedChoice: string | null;
}): boolean {
  if (args.isStandalone) return false;
  if (args.storedChoice === INSTALL_CHOICE_BROWSER) return false;
  return true;
}
