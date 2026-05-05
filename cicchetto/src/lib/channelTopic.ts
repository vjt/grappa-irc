import { createRoot, createSignal } from "solid-js";
import type { ChannelKey } from "./channelKey";

// Per-channel topic + modes store. Module-singleton reactive signals.
//
// Topic state is pushed by the server via `topic_changed` events on the
// channel-level Phoenix Channel topic. Modes are pushed via
// `channel_modes_changed`. Both are consumed in `subscribe.ts` and routed
// here via `seedTopic` / `seedModes`.
//
// `compactModeString` is a pure function exported for use in TopicBar and
// tests alike — formats `["n", "t"]` → `"+nt"`.
//
// Lifecycle: module-singleton signals, no identity-scoped cleanup needed
// for this store (topic data is overwritten on each WS push; stale data
// from a previous channel join is harmless — the next channel join will
// push fresh state).

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

  return { topicByChannel, modesByChannel, seedTopic, seedModes };
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
