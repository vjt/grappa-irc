import { describe, expect, it } from "vitest";
import { type TopicEntry, topicJoinLine, topicJoinMeta } from "./channelTopic";

// #237 — the on-JOIN inline topic line is DERIVED from the existing
// `topicByChannel` store (no parallel state, no faked scrollback id). These
// pure helpers are the derivation seam: `topicJoinLine` maps a channel + its
// cached topic entry to the renderable line (or null when there is nothing to
// show), and `topicJoinMeta` formats the irssi-style "set by <nick> at <time>"
// suffix. Unit-tested here so the mapping is provable without rendering the
// whole pane (the VISIBLE-in-flow assertion lives in the e2e).

const entry = (over: Partial<TopicEntry>): TopicEntry => ({
  text: null,
  set_by: null,
  set_at: null,
  ...over,
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
