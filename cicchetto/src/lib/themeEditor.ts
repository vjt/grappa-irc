import { createRoot, createSignal } from "solid-js";
import { activateTheme } from "./customTheme";
import type { TokenPayload } from "./themesApi";
import { createTheme, updateTheme } from "./themesApi";
import type { ThemesWireT } from "./wireTypes";

// #75 producer path — the theme editor's shared state + orchestration.
//
// The editor is a pane-covering overlay (ThemeEditor.tsx) opened from the
// gallery: "new theme" (seeded from a fetched built-in) or "edit" (an own
// theme). It edits a draft TokenPayload with LIVE client-side preview
// (`applyCustomTheme`), then persists via the REST verbs. cic NEVER
// originates the active theme — preview is client-only; Save persists +
// activates through the server, and the apply engine re-applies whatever
// the server resolves.

export type ThemeEditorSeed =
  | { mode: "new"; basePayload: TokenPayload }
  | { mode: "edit"; theme: ThemesWireT };

// Module-lifetime open/close signal — same shape as archiveModalNetwork.
// null = closed; a seed = open (which mode + the initial draft source).
const store = createRoot(() => {
  const [state, setState] = createSignal<ThemeEditorSeed | null>(null);
  return { state, setState };
});

export const themeEditorState = store.state;

export function openThemeEditor(seed: ThemeEditorSeed): void {
  store.setState(seed);
}

export function closeThemeEditor(): void {
  store.setState(null);
}

// Gallery-refresh trigger. A save mutates the gallery (a new card, a
// renamed/re-coloured own card), but the editor overlay leaves the gallery
// sub-page mounted underneath, so it won't re-fetch on its own. Rather than
// couple the editor to the gallery's load verb, the editor bumps a revision
// the gallery derives its reload from (one source, no parallel state).
const rev = createRoot(() => {
  const [revision, setRevision] = createSignal(0);
  return { revision, setRevision };
});

export const themesRevision = rev.revision;

export function bumpThemesRevision(): void {
  rev.setRevision((n) => n + 1);
}

// Seed a brand-new theme from the built-in the gallery ALREADY fetched —
// reuse the server's canonical default, never a hand-copied cic palette
// constant (two copies of the 27-key palette WOULD drift; orchestrator
// directive 2026-07-17). Prefers irssi-dark (the product default), else
// any built-in; returns null when the loaded gallery carries none — the
// "new theme" entry point disables itself rather than fabricate a palette.
// Deep-cloned so editing the draft can't mutate the source card's payload.
export function newThemeSeedPayload(themes: ThemesWireT[]): TokenPayload | null {
  const builtin =
    themes.find((t) => t.built_in && t.name === "irssi-dark") ?? themes.find((t) => t.built_in);
  return builtin ? structuredClone(builtin.payload as TokenPayload) : null;
}

// Save the editor draft: create (new) or update (edit own), then activate
// so the saved theme becomes the live + server-persisted active theme.
// Returns the server-authoritative saved theme (the caller applies it via
// activateTheme's re-apply of the resolved payload). Surfaces ApiError
// (rate_limited / validation_failed / forbidden …) to the caller.
export async function persistThemeDraft(
  t: string,
  seed: ThemeEditorSeed,
  name: string,
  payload: TokenPayload,
): Promise<ThemesWireT> {
  const saved =
    seed.mode === "edit"
      ? await updateTheme(t, seed.theme.id, { name, payload })
      : await createTheme(t, { name, payload });
  await activateTheme(t, saved);
  return saved;
}
