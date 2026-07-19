import { createEffect, createMemo, createSignal, on } from "solid-js";
import type { UnreadCountsEnvelope } from "./api";
import { type ChannelKey, channelKey } from "./channelKey";
import { isDocumentVisible } from "./documentVisibility";
import { identityScopedStore } from "./identityScopedStore";
import { user } from "./networks";
import { selectedChannel } from "./selection";

// Per-channel MENTION count — SERVER-AUTHORITATIVE (#267).
//
// Was a client bump: `bumpMention(key)` on every inbound PRIVMSG whose
// body word-boundary-matched the operator's nick. That count was derived
// purely from what a single connected tab observed live, so it NEVER
// rebuilt on reconnect (a mention that landed while the tab was
// disconnected was silently lost) and diverged across tabs/devices — the
// exact inconsistency #267 exists to fix.
//
// Now the count comes from the server's `Grappa.WindowCounts` snapshot
// (SSOT `Mentions.mentioned?/3` = own nick ∪ highlight patterns), seeded
// by `/me` + the per-channel join reply and pushed on every new message +
// cursor advance. It reconstructs identically on every (re)subscribe and
// stays consistent across devices.
//
// `mentionCounts()` overlays a focus-zero on the raw server value: the
// selected+visible window renders 0 (the operator is reading it), matching
// the messages/events badge suppression in `selection.ts`. The read cursor
// is NOT advanced by this overlay — the server re-pushes 0 for that window
// on the next cursor-advance settle. A selected-but-backgrounded tab keeps
// its count so a returning operator sees the activity.
//
// Note: the per-row `.scrollback-mention` highlight (ScrollbackPane) still
// uses the client `mentionsUser` regex — it's a deterministic per-row
// render decision, not a count, with no cross-tab/reconnect consistency
// problem. Only the COUNT moved server-side.
//
// Identity-scoped via identityScopedStore reset (dup-A3 close).

const exports_ = identityScopedStore((onIdentityChange) => {
  const [serverMentions, setServerMentions] = createSignal<Record<ChannelKey, number>>({});

  onIdentityChange(() => setServerMentions({}));

  // Set the server mention count for one window — from the `window_counts`
  // push (new message + cursor advance) and the per-channel join reply.
  // A 0 drops the key; short-circuits equal-value updates so an unchanged
  // count never re-fires the memo.
  const setServerMention = (key: ChannelKey, count: number): void => {
    setServerMentions((prev) => {
      if ((prev[key] ?? 0) === count) return prev;
      if (count === 0) {
        const { [key]: _drop, ...rest } = prev;
        return rest;
      }
      return { ...prev, [key]: count };
    });
  };

  // Bulk-hydrate from the `/me` `unread_counts` envelope's `mentions`
  // field. Replaces the whole map — cold-load semantic, same as
  // selection.ts's `applySeedEnvelope` for messages/events.
  const applyServerMentionsEnvelope = (envelope: UnreadCountsEnvelope): void => {
    const next: Record<ChannelKey, number> = {};
    for (const [slug, perChannel] of Object.entries(envelope)) {
      for (const [chan, counts] of Object.entries(perChannel)) {
        if (counts && typeof counts.mentions === "number" && counts.mentions > 0) {
          next[channelKey(slug, chan)] = counts.mentions;
        }
      }
    }
    setServerMentions(next);
  };

  // `/me` cold-load seed. Mirrors selection.ts's `serverSeedCounts`
  // effect; reads `user()` reactively (networks ↔ selection ↔ mentions is
  // an import triangle — reading `user()` from here is the one-way arrow
  // that avoids a cycle, same rationale documented in selection.ts). Fires
  // on every `user()` change (login, token rotation, refetch); the null
  // arms reset via the identity-rotation `onIdentityChange` above.
  createEffect(
    on(user, (m) => {
      if (m == null) return;
      applyServerMentionsEnvelope(m.unread_counts ?? {});
    }),
  );

  // Focus-zeroed projection — the export every consumer reads. Raw server
  // value except the selected+visible window, which renders 0.
  const mentionCounts = createMemo((): Record<ChannelKey, number> => {
    const raw = serverMentions();
    const focused = selectedChannel();
    if (focused === null || !isDocumentVisible()) return raw;
    const focusedKey = channelKey(focused.networkSlug, focused.channelName);
    if (!(focusedKey in raw)) return raw;
    const { [focusedKey]: _drop, ...rest } = raw;
    return rest;
  });

  return { mentionCounts, setServerMention };
});

export const mentionCounts = exports_.mentionCounts;
export const setServerMention = exports_.setServerMention;
