import { createRoot, createSignal } from "solid-js";
import type { ChannelKey } from "./channelKey";

// Per-channel topic + modes + creation-time store. Module-singleton
// reactive signals.
//
// Topic state is pushed by the server via `topic_changed` events on the
// channel-level Phoenix Channel topic. Modes are pushed via
// `channel_modes_changed`. Creation timestamps (329 RPL_CREATIONTIME)
// are pushed via `channel_created`. All three are consumed in
// `subscribe.ts` and routed here via `seedTopic` / `seedModes` /
// `seedChannelCreated`.
//
// `compactModeString` is a pure function exported for use in TopicBar and
// tests alike — formats `["n", "t"]` → `"+nt"`.
//
// Lifecycle: module-singleton signals, no identity-scoped cleanup needed
// for this store (data is overwritten on each WS push; stale data
// from a previous channel join is harmless — the next channel join will
// push fresh state, and self-PART/self-KICK on the server clears the
// per-channel cache so the next 329/topic_changed re-seeds with the new
// channel-instance values).

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
  const [createdByChannel, setCreatedByChannel] = createSignal<Record<ChannelKey, string>>({});

  const seedTopic = (key: ChannelKey, entry: TopicEntry): void => {
    setTopicByChannel((prev) => ({ ...prev, [key]: entry }));
  };

  const seedModes = (key: ChannelKey, entry: ModesEntry): void => {
    setModesByChannel((prev) => ({ ...prev, [key]: entry }));
  };

  const seedChannelCreated = (key: ChannelKey, createdAtIso: string): void => {
    setCreatedByChannel((prev) => ({ ...prev, [key]: createdAtIso }));
  };

  return {
    topicByChannel,
    modesByChannel,
    createdByChannel,
    seedTopic,
    seedModes,
    seedChannelCreated,
  };
});

export const topicByChannel = exports_.topicByChannel;
export const modesByChannel = exports_.modesByChannel;
export const createdByChannel = exports_.createdByChannel;
export const seedTopic = exports_.seedTopic;
export const seedModes = exports_.seedModes;
export const seedChannelCreated = exports_.seedChannelCreated;

/**
 * Formats a modes array into a compact IRC mode string.
 * `["n", "t"]` → `"+nt"`. Empty array → `""`.
 */
export function compactModeString(modes: string[]): string {
  if (modes.length === 0) return "";
  return `+${modes.join("")}`;
}
