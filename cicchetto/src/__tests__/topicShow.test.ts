import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelKey } from "../lib/channelKey";
import type { TopicEntry } from "../lib/channelTopic";

// #1914 — the `/topic` answer store. Two properties carry the design and are
// the only ones worth pinning: the snapshot is FROZEN at invocation, and rows
// accumulate in ask-order rather than collapsing last-write-wins.

vi.mock("../lib/auth", () => ({ token: () => "tok" }));

const k = (name: string) => `freenode ${name}` as ChannelKey;
const entry = (over: Partial<TopicEntry> = {}): TopicEntry => ({
  text: "beta",
  set_by: "vjt",
  set_at: "2026-09-05T09:11:40.000Z",
  ...over,
});

describe("topicShow store", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("appends one entry per invocation, in ask order", async () => {
    const { appendTopicShow, topicShowByWindow } = await import("../lib/topicShow");
    appendTopicShow(k("#a"), "#a", entry({ text: "first" }));
    appendTopicShow(k("#a"), "#a", entry({ text: "second" }));

    const rows = topicShowByWindow()[k("#a")] ?? [];
    expect(rows.map((r) => r.topic.text)).toEqual(["first", "second"]);
  });

  it("gives every entry a strictly increasing sequence, for same-ms ties", async () => {
    const { appendTopicShow, topicShowByWindow } = await import("../lib/topicShow");
    appendTopicShow(k("#a"), "#a", entry());
    appendTopicShow(k("#a"), "#a", entry());

    const rows = topicShowByWindow()[k("#a")] ?? [];
    expect(rows[1]?.ts).toBeGreaterThan(rows[0]?.ts ?? 0);
  });

  // The whole reason the entry copies the fields instead of holding the key:
  // a topic change after the answer was printed must not rewrite what the
  // operator already read.
  it("freezes the snapshot — a later topic change cannot rewrite a printed row", async () => {
    const { appendTopicShow, topicShowByWindow } = await import("../lib/topicShow");
    const live = entry({ text: "before" });
    appendTopicShow(k("#a"), "#a", live);
    live.text = "after";

    expect(topicShowByWindow()[k("#a")]?.[0]?.topic.text).toBe("before");
  });

  it("keys on the submitting window, so two windows never share rows", async () => {
    const { appendTopicShow, topicShowByWindow } = await import("../lib/topicShow");
    appendTopicShow(k("#a"), "#other", entry());

    expect(topicShowByWindow()[k("#a")]).toHaveLength(1);
    expect(topicShowByWindow()[k("#other")]).toBeUndefined();
  });

  it("records the channel AS SPELLED — the row prints it, never keys on it", async () => {
    const { appendTopicShow, topicShowByWindow } = await import("../lib/topicShow");
    appendTopicShow(k("#a"), "#Sbiffo", entry());

    expect(topicShowByWindow()[k("#a")]?.[0]?.channel).toBe("#Sbiffo");
  });
});
