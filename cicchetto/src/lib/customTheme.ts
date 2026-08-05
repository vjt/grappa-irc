import { createEffect, createSignal } from "solid-js";
import { token } from "./auth";
import { identityMoved } from "./identityMoved";
import { moduleRoot } from "./moduleRoot";
import { prefersDark } from "./theme";
import type { ActiveThemePair, TokenPayload } from "./themesApi";
import { getActiveThemePair, setActiveThemePair } from "./themesApi";
import type { ThemesWireT } from "./wireTypes";

// #75 sub-task 5 — the custom-theme apply engine. #358 — day/night pairing.
//
// A theme's frozen token payload (`TokenPayload`) is turned into scoped
// CSS custom properties written directly onto `document.documentElement`
// via `style.setProperty`. Those inline props cascade OVER the base
// `:root[data-theme="…"]` blocks in `themes/default.css`, so a custom
// theme overrides the built-in light/dark palette without a rebuild and
// with no FOUC (the boot path applies the localStorage-cached payload
// synchronously before render, mirroring `applyTheme()` / font-size).
//
// Active theme is SERVER-owned (`UserSettings.active_theme_id` +
// `dark_theme_id`, read via `GET /me/theme`). cic never originates it — it
// applies whatever the server resolves, and writes changes back through
// `PUT /me/theme` (`activateThemePair`). The localStorage cache is a pure
// offline mirror for the first paint, refreshed from the server on login.
//
// #358 — the active theme is a `{light, dark}` PAIR: the light (day) slot and
// an optional dark (night) slot. WHICH slot paints is derived from the OS
// `prefers-color-scheme` signal (`theme.ts` `prefersDark`), the SAME signal
// the base [data-theme] already follows — no scheduler, no geolocation. The
// server owns the pair (state); cic derives the resolution (view). A `null`
// dark falls back to the light slot, so a single pick applies in both modes
// (the #75 behaviour, preserved).

// The 11 named color keys + nick_0..15 — mirror of
// `Grappa.Themes.TokenModel.color_keys/0`. Exported so the editor's grouped
// picker vocabulary can be pinned against it (no silent drift into a
// non-editable key).
export const COLOR_KEYS: string[] = [
  "bg",
  "bg_alt",
  "fg",
  "accent",
  "muted",
  "border",
  "mention",
  "mode_op",
  "mode_halfop",
  "mode_voiced",
  "mode_plain",
  ...Array.from({ length: 16 }, (_, i) => `nick_${i}`),
];

// Base monospace fallback stack (mirror of `themes/default.css` :root
// `--font-mono`) appended after a named family so an unshipped @font-face
// (sub-task 8) degrades gracefully.
const FONT_FALLBACK_STACK =
  'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

const CACHE_KEY = "grappa-custom-theme";

// Map a token color key to its CSS custom property: `nick_N` →
// `--nick-color-N`, everything else `--<key-with-dashes>`.
function cssVarForColor(key: string): string {
  const nick = key.match(/^nick_(\d+)$/);
  if (nick) return `--nick-color-${nick[1]}`;
  return `--${key.replace(/_/g, "-")}`;
}

// Every CSS custom property a theme can touch — the closed set used to
// clear back to the base cascade on logout / null-apply.
export const THEME_CSS_VARS: string[] = [
  ...COLOR_KEYS.map(cssVarForColor),
  "--font-mono",
  "--theme-bg-image",
  "--theme-bg-opacity",
  "--theme-bg-size",
  "--theme-bg-repeat",
];

// Pure: token payload → CSS custom property map. `mono-default` omits
// `--font-mono` so the base stack wins; a named family overrides it with
// a graceful fallback. Background maps to `--theme-bg-image` (a scoped
// `url()` or `none`), `--theme-bg-opacity`, and the #294 sizing pair
// `--theme-bg-size`/`--theme-bg-repeat` the wallpaper `::before` consumes.
//
// A `builtin` key resolves to the static /backgrounds/<key>.webp asset and
// takes precedence over an uploaded `image_id` (the two are mutually exclusive
// server-side). `size === "repeat"` → tile at natural size; anything else
// (cover, or a legacy pre-#294 payload where `size` is absent) → full-bleed
// cover — so an old cached/wire payload degrades safely.
export function tokenToCssVars(payload: TokenPayload): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload.colors)) {
    vars[cssVarForColor(key)] = value;
  }
  if (payload.font_family !== "mono-default") {
    vars["--font-mono"] = `"${payload.font_family}", ${FONT_FALLBACK_STACK}`;
  }
  const bg = payload.background;
  vars["--theme-bg-image"] = bg.builtin
    ? `url("/backgrounds/${bg.builtin}.webp")`
    : bg.image_id
      ? `url("/uploads/${bg.image_id}")`
      : "none";
  vars["--theme-bg-opacity"] = String(bg.opacity);
  const tile = bg.size === "repeat";
  vars["--theme-bg-size"] = tile ? "auto" : "cover";
  vars["--theme-bg-repeat"] = tile ? "repeat" : "no-repeat";
  return vars;
}

