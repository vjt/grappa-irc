import {
  type Component,
  createEffect,
  createSignal,
  For,
  Match,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { ApiError } from "./lib/api";
import { token } from "./lib/auth";
import { activateTheme, activeThemeId } from "./lib/customTheme";
import { friendlyApiError } from "./lib/friendlyApiError";
import { isAdmin } from "./lib/networks";
import { newThemeSeedPayload, openThemeEditor, themesRevision } from "./lib/themeEditor";
import { canManageTheme, swatchColors } from "./lib/themeGallery";
import type { TokenPayload } from "./lib/themesApi";
import { copyTheme, deleteTheme, listGallery, publishTheme, unpublishTheme } from "./lib/themesApi";
import type { ThemesWireT } from "./lib/wireTypes";

// #75 sub-task 7 — the theme gallery, rendered as the SettingsDrawer
// "themes" sub-page (mirrors VhostSettingsPage's header/back shape).
//
// The consumer path end to end: browse the published + built-in gallery
// with DERIVED swatch previews (palette chips, no stored screenshot),
// apply a theme (server-owned active theme via `activateTheme` → live
// CSS apply + cross-device persist), copy a gallery theme into your own
// account, and — for own themes or as an admin — publish/unpublish and
// delete. cic never originates the active theme; every mutation is a
// server call and the list re-loads from the server after it.
//
// The editor overlay (color pickers, live preview, save), self-hosted
// fonts, and the background-upload UI are the producer path (deferred
// sub-tasks 6/8/9).

export type Props = {
  onBack: () => void;
};

const ThemeGallery: Component<Props> = (props) => {
  const [themes, setThemes] = createSignal<ThemesWireT[] | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  // Id of the theme whose action is in flight. Every action button gates
  // on `busyId() !== null`, so ALL cards' buttons disable during any
  // in-flight action (not just the acting row) — a deliberately
  // conservative guard against concurrent mutations + double-taps.
  const [busyId, setBusyId] = createSignal<number | null>(null);

  const errMessage = (e: unknown): string =>
    e instanceof ApiError ? friendlyApiError(e) : "something went wrong";

  const load = async (): Promise<void> => {
    const t = token();
    if (t === null) return;
    try {
      setThemes(await listGallery(t));
      setError(null);
    } catch (e) {
      setError(errMessage(e));
    }
  };

  // Re-load on entry AND whenever the editor bumps the revision (a save
  // creates/edits a theme underneath the still-mounted gallery). The first
  // effect run does the on-entry load; subsequent runs refresh after edits
  // — one source of truth (the server), never a locally-patched card.
  createEffect(() => {
    themesRevision();
    // untrack: load() reads token() before its first await; without this the
    // effect would also re-run on token() change (unintended dependency).
    // The revision bump is the only trigger we want.
    untrack(() => void load());
  });

  // Seed for a brand-new theme — the built-in the gallery already fetched
  // (irssi-dark), never a hand-copied palette. null → no built-in loaded →
  // hide the "new theme" entry point rather than fabricate a palette.
  const newSeed = (): TokenPayload | null => newThemeSeedPayload(themes() ?? []);

  const withBusy = async (id: number, fn: (t: string) => Promise<void>): Promise<void> => {
    const t = token();
    if (t === null) return;
    setBusyId(id);
    setError(null);
    try {
      await fn(t);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const apply = (theme: ThemesWireT): Promise<void> =>
    withBusy(theme.id, (t) => activateTheme(t, theme));

  const copy = (theme: ThemesWireT): Promise<void> =>
    withBusy(theme.id, async (t) => {
      const made = await copyTheme(t, theme.id);
      // "Copy → set active" (spec): apply the fresh owned copy.
      await activateTheme(t, made);
      await load();
    });

  const publish = (theme: ThemesWireT): Promise<void> =>
    withBusy(theme.id, async (t) => {
      await publishTheme(t, theme.id);
      await load();
    });

  const unpublish = (theme: ThemesWireT): Promise<void> =>
    withBusy(theme.id, async (t) => {
      await unpublishTheme(t, theme.id);
      await load();
    });

  const remove = (theme: ThemesWireT): Promise<void> =>
    withBusy(theme.id, async (t) => {
      await deleteTheme(t, theme.id);
      await load();
    });

  return (
    <section class="settings-subpage theme-gallery" data-testid="theme-gallery">
      <header class="settings-subpage-header">
        <button
          type="button"
          class="settings-back"
          data-testid="themes-back"
          aria-label="back to settings"
          onClick={props.onBack}
        >
          ‹ back
        </button>
        <h3>themes</h3>
        <Show when={newSeed() !== null}>
          <button
            type="button"
            class="theme-action"
            data-testid="theme-new"
            disabled={busyId() !== null}
            onClick={() => {
              const seed = newSeed();
              if (seed !== null) openThemeEditor({ mode: "new", basePayload: seed });
            }}
          >
            new theme
          </button>
        </Show>
      </header>

      <Show when={error() !== null}>
        <p class="theme-gallery-error" role="alert" data-testid="theme-gallery-error">
          {error()}
        </p>
      </Show>

      <Show
        when={themes() !== null}
        fallback={
          <p class="theme-gallery-loading" data-testid="theme-gallery-loading">
            loading…
          </p>
        }
      >
        <ul class="theme-gallery-list">
          <For each={themes() ?? []}>
            {(theme) => (
              <li
                class="theme-card"
                data-testid={`theme-card-${theme.id}`}
                classList={{ "theme-card-active": activeThemeId() === theme.id }}
              >
                <div
                  class="theme-swatch"
                  data-testid={`theme-swatch-${theme.id}`}
                  aria-hidden="true"
                >
                  <For each={swatchColors(theme.payload as TokenPayload)}>
                    {(c) => <span class="theme-chip" style={{ "background-color": c }} />}
                  </For>
                </div>
                <div class="theme-card-meta">
                  <span class="theme-card-name">{theme.name}</span>
                  <span class="theme-card-author muted">by {theme.author}</span>
                  <span class="theme-card-count muted" data-testid={`theme-count-${theme.id}`}>
                    {theme.apply_count} applied
                  </span>
                  <Show when={activeThemeId() === theme.id}>
                    <span class="theme-card-active-marker" data-testid={`theme-active-${theme.id}`}>
                      active
                    </span>
                  </Show>
                </div>
                <div class="theme-card-actions">
                  <button
                    type="button"
                    class="theme-action"
                    data-testid={`theme-apply-${theme.id}`}
                    disabled={busyId() !== null}
                    onClick={() => void apply(theme)}
                  >
                    apply
                  </button>
                  <button
                    type="button"
                    class="theme-action"
                    data-testid={`theme-copy-${theme.id}`}
                    disabled={busyId() !== null}
                    onClick={() => void copy(theme)}
                  >
                    copy
                  </button>
                  <Show when={canManageTheme(theme, isAdmin())}>
                    <button
                      type="button"
                      class="theme-action"
                      data-testid={`theme-edit-${theme.id}`}
                      disabled={busyId() !== null}
                      onClick={() => openThemeEditor({ mode: "edit", theme })}
                    >
                      edit
                    </button>
                    <Switch>
                      <Match when={theme.published}>
                        <button
                          type="button"
                          class="theme-action"
                          data-testid={`theme-unpublish-${theme.id}`}
                          disabled={busyId() !== null}
                          onClick={() => void unpublish(theme)}
                        >
                          unpublish
                        </button>
                      </Match>
                      <Match when={!theme.published}>
                        <button
                          type="button"
                          class="theme-action"
                          data-testid={`theme-publish-${theme.id}`}
                          disabled={busyId() !== null}
                          onClick={() => void publish(theme)}
                        >
                          publish
                        </button>
                      </Match>
                    </Switch>
                    <button
                      type="button"
                      class="theme-action theme-action-danger"
                      data-testid={`theme-delete-${theme.id}`}
                      disabled={busyId() !== null}
                      onClick={() => void remove(theme)}
                    >
                      delete
                    </button>
                  </Show>
                </div>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
};

export default ThemeGallery;
