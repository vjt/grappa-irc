import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Test the channelTopic store — wire boundary between WS events and
// the TopicBar component. The store must:
//   - track per-channel topic (text, set_by, set_at) from topic_changed events
//   - track per-channel modes (modes[], params{}) from channel_modes_changed events
//   - expose reactive accessors topicByChannel() and modesByChannel()
//   - export seedFromTest() seam for isolated unit testing
//
// #1582 — the module's surface used to be PARTITIONED across two test files:
// the store lived here, the pure derivation helpers (`flattenTopicNewlines`,
// `topicJoinLine`, `topicJoinMeta`) in a co-located `src/lib/channelTopic.test.ts`.
// Disjoint verbs, no overlap — which is the worse shape of the two, because a
// verb missing from the file you opened meant nothing: it might be covered
// next door, or nowhere. Both halves now live here and the absence of a test
// is evidence again.

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
import {
  flattenTopicNewlines,
  type TopicEntry,
  topicJoinLine,
  topicJoinMeta,
  topicShowLine,
} from "../lib/channelTopic";

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

// #237 — the on-JOIN inline topic line is DERIVED from the existing
// `topicByChannel` store (no parallel state, no faked scrollback id). These
// pure helpers are the derivation seam: `topicJoinLine` maps a channel + its
// cached topic entry to the renderable line (or null when there is nothing to
// show), and `topicJoinMeta` formats the irssi-style "set by <nick> at <time>"
// suffix. Unit-tested here so the mapping is provable without rendering the
// whole pane (the VISIBLE-in-flow assertion lives in the e2e).
//
// Statically imported, unlike the store cases above: these are pure functions,
// so the `vi.resetModules()` those describes run does not concern them.

const entry = (over: Partial<TopicEntry>): TopicEntry => ({
  text: null,
  set_by: null,
  set_at: null,
  ...over,
});

describe("flattenTopicNewlines", () => {
  // #263 — the topic-edit modal uses a multi-line <textarea>, but an IRC topic
  // is a SINGLE wire line (CRLF is the message terminator). The server REJECTS
  // a topic body containing \r/\n/\x00 outright (Identifier.safe_line_token?/1
  // → :invalid_line), so flattening on submit is MANDATORY, not cosmetic: a raw
  // multi-line submit would always fail. Newline runs collapse to ONE space so
  // words on separate lines stay separated (never fused).

  it("returns text without newlines unchanged", () => {
    expect(flattenTopicNewlines("a single line topic")).toBe("a single line topic");
  });

  it("collapses a Unix newline (\\n) to a single space", () => {
    expect(flattenTopicNewlines("line one\nline two")).toBe("line one line two");
  });

  it("collapses a Windows CRLF (\\r\\n) to a SINGLE space (not two)", () => {
    expect(flattenTopicNewlines("line one\r\nline two")).toBe("line one line two");
  });

  it("collapses a lone carriage return (\\r) to a single space", () => {
    expect(flattenTopicNewlines("line one\rline two")).toBe("line one line two");
  });

  it("collapses a run of consecutive newlines (blank lines) to one space", () => {
    expect(flattenTopicNewlines("line one\n\n\nline two")).toBe("line one line two");
  });

  it("collapses mixed EOL forms in one string", () => {
    expect(flattenTopicNewlines("a\nb\r\nc\rd")).toBe("a b c d");
  });

  it("returns the empty string unchanged", () => {
    expect(flattenTopicNewlines("")).toBe("");
  });

  it("yields a body free of the newline bytes the server's safe-line guard rejects", () => {
    const flat = flattenTopicNewlines("multi\r\nline\ntopic\rwith more");
    expect(flat).not.toMatch(/[\r\n]/);
    expect(flat).toBe("multi line topic with more");
  });
});

