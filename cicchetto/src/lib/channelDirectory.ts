import { createSignal } from "solid-js";
import * as api from "./api";
import { token } from "./auth";
import { friendlyApiError } from "./friendlyApiError";
import { identityScopedStore } from "./identityScopedStore";

// Per-slug directory view preferences: sort order + text filter.
// Default = user-count sort, no filter.
type View = { sort: "users" | "name"; q: string };

// #732 — a stored page plus the id of the request that produced it. The id
// travels WITH the page instead of in a parallel map so it cannot drift: the
// two are written, dropped and identity-reset as one value.
type Snapshot = { id: number; page: api.DirectoryPage };

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
// fetchInto is the shared private primitive: fetches page 1 (no cursor) of
// the current view (sort + q) for the given slug and REPLACES the stored
// page. Every top-of-view event routes through it — load, sort-change,
// query-change, and the three server pings — so all of those correctly
// reset the accumulation back to page 1 (#677 constraint 3).
//
// loadMore (#677) is the SEPARATE append primitive: it fetches the NEXT
// keyset page (cursor = the stored page's next_cursor) and APPENDS its
// rows. It deliberately does NOT go through fetchInto — routing it there
// would wipe the accumulated pages the user has scrolled through.
//
// Server-ping posture (#677 constraint 2): a progress/complete/failed ping
// re-GETs page 1 via fetchInto, discarding any accumulated pages. This is
// the honest behaviour — a ping means a NEW upstream LIST capture landed,
// so the old pages' keyset cursors belong to a prior snapshot and can't be
// spliced onto the new one. Reset-to-page-1 beats stitching two captures.
//
// #732 — two module-wide rules the verbs above all obey:
//
//   1. NOTHING rejects. Every caller fires these as `void` (a store verb has
//      no one to return an error to), so a rejection would be an unhandled
//      rejection and a pane that renders nothing forever. Each verb catches,
//      maps via friendlyApiError, and parks the copy in `errors[slug]` for
//      the pane to render with a reload. "No silent-swallow at boundaries" —
//      caught here IS the surfacing, not a swallow. Only a successful ROW
//      write clears that copy: the refresh POST merely asks the server to
//      re-capture, so clearing on its 202 would drop the banner off a pane
//      that still has nothing to show — the #732 symptom, restored.
//   2. Only the NEWEST request may write. Every response — page, append, or
//      failure — is stamped with the request id it was issued under and
//      dropped if a newer one has since been issued for that slug. Without
//      it a slow `ru` GET lands after a fast `rust` one and the pane shows
//      `ru` rows under a box reading `rust`, with a next_cursor that pages
//      the wrong query.
const exports_ = identityScopedStore((onIdentityChange) => {
  const [pages, setPages] = createSignal<Record<string, Snapshot>>({});
  const [views, setViews] = createSignal<Record<string, View>>({});
  // Per-slug load-more in-flight guard. Doubles as the sentinel's spinner
  // source (isLoadingMore). Prevents a burst of IntersectionObserver fires
  // from stacking concurrent page-2 GETs. Identity-scoped like the rest.
  const [loadingMore, setLoadingMore] = createSignal<Record<string, boolean>>({});
  // #732 — per-slug failure copy for the LAST request that was still current
  // when it settled. Every async verb in this module writes it; the pane
  // renders it with a reload affordance.
  const [errors, setErrors] = createSignal<Record<string, string>>({});

  // #732 — request identity. `issued` is a single monotonic counter and
  // `newest[slug]` is the id of the latest request ISSUED for that slug; a
  // response may write only while it still holds that id. Plain mutable
  // state, not a signal — request identity is bookkeeping, never rendered.
  //
  // Ids are globally monotonic and never reused, which is what makes the
  // close-while-in-flight and identity-rotation resets safe: they burn an id
  // nobody holds, so every response already out there finds no match and
  // drops. A per-slug counter reset to 0 could re-mint an id an older request
  // still held — across a rotation, a cross-tenant write.
  let issued = 0;
  const newest: Record<string, number> = {};
  const issue = (slug: string): number => {
    issued += 1;
    newest[slug] = issued;
    return issued;
  };
  // Supersede everything in flight for `slug`: an id is issued and handed to
  // nobody. DELETING the entry instead would conflate "invalidated" with
  // "never touched", and `isNewest(slug, undefined)` reads those the same —
  // a refresh rejection arriving after the close would then park copy on a
  // dead pane, which is the case this guard exists for.
  const invalidate = (slug: string): void => {
    issue(slug);
  };
  // `undefined` is a legitimate id: the verbs that do not issue one (the
  // refresh POST) pass what the slug currently holds, and a slug NOTHING has
  // ever touched holds nothing. Nothing has superseded it either, so its
  // failure is still the newest word on that slug and must surface.
  const isNewest = (slug: string, id: number | undefined): boolean => newest[slug] === id;

  onIdentityChange(() => setPages({}));
  onIdentityChange(() => setViews({}));
  onIdentityChange(() => setLoadingMore({}));
  onIdentityChange(() => setErrors({}));
  onIdentityChange(() => {
    for (const slug of Object.keys(newest)) invalidate(slug);
  });

  const currentView = (slug: string): View => views()[slug] ?? { sort: "users", q: "" };

  const clearError = (slug: string): void => {
    setErrors((prev) => {
      if (!(slug in prev)) return prev;
      const { [slug]: _cleared, ...rest } = prev;
      return rest;
    });
  };

  // #732 — the single failure boundary for this module. `friendlyApiError`
  // owns the copy for every typed server token; a transport-level failure
  // (offline, DNS, aborted socket) isn't an ApiError and gets the generic
  // line. Never rethrows: callers fire these verbs as `void`, so a rejection
  // here is an unhandled rejection and a pane that stays blank forever.
  const describe = (err: unknown): string =>
    err instanceof api.ApiError ? friendlyApiError(err) : "Couldn't reach the server.";

  const fetchInto = async (slug: string): Promise<void> => {
    const t = token();
    if (!t) return;
    const view = currentView(slug);
    const id = issue(slug);
    try {
      const page = await api.listDirectory(t, slug, { sort: view.sort, q: view.q });
      if (!isNewest(slug, id)) return;
      setPages((prev) => ({ ...prev, [slug]: { id, page } }));
      clearError(slug);
    } catch (err) {
      if (!isNewest(slug, id)) return;
      setErrors((prev) => ({ ...prev, [slug]: describe(err) }));
    }
  };

  const directoryPage = (slug: string): api.DirectoryPage | undefined => pages()[slug]?.page;

  // #732 — the last failure for this slug, already mapped to human copy, or
  // null when the newest request succeeded. Null (not undefined) so the
  // pane's <Show> reads as an explicit "no error".
  const directoryError = (slug: string): string | null => errors()[slug] ?? null;

  // #677 — the sort a reopened pane should rehydrate its toggle from. Sort
  // is a sticky PREFERENCE (unlike the search key, which is cleared on
  // close); the pane reads this so the toggle label matches the sorted list
  // fetchInto produces on reopen. Defaults to "users".
  const directorySort = (slug: string): "users" | "name" => currentView(slug).sort;

  // #738 — the filter the store is actually applying, for the pane's search
  // box to render. The filter is NOT sticky (resetDirectory clears it on
  // close), but it IS settable from outside the pane: compose.ts's
  // `/list <pattern>` calls setQuery directly. Without this the box has no
  // way to know, and shows an empty filter over a filtered list.
  const directoryQuery = (slug: string): string => currentView(slug).q;

  // #677 — true while a loadMore for `slug` is in flight (sentinel spinner).
  const isLoadingMore = (slug: string): boolean => loadingMore()[slug] ?? false;

  // #677 — fetch the NEXT keyset page and APPEND. No-op when: no token, no
  // page yet (nothing to page from), no next_cursor (already at the end),
  // or a load is already in flight for this slug. The cursor is opaque —
  // fed straight back to the server, which encodes sort into it.
  const loadMore = async (slug: string): Promise<void> => {
    const t = token();
    if (!t) return;
    const current = pages()[slug];
    if (!current || current.page.next_cursor === null) return;
    if (loadingMore()[slug]) return;
    // #732 — an append does NOT supersede anything, so it issues no id of its
    // own: it rides the id of the snapshot it is extending. Reading the
    // slug's NEWEST id instead would be wrong in both directions — a
    // top-of-view GET already in flight has bumped it, so the append would
    // splice the new view's keyset onto the old view's rows and pass its own
    // guard. Bail here rather than fetch: the page this would extend is
    // already superseded.
    const { id } = current;
    if (!isNewest(slug, id)) return;
    setLoadingMore((prev) => ({ ...prev, [slug]: true }));
    try {
      const view = currentView(slug);
      const next = await api.listDirectory(t, slug, {
        sort: view.sort,
        q: view.q,
        cursor: current.page.next_cursor,
      });
      if (!isNewest(slug, id)) return;
      // Merge: keep the accumulated entries, append the new page's rows, and
      // adopt the new page's cursor/total/captured_at/status. The snapshot
      // keeps the id of the fetchInto that seeded it — an append extends that
      // request's result, it does not become a new one.
      setPages((prev) => {
        // `isNewest` above already proves the base survived, but
        // noUncheckedIndexedAccess types this read as possibly-undefined:
        // the narrowing is a tsc obligation, not a runtime guard.
        const base = prev[slug];
        if (!base) return prev;
        return {
          ...prev,
          [slug]: { id, page: { ...next, entries: [...base.page.entries, ...next.entries] } },
        };
      });
      clearError(slug);
    } catch (err) {
      if (isNewest(slug, id)) setErrors((prev) => ({ ...prev, [slug]: describe(err) }));
    } finally {
      setLoadingMore((prev) => ({ ...prev, [slug]: false }));
    }
  };

  // #677 — reset the per-slug browse state on window close. Clears the
  // search key (the filter is NOT sticky — vjt's call) and DROPS the cached
  // page so a reopen re-fetches page 1 fresh + unfiltered (the drop also
  // discards the accumulated pages, so a reopened directory never inherits a
  // deep scroll's worth of rows). Sort is preserved as a sticky preference.
  const resetDirectory = (slug: string): void => {
    // #732 — a GET issued before the close must not land after it: without
    // this the dropped page comes back moments later, and the reopen the
    // user does next inherits a snapshot the close was supposed to discard.
    invalidate(slug);
    clearError(slug);
    setViews((prev) => ({ ...prev, [slug]: { ...currentView(slug), q: "" } }));
    setPages((prev) => {
      const { [slug]: _dropped, ...rest } = prev;
      return rest;
    });
    setLoadingMore((prev) => {
      const { [slug]: _dropped, ...rest } = prev;
      return rest;
    });
  };

  const loadDirectory = (slug: string): Promise<void> => fetchInto(slug);

  const setSort = async (slug: string, sort: "users" | "name"): Promise<void> => {
    setViews((prev) => ({ ...prev, [slug]: { ...currentView(slug), sort } }));
    await fetchInto(slug);
  };

  const setQuery = async (slug: string, q: string): Promise<void> => {
    setViews((prev) => ({ ...prev, [slug]: { ...currentView(slug), q } }));
    await fetchInto(slug);
  };

  // The POST only ASKS the server to re-capture; the rows arrive later via
  // the progress/complete pings — which is also why a 202 clears nothing. It
  // proves the server took the request, not that the list GET now works, and
  // the pane it would un-banner may still be empty. #732 — the rejection was
  // the third silent one in this module: the button un-disabled itself and
  // nothing else happened, so a refresh refused (no live session, upstream
  // timeout) read exactly like a refresh that worked.
  const triggerRefresh = async (slug: string): Promise<void> => {
    const t = token();
    if (!t) return;
    // Not `issue`: a re-capture request must not supersede a page GET in
    // flight. It rides the current id purely so a rejection arriving after a
    // close — or after an identity rotation — cannot park copy on a slug that
    // no longer has a pane, or on the next tenant's.
    const id = newest[slug];
    try {
      await api.refreshDirectory(t, slug);
    } catch (err) {
      if (isNewest(slug, id)) setErrors((prev) => ({ ...prev, [slug]: describe(err) }));
    }
  };

  const onDirectoryProgress = (slug: string): Promise<void> => fetchInto(slug);
  const onDirectoryComplete = (slug: string): Promise<void> => fetchInto(slug);
  const onDirectoryFailed = (slug: string): Promise<void> => fetchInto(slug);

  return {
    directoryError,
    directoryPage,
    directoryQuery,
    directorySort,
    isLoadingMore,
    loadDirectory,
    loadMore,
    resetDirectory,
    setSort,
    setQuery,
    triggerRefresh,
    onDirectoryProgress,
    onDirectoryComplete,
    onDirectoryFailed,
  };
});

export const directoryError = exports_.directoryError;
export const directoryPage = exports_.directoryPage;
export const directoryQuery = exports_.directoryQuery;
export const directorySort = exports_.directorySort;
export const isLoadingMore = exports_.isLoadingMore;
export const loadDirectory = exports_.loadDirectory;
export const loadMore = exports_.loadMore;
export const resetDirectory = exports_.resetDirectory;
export const setSort = exports_.setSort;
export const setQuery = exports_.setQuery;
export const triggerRefresh = exports_.triggerRefresh;
export const onDirectoryProgress = exports_.onDirectoryProgress;
export const onDirectoryComplete = exports_.onDirectoryComplete;
export const onDirectoryFailed = exports_.onDirectoryFailed;
