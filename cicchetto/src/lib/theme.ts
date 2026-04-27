import { createEffect, createRoot, createSignal } from "solid-js";

// Theme state + DOM dataset toggle + reactive viewport-mode signal.
// Module-singleton pattern mirroring auth.ts / socket.ts / scrollback.ts:
// every consumer reads the same fine-grained signals, no provider
// boilerplate.
//
// Three resolved themes:
//   * "mirc-light" — white bg, mIRC palette accents
//   * "irssi-dark" — dark bg, irssi palette accents (existing default)
//
// User preference persists in localStorage as one of:
//   * "mirc-light" / "irssi-dark" — explicit override
//   * (absent / "auto") — follow prefers-color-scheme
//
// `applyTheme()` is the boot-time entry called from main.tsx BEFORE
// `render()` so the first paint already has the right theme — no FOUC
// (and no flash on toggle either, because both themes ship in one CSS
// file via :root[data-theme="..."] blocks).

export type ThemePref = "mirc-light" | "irssi-dark" | "auto";
export type ResolvedTheme = "mirc-light" | "irssi-dark";

const STORAGE_KEY = "grappa-theme";
const MOBILE_QUERY = "(max-width: 768px)";

// Resolves the OS preference via matchMedia — used when ThemePref is
// "auto" to pick a concrete theme. Defensive against environments
// without matchMedia (older browsers, SSR — neither applies to cicchetto
// today, but the boundary is cheap).
function resolveAuto(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "irssi-dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "irssi-dark" : "mirc-light";
}

function readStoredPref(): ThemePref {
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === "mirc-light" || v === "irssi-dark") return v;
  return "auto";
}

function resolveTheme(pref: ThemePref): ResolvedTheme {
  return pref === "auto" ? resolveAuto() : pref;
}

function writeDataset(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme;
}

export function getTheme(): ThemePref {
  return readStoredPref();
}

export function setTheme(pref: ThemePref): void {
  if (pref === "auto") {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, pref);
  }
  writeDataset(resolveTheme(pref));
}

// Boot-time entry. Applies the stored or auto-resolved theme to
// document.documentElement.dataset.theme so the first paint matches.
// Also wires up a media-query listener so OS-level theme changes
// propagate live when the user has "auto" selected.
export function applyTheme(): void {
  const pref = readStoredPref();
  writeDataset(resolveTheme(pref));

  if (typeof window === "undefined" || !window.matchMedia) return;
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  dark.addEventListener("change", () => {
    // Only re-resolve when user is in "auto" mode; explicit override
    // ignores OS changes.
    if (readStoredPref() === "auto") {
      writeDataset(resolveTheme("auto"));
    }
  });
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
