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

// #1223 — the ADMIN console's own breakpoint, which is not the shell's.
//
// Everything about the console changes at 900px, not 768px: the desktop
// nav rail (`.admin-pane` grid), the two-column form grid, the table
// stacking block and `.adm-col-detail`'s drop are all written against
// `900px` / `899px` in `themes/default.css`. Between 769 and 899 the
// shell is a desktop and the console is already a stack of cards, so an
// admin component that branches on `isMobile()` reads the wrong regime
// for a 130px-wide band — which is how the Users and Credentials tables
// came to drop their secondary columns while `AdminRowName` still
// rendered a plain span, leaving the detail panel with no door.
//
// Same literal-in-CSS caveat as `--breakpoint-mobile`: a media query
// cannot read a `var()`, so the number is mirrored, not shared.
const ADMIN_NARROW_QUERY = "(max-width: 899px)";

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

  const adminNarrowInitial =
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia(ADMIN_NARROW_QUERY).matches
      : false;
  const [adminNarrow, setAdminNarrow] = createSignal(adminNarrowInitial);

  const darkInitial =
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia(DARK_QUERY).matches
      : false;
  const [prefersDark, setPrefersDark] = createSignal(darkInitial);

  if (typeof window !== "undefined" && window.matchMedia) {
    const mm = window.matchMedia(MOBILE_QUERY);
    const listener = (e: MediaQueryListEvent) => setMobile(e.matches);
    mm.addEventListener("change", listener);

    const mmAdmin = window.matchMedia(ADMIN_NARROW_QUERY);
    mmAdmin.addEventListener("change", (e: MediaQueryListEvent) => setAdminNarrow(e.matches));

    const mmDark = window.matchMedia(DARK_QUERY);
    mmDark.addEventListener("change", (e: MediaQueryListEvent) => setPrefersDark(e.matches));

    // No cleanup arm here: the module-singleton lives for app lifetime;
    // matchMedia listeners on window are cheap and there's no token-
    // rotation analogue (viewport + OS-scheme state are identity-agnostic).
    void createEffect(() => {
      // Force the signals into the createRoot's tracking scope.
      void mobile();
      void adminNarrow();
      void prefersDark();
    });
  }

  return { isMobile: mobile, isAdminNarrow: adminNarrow, prefersDark };
});

export const isMobile = exports_.isMobile;

// #1223 — true below the ADMIN console's 900px breakpoint (see
// ADMIN_NARROW_QUERY). Every admin component whose behaviour has to match
// what the console's CSS is doing at that width reads THIS, not
// `isMobile()`; the shell's own layout keeps `isMobile()`.
export const isAdminNarrow = exports_.isAdminNarrow;

// #358 — the reactive OS dark-mode preference (true = dark). customTheme.ts's
// apply effect subscribes to it; the gallery reads it to default the slot
// selector to the current mode.
export const prefersDark = exports_.prefersDark;
