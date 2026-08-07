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

// Reached transitively via identityScopedStore → auth → api (#975). The
// store itself never calls it; the stub only keeps the import graph inert.
vi.mock(import("../lib/api"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, setOn401Handler: vi.fn() };
});

import { channelKey } from "../lib/channelKey";

describe("channelTopic store", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
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

// #975 — the store had one filler and no emptier, so an entry seeded while
// joined outlived the PART and ModeModal presented it as CURRENT. Both maps
// are wiped at the two boundaries where the data stops being true. The
// assertions below are on ABSENCE of the key, not on an emptied value: a
// present-but-empty entry is exactly the wrong answer (an empty toggle set
// rendered as fact), which is what the modal's "unknown" branch keys off.
describe("channelTopic drop on own-PART", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it("dropChannelTopicState removes the key from BOTH maps", async () => {
    const mod = await import("../lib/channelTopic");
    const key = channelKey("freenode", "#grappa");
    mod.seedTopic(key, { text: "hi", set_by: "vjt", set_at: null });
    mod.seedModes(key, { modes: ["n", "t"], params: {} });

    mod.dropChannelTopicState(key);

    expect(key in mod.topicByChannel()).toBe(false);
    expect(key in mod.modesByChannel()).toBe(false);
  });

  it("leaves other channels untouched", async () => {
    const mod = await import("../lib/channelTopic");
    const parted = channelKey("freenode", "#grappa");
    const stillIn = channelKey("freenode", "#bofh");
    mod.seedModes(parted, { modes: ["s"], params: {} });
    mod.seedModes(stillIn, { modes: ["n"], params: {} });
    mod.seedTopic(stillIn, { text: "keep me", set_by: null, set_at: null });

    mod.dropChannelTopicState(parted);

    expect(mod.modesByChannel()[stillIn]).toEqual({ modes: ["n"], params: {} });
    expect(mod.topicByChannel()[stillIn]?.text).toBe("keep me");
  });

  it("dropping an unknown key does not rebuild the maps (no consumer wakeup)", async () => {
    const mod = await import("../lib/channelTopic");
    const key = channelKey("freenode", "#grappa");
    mod.seedModes(key, { modes: ["n"], params: {} });
    const before = mod.modesByChannel();

    mod.dropChannelTopicState(channelKey("freenode", "#never-joined"));

    expect(mod.modesByChannel()).toBe(before);
  });
});

describe("channelTopic identity rotation (token change)", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it("empties both maps when the bearer rotates", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const auth = await import("../lib/auth");
    const mod = await import("../lib/channelTopic");
    mod.seedTopic(channelKey("freenode", "#grappa"), {
      text: "hi",
      set_by: "vjt",
      set_at: null,
    });
    mod.seedModes(channelKey("freenode", "#bofh"), { modes: ["s"], params: {} });

    auth.setToken("tokB");
    // Solid runs the on(token) cleanup in the next microtask flush.
    await Promise.resolve();

    expect(mod.topicByChannel()).toEqual({});
    expect(mod.modesByChannel()).toEqual({});
  });

  it("does NOT empty on the initial bearer set (cold-start login)", async () => {
    const auth = await import("../lib/auth");
    const mod = await import("../lib/channelTopic");
    const key = channelKey("freenode", "#grappa");

    auth.setToken("tokA");
    await Promise.resolve();
    mod.seedModes(key, { modes: ["n"], params: {} });

    expect(mod.modesByChannel()[key]).toEqual({ modes: ["n"], params: {} });
  });
});
