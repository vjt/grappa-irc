import { createRoot, createSignal } from "solid-js";
import type { ChannelKey } from "./channelKey";

// Per-channel topic + modes store. Module-singleton reactive signals.
//
// Topic state is pushed by the server via `topic_changed` events on the
// channel-level Phoenix Channel topic. Modes are pushed via
// `channel_modes_changed`. Both are consumed in `subscribe.ts` and
// routed here via `seedTopic` / `seedModes`.
//
// `compactModeString` is a pure function exported for use in TopicBar and
// tests alike — formats `["n", "t"]` → `"+nt"`.
//
// Lifecycle: module-singleton signals, no identity-scoped cleanup needed
// for this store (data is overwritten on each WS push; stale data
// from a previous channel join is harmless — the next channel join will
// push fresh state, and self-PART/self-KICK on the server clears the
// per-channel cache so the next topic_changed re-seeds with the new
// channel-instance values).
//
// UX-5 BJ (2026-05-19): the per-channel creation timestamp store
// (329 RPL_CREATIONTIME → `createdByChannel` / `seedChannelCreated`)
// was removed. Its only consumer was the JOIN-self banner, which BJ
// killed (topic + members already surface via TopicBar + MembersPane;
// the banner duplicated both). The corresponding `channel_created`
// wire-event arm survives as a recognized-but-ignored no-op in
// `subscribe.ts` (server still emits per-channel on every JOIN; killing
// the narrow arm would route the payload through the default-null
// drop and log `[subscribe] dropped malformed payload` on every JOIN).
// Server-side reaping of the broadcast itself is a separate decision.

export type TopicEntry = {
  text: string | null;
  set_by: string | null;
  set_at: string | null;
};

export type ModesEntry = {
  modes: string[];
  params: Record<string, string | null>;
};

const exports_ = createRoot(() => {
  const [topicByChannel, setTopicByChannel] = createSignal<Record<ChannelKey, TopicEntry>>({});
  const [modesByChannel, setModesByChannel] = createSignal<Record<ChannelKey, ModesEntry>>({});

  const seedTopic = (key: ChannelKey, entry: TopicEntry): void => {
    setTopicByChannel((prev) => ({ ...prev, [key]: entry }));
  };

  const seedModes = (key: ChannelKey, entry: ModesEntry): void => {
    setModesByChannel((prev) => ({ ...prev, [key]: entry }));
  };

  return {
    topicByChannel,
    modesByChannel,
    seedTopic,
    seedModes,
  };
});

export const topicByChannel = exports_.topicByChannel;
export const modesByChannel = exports_.modesByChannel;
export const seedTopic = exports_.seedTopic;
export const seedModes = exports_.seedModes;

/**
 * Formats a modes array into a compact IRC mode string.
 * `["n", "t"]` → `"+nt"`. Empty array → `""`.
 */
export function compactModeString(modes: string[]): string {
  if (modes.length === 0) return "";
  return `+${modes.join("")}`;
}

// #237 — the on-JOIN inline topic line, DERIVED from this store (no parallel
// state, no faked scrollback id). `topicByChannel` is already seeded by the
// server's `topic_changed` event on JOIN (RPL_TOPIC 332 → full text + setter +
// time) and on every change; ScrollbackPane reads these pure helpers to render
// a PRESENTATIONAL buffer row anchored to the own-JOIN, irssi-style. Kept pure
// (no signal reads) so the derivation is unit-testable without rendering.
//
// on-JOIN vs on-CHANGE split: the server persists a real `:topic` scrollback
// row ONLY on a mid-session TOPIC change (rendered by ScrollbackPane's
// `case "topic"`). JOIN emits topic_changed WITHOUT a scrollback row (avoids
// reconnect spam), so the join-time inline print is derived HERE from the
// cached entry — it shows the CURRENT cached topic (last-write-wins), not a
// frozen topic-at-join snapshot (cic holds no per-join topic history). See
// docs/DESIGN_NOTES.md 2026-07-15.

/** The renderable on-JOIN topic line: channel + full topic text + optional
 * "set by <nick> at <time>" meta. */
export type TopicJoinLine = {
  channel: string;
  /** Full topic text VERBATIM (mIRC control bytes preserved for MircBody). */
  text: string;
  meta: string | null;
};

/**
 * Maps a channel + its cached topic entry to the on-JOIN inline line, or
 * `null` when there is nothing to print (no entry, explicit no-topic, or a
 * blank/whitespace-only topic — mirrors irssi printing nothing on join for a
 * topicless channel).
 */
export function topicJoinLine(channel: string, entry: TopicEntry | null): TopicJoinLine | null {
  const text = entry?.text ?? null;
  if (text === null || text.trim() === "") return null;
  return { channel, text, meta: topicJoinMeta(entry) };
}

/**
 * Formats the irssi-style "set by <nick> at <time>" suffix from a topic entry.
 * `null` when the setter is unknown (a 332 that arrived without a 333). The
 * set-at time is dropped when absent, and falls back to the raw string when
 * unparseable (never leaks a JS "Invalid Date" to the user).
 */
export function topicJoinMeta(entry: TopicEntry | null): string | null {
  const setBy = entry?.set_by ?? null;
  if (!setBy) return null;
  const setAt = entry?.set_at ?? null;
  return setAt ? `set by ${setBy} at ${formatTopicSetAt(setAt)}` : `set by ${setBy}`;
}

function formatTopicSetAt(setAt: string): string {
  const parsed = new Date(setAt);
  if (Number.isNaN(parsed.getTime())) return setAt;
  return parsed.toLocaleString();
}
