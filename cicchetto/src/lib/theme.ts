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

// issue 2161 — the NARROW-PANE breakpoint: the third viewport regime in this
// module, and the narrowest.
//
// In iPadOS Split View the OS keeps both horizontal screen edges for the window
// divider, so NEITHER of `Shell.tsx`'s edge swipes ever reaches the page
// (#1041's left→sidebar, #308's right→members): the gesture does not fail, it
// never arms, and there is no signal distinguishing "not supported here" from
// "I swiped wrong". vjt ruled direction 2 (`#grappa`, 2026-09-18): below a
// width threshold the window bar stays IN FLOW regardless of the #1766
// preference, and the gesture STAYS LOST — accepted, not worked around.
// Direction 1 (arming a band inboard of the system's own) is NOT taken: the
// width iPadOS reserves for the divider is unmeasured and nobody is guessing it.
//
// ## Why 383, and against what it is measured
//
// THREE widths are measured and 383 is not one of them. Each bullet below
// bounds the threshold; none of them picks it, and this comment is the only
// place that says which is which.
//
//   * `> 380` — the narrow Split View pane measured on the reporting device
//     (#2160: 380 x 650 CSS px, iPad Pro 11 landscape, installed PWA,
//     `standalone: true`). The ruling requires that width to be INSIDE.
//   * `< 384` — issue 2301: a Samsung Galaxy S Ultra in portrait, Chrome at
//     the default display zoom, reports 384 x 690 CSS px (DPR 2.81, screen
//     384 x 832). A flagship phone whose edge swipes work — and the threshold
//     1.5.10 shipped sat exactly ON it, so every one of those phones lost the
//     #1766 preference and the ☰ with it. It has to be OUTSIDE.
//   * `< 393` — `devices["iPhone 15"].viewport.width`, the narrowest viewport
//     this project's own e2e projects drive (`chromium-pixel-touch` is a
//     Pixel 7 at 412). A threshold at or above it forces the bar back on for
//     every phone the suite runs, which is #1766's own configuration — its
//     spec would go red for asserting the preference it exists to prove.
//     Subsumed by the 384 above, and kept anyway: it is the bound a red e2e
//     spec would name, because 393 is a viewport the suite actually drives.
//
// That leaves [381, 383]; inside it nothing is measured. 383 is a TIE-BREAK —
// the top of the admissible set, not a derived value. What picks the top
// rather than 381 is that nothing distinguishes the three (no viewport in that
// span has been measured either way) and the top keeps the most Split View
// pane widths inside, which is what the ruling is for.
//
// 384 WAS that tie-break (`768 / 2`, half MOBILE_QUERY's own breakpoint, so no
// new number family entered the file — tidy, and wrong): a midpoint chosen for
// arithmetic landed on a real device. That is the whole argument for writing
// down which numbers in a band are measured and which are a guess.
//
// 🔴 NOT MEASURED, and the reason 383 stays a tie-break instead of becoming a
// derivation: whether other S Ultra generations, or the same phone at another
// display-zoom setting, report the same 384. One device, one reading — a
// second measurement can move this number again.
//
// 🔴 What a width threshold CANNOT do — this is the accepted cost of ruling
// out OS sniffing, not an oversight to cure with a second threshold. A Split
// View pane WIDER than 383 (a 50/50 split on the same device is ~507 CSS px)
// loses the same two gestures and is NOT covered; and several shipping phones
// in portrait are NARROWER than the measured pane (iPhone SE 375, most Galaxy
// S 360), so they ARE covered and do lose the preference even though their
// edge swipes work. Width cannot separate "the platform ate the edge" from
// "the viewport is small".
//
// Same literal-in-CSS caveat as the two queries above — except that nothing
// mirrors this one: the window bar is a JSX MOUNT gate (#1766), never a
// `display: none`, so this number lives here and only here.
const NARROW_PANE_QUERY = "(max-width: 383px)";

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

  const narrowPaneInitial =
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia(NARROW_PANE_QUERY).matches
      : false;
  const [narrowPane, setNarrowPane] = createSignal(narrowPaneInitial);

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

    // issue 2161 — the listener is load-bearing, not symmetry: an iPadOS Split
    // View pane is RESIZED by dragging the divider, so the regime flips while
    // the page is live and a boot-time read alone would leave the window bar
    // gone in a pane the user just narrowed.
    const mmNarrow = window.matchMedia(NARROW_PANE_QUERY);
    mmNarrow.addEventListener("change", (e: MediaQueryListEvent) => setNarrowPane(e.matches));

    const mmDark = window.matchMedia(DARK_QUERY);
    mmDark.addEventListener("change", (e: MediaQueryListEvent) => setPrefersDark(e.matches));

    // No cleanup arm here: the module-singleton lives for app lifetime;
    // matchMedia listeners on window are cheap and there's no token-
    // rotation analogue (viewport + OS-scheme state are identity-agnostic).
    void createEffect(() => {
      // Force the signals into the createRoot's tracking scope.
      void mobile();
      void adminNarrow();
      void narrowPane();
      void prefersDark();
    });
  }

  return { isMobile: mobile, isAdminNarrow: adminNarrow, isNarrowPane: narrowPane, prefersDark };
});

export const isMobile = exports_.isMobile;

// #1223 — true below the ADMIN console's 900px breakpoint (see
// ADMIN_NARROW_QUERY). Every admin component whose behaviour has to match
// what the console's CSS is doing at that width reads THIS, not
// `isMobile()`; the shell's own layout keeps `isMobile()`.
export const isAdminNarrow = exports_.isAdminNarrow;

// issue 2161 — true at or below NARROW_PANE_QUERY's width (see the derivation
// there). Exactly ONE consumer by design: `showBottomBar.ts`'s
// `windowBarInFlow()`, which is what decides whether the window bar or the ☰
// is the door. A second reader would be a second policy — take it to the
// ruling first.
export const isNarrowPane = exports_.isNarrowPane;

// #358 — the reactive OS dark-mode preference (true = dark). customTheme.ts's
// apply effect subscribes to it; the gallery reads it to default the slot
// selector to the current mode.
export const prefersDark = exports_.prefersDark;
