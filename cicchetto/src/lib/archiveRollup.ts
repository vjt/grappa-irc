import { createMemo } from "solid-js";
import {
  type ArchiveSuppression,
  archiveSuppressionForNetwork,
  archiveTargetSuppressed,
} from "./archive";
import { type ChannelKey, decodeChannelKey } from "./channelKey";
import { isChannelName } from "./chantypes";
import { type Casemapping, casemappingForNetwork, chantypesForNetwork } from "./isupport";
import { moduleRoot } from "./moduleRoot";
import { networkBySlug } from "./networks";
import { normalizeNick } from "./nickEquals";
import { eventsUnread, messagesUnread } from "./selection";
import { SERVER_WINDOW_NAME } from "./windowKinds";

// issue 2096 — the unread rollup behind the archive launcher.
//
// ## Where the numbers come from, and why nothing new is fetched
//
// Fairy's report: an archived window holding unread is invisible until you
// open the modal and expand the right network group. The modal itself has
// shown per-row badges since #532 B, keyed off `/me`'s `unread_counts` seed —
// so the counts were never the missing half. The issue offered two ways to
// get a rollup (eager-load every network's archive list; ship a server-side
// aggregate) and vjt's first ruling took the second.
//
// Both premises turned out to be wrong in the same place, and the measurement
// is on the artefact rather than on the query (DESIGN_NOTES 2026-09-12):
// `ReadCursor.bulk_unread_split/3` is driven purely from `read_cursors`, with
// NO active-window filter, so the seed cic already holds carries every window
// with a cursor — ARCHIVED ONES INCLUDED. Read off a real `GET /me` body with
// a live session: the envelope listed an archived channel and an active DM,
// while `GET /networks/:slug/archive` listed the archived channel and a
// cursor-less one the envelope did not carry. Neither set is a subset of the
// other, so the envelope is not a mirror of the listing — it genuinely
// carries the archived window. vjt re-ruled on that measurement: derive
// client-side, no wire change, no `protocol_version` bump, `loadArchive`
// stays lazy.
//
// So the missing half is MEMBERSHIP, not counts, and membership is
// `seed − what the nav already draws` — which cic holds too
// (`channelsBySlug`, `queryWindowsByNetwork`, the pseudo-row projection).
// Deriving it also makes the badge LIVE for free: open an archived window and
// it becomes active, drops out of the set, and the badge falls. A boot-time
// aggregate could not have done that without a second push.
//
// ## Shape
//
// Pure fn + thin memo, exactly like `orderUnreadWindows` / `activeWindows`
// (lib/activeWindows.ts): the subtraction is plain data in, plain data out so
// it is testable without a reactive context, and the memo only wires the live
// signals to it.
//
// ## Mute
//
// Untouched, deliberately. "The mute always wins" is the rule for the
// on-screen AFFORDANCE (`activeWindows.ts`, #1018/#866 Q2) and it leaves the
// COUNTS intact — the sidebar badges and the modal's own rows keep rendering a
// muted window's numbers. This is a count badge, so it inherits that rule by
// doing nothing; a rollup that subtracted mutes would be a SECOND rule, and
// one that no other badge in the tree obeys.

/** The launcher's two totals. Messages and events stay separate tiers (#265). */
export type ArchiveRollup = {
  messages: number;
  events: number;
};

/** Per-network facts the subtraction needs, resolved once per slug. */
export type ArchiveNetworkFacts = {
  casemapping: Casemapping;
  chantypes: readonly string[];
  /** `null` when the nav draws no row for this network (issue 1985). */
  suppression: ArchiveSuppression | null;
};

export type ArchiveRollupInput = {
  /** Per-window message-scoped unread, `selection.messagesUnread`. */
  messages: Record<ChannelKey, number>;
  /** Per-window presence/control unread, `selection.eventsUnread`. */
  events: Record<ChannelKey, number>;
  /**
   * Per-network facts, or `null` for a slug cic draws no archive group for.
   *
   * GH #105 — an unbound-but-retained network keeps seeding `unread_counts`
   * while `ArchiveModal` iterates `networks()` and renders no group for it. No
   * group, no row, so no contribution: the badge must not out-count the door
   * it sits on.
   */
  factsForSlug: (slug: string) => ArchiveNetworkFacts | null;
};

/**
 * Sum the unread of every window that has NO surface in the nav — i.e. the
 * windows `ArchiveModal` would list.
 *
 * The invariant: this must equal the sum of the badges the modal draws behind
 * the launcher. It cannot over-count by construction — a key here carries
 * unread, unread implies rows, and `Scrollback.list_archive/3` returns every
 * non-active target that has rows — with the two exceptions handled below
 * (`$server`, which the server excludes unconditionally, and a slug with no
 * rendered group).
 */
export function rollupArchivedUnread(input: ArchiveRollupInput): ArchiveRollup {
  const { messages, events, factsForSlug } = input;
  // One resolve per slug, not per key: `factsForSlug` reaches three stores and
  // a window can repeat a slug dozens of times.
  const factsBySlug = new Map<string, ArchiveNetworkFacts | null>();
  let unreadMessages = 0;
  let unreadEvents = 0;

  for (const rawKey of new Set([...Object.keys(messages), ...Object.keys(events)])) {
    const key = rawKey as ChannelKey;
    const keyMessages = messages[key] ?? 0;
    const keyEvents = events[key] ?? 0;
    if (keyMessages === 0 && keyEvents === 0) continue;

    // Codebase audit cic M4 — the paired decoder, never an open-coded split.
    const decoded = decodeChannelKey(key);
    if (decoded === null) continue;
    const { slug, name } = decoded;

    // `list_archive/3` excludes the `$server` pseudo-channel unconditionally
    // (system surface, never archived per the intent doc), so the modal never
    // draws a row for it and neither may this.
    if (name === SERVER_WINDOW_NAME) continue;

    if (!factsBySlug.has(slug)) factsBySlug.set(slug, factsForSlug(slug));
    const facts = factsBySlug.get(slug) ?? null;
    if (facts === null) continue;

    if (facts.suppression !== null) {
      const folded = normalizeNick(name, facts.casemapping);
      const kind = isChannelName(name, facts.chantypes) ? "channel" : "query";
      if (archiveTargetSuppressed(facts.suppression, folded, kind)) continue;
    }

    unreadMessages += keyMessages;
    unreadEvents += keyEvents;
  }

  return { messages: unreadMessages, events: unreadEvents };
}

// Reactive, memoised rollup for the `RailActions` archive launcher. Every
// input is a live signal, so the badge follows a read, a JOIN, a PART, an
// archive delete and a network parking with no refetch of its own.
const root = moduleRoot(() => {
  const archivedUnread = createMemo(
    (): ArchiveRollup =>
      rollupArchivedUnread({
        messages: messagesUnread(),
        events: eventsUnread(),
        factsForSlug: (slug) => {
          const net = networkBySlug(slug);
          if (net === undefined) return null;
          return {
            casemapping: casemappingForNetwork(net.id),
            chantypes: chantypesForNetwork(net.id),
            suppression: archiveSuppressionForNetwork(slug, net.id),
          };
        },
      }),
  );
  return { archivedUnread };
});

export const archivedUnread = root.archivedUnread;