describe("topicJoinLine", () => {
  it("returns null when there is no cached topic entry", () => {
    expect(topicJoinLine("#chan", null)).toBeNull();
  });

  it("returns null when the entry carries an explicit no-topic (text null)", () => {
    // 331 RPL_NOTOPIC seeds `{text: null}` — no inline line, mirrors irssi
    // printing nothing on join for a topicless channel.
    expect(topicJoinLine("#chan", entry({ text: null }))).toBeNull();
  });

  it("returns null when the topic text is blank/whitespace-only", () => {
    expect(topicJoinLine("#chan", entry({ text: "   " }))).toBeNull();
  });

  it("carries the channel + FULL topic text verbatim (not truncated)", () => {
    const long = "a very long topic ".repeat(20).trim();
    const line = topicJoinLine("#bofh", entry({ text: long }));
    expect(line).not.toBeNull();
    expect(line?.channel).toBe("#bofh");
    // Verbatim: MircBody renders the raw text (control bytes included), so the
    // helper must NOT mutate it.
    expect(line?.text).toBe(long);
  });

  it("preserves mIRC control bytes in the topic text (rendered by MircBody)", () => {
    const raw = "\x02bold\x02 topic \x0304red\x03";
    expect(topicJoinLine("#chan", entry({ text: raw }))?.text).toBe(raw);
  });

  it("has no meta when the setter is unknown (332 without a 333)", () => {
    expect(topicJoinLine("#chan", entry({ text: "hi" }))?.meta).toBeNull();
  });
});

describe("topicJoinMeta", () => {
  it("returns null when the setter nick is unknown", () => {
    expect(topicJoinMeta(entry({ text: "hi", set_by: null }))).toBeNull();
  });

  it("names the setter when known but the set-at time is absent", () => {
    expect(topicJoinMeta(entry({ text: "hi", set_by: "vjt" }))).toBe("set by vjt");
  });

  it("appends the set-at time when both setter and time are known", () => {
    const meta = topicJoinMeta(
      entry({ text: "hi", set_by: "vjt", set_at: "2026-07-15T12:00:00.000Z" }),
    );
    // Locale rendering is environment-dependent — assert the stable prefix.
    expect(meta).toMatch(/^set by vjt at /);
  });

  it("falls back to the raw set-at string when it is unparseable", () => {
    const meta = topicJoinMeta(entry({ text: "hi", set_by: "vjt", set_at: "not-a-date" }));
    expect(meta).toBe("set by vjt at not-a-date");
  });
});

// #1914 — the `/topic` answer line. The contrast with `topicJoinLine` above is
// the point of every case here: the join line stays SILENT when there is
// nothing worth printing, this one always answers, because the operator asked.
describe("topicShowLine", () => {
  it("carries the topic text verbatim, control bytes included", () => {
    const raw = "bold 4red";
    expect(topicShowLine("#chan", entry({ text: raw })).text).toBe(raw);
  });

  it("names the channel as spelled — it is a label, never a key", () => {
    expect(topicShowLine("#Chan", entry({ text: "hi" })).channel).toBe("#Chan");
  });

  it("appends the setter/time meta when the 333 supplied it", () => {
    const line = topicShowLine("#chan", entry({ text: "hi", set_by: "vjt" }));
    expect(line.meta).toBe("set by vjt");
  });

  it("answers 'no topic' for 331's null — where topicJoinLine prints nothing", () => {
    expect(topicShowLine("#chan", entry({ text: null })).text).toBeNull();
    expect(topicJoinLine("#chan", entry({ text: null }))).toBeNull();
  });

  it("answers 'no topic' for the empty string an explicit TOPIC clear wrote", () => {
    expect(topicShowLine("#chan", entry({ text: "" })).text).toBeNull();
  });

  it("drops a stale setter alongside a cleared topic (no orphan meta)", () => {
    const line = topicShowLine("#chan", entry({ text: "", set_by: "vjt", set_at: null }));
    expect(line.text).toBeNull();
    expect(line.meta).toBeNull();
  });

  it("treats a whitespace-only topic as PRESENT — the wire carried it", () => {
    // Deliberate divergence from topicJoinLine, which trims and stays silent.
    expect(topicShowLine("#chan", entry({ text: "   " })).text).toBe("   ");
    expect(topicJoinLine("#chan", entry({ text: "   " }))).toBeNull();
  });
});
