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
