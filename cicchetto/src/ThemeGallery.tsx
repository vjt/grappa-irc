import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { ApiError } from "./lib/api";
import { token } from "./lib/auth";
import { requestConfirm } from "./lib/confirmDialog";
import { activateTheme, activeThemeId } from "./lib/customTheme";
import { friendlyApiError } from "./lib/friendlyApiError";
import { isAdmin } from "./lib/networks";
import { newThemeSeedPayload, openThemeEditor, themesRevision } from "./lib/themeEditor";
import { canManageTheme, dedupeThemesById, swatchColors } from "./lib/themeGallery";
import type { TokenPayload } from "./lib/themesApi";
import {
  copyTheme,
  deleteTheme,
  listGallery,
  listMine,
  listUnpublishedBuiltins,
  publishTheme,
  unpublishTheme,
} from "./lib/themesApi";
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
  // #299 item 7 — progressive disclosure: only the SELECTED card reveals its
  // action row (copy + owner/admin manage). Tapping a card's select button
  // both selects it AND applies it live. Nothing is selected on entry, so the
  // gallery opens uncluttered (44px tap targets, mobile-first).
  const [selectedId, setSelectedId] = createSignal<number | null>(null);

  const errMessage = (e: unknown): string =>
    e instanceof ApiError ? friendlyApiError(e) : "something went wrong";

  // #299 — the gallery view is the published gallery PLUS the caller's owned
  // library (their unpublished copies/creates/saves, which never appear in the
  // published gallery — the root cause of "copy/create/save don't show"). Both
  // are fetched and merged, de-duplicated by id (gallery order leads). Owned
  // fetch is the caller's own themes — for BOTH users and visitors: visitors
  // are first-class producers (create/copy/edit/publish their own, #299 item 8).
  const load = async (): Promise<void> => {
    const t = token();
    if (t === null) return;
    try {
      // #299 — admins ALSO see unpublished system built-ins (stranded by an
      // unpublish) so they can re-publish them; the existing owner|admin
      // `canManageTheme` gate already renders the publish switch on those rows.
      // Non-admins skip the request (the server would return [] anyway).
      const [gallery, owned, stranded] = await Promise.all([
        listGallery(t),
        listMine(t),
        isAdmin() ? listUnpublishedBuiltins(t) : Promise.resolve([]),
      ]);
      setThemes(dedupeThemesById([...gallery, ...owned, ...stranded]));
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

  // Tap a card → reveal its actions (select) AND apply it live (activate).
  // The two are one gesture per the #299 item-7 spec (no standalone apply
  // button): tapping a card is "try this on + manage it".
  const selectAndApply = (theme: ThemesWireT): Promise<void> => {
    setSelectedId(theme.id);
    return withBusy(theme.id, (t) => activateTheme(t, theme));
  };

  const copy = (theme: ThemesWireT): Promise<void> =>
    withBusy(theme.id, async (t) => {
      const made = await copyTheme(t, theme.id);
      // "Copy → set active" (spec): apply the fresh owned copy, and select it
      // so its own card (now owned → manage actions) is revealed after reload.
      await activateTheme(t, made);
      setSelectedId(made.id);
      await load();
      // #333 — the copy lands in the "your themes" section (mine === true).
      // Scroll there so it's immediately visible: the old flat, apply_count-
      // ordered list buried the copy + bumped the source to the top, reading
      // as "the copy vanished / the base disappeared". queueMicrotask lets the
      // freshly-mounted personal section attach its ref before we scroll.
      queueMicrotask(() =>
        personalSectionEl?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
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

  // #333 — delete is destructive + irreversible, so it goes through the
  // shared confirm modal (lib/confirmDialog singleton, mounted at Shell
  // level) instead of firing on the first tap. Cancel is the safe default;
  // only the affirmative button runs `remove`.
  const confirmDelete = (theme: ThemesWireT): void =>
    requestConfirm({
      title: "Delete theme",
      body: `Delete "${theme.name}"? This can't be undone.`,
      confirmLabel: "Delete",
      onConfirm: () => void remove(theme),
    });

  // #333 — split the merged list into "your themes" (owned copies/creates)
  // and the "gallery" (published + built-in), personal FIRST. `mine` is the
  // server's per-viewer ownership flag (same one `canManageTheme` reads); a
  // copied built-in surfaces in personal while the base stays in the gallery
  // — the fix for the "copy vanished" confusion. Dedup already ran in load().
  const personalThemes = createMemo(() => (themes() ?? []).filter((t) => t.mine));
  const galleryThemes = createMemo(() => (themes() ?? []).filter((t) => !t.mine));
  let personalSectionEl: HTMLElement | undefined;

  // One card, rendered in both the personal + gallery sections (#333). The
  // action row (copy + owner/admin manage) reveals only for the selected
  // card; delete routes through the confirm modal.
  const themeCard = (theme: ThemesWireT): JSX.Element => (
    <li
      class="theme-card"
      data-testid={`theme-card-${theme.id}`}
      classList={{
        "theme-card-active": activeThemeId() === theme.id,
        "theme-card-selected": selectedId() === theme.id,
      }}
    >
      {/* Whole-card tap target: select (reveal actions) + apply live.
          The action buttons below are SIBLINGS, never nested inside
          this button (no nested-interactive, no stopPropagation). */}
      <button
        type="button"
        class="theme-card-select"
        data-testid={`theme-select-${theme.id}`}
        aria-label={`apply theme ${theme.name}`}
        disabled={busyId() !== null}
        onClick={() => void selectAndApply(theme)}
      >
        <div class="theme-swatch" data-testid={`theme-swatch-${theme.id}`} aria-hidden="true">
          <For each={swatchColors(theme.payload as TokenPayload)}>
            {(c) => <span class="theme-chip" style={{ "background-color": c }} />}
          </For>
        </div>
        <div class="theme-card-meta">
          <span class="theme-card-name">{theme.name}</span>
          <span class="theme-card-author muted">by {theme.author}</span>
          {/* #299 item 9 — real usage: how many subjects have this
              theme active right now (apply_count only counts copies). */}
          <span class="theme-card-count muted" data-testid={`theme-count-${theme.id}`}>
            {theme.in_use} in use
          </span>
          <Show when={activeThemeId() === theme.id}>
            <span class="theme-card-active-marker" data-testid={`theme-active-${theme.id}`}>
              active
            </span>
          </Show>
        </div>
      </button>
      <Show when={selectedId() === theme.id}>
        <div class="theme-card-actions" data-testid={`theme-actions-${theme.id}`}>
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
              onClick={() => confirmDelete(theme)}
            >
              delete
            </button>
          </Show>
        </div>
      </Show>
    </li>
  );

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
        {/* #333 — personal ("your themes") FIRST, then the gallery. Same
            transparent .settings-section idiom as the vhost sections — the
            theme cards carry their own borders. Empty sections hide (a
            visitor with no copies sees only the gallery). */}
        <Show when={personalThemes().length > 0}>
          <section
            class="settings-section"
            data-testid="theme-section-personal"
            ref={(el) => {
              personalSectionEl = el;
            }}
          >
            <h4 class="settings-section-heading">your themes</h4>
            <ul class="theme-gallery-list">
              <For each={personalThemes()}>{themeCard}</For>
            </ul>
          </section>
        </Show>

        <Show when={galleryThemes().length > 0}>
          <section class="settings-section" data-testid="theme-section-gallery">
            <h4 class="settings-section-heading">gallery</h4>
            <ul class="theme-gallery-list">
              <For each={galleryThemes()}>{themeCard}</For>
            </ul>
          </section>
        </Show>
      </Show>
    </section>
  );
};

export default ThemeGallery;
