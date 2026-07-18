// Typed REST client for the #75 themes surface. Mirrors `api.ts` and
// reuses its `buildHeaders` (JSON + x-grappa-client-id) and `readError`
// (wire-token → `ApiError.code`, plus the shared 401 dead-token handler)
// so these verbs behave identically to the rest of the REST surface.
//
// Keep the wire shapes in lockstep with `lib/grappa/themes/wire.ex`
// (`ThemesWireT`, generated in `wireTypes.ts`) and the token vocabulary
// frozen in `Grappa.Themes.TokenModel` — `TokenPayload` below is the
// typed refinement of `ThemesWireT.payload` (which the server keeps
// `Record<string, unknown>` on the wire).

import { buildHeaders, readError } from "./api";
import { getOrCreateClientId } from "./clientId";
import type { ThemesWireT } from "./wireTypes";

// The closed font-family allow-list — mirror of
// `Grappa.Themes.TokenModel.font_families/0`. `mono-default` maps to the
// existing `--font-mono` stack (no font file); the rest each get a
// self-hosted `@font-face` (sub-task 8, deferred).
export type ThemeFontFamily =
  | "mono-default"
  | "jetbrains-mono"
  | "fira-code"
  | "iosevka"
  | "hack"
  | "cascadia-code"
  | "source-code-pro"
  | "ibm-plex-mono";

// The 27 color keys — mirror of `Grappa.Themes.TokenModel.color_keys/0`.
// Each value is a strict `#rrggbb` string (validated server-side; cic
// treats them as opaque CSS color literals via `customTheme.ts`).
export type ThemeColorKey =
  | "bg"
  | "bg_alt"
  | "fg"
  | "accent"
  | "muted"
  | "border"
  | "mention"
  | "mode_op"
  | "mode_halfop"
  | "mode_voiced"
  | "mode_plain"
  | `nick_${number}`;

export type TokenColors = Record<ThemeColorKey, string>;

// The frozen token vocabulary — the sanitized payload every theme carries.
// Producers can only express what this allows; anything else is dropped
// server-side (safe-by-construction). `customTheme.ts` consumes this to
// generate scoped CSS custom properties.
// Background sizing — mirror of `Grappa.Themes.TokenModel.size_modes/0`.
// `cover` = full-bleed (the v1 built-in set + every upload); `repeat` =
// seamless tile (the deferred #294 pattern set).
export type ThemeBackgroundSize = "cover" | "repeat";

export type TokenPayload = {
  colors: TokenColors;
  font_family: ThemeFontFamily;
  background: {
    // Uploads slug of the re-hosted background image, or null for none.
    image_id: string | null;
    // #294 — a member of the server-owned BuiltinBackgrounds catalog, or null.
    // Mutually exclusive with image_id (a background is EITHER an upload OR a
    // built-in). Resolves to /backgrounds/<builtin>.webp in customTheme.
    builtin: string | null;
    // #294 — cover (v1 default) or repeat (deferred tile mode).
    size: ThemeBackgroundSize;
    // 0.0..1.0; default 0.3.
    opacity: number;
  };
};

// One entry in the built-in background catalog (`GET /themes/backgrounds`) —
// mirror of `Grappa.Themes.BuiltinBackgrounds.t`. The picker consumes this;
// `path` is the static /backgrounds/<key>.webp URL the asset is served at.
export type BuiltinBackground = {
  key: string;
  name: string;
  variant: "dark" | "light";
  path: string;
};

// Request body for create — atom-keyed at the server boundary; the wire
// `payload` value stays string-keyed (`"colors"` etc.), which
// `TokenPayload` already is.
export type CreateThemeBody = { name: string; payload: TokenPayload };

// Partial edit — name and/or payload. Omitted fields are left untouched
// server-side.
export type UpdateThemeBody = { name?: string; payload?: TokenPayload };

// Background source — an uploaded File (multipart) OR a URL the server
// fetches (SSRF-guarded). One pipeline, two entry shapes.
export type BackgroundSource = { file: File } | { url: string };

