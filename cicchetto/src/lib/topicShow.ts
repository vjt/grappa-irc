import { createSignal } from "solid-js";
import type { ChannelKey } from "./channelKey";
import type { TopicEntry } from "./channelTopic";
import { identityScopedStore } from "./identityScopedStore";

// #1914 — `/topic` (bare, or `/topic #chan`) ephemeral store. Append-only
// list of frozen topic snapshots per SUBMITTING window key.
//
// Why a store at all: the operator asked to SEE the topic, and irssi answers
// in the window, not in a toast. A command handler cannot reach into
// `ScrollbackPane`, so the request lands here and the pane's `rows()` memo
// interleaves it by wallclock `at` — the same shape `inviteAck.ts` uses for
// the other client-rendered inline row, and for the same reason (a sibling
// render pinned to the bottom lies about when the line was produced).
//
// Display rules, mirroring `inviteAck`:
//   * Keyed by the SUBMITTING window, not the target channel. `/topic #other`
//     typed in `#sbiffo` answers in `#sbiffo`, because that is where the
//     operator is looking — irssi's rule.
//   * One row per invocation. Asking twice prints twice; that is a log of
//     what the operator asked and when, not a last-write-wins banner.
//   * NOT persisted — an answer to a question the operator just asked, not
//     audit log. Lost on refresh, like an invite-ack.
//
// **The snapshot is FROZEN, deliberately.** The entry copies `text` /
// `set_by` / `set_at` out of `topicByChannel` at invocation time rather than
// holding the channel key and re-reading it at render time. A later TOPIC
// change would otherwise retroactively rewrite a line the operator already
// read — the same lie `meta.sender_prefix` freezes away at send time (#25),
// and the caveat #237's derived join line had to document rather than fix.
//
// Identity-scoped: cleared on logout / token rotation, like every other
// client-side buffer.

export type TopicShowEntry = {
  /** The target channel AS SPELLED — this is a label, never a key. */
  channel: string;
  /** Frozen copy of the cached topic at invocation time. */
  topic: TopicEntry;
  /**
   * Monotonic insertion sequence (closure-local counter, NOT a clock).
   * Tiebreaker for two invocations inside the same millisecond.
   */
  ts: number;
  /** Wallclock epoch ms — the sort key against `ScrollbackMessage.server_time`. */
  at: number;
};

const exports_ = identityScopedStore((onIdentityChange) => {
  const [topicShowByWindow, setTopicShowByWindow] = createSignal<
    Record<ChannelKey, TopicShowEntry[]>
  >({});

  let seq = 0;

  onIdentityChange(() => {
    setTopicShowByWindow({});
    seq = 0;
  });

  const appendTopicShow = (windowKey: ChannelKey, channel: string, topic: TopicEntry): void => {
    seq += 1;
    const entry: TopicShowEntry = {
      channel,
      // Copy the fields rather than the reference: `seedTopic` replaces the
      // whole entry object today, but a future in-place update must not be
      // able to reach a line already printed.
      topic: { text: topic.text, set_by: topic.set_by, set_at: topic.set_at },
      ts: seq,
      at: Date.now(),
    };
    setTopicShowByWindow((prev) => ({
      ...prev,
      [windowKey]: [...(prev[windowKey] ?? []), entry],
    }));
  };

  return { topicShowByWindow, appendTopicShow };
});

export const topicShowByWindow = exports_.topicShowByWindow;
export const appendTopicShow = exports_.appendTopicShow;