// Apply a payload (or clear back to base on null). Stale vars not present
// in the new map are removed first so switching from a named-font theme
// to a mono-default one drops the `--font-mono` override.
export function applyCustomTheme(payload: TokenPayload | null): void {
  const root = document.documentElement;
  if (payload === null) {
    for (const v of THEME_CSS_VARS) root.style.removeProperty(v);
    root.classList.remove("theme-has-bg");
    return;
  }
  const vars = tokenToCssVars(payload);
  for (const v of THEME_CSS_VARS) {
    if (!(v in vars)) root.style.removeProperty(v);
  }
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
  // Gate the wallpaper layer + pane translucency (themes/default.css) on a
  // class — CSS can't branch on `--theme-bg-image` being "none". Only a
  // theme carrying a background (an upload OR a #294 built-in) engages the
  // layer; clearing it drops back to the opaque base bg.
  root.classList.toggle(
    "theme-has-bg",
    Boolean(payload.background.image_id || payload.background.builtin),
  );
}

// #358 — the cached day/night payload pair. `light` is the day slot, `dark`
// the optional night slot (null = same theme both modes).
export type PayloadPair = { light: TokenPayload | null; dark: TokenPayload | null };

const EMPTY_PAIR: PayloadPair = { light: null, dark: null };

// Resolve which slot's payload paints for a given mode: dark mode → the dark
// slot with a light fallback (an unpaired single pick applies in both modes);
// light mode → always the light slot.
export function resolvePayloadForMode(pair: PayloadPair, dark: boolean): TokenPayload | null {
  return dark ? (pair.dark ?? pair.light) : pair.light;
}

// The mode the app should paint RIGHT NOW: the gallery preview override when
// set, otherwise the OS `prefers-color-scheme`. Shared by the store apply
// effect and the editor's restore-on-cancel snapshot so both resolve the SAME
// slot — otherwise cancelling an edit while previewing the night theme in
// daylight would flash to the day theme.
function resolvedModeIsDark(override: "light" | "dark" | null): boolean {
  return override !== null ? override === "dark" : prefersDark();
}

// Read the cached pair, defending BOTH the parse AND the shape. This runs at
// module top-level (main.tsx boot, before render, outside any ErrorBoundary),
// so a malformed cache that reached `tokenToCssVars` (`Object.entries(
// payload.colors)`) would throw and white-screen the PWA on every boot — and
// the bad cache reloads each time, bricking it. A wrong-shaped object is
// treated as "no cache". A legacy #75 cache (a bare `TokenPayload`, no
// `{light,dark}`) is read as the light slot so an existing user's theme
// survives the upgrade unchanged.
function readCachePair(): PayloadPair {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw === null) return EMPTY_PAIR;
    const parsed = JSON.parse(raw) as unknown;
    if (isPayloadPairShape(parsed)) {
      return {
        light: isTokenPayloadShape(parsed.light) ? parsed.light : null,
        dark: isTokenPayloadShape(parsed.dark) ? parsed.dark : null,
      };
    }
    // Legacy #75 single-payload cache → treat as the day (light) slot.
    if (isTokenPayloadShape(parsed)) return { light: parsed, dark: null };
    return EMPTY_PAIR;
  } catch {
    return EMPTY_PAIR;
  }
}

// The payload currently PERSISTED as applied FOR THE CURRENT MODE — the
// editor's snapshot source for restore-on-cancel. Live preview
// (`applyCustomTheme`) deliberately leaves the cache untouched, so mid-edit
// this still returns the pre-edit active theme (or null = base cascade). Same
// defend-the-shape read as boot, so a corrupt cache degrades to "no
// snapshot", never a throw.
export function getAppliedThemePayload(): TokenPayload | null {
  return resolvePayloadForMode(readCachePair(), resolvedModeIsDark(store.previewMode()));
}

// A `{light, dark}` cache object (vs a legacy bare `TokenPayload`, which
// carries `colors`). Either slot may be null.
function isPayloadPairShape(v: unknown): v is { light: unknown; dark: unknown } {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return ("light" in o || "dark" in o) && !("colors" in o);
}

function isTokenPayloadShape(v: unknown): v is TokenPayload {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.colors === "object" &&
    o.colors !== null &&
    typeof o.background === "object" &&
    o.background !== null
  );
}

function writeCache(pair: PayloadPair): void {
  try {
    if (pair.light || pair.dark) localStorage.setItem(CACHE_KEY, JSON.stringify(pair));
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    // localStorage unavailable (private mode / quota) — the server round
    // trip on next login re-establishes the theme; the cache is a
    // best-effort FOUC mirror only.
  }
}

