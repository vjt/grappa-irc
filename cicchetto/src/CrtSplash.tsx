import { type Component, Show } from "solid-js";
import { channelsBySlug, user } from "./lib/networks";

// #134 — retro CRT splash / loading screen.
//
// LOADING-ONLY by contract. This is the content of the Shell main-pane
// `<Switch fallback>` (desktop + mobile): the fallback only renders when
// `selectedChannel()` is null, which in practice is the cold-load window
// BEFORE Shell's auto-select effect lands on `$home`. The splash animates
// while cic boots, then HANDS OFF to the home window — it is NOT a
// persistent "no-channel-selected" empty state and must never block the
// auto-select handoff.
//
// The `loading` predicate mirrors Shell's cold-load auto-select wait
// EXACTLY (Shell.tsx ~L445-454): `!user()` (/, me not resolved) OR
// `channelsBySlug() === undefined` (createResource is `undefined` while
// loading; a resolved `{}` is truthy → load done, just no channels yet).
// Reusing the same predicate guarantees the splash clears on the same
// reactive tick the handoff fires, with no parallel "still loading"
// notion to drift.
//
// Pattern mirror: InstallSplash.tsx (self-contained splash component +
// `.install-splash*` CSS in themes/default.css). All chrome is CSS/SVG —
// no external asset pipeline, theme-aware via CSS vars. The IRC-text-only
// scrollback invariant is unaffected: this is app chrome, not inline
// scrollback media.

// Fake POST / boot lines for nerd flavour. Static text (no typing
// animation) keeps it cheap to render and free of timing flake.
const BOOT_LINES: readonly string[] = [
  "GRAPPA TERMINAL  ·  phosphor edition",
  "POST ............................ OK",
  "scrollback subsystem ............ OK",
  "phoenix channels link ........... OK",
  "connecting to bouncer ...",
];

const CrtSplash: Component = () => {
  const loading = (): boolean => !user() || channelsBySlug() === undefined;

  return (
    <Show when={loading()}>
      <div
        class="crt-splash"
        data-testid="crt-splash"
        role="status"
        aria-live="polite"
        aria-label="Loading Grappa"
      >
        <div class="crt-splash-screen">
          {/* Boot text + blinking cursor live above the scanline /
              vignette overlays so the phosphor glow reads through. */}
          <div class="crt-splash-content">
            <pre class="crt-splash-boot" aria-hidden="true">
              {BOOT_LINES.join("\n")}
            </pre>
            <p class="crt-splash-status">
              <span class="crt-splash-loading-text">LOADING</span>
              <span class="crt-splash-cursor" aria-hidden="true">
                █
              </span>
            </p>
          </div>
          <div class="crt-splash-scanlines" aria-hidden="true" />
          <div class="crt-splash-vignette" aria-hidden="true" />
        </div>
      </div>
    </Show>
  );
};

export default CrtSplash;
