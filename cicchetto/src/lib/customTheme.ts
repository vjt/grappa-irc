import { createEffect, createRoot, createSignal } from "solid-js";
import { token } from "./auth";
import type { TokenPayload } from "./themesApi";
import { getActiveTheme, setActiveTheme } from "./themesApi";
import type { ThemesWireT } from "./wireTypes";

// #75 sub-task 5 — the custom-theme apply engine.
//
// A theme's frozen token payload (`TokenPayload`) is turned into scoped
// CSS custom properties written directly onto `document.documentElement`
// via `style.setProperty`. Those inline props cascade OVER the base
// `:root[data-theme="…"]` blocks in `themes/default.css`, so a custom
// theme overrides the built-in light/dark palette without a rebuild and
// with no FOUC (the boot path applies the localStorage-cached payload
// synchronously before render, mirroring `applyTheme()` / font-size).
//
// Active theme is SERVER-owned (`UserSettings.active_theme_id`, read via
// `GET /me/theme`). cic never originates it — it applies whatever the
// server resolves, and writes changes back through `PUT /me/theme`
// (`activateTheme`). The localStorage cache is a pure offline mirror for
// the first paint, refreshed from the server on every login.

// The 11 named color keys + nick_0..15 — mirror of
// `Grappa.Themes.TokenModel.color_keys/0`.
const COLOR_KEYS: string[] = [
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
];

// Pure: token payload → CSS custom property map. `mono-default` omits
// `--font-mono` so the base stack wins; a named family overrides it with
// a graceful fallback. Background maps to `--theme-bg-image` (a scoped
// `url()` or `none`) + `--theme-bg-opacity`. NOTE: the CSS layer that
// CONSUMES those two vars ships with the deferred background-upload UI
// (producer-path sub-task 9) — no built-in carries an image today, so the
// vars are currently dormant. The colors + font vars are the live feature.
export function tokenToCssVars(payload: TokenPayload): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload.colors)) {
    vars[cssVarForColor(key)] = value;
  }
  if (payload.font_family !== "mono-default") {
    vars["--font-mono"] = `"${payload.font_family}", ${FONT_FALLBACK_STACK}`;
  }
  vars["--theme-bg-image"] = payload.background.image_id
    ? `url("/uploads/${payload.background.image_id}")`
    : "none";
  vars["--theme-bg-opacity"] = String(payload.background.opacity);
  return vars;
}

// Apply a payload (or clear back to base on null). Stale vars not present
// in the new map are removed first so switching from a named-font theme
// to a mono-default one drops the `--font-mono` override.
export function applyCustomTheme(payload: TokenPayload | null): void {
  const root = document.documentElement;
  if (payload === null) {
    for (const v of THEME_CSS_VARS) root.style.removeProperty(v);
    return;
  }
  const vars = tokenToCssVars(payload);
  for (const v of THEME_CSS_VARS) {
    if (!(v in vars)) root.style.removeProperty(v);
  }
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
}

// Read the cached payload, defending BOTH the parse AND the shape. This
// runs at module top-level (main.tsx boot, before render, outside any
// ErrorBoundary), so a malformed cache that reached `tokenToCssVars`
// (`Object.entries(payload.colors)`) would throw and white-screen the PWA
// on every boot — and the bad cache reloads each time, bricking it. A
// wrong-shaped object is treated as "no cache" (the server refresh on the
// next login re-establishes the real theme).
function readCache(): TokenPayload | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isTokenPayloadShape(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
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

function writeCache(payload: TokenPayload | null): void {
  try {
    if (payload) localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    // localStorage unavailable (private mode / quota) — the server round
    // trip on next login re-establishes the theme; the cache is a
    // best-effort FOUC mirror only.
  }
}

// Boot entry (main.tsx, BEFORE render) — apply the cached payload
// synchronously so the first frame already carries the operator's theme.
// The server round-trip in `mountCustomThemeSync` refreshes it after
// login.
export function applyCachedCustomTheme(): void {
  applyCustomTheme(readCache());
}

// Active-theme id — the server-resolved active theme's id, mirrored for
// the gallery's "active" marker. Own root (module-lifetime), fed by the
// mount sync + `activateTheme`.
const store = createRoot(() => {
  const [activeThemeId, setActiveThemeId] = createSignal<number | null>(null);
  return { activeThemeId, setActiveThemeId };
});

export const activeThemeId = store.activeThemeId;

// Reactive server sync — re-runs on every `token()` change. On login,
// fetch the resolved active theme and apply + cache it; on logout, clear
// the custom theme, the cache, and the active id. Registered inside a
// `createRoot` by main.tsx (mirrors `mountBadgeSync`).
export function mountCustomThemeSync(): void {
  createEffect(() => {
    const t = token();
    if (!t) {
      applyCustomTheme(null);
      writeCache(null);
      store.setActiveThemeId(null);
      return;
    }
    void getActiveTheme(t)
      .then((theme) => {
        // Token rotated mid-flight — a later effect run owns the DOM now.
        if (token() !== t) return;
        applyResolved(theme);
      })
      .catch((e) => {
        // Offline / transient failure — keep the boot-cached apply. Log
        // for observability so a PERSISTENT server error (e.g. a 500 on
        // /me/theme) isn't fully invisible.
        console.warn("customTheme: active-theme refresh failed", e);
      });
  });
}

// User action — set the active theme server-side, then apply the
// authoritative payload the server returns (never the optimistic
// client copy) + cache it. Surfaces `ApiError` on failure so the
// caller can show the error.
export async function activateTheme(t: string, theme: ThemesWireT): Promise<void> {
  const resolved = await setActiveTheme(t, theme.id);
  applyResolved(resolved);
}

function applyResolved(theme: ThemesWireT | null): void {
  if (theme) {
    const payload = theme.payload as TokenPayload;
    applyCustomTheme(payload);
    writeCache(payload);
    store.setActiveThemeId(theme.id);
  } else {
    applyCustomTheme(null);
    writeCache(null);
    store.setActiveThemeId(null);
  }
}
