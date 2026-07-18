import { createEffect, createRoot, createSignal } from "solid-js";

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

function writeDataset(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme;
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

// Reactive viewport-mode signal — backed by matchMedia(MOBILE_QUERY).
// Consumers (Shell.tsx for layout switch, keybindings.ts for gating)
// call isMobile() inside reactive contexts and re-render on viewport
// resize. createRoot anchors the listener since module-level effects
// need an owner.
const exports_ = createRoot(() => {
  const initial =
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia(MOBILE_QUERY).matches
      : false;
  const [mobile, setMobile] = createSignal(initial);

  if (typeof window !== "undefined" && window.matchMedia) {
    const mm = window.matchMedia(MOBILE_QUERY);
    const listener = (e: MediaQueryListEvent) => setMobile(e.matches);
    mm.addEventListener("change", listener);
    // No cleanup arm here: the module-singleton lives for app lifetime;
    // matchMedia listeners on window are cheap and there's no token-
    // rotation analogue (viewport state is identity-agnostic).
    void createEffect(() => {
      // Force the signal into the createRoot's tracking scope.
      void mobile();
    });
  }

  return { isMobile: mobile };
});

export const isMobile = exports_.isMobile;
