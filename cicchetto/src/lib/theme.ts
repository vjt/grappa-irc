import { createEffect, createSignal } from "solid-js";
import { applyColorScheme } from "./colorScheme";
import { moduleRoot } from "./moduleRoot";

// Boot-time base theme + reactive viewport-mode signal.
// Module-singleton pattern mirroring auth.ts / socket.ts / scrollback.ts:
// every consumer reads the same fine-grained signals, no provider
// boilerplate.
//
// The base look is one of two [data-theme] palette blocks in
// themes/default.css:
//   * "mirc-light" — white bg, mIRC palette accents
//   * "irssi-dark" — dark bg, irssi palette accents (default)
//
// #299 removed the user-facing auto/mirc/irssi selector: it was superseded
// by the #75 theme gallery (cog → themes), which layers inline CSS vars OVER
// this base, and it was broken (toggling the radio did nothing once a gallery
// theme was active). The base is now ALWAYS OS-resolved
// (prefers-color-scheme). A user who picked a gallery theme has it applied
// over this base by customTheme.ts; a user who hasn't falls back to this.
//
// `applyTheme()` is the boot-time entry called from main.tsx BEFORE
// `render()` so the first paint already has the right base — no FOUC (both
// palettes ship in one CSS file via :root[data-theme="..."] blocks).

export type ResolvedTheme = "mirc-light" | "irssi-dark";

const MOBILE_QUERY = "(max-width: 768px)";

// Resolves the OS preference via matchMedia. Defensive against environments
// without matchMedia (older browsers, SSR — neither applies to cicchetto
// today, but the boundary is cheap).
function resolveAuto(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "irssi-dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "irssi-dark" : "mirc-light";
}

// #963 — the base palette write is one of the two places a theme lands on
// <html>, so it is one of the two that re-derive `color-scheme` for the UA-
// painted surfaces (the open <option> list first of all). The other is
// customTheme.ts's overlay apply; both go through the same derivation, which
// reads whatever `--bg` resolves to after the write.
function writeDataset(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme;
  applyColorScheme();
}

// Boot-time entry. Applies the OS-resolved base theme to
// document.documentElement.dataset.theme so the first paint matches, and
// wires a media-query listener so OS-level theme changes propagate live.
export function applyTheme(): void {
  writeDataset(resolveAuto());

  if (typeof window === "undefined" || !window.matchMedia) return;
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  dark.addEventListener("change", () => writeDataset(resolveAuto()));
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

// Reactive viewport-mode + OS-color-scheme signals — both backed by
// matchMedia. Consumers (Shell.tsx for layout switch, keybindings.ts for
// gating) call isMobile() inside reactive contexts and re-render on viewport
// resize. `prefersDark()` is the reactive twin of the OS dark-mode signal:
// the base [data-theme] path (`applyTheme`) keeps its own imperative boot
// listener for FOUC, while the #75 gallery layer (customTheme.ts) subscribes
// to this signal so a #358 day/night pair re-resolves live on an OS flip —
// the SAME `prefers-color-scheme` media query the base already follows (no
// scheduler, no geolocation). createRoot anchors the listeners since
// module-level effects need an owner.
const exports_ = moduleRoot(() => {
  const initial =
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia(MOBILE_QUERY).matches
      : false;
  const [mobile, setMobile] = createSignal(initial);

  const darkInitial =
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia(DARK_QUERY).matches
      : false;
  const [prefersDark, setPrefersDark] = createSignal(darkInitial);

  if (typeof window !== "undefined" && window.matchMedia) {
    const mm = window.matchMedia(MOBILE_QUERY);
    const listener = (e: MediaQueryListEvent) => setMobile(e.matches);
    mm.addEventListener("change", listener);

    const mmDark = window.matchMedia(DARK_QUERY);
    mmDark.addEventListener("change", (e: MediaQueryListEvent) => setPrefersDark(e.matches));

    // No cleanup arm here: the module-singleton lives for app lifetime;
    // matchMedia listeners on window are cheap and there's no token-
    // rotation analogue (viewport + OS-scheme state are identity-agnostic).
    void createEffect(() => {
      // Force the signals into the createRoot's tracking scope.
      void mobile();
      void prefersDark();
    });
  }

  return { isMobile: mobile, prefersDark };
});

export const isMobile = exports_.isMobile;

// #358 — the reactive OS dark-mode preference (true = dark). customTheme.ts's
// apply effect subscribes to it; the gallery reads it to default the slot
// selector to the current mode.
export const prefersDark = exports_.prefersDark;