type ThemesEnvelope = { themes: ThemesWireT[] };

export async function listGallery(token: string): Promise<ThemesWireT[]> {
  const res = await fetch("/themes", { headers: buildHeaders(token) });
  if (!res.ok) throw await readError(res);
  return ((await res.json()) as ThemesEnvelope).themes;
}

export async function listMine(token: string): Promise<ThemesWireT[]> {
  const res = await fetch("/me/themes", { headers: buildHeaders(token) });
  if (!res.ok) throw await readError(res);
  return ((await res.json()) as ThemesEnvelope).themes;
}

// GET /themes/backgrounds — the server-owned built-in background catalog the
// picker renders. Server-owned so cic never hard-codes the closed set (it would
// drift from the sanitizer's allowlist).
export async function listBuiltinBackgrounds(token: string): Promise<BuiltinBackground[]> {
  const res = await fetch("/themes/backgrounds", { headers: buildHeaders(token) });
  if (!res.ok) throw await readError(res);
  return ((await res.json()) as { backgrounds: BuiltinBackground[] }).backgrounds;
}

export async function getTheme(token: string, id: number): Promise<ThemesWireT> {
  const res = await fetch(`/themes/${id}`, { headers: buildHeaders(token) });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as ThemesWireT;
}

export async function createTheme(token: string, body: CreateThemeBody): Promise<ThemesWireT> {
  const res = await fetch("/themes", {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as ThemesWireT;
}

export async function updateTheme(
  token: string,
  id: number,
  body: UpdateThemeBody,
): Promise<ThemesWireT> {
  const res = await fetch(`/themes/${id}`, {
    method: "PATCH",
    headers: buildHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as ThemesWireT;
}

export async function deleteTheme(token: string, id: number): Promise<void> {
  const res = await fetch(`/themes/${id}`, {
    method: "DELETE",
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
}

export async function publishTheme(token: string, id: number): Promise<ThemesWireT> {
  const res = await fetch(`/themes/${id}/publish`, {
    method: "POST",
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as ThemesWireT;
}

export async function unpublishTheme(token: string, id: number): Promise<ThemesWireT> {
  const res = await fetch(`/themes/${id}/unpublish`, {
    method: "POST",
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as ThemesWireT;
}

export async function copyTheme(token: string, id: number): Promise<ThemesWireT> {
  const res = await fetch(`/themes/${id}/copy`, {
    method: "POST",
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as ThemesWireT;
}

// GET /me/theme — the resolved active theme, or null (none set, or the
// stored id dangles server-side). cic falls back to its own default.
export async function getActiveTheme(token: string): Promise<ThemesWireT | null> {
  const res = await fetch("/me/theme", { headers: buildHeaders(token) });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as ThemesWireT | null;
}

// PUT /me/theme — set the active theme by id (server validates it is
// readable; unknown id → 404 not_found).
export async function setActiveTheme(token: string, id: number): Promise<ThemesWireT> {
  const res = await fetch("/me/theme", {
    method: "PUT",
    headers: buildHeaders(token),
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as ThemesWireT;
}

// POST /themes/background — upload a File (multipart "file") OR ask the
// server to fetch a URL. Returns the re-hosted uploads slug.
//
// The multipart path must NOT set a JSON content-type: the browser sets
// the `multipart/form-data; boundary=…` header itself when the body is a
// FormData, and forcing application/json here corrupts the request. So it
// builds headers inline (auth + client-id) instead of `buildHeaders`.
export async function uploadBackground(
  token: string,
  source: BackgroundSource,
): Promise<{ image_id: string }> {
  let init: RequestInit;
  if ("file" in source) {
    const form = new FormData();
    form.append("file", source.file);
    init = {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-grappa-client-id": getOrCreateClientId(),
      },
      body: form,
    };
  } else {
    init = {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify({ url: source.url }),
    };
  }
  const res = await fetch("/themes/background", init);
  if (!res.ok) throw await readError(res);
  return (await res.json()) as { image_id: string };
}