// #358 — active-theme state. `activePair` are the resolved day/night theme
// IDS (the gallery's day/night markers); `payloads` are their token payloads;
// `previewMode` is a gallery-only override so selecting the Night slot paints
// the night theme even in daylight (cleared on leaving the gallery — the
// automatic behaviour always follows the OS). Own root (module-lifetime), fed
// by the boot cache, the mount sync, and `activateThemePair`.
const store = moduleRoot(() => {
  const [activePair, setActivePair] = createSignal<{ light: number | null; dark: number | null }>({
    light: null,
    dark: null,
  });
  const [payloads, setPayloads] = createSignal<PayloadPair>(EMPTY_PAIR);
  const [previewMode, setPreviewMode] = createSignal<"light" | "dark" | null>(null);

  // The SINGLE apply authority. Re-runs whenever the payloads change
  // (login / activate / logout), the OS color scheme flips (`prefersDark`),
  // or the gallery sets a preview override — so an OS light/dark flip
  // re-paints the matching slot live, no re-fetch. Day (light) mode paints
  // the light slot; night (dark) mode the dark slot with a light fallback.
  createEffect(() => {
    applyCustomTheme(resolvePayloadForMode(payloads(), resolvedModeIsDark(previewMode())));
  });

  return { activePair, setActivePair, payloads, setPayloads, previewMode, setPreviewMode };
});

// The resolved day/night theme ids — the gallery's slot markers.
export const activePair = store.activePair;

// #358 gallery preview override: "light" | "dark" paints that slot regardless
// of the OS; null (the default) follows the OS `prefers-color-scheme`. The
// gallery sets it while its slot selector is open and clears it on close, so
// the shipped auto-swap behaviour is never overridden outside the picker.
export const setThemePreviewMode = store.setPreviewMode;

// Boot entry (main.tsx, BEFORE render) — seed the cached pair + apply the
// resolved-for-current-mode payload synchronously so the first frame already
// carries the operator's theme (the store effect's first flush is deferred
// past the first paint, so this imperative apply is what kills FOUC). The
// server round-trip in `mountCustomThemeSync` refreshes it after login.
export function applyCachedCustomTheme(): void {
  const pair = readCachePair();
  store.setPayloads(pair);
  applyCustomTheme(resolvePayloadForMode(pair, prefersDark()));
}

// Reactive server sync — re-runs on every `token()` change. On login, fetch
// the resolved pair and apply + cache it; on logout, clear the theme, cache,
// and ids. Registered inside a `createRoot` by main.tsx (mirrors
// `mountBadgeSync`).
export function mountCustomThemeSync(): void {
  createEffect(() => {
    const t = token();
    if (!t) {
      store.setActivePair({ light: null, dark: null });
      store.setPayloads(EMPTY_PAIR);
      writeCache(EMPTY_PAIR);
      return;
    }
    void getActiveThemePair(t)
      .then((pair) => {
        // Token rotated mid-flight — a later effect run owns the DOM and the
        // boot cache now (#837).
        if (identityMoved(t)) return;
        applyResolvedPair(pair);
      })
      .catch((e) => {
        // Offline / transient failure — keep the boot-cached apply. Log
        // for observability so a PERSISTENT server error (e.g. a 500 on
        // /me/theme) isn't fully invisible.
        console.warn("customTheme: active-theme refresh failed", e);
      });
  });
}

// User action — set the full day/night pair server-side, then apply the
// authoritative payloads the server returns (never the optimistic client
// copy) + cache them. `light` is required; `dark` null is a single pick.
// Surfaces `ApiError` on failure so the caller can show the error.
export async function activateThemePair(
  t: string,
  light: number,
  dark: number | null,
): Promise<void> {
  applyResolvedPair(await setActiveThemePair(t, light, dark));
}

// Convenience for "make THIS theme active" (the editor save + gallery copy
// flows) — it keeps the day/night pairing intact: re-activating the current
// night theme (e.g. an in-place edit) keeps it in the night slot; anything
// else becomes the day slot while the night slot is preserved. So editing a
// paired theme never silently collapses the pair.
export async function activateTheme(t: string, theme: ThemesWireT): Promise<void> {
  const cur = store.activePair();
  if (cur.dark === theme.id) {
    await activateThemePair(t, cur.light ?? theme.id, theme.id);
  } else {
    await activateThemePair(t, theme.id, cur.dark);
  }
}

function applyResolvedPair(pair: ActiveThemePair): void {
  const payloads: PayloadPair = {
    light: (pair.light?.payload as TokenPayload | undefined) ?? null,
    dark: (pair.dark?.payload as TokenPayload | undefined) ?? null,
  };
  store.setPayloads(payloads); // the store effect paints the resolved slot
  store.setActivePair({ light: pair.light?.id ?? null, dark: pair.dark?.id ?? null });
  writeCache(payloads);
}
