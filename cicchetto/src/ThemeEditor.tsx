import { type Component, createEffect, createSignal, For, Show } from "solid-js";
import { ApiError } from "./lib/api";
import { token } from "./lib/auth";
import { applyCustomTheme, getAppliedThemePayload } from "./lib/customTheme";
import { friendlyApiError } from "./lib/friendlyApiError";
import { createOverlayLock } from "./lib/overlayScrollLock";
import {
  bumpThemesRevision,
  closeThemeEditor,
  persistThemeDraft,
  themeEditorState,
} from "./lib/themeEditor";
import type { ThemeColorKey, ThemeFontFamily, TokenPayload } from "./lib/themesApi";
import { uploadBackground } from "./lib/themesApi";

// #75 producer path — the theme editor overlay.
//
// A pane-covering modal (opened from ThemeGallery's "new"/"edit" entry
// points) that edits a draft TokenPayload with LIVE client-side preview:
// every change re-applies the draft via `applyCustomTheme` so the whole
// app re-paints in real time. Preview is client-only (cic NEVER
// originates the server active theme); Save persists via createTheme /
// updateTheme then `activateTheme` (server round-trip → authoritative
// re-apply). Cancel / ESC / backdrop RESTORE the pre-open applied theme
// so an abandoned edit leaves no draft applied.
//
// Overlay scroll-lock + ESC ride the shared createOverlayLock wiring
// (`.theme-editor-modal`) — a new pane-covering modal MUST refcount the
// lock or it yanks iOS scroll (feedback_new_covering_modal_must_push…).

// Color pickers grouped by role (mirror of TokenModel's key set). nick_N
// is the 16-slot palette. `--font-mono` families are the closed allow-list.
const BASE_KEYS: ThemeColorKey[] = ["bg", "bg_alt", "fg", "accent", "muted", "border", "mention"];
const MODE_KEYS: ThemeColorKey[] = ["mode_op", "mode_halfop", "mode_voiced", "mode_plain"];
const NICK_KEYS: ThemeColorKey[] = Array.from(
  { length: 16 },
  (_, i) => `nick_${i}` as ThemeColorKey,
);
const FONT_FAMILIES: ThemeFontFamily[] = [
  "mono-default",
  "jetbrains-mono",
  "fira-code",
  "iosevka",
  "hack",
  "cascadia-code",
  "source-code-pro",
  "ibm-plex-mono",
];

