import { createSignal } from "solid-js";
import { type ArchiveEntry, listArchive } from "./api";
import { token } from "./auth";
import { identityScopedStore } from "./identityScopedStore";
import { channelsBySlug } from "./networks";
import { normalizeNick } from "./nickEquals";
import { navPseudoChannelsForNetwork } from "./pseudoChannels";
import { queryWindowsByNetwork } from "./queryWindows";

// Per-network archive store. Source-of-truth for cic's per-network
// Archive collapsible groups in `ArchiveModal` (#473; pre-#473 this
// backed the Sidebar `<details>` archive section, CP15 B4).
//
// Lifecycle:
//   1. On user expand of a network's `<details>` group in ArchiveModal,
//      its `onToggle` calls `loadArchive(slug)` which fetches GET /archive
//      and writes the entries into `archivedBySlug()[slug]`. Lazy by
//      design — the list can be O(hundreds) per network and the user
//      rarely opens it.
//   2. Re-loading the same slug is a deliberate refresh (no double-load
//      gate like `members.loadedChannels`); the user re-expanding signals
//      "give me the current state." Concurrent loads for the same slug
//      are ordering-guarded (see `loadSeq`): the last-STARTED fetch wins,
//      so a stale response can't overwrite a fresher one.
//   3. Identity rotation flushes the whole store via `clearArchive` —
//      registered as the identityScopedStore reset (dup-A3 close).
//
// Sort order: server-side `Scrollback.list_archive/3` already returns
// entries sorted by `last_activity` DESC. The store preserves the wire
// order; the renderer is pure pass-through.

const exports_ = identityScopedStore((onIdentityChange) => {
  const [archivedBySlug, setArchivedBySlug] = createSignal<Record<string, ArchiveEntry[]>>({});
  // #473 — boolean open/closed flag for the ONE archive modal. Was the
  // per-network slug signal `archiveModalNetwork` (UX-2): back then the
  // modal showed a single network, so the slug doubled as the open flag.
  // The archive rework makes `ArchiveModal` the SINGLE archive surface on
  // both form factors, rendering EVERY network as a collapsible group, so
  // the modal no longer tracks a network — only whether it is visible.
  // Read by `ArchiveModal.tsx`; written by the `RailActions` archive
  // button (via `mobilePanel.openArchivePanel`) + the modal's close
  // affordances, and cleared by the mutex helpers in `mobilePanel.ts`.
  //
  // Lives INSIDE the identityScopedStore so token rotation closes any
  // open modal alongside `archivedBySlug` flush — otherwise a previous
  // identity's modal could linger on top of the new identity's shell.
  const [archiveModalOpen, setArchiveModalOpen] = createSignal<boolean>(false);

  // Per-slug monotonic load sequence — guards `loadArchive` against
  // out-of-order responses. Two `loadArchive(slug)` calls can be in
  // flight at once (e.g. a group's `onToggle` fetch overlapping an
  // `archive_changed`-driven refetch after a PART): without ordering, a
  // stale response resolving last silently overwrites the fresh one,
  // dropping a just-archived window from an OPEN modal (the cp15-b6
  // re-PART-while-open race). The last-STARTED load wins — it reflects
  // the most recent server state at fetch time — regardless of which
  // response resolves first.
  const loadSeq = new Map<string, number>();

  const clearArchive = (): void => {
    setArchivedBySlug({});
    setArchiveModalOpen(false);
    loadSeq.clear();
  };

  // Identity-transition cleanup. A token rotation MUST flush the prior
  // identity's archive cache AND close any open modal before the new
  // identity's first load fires.
  onIdentityChange(clearArchive);

  const loadArchive = async (slug: string): Promise<void> => {
    const t = token();
    if (!t) return;
    // Claim this slug's latest sequence BEFORE awaiting, so a later call
    // started while our fetch is in flight can invalidate our response.
    const seq = (loadSeq.get(slug) ?? 0) + 1;
    loadSeq.set(slug, seq);
    try {
      const entries = await listArchive(t, slug);
      // Drop a stale response: a newer loadArchive for this slug started
      // while our fetch was in flight, so its result supersedes ours.
      // Without this, a slow onToggle fetch (pre-PART state) resolving
      // after an archive_changed refetch (post-PART) would erase the
      // just-archived window from an open modal.
      if (loadSeq.get(slug) !== seq) return;
      setArchivedBySlug((prev) => ({ ...prev, [slug]: entries }));
    } catch {
      // Leave the prior entries (if any) in place. The renderer
      // tolerates an absent slug key as "not loaded yet"; a transient
      // failure shouldn't blank the user's previously-rendered list.
    }
  };

  return {
    archivedBySlug,
    archiveModalOpen,
    loadArchive,
    clearArchive,
    setArchiveModalOpen,
  };
});

