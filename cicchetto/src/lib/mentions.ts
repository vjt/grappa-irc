import { createSignal } from "solid-js";
import type { ChannelKey } from "./channelKey";
import { identityScopedStore } from "./identityScopedStore";

// Per-channel mention-count store. Mirror of `selection.messagesUnread` /
// `selection.eventsUnread` shape but tracks "messages mentioning the
// operator" specifically — rendered as a separate red badge in the
// sidebar so a channel with 50 unread + 1 mention is visually distinct
// from 50 unread + 0.
//
// `bumpMention(key)` is called by `subscribe.ts` when a new PRIVMSG
// arrives on a NON-effectively-focused channel AND the body word-boundary
// matches the operator's nick. `clearMentionsForKey(key)` is called by
// `selection.ts`'s `clearBadgesForWindow` helper as part of the unified
// four-sink badge clear (UX-5 bucket BU 2026-05-19: prior shape had a
// standalone `on(selectedChannel)` effect here, but that arm did NOT fire
// on browser-focus-regain — selection.ts's unread/messages/events clear
// did. The asymmetry stranded the red badge across the visibility
// transition. Consolidating the clear-verb here + the effect-arm there
// puts all four sinks behind one "is operator reading?" gate.)
//
// Identity-scoped via identityScopedStore reset (dup-A3 close).

const exports_ = identityScopedStore((onIdentityChange) => {
  const [mentionCounts, setMentionCounts] = createSignal<Record<ChannelKey, number>>({});

  onIdentityChange(() => setMentionCounts({}));

  const bumpMention = (key: ChannelKey): void => {
    setMentionCounts((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
  };

  const clearMentionsForKey = (key: ChannelKey): void => {
    setMentionCounts((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
  };

  return { mentionCounts, bumpMention, clearMentionsForKey };
});

export const mentionCounts = exports_.mentionCounts;
export const bumpMention = exports_.bumpMention;
export const clearMentionsForKey = exports_.clearMentionsForKey;