const ThemeEditor: Component = () => {
  // Snapshot of the applied theme at open — restored on cancel so an
  // abandoned edit never leaks a draft. Held at component scope so the
  // top-level overlay-lock onEscape can restore it (the per-open draft
  // lives inside the keyed block below).
  let snapshot: TokenPayload | null = null;

  const cancel = () => {
    applyCustomTheme(snapshot);
    closeThemeEditor();
  };

  createOverlayLock(() => themeEditorState() !== null, ".theme-editor-modal", cancel);

  const errMessage = (e: unknown): string =>
    e instanceof ApiError ? friendlyApiError(e) : "something went wrong";

  return (
    <Show when={themeEditorState()} keyed>
      {(seed) => {
        // Capture the restore point BEFORE any preview apply. Live preview
        // never writes the cache, so this is the pre-edit active theme.
        snapshot = getAppliedThemePayload();

        const initial: TokenPayload =
          seed.mode === "edit"
            ? structuredClone(seed.theme.payload as TokenPayload)
            : structuredClone(seed.basePayload);

        const [draft, setDraft] = createSignal<TokenPayload>(initial);
        const [name, setName] = createSignal(seed.mode === "edit" ? seed.theme.name : "");
        const [error, setError] = createSignal<string | null>(null);
        const [saving, setSaving] = createSignal(false);

        // LIVE preview — re-paint the whole app on every draft change.
        createEffect(() => applyCustomTheme(draft()));

        const setColor = (key: ThemeColorKey, value: string) =>
          setDraft((d) => ({ ...d, colors: { ...d.colors, [key]: value } }));
        const setFont = (f: ThemeFontFamily) => setDraft((d) => ({ ...d, font_family: f }));
        const setOpacity = (o: number) =>
          setDraft((d) => ({ ...d, background: { ...d.background, opacity: o } }));
        const setImageId = (image_id: string | null) =>
          setDraft((d) => ({ ...d, background: { ...d.background, image_id } }));

        const uploadFrom = async (source: { file: File } | { url: string }) => {
          const t = token();
          if (t === null) return;
          setError(null);
          try {
            const { image_id } = await uploadBackground(t, source);
            setImageId(image_id);
          } catch (e) {
            setError(errMessage(e));
          }
        };

        const [bgUrl, setBgUrl] = createSignal("");

        const save = async () => {
          const t = token();
          if (t === null) return;
          const trimmed = name().trim();
          if (trimmed === "") {
            setError("Give the theme a name.");
            return;
          }
          setSaving(true);
          setError(null);
          try {
            await persistThemeDraft(t, seed, trimmed, draft());
            bumpThemesRevision();
            // Saved + activated — keep the applied theme (do NOT restore).
            closeThemeEditor();
          } catch (e) {
            setError(errMessage(e));
          } finally {
            setSaving(false);
          }
        };

        const colorRow = (key: ThemeColorKey) => (
          <label class="theme-editor-color-row">
            <span class="theme-editor-color-label">{key}</span>
            <input
              type="color"
              class="theme-editor-color-input"
              data-testid={`theme-editor-color-${key}`}
              value={draft().colors[key]}
              onInput={(e) => setColor(key, e.currentTarget.value)}
            />
          </label>
        );

        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close-on-outside; Esc via the shared overlay stack (keybindings → runTopmostOverlayEscape)
          // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is non-interactive scrim
          <div class="theme-editor-backdrop" onClick={cancel}>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: inner dialog onClick only stops backdrop-click propagation; Esc closes via the shared overlay stack */}
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="theme-editor-title"
              class="theme-editor-modal"
              data-testid="theme-editor"
              onClick={(e) => e.stopPropagation()}
              tabIndex={-1}
            >
              <header class="theme-editor-header">
                <h2 id="theme-editor-title">{seed.mode === "edit" ? "edit theme" : "new theme"}</h2>
                <button
                  type="button"
                  class="theme-editor-close"
                  aria-label="close editor"
                  data-testid="theme-editor-cancel"
                  onClick={cancel}
                >
                  ×
                </button>
              </header>

              <Show when={error() !== null}>
                <p class="theme-editor-error" role="alert" data-testid="theme-editor-error">
                  {error()}
                </p>
              </Show>

              <div class="theme-editor-body">
                <label class="theme-editor-field">
                  <span>name</span>
                  <input
                    type="text"
                    class="theme-editor-name-input"
                    data-testid="theme-editor-name"
                    value={name()}
                    onInput={(e) => setName(e.currentTarget.value)}
                    placeholder="my theme"
                  />
                </label>

                <fieldset class="theme-editor-group">
                  <legend>base</legend>
                  <For each={BASE_KEYS}>{colorRow}</For>
                </fieldset>

                <fieldset class="theme-editor-group">
                  <legend>modes</legend>
                  <For each={MODE_KEYS}>{colorRow}</For>
                </fieldset>

                <fieldset class="theme-editor-group">
                  <legend>nick palette</legend>
                  <div class="theme-editor-nick-grid">
                    <For each={NICK_KEYS}>{colorRow}</For>
                  </div>
                </fieldset>

                <label class="theme-editor-field">
                  <span>font</span>
                  <select
                    class="theme-editor-font-select"
                    data-testid="theme-editor-font"
                    value={draft().font_family}
                    onInput={(e) => setFont(e.currentTarget.value as ThemeFontFamily)}
                  >
                    <For each={FONT_FAMILIES}>{(f) => <option value={f}>{f}</option>}</For>
                  </select>
                </label>

                <fieldset class="theme-editor-group">
                  <legend>background</legend>
                  <label class="theme-editor-field">
                    <span>upload image</span>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/gif,image/webp"
                      class="theme-editor-bg-file"
                      data-testid="theme-editor-bg-file"
                      onChange={(e) => {
                        const file = e.currentTarget.files?.[0];
                        if (file) void uploadFrom({ file });
                      }}
                    />
                  </label>
                  <div class="theme-editor-field">
                    <span>or image URL</span>
                    <div class="theme-editor-bg-url-row">
                      <input
                        type="url"
                        class="theme-editor-bg-url-input"
                        data-testid="theme-editor-bg-url"
                        value={bgUrl()}
                        onInput={(e) => setBgUrl(e.currentTarget.value)}
                        placeholder="https://…"
                      />
                      <button
                        type="button"
                        class="theme-editor-action"
                        data-testid="theme-editor-bg-url-apply"
                        disabled={bgUrl().trim() === ""}
                        onClick={() => void uploadFrom({ url: bgUrl().trim() })}
                      >
                        fetch
                      </button>
                    </div>
                  </div>
                  <Show when={draft().background.image_id !== null}>
                    <button
                      type="button"
                      class="theme-editor-action"
                      data-testid="theme-editor-bg-clear"
                      onClick={() => setImageId(null)}
                    >
                      remove background
                    </button>
                  </Show>
                  <label class="theme-editor-field">
                    <span>opacity {draft().background.opacity.toFixed(2)}</span>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      class="theme-editor-opacity"
                      data-testid="theme-editor-opacity"
                      value={draft().background.opacity}
                      onInput={(e) => setOpacity(Number(e.currentTarget.value))}
                    />
                  </label>
                </fieldset>
              </div>

              <footer class="theme-editor-footer">
                <button
                  type="button"
                  class="theme-editor-action"
                  data-testid="theme-editor-cancel-btn"
                  onClick={cancel}
                >
                  cancel
                </button>
                <button
                  type="button"
                  class="theme-editor-action theme-editor-save"
                  data-testid="theme-editor-save"
                  disabled={saving() || name().trim() === ""}
                  onClick={() => void save()}
                >
                  {saving() ? "saving…" : "save"}
                </button>
              </footer>
            </div>
          </div>
        );
      }}
    </Show>
  );
};

export default ThemeEditor;