export const archivedBySlug = exports_.archivedBySlug;
export const archiveModalOpen = exports_.archiveModalOpen;
export const loadArchive = exports_.loadArchive;
export const clearArchive = exports_.clearArchive;
export const setArchiveModalOpen = exports_.setArchiveModalOpen;

// UX-2 — shared archive-visibility filter. Pre-UX-2 lived inline in
// `Sidebar.tsx` as `visibleArchiveForNetwork/2`; UX-2 lifted it here so
// the (then-two) archive surfaces could share one verb. #473 collapsed
// those surfaces into ONE — `ArchiveModal` is now the sole caller, using
// it for each per-network group's list — but it stays a standalone verb
// (a re-JOINed channel or re-opened query must not appear in the archive).
//
// CP15 B5 contract preserved: render-time derivation, backing
// `archivedBySlug` cache untouched. Server-side `Scrollback.list_archive/3`
// does the same exclusion via active_keyset, but the client-side cache
// survives JOIN echoes; re-JOIN of an archived channel would otherwise
// dup the row in active + archive sections.
//
// UX-5 bucket BK (2026-05-19): ALSO exclude anything shown as a
// pseudo-row for this network — a failed/kicked/pending/parked window
// carries scrollback (Session.Server's `:join_failed` arm etc.) that
// qualifies as archived because the channel isn't in
// Session.list_channels, so without this filter it appears in BOTH the
// active sidebar (pseudo-row) AND the archive. One window, one surface.
// Operator clicks × on the pseudo-row → forceParted drops the windowState
// key → this filter releases → archive shows the row.
//
// #902 — an `:invited` channel is NOT subtracted any more, because no nav
// draws it: the invite is a transient top banner, and the banner is a
// notification rather than a window. So the invited channel's buffer (which
// holds the persisted INVITE row — kept as history) surfaces in the ARCHIVE.
// That is the intended answer to "where did the invite go once I dismissed
// the banner", and it is the same rule as before, not an exception to it:
// subtract what the nav draws, and the nav draws no invite.
//
// cp15-b6 (#473): this MUST reuse the ONE shared pseudo-row projection
// `pseudoChannelsForNetwork` (#71 INC-3), NOT re-derive it from raw
// windowState. The earlier hand-written copy diverged — it counted
// `:joined` as a pseudo-row, but `:joined` is a LIVE-ROW state the
// shared projection deliberately EXCLUDES (its documented ghost-row
// guard). On a re-PART the user-topic `channels_changed` and the
// per-channel PART message have no cross-topic ordering guarantee at the
// WS edge: `channels_changed` can drop the channel from `channelsBySlug`
// while windowState still carries a stale `:joined`, and the raw-
// windowState copy then hid the just-archived channel from an OPEN
// ArchiveModal (the intermittent re-PART-while-open flake — the server
// returned the row, the modal rendered 0). One source of truth for
// "which pseudo-rows exist" is the fix.
export function visibleArchiveForNetwork(slug: string, networkId: number): ArchiveEntry[] {
  const entries = archivedBySlug()[slug] ?? [];
  if (entries.length === 0) return entries;
  // #372: fold every comparison key under ASCII casemapping (`normalizeNick`
  // — the single client mirror of the server fold, A-Z only; #525). A
  // service that replied as `DebugServ` archives under that casing while
  // the open window is `debugserv`; a raw `Set.has` would leave the
  // archived split visible. Folding both sides collapses the casing so an
  // active window suppresses its archived variant. Idempotent on channel
  // names (already server-canonical) and ASCII-only (non-ASCII case
  // variants stay distinct, matching the ircd + the server's fold).
  const liveChannels = new Set((channelsBySlug()?.[slug] ?? []).map((c) => normalizeNick(c.name)));
  const liveQueries = new Set(
    (queryWindowsByNetwork()[networkId] ?? []).map((qw) => normalizeNick(qw.targetNick)),
  );
  // Reuse the ONE shared pseudo-row projection — folding its names
  // (ASCII, #372/#525) for the archive's own compare. See the block comment
  // above for why this MUST NOT re-derive from raw windowState.
  //
  // #402: subtract what the nav of THIS form factor actually draws, not the
  // whole projection. On mobile there is no Sidebar and the BottomBar draws
  // only `:invited`, so subtracting `pending`/`failed`/`kicked`/`parked`
  // there left the window with no surface at all. `navPseudoChannelsForNetwork`
  // owns that narrowing for the navs too, so the two cannot drift.
  const pseudoNames = new Set(
    navPseudoChannelsForNetwork(slug, networkId).map((row) => normalizeNick(row.name)),
  );
  return entries.filter((entry) => {
    const folded = normalizeNick(entry.target);
    if (pseudoNames.has(folded)) return false;
    if (entry.kind === "channel") return !liveChannels.has(folded);
    return !liveQueries.has(folded);
  });
}
