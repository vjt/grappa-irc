import { createEffect, createSignal, on } from "solid-js";
import { type ChannelKey, channelKey } from "./channelKey";
import { identityScopedStore } from "./identityScopedStore";
import { selectedChannel } from "./selection";

// Per-channel mention-count store. Mirror of `selection.unreadCounts`'s
// shape but tracks "messages mentioning the operator" specifically —
// rendered as a separate red badge in the sidebar so a channel with
// 50 unread + 1 mention is visually distinct from 50 unread + 0.
//
// `bumpMention(key)` is called by `subscribe.ts` (Task 29) when a new
// PRIVMSG arrives on a NON-selected channel AND the body word-boundary
// matches the operator's nick. Selecting that channel clears the count
// (mirrors the unread-clear behavior).
//
// Identity-scoped via identityScopedStore reset (dup-A3 close).
// The selection-clear createEffect on(selectedChannel) is orthogonal
// business logic and stays inline.

const exports_ = identityScopedStore((onIdentityChange) => {
  const [mentionCounts, setMentionCounts] = createSignal<Record<ChannelKey, number>>({});

  onIdentityChange(() => setMentionCounts({}));

  // Selection clears mention count for the just-selected channel.
  createEffect(
    on(selectedChannel, (sel) => {
      if (!sel) return;
      const key = channelKey(sel.networkSlug, sel.channelName);
      setMentionCounts((prev) => {
        if (!(key in prev)) return prev;
        const { [key]: _drop, ...rest } = prev;
        return rest;
      });
    }),
  );

  const bumpMention = (key: ChannelKey): void => {
    setMentionCounts((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
  };

  return { mentionCounts, bumpMention };
});

export const mentionCounts = exports_.mentionCounts;
export const bumpMention = exports_.bumpMention;
