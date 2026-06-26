import { createSignal } from "solid-js";
import * as api from "./api";
import { token } from "./auth";
import { identityScopedStore } from "./identityScopedStore";

// Per-slug directory view preferences: sort order + text filter.
// Default = user-count sort, no filter.
type View = { sort: "users" | "name"; q: string };

// Per-network channel-directory store.
//
// Holds the last-fetched DirectoryPage and the active view (sort + q) per
// network slug. Re-GETs on load, view-change, and on each server-side
// directory ping (progress / complete / failed). Identity-scoped so a
// bearer rotation clears the prior tenant's snapshot (two resets, one per
// signal map — same shape as windowState.ts).
//
// The three ping hooks today all do the same re-GET. They are distinct
// exports so task D4 (userTopic dispatch) can wire each one independently
// and future divergence (e.g. "failed" surfaces an error toast, "complete"
// scrolls back to the top) is additive — no call-site changes required.
//
// fetchInto is the shared private primitive: fetches page 1 of the current
// view (sort + q) for the given slug. Pagination / load-more is the pane's
// concern (task E3); the store always re-fetches from the top on any event.
const exports_ = identityScopedStore((onIdentityChange) => {
  const [pages, setPages] = createSignal<Record<string, api.DirectoryPage>>({});
  const [views, setViews] = createSignal<Record<string, View>>({});

  onIdentityChange(() => setPages({}));
  onIdentityChange(() => setViews({}));

  const currentView = (slug: string): View => views()[slug] ?? { sort: "users", q: "" };

  const fetchInto = async (slug: string): Promise<void> => {
    const t = token();
    if (!t) return;
    const view = currentView(slug);
    const page = await api.listDirectory(t, slug, { sort: view.sort, q: view.q });
    setPages((prev) => ({ ...prev, [slug]: page }));
  };

  const directoryPage = (slug: string): api.DirectoryPage | undefined => pages()[slug];

  const loadDirectory = (slug: string): Promise<void> => fetchInto(slug);

  const setSort = async (slug: string, sort: "users" | "name"): Promise<void> => {
    setViews((prev) => ({ ...prev, [slug]: { ...currentView(slug), sort } }));
    await fetchInto(slug);
  };

  const setQuery = async (slug: string, q: string): Promise<void> => {
    setViews((prev) => ({ ...prev, [slug]: { ...currentView(slug), q } }));
    await fetchInto(slug);
  };

  const triggerRefresh = async (slug: string): Promise<void> => {
    const t = token();
    if (!t) return;
    await api.refreshDirectory(t, slug);
  };

  const onDirectoryProgress = (slug: string): Promise<void> => fetchInto(slug);
  const onDirectoryComplete = (slug: string): Promise<void> => fetchInto(slug);
  const onDirectoryFailed = (slug: string): Promise<void> => fetchInto(slug);

  return {
    directoryPage,
    loadDirectory,
    setSort,
    setQuery,
    triggerRefresh,
    onDirectoryProgress,
    onDirectoryComplete,
    onDirectoryFailed,
  };
});

export const directoryPage = exports_.directoryPage;
export const loadDirectory = exports_.loadDirectory;
export const setSort = exports_.setSort;
export const setQuery = exports_.setQuery;
export const triggerRefresh = exports_.triggerRefresh;
export const onDirectoryProgress = exports_.onDirectoryProgress;
export const onDirectoryComplete = exports_.onDirectoryComplete;
export const onDirectoryFailed = exports_.onDirectoryFailed;
