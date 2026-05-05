import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Test the channelTopic store — wire boundary between WS events and
// the TopicBar component. The store must:
//   - track per-channel topic (text, set_by, set_at) from topic_changed events
//   - track per-channel modes (modes[], params{}) from channel_modes_changed events
//   - expose reactive accessors topicByChannel() and modesByChannel()
//   - export seedFromTest() seam for isolated unit testing

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
}));

import { channelKey } from "../lib/channelKey";

describe("channelTopic store", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("exports topicByChannel and modesByChannel signals", async () => {
    const mod = await import("../lib/channelTopic");
    expect(typeof mod.topicByChannel).toBe("function");
    expect(typeof mod.modesByChannel).toBe("function");
  });

  it("topicByChannel returns empty object initially", async () => {
    const mod = await import("../lib/channelTopic");
    expect(mod.topicByChannel()).toEqual({});
  });

  it("modesByChannel returns empty object initially", async () => {
    const mod = await import("../lib/channelTopic");
    expect(mod.modesByChannel()).toEqual({});
  });

  it("seedTopic sets topic entry for the channel key", async () => {
    const mod = await import("../lib/channelTopic");
    const key = channelKey("freenode", "#grappa");
    mod.seedTopic(key, { text: "Hello world", set_by: "vjt", set_at: "2026-05-04T10:00:00Z" });
    expect(mod.topicByChannel()[key]).toEqual({
      text: "Hello world",
      set_by: "vjt",
      set_at: "2026-05-04T10:00:00Z",
    });
  });

  it("seedModes sets modes entry for the channel key", async () => {
    const mod = await import("../lib/channelTopic");
    const key = channelKey("freenode", "#grappa");
    mod.seedModes(key, { modes: ["n", "t"], params: {} });
    expect(mod.modesByChannel()[key]).toEqual({ modes: ["n", "t"], params: {} });
  });

  it("seedTopic with null text stores null text (no topic set)", async () => {
    const mod = await import("../lib/channelTopic");
    const key = channelKey("freenode", "#grappa");
    mod.seedTopic(key, { text: null, set_by: null, set_at: null });
    expect(mod.topicByChannel()[key]?.text).toBeNull();
  });

  it("multiple channels are stored independently", async () => {
    const mod = await import("../lib/channelTopic");
    const key1 = channelKey("freenode", "#grappa");
    const key2 = channelKey("libera", "#test");
    mod.seedTopic(key1, { text: "Grappa channel", set_by: "alice", set_at: null });
    mod.seedTopic(key2, { text: "Test channel", set_by: "bob", set_at: null });
    expect(mod.topicByChannel()[key1]?.text).toBe("Grappa channel");
    expect(mod.topicByChannel()[key2]?.text).toBe("Test channel");
  });

  it("compactModeString formats modes array into +nt style string", async () => {
    const mod = await import("../lib/channelTopic");
    expect(mod.compactModeString(["n", "t"])).toBe("+nt");
    expect(mod.compactModeString([])).toBe("");
    expect(mod.compactModeString(["m"])).toBe("+m");
  });
});
