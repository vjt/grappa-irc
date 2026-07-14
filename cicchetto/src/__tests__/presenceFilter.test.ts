import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrollbackMessage } from "../lib/api";
import { channelKey } from "../lib/channelKey";

// #222 — hide join/part/quit/nick-change signalling on large channels by
// default, with a per-channel opt-in to re-show. Client-side only: grappa
// still delivers the events over the wire (no wire change), cic decides
// whether to RENDER them. Mirrors the #217 timeFormat precedent — closed-set
// keys (CLAUDE.md "atoms/literals, never untyped strings for closed sets"),
// localStorage-persisted, backed by a module-singleton Solid signal so open
// scrollback panes re-filter live on toggle.
//
// The "tough" part the issue flagged: an automatic size-based default and a
// manual per-channel override need a clear precedence — explicit choice WINS
// over the size default. That precedence is the pure `resolvePresenceVisible`
// truth table tested here (the size-default math the e2e deliberately does NOT
// exercise with 50 real peers — flood/autokill risk).

describe("presenceFilter module", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  const key = () => channelKey("bahamut-test", "#bofh");

  describe("resolvePresenceVisible() — pure precedence truth table", () => {
    it("unset pref: visible below the LARGE_CHANNEL_THRESHOLD", async () => {
      const { resolvePresenceVisible } = await import("../lib/presenceFilter");
      expect(resolvePresenceVisible(undefined, 49)).toBe(true);
    });

    it("unset pref: hidden at-or-above the LARGE_CHANNEL_THRESHOLD", async () => {
      const { resolvePresenceVisible } = await import("../lib/presenceFilter");
      // 50 is the boundary: >= threshold hides.
      expect(resolvePresenceVisible(undefined, 50)).toBe(false);
      expect(resolvePresenceVisible(undefined, 500)).toBe(false);
    });

    it("boundary is exactly LARGE_CHANNEL_THRESHOLD (49 shown, 50 hidden)", async () => {
      const { resolvePresenceVisible, LARGE_CHANNEL_THRESHOLD } = await import(
        "../lib/presenceFilter"
      );
      expect(resolvePresenceVisible(undefined, LARGE_CHANNEL_THRESHOLD - 1)).toBe(true);
      expect(resolvePresenceVisible(undefined, LARGE_CHANNEL_THRESHOLD)).toBe(false);
    });

    it("explicit 'show' overrides the size default even on a huge channel", async () => {
      const { resolvePresenceVisible } = await import("../lib/presenceFilter");
      expect(resolvePresenceVisible("show", 100)).toBe(true);
      expect(resolvePresenceVisible("show", 5000)).toBe(true);
    });

    it("explicit 'hide' overrides the size default even on a tiny channel", async () => {
      const { resolvePresenceVisible } = await import("../lib/presenceFilter");
      expect(resolvePresenceVisible("hide", 2)).toBe(false);
      expect(resolvePresenceVisible("hide", 0)).toBe(false);
    });
  });

  describe("SUPPRESSED_PRESENCE_KINDS — the NARROW noise set", () => {
    it("suppresses exactly join/part/quit/nick_change", async () => {
      const { SUPPRESSED_PRESENCE_KINDS } = await import("../lib/presenceFilter");
      expect(SUPPRESSED_PRESENCE_KINDS.has("join")).toBe(true);
      expect(SUPPRESSED_PRESENCE_KINDS.has("part")).toBe(true);
      expect(SUPPRESSED_PRESENCE_KINDS.has("quit")).toBe(true);
      expect(SUPPRESSED_PRESENCE_KINDS.has("nick_change")).toBe(true);
    });

    it("does NOT suppress mode/topic/kick/server_event (they are not noise)", async () => {
      const { SUPPRESSED_PRESENCE_KINDS } = await import("../lib/presenceFilter");
      expect(SUPPRESSED_PRESENCE_KINDS.has("mode")).toBe(false);
      expect(SUPPRESSED_PRESENCE_KINDS.has("topic")).toBe(false);
      expect(SUPPRESSED_PRESENCE_KINDS.has("kick")).toBe(false);
      expect(SUPPRESSED_PRESENCE_KINDS.has("server_event")).toBe(false);
    });

    it("does NOT suppress content kinds (privmsg/notice/action)", async () => {
      const { SUPPRESSED_PRESENCE_KINDS } = await import("../lib/presenceFilter");
      expect(SUPPRESSED_PRESENCE_KINDS.has("privmsg")).toBe(false);
      expect(SUPPRESSED_PRESENCE_KINDS.has("notice")).toBe(false);
      expect(SUPPRESSED_PRESENCE_KINDS.has("action")).toBe(false);
    });
  });

  describe("getChannelPresencePref() / setChannelPresencePref()", () => {
    it("returns undefined (follow-size-default) when nothing is stored", async () => {
      const { getChannelPresencePref } = await import("../lib/presenceFilter");
      expect(getChannelPresencePref(key())).toBeUndefined();
    });

    it("returns the stored pref for the channel", async () => {
      const { getChannelPresencePref, setChannelPresencePref } = await import(
        "../lib/presenceFilter"
      );
      setChannelPresencePref(key(), "hide");
      expect(getChannelPresencePref(key())).toBe("hide");
    });

    it("persists the pref to localStorage keyed under the channelKey", async () => {
      const { setChannelPresencePref } = await import("../lib/presenceFilter");
      setChannelPresencePref(key(), "hide");
      const raw = localStorage.getItem("cicchetto.presenceFilter");
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw ?? "{}");
      expect(parsed[key()]).toBe("hide");
    });

    it("survives a module reload (re-seeds the signal from localStorage)", async () => {
      const first = await import("../lib/presenceFilter");
      first.setChannelPresencePref(key(), "show");
      vi.resetModules();
      const second = await import("../lib/presenceFilter");
      expect(second.getChannelPresencePref(key())).toBe("show");
    });

    it("ignores a corrupt localStorage value and defaults to follow-size", async () => {
      localStorage.setItem("cicchetto.presenceFilter", "not-json{");
      const { getChannelPresencePref } = await import("../lib/presenceFilter");
      expect(getChannelPresencePref(key())).toBeUndefined();
    });

    it("keys are case-folded via channelKey — #Bofh and #bofh share one pref", async () => {
      const { getChannelPresencePref, setChannelPresencePref } = await import(
        "../lib/presenceFilter"
      );
      setChannelPresencePref(channelKey("bahamut-test", "#BOFH"), "hide");
      expect(getChannelPresencePref(channelKey("bahamut-test", "#bofh"))).toBe("hide");
    });
  });

  describe("clearChannelPresencePref() — back to follow-size-default", () => {
    it("removes the explicit pref so the channel follows the size default again", async () => {
      const { getChannelPresencePref, setChannelPresencePref, clearChannelPresencePref } =
        await import("../lib/presenceFilter");
      setChannelPresencePref(key(), "hide");
      expect(getChannelPresencePref(key())).toBe("hide");
      clearChannelPresencePref(key());
      expect(getChannelPresencePref(key())).toBeUndefined();
    });
  });

  describe("channelPresenceVisible() — reactive wrapper reading the signal", () => {
    it("follows the size default when the pref is unset", async () => {
      const { channelPresenceVisible } = await import("../lib/presenceFilter");
      expect(channelPresenceVisible(key(), 10)).toBe(true);
      expect(channelPresenceVisible(key(), 80)).toBe(false);
    });

    it("reflects an explicit pin regardless of member count", async () => {
      const { channelPresenceVisible, setChannelPresencePref } = await import(
        "../lib/presenceFilter"
      );
      setChannelPresencePref(key(), "hide");
      expect(channelPresenceVisible(key(), 3)).toBe(false);
      setChannelPresencePref(key(), "show");
      expect(channelPresenceVisible(key(), 999)).toBe(true);
    });
  });

  // #239 — the ONE shared "is this row visible under the channel's presence
  // filter?" predicate. BOTH the render filter (ScrollbackPane.rows) AND the
  // unread-count derivation (selection.ts perChannelUnread) route through it,
  // so a hidden control row can never inflate a badge the operator cannot
  // clear. Reconcile-to-one-predicate — no forked filter.
  describe("presenceRowVisible() — the shared visible predicate (#239)", () => {
    it("content kinds are always visible, even when the channel hides presence", async () => {
      const { presenceRowVisible, setChannelPresencePref } = await import("../lib/presenceFilter");
      setChannelPresencePref(key(), "hide");
      expect(presenceRowVisible(key(), 999, "privmsg")).toBe(true);
      expect(presenceRowVisible(key(), 999, "notice")).toBe(true);
      expect(presenceRowVisible(key(), 999, "action")).toBe(true);
    });

    it("non-suppressed event kinds (mode/topic/kick/server_event) stay visible when hiding", async () => {
      const { presenceRowVisible, setChannelPresencePref } = await import("../lib/presenceFilter");
      setChannelPresencePref(key(), "hide");
      expect(presenceRowVisible(key(), 999, "mode")).toBe(true);
      expect(presenceRowVisible(key(), 999, "topic")).toBe(true);
      expect(presenceRowVisible(key(), 999, "kick")).toBe(true);
      expect(presenceRowVisible(key(), 999, "server_event")).toBe(true);
    });

    it("suppressed kinds hidden when the channel hides presence, visible otherwise", async () => {
      const { presenceRowVisible, setChannelPresencePref, clearChannelPresencePref } = await import(
        "../lib/presenceFilter"
      );
      // Small channel, pref unset → follow-size default → visible.
      expect(presenceRowVisible(key(), 3, "join")).toBe(true);
      // Large channel, pref unset → hidden by the size default.
      expect(presenceRowVisible(key(), 80, "join")).toBe(false);
      // Explicit hide on a tiny channel → hidden.
      setChannelPresencePref(key(), "hide");
      expect(presenceRowVisible(key(), 3, "part")).toBe(false);
      // Explicit show on a huge channel → visible.
      setChannelPresencePref(key(), "show");
      expect(presenceRowVisible(key(), 999, "quit")).toBe(true);
      clearChannelPresencePref(key());
    });
  });

  // #239 — the read-cursor advance target that skips the TRAILING run of
  // hidden control messages on window display WITHOUT marking any visible
  // unread read. Pure (predicate injected) so it is unit-testable without
  // DOM/timers; the ScrollbackPane effect injects `presenceRowVisible`.
  describe("trailingHiddenAdvanceTarget() — skip the trailing hidden run (#239)", () => {
    type Row = { id: number; kind: ScrollbackMessage["kind"] };
    const hidden = new Set<ScrollbackMessage["kind"]>(["join", "part", "quit", "nick_change"]);
    const isVisible = (kind: ScrollbackMessage["kind"]): boolean => !hidden.has(kind);

    it("returns the cursor unchanged when nothing is past it", async () => {
      const { trailingHiddenAdvanceTarget } = await import("../lib/presenceFilter");
      const rows: Row[] = [
        { id: 1, kind: "privmsg" },
        { id: 2, kind: "join" },
      ];
      expect(trailingHiddenAdvanceTarget(rows, 2, isVisible)).toBe(2);
    });

    it("advances to the tail when the whole post-cursor tail is hidden", async () => {
      const { trailingHiddenAdvanceTarget } = await import("../lib/presenceFilter");
      const rows: Row[] = [
        { id: 1, kind: "privmsg" },
        { id: 2, kind: "join" },
        { id: 3, kind: "part" },
      ];
      // cursor at 1 — id2/id3 are a hidden trailing run → advance to 3.
      expect(trailingHiddenAdvanceTarget(rows, 1, isVisible)).toBe(3);
    });

    it("stops before the first visible unread (never marks it read)", async () => {
      const { trailingHiddenAdvanceTarget } = await import("../lib/presenceFilter");
      const rows: Row[] = [
        { id: 10, kind: "join" }, // hidden, past cursor
        { id: 11, kind: "privmsg" }, // first visible unread
        { id: 12, kind: "part" }, // trailing hidden AFTER the visible unread
      ];
      // cursor 9: skip the hidden id10, STOP before the visible id11.
      expect(trailingHiddenAdvanceTarget(rows, 9, isVisible)).toBe(10);
    });

    it("does not advance when the first row past the cursor is visible", async () => {
      const { trailingHiddenAdvanceTarget } = await import("../lib/presenceFilter");
      const rows: Row[] = [
        { id: 5, kind: "privmsg" },
        { id: 6, kind: "join" },
      ];
      expect(trailingHiddenAdvanceTarget(rows, 4, isVisible)).toBe(4);
    });

    it("is forward-only in effect — a stale row below the cursor is ignored", async () => {
      const { trailingHiddenAdvanceTarget } = await import("../lib/presenceFilter");
      const rows: Row[] = [
        { id: 1, kind: "join" }, // below cursor — skipped by the id guard
        { id: 2, kind: "part" }, // below cursor — skipped
        { id: 3, kind: "join" }, // hidden, past cursor
      ];
      expect(trailingHiddenAdvanceTarget(rows, 2, isVisible)).toBe(3);
    });

    it("is order-independent — never advances past a visible unread even when array order diverges from id order", async () => {
      const { trailingHiddenAdvanceTarget } = await import("../lib/presenceFilter");
      // The store sorts by [server_time asc, id asc], so a visible privmsg with
      // an EARLIER server_time but a LOWER id can appear AFTER a hidden row with
      // a HIGHER id in the array. Advancing to the hidden id (10) would mark the
      // visible unread (id 5) read though the operator never saw it. The target
      // must respect id order, not array order → stop below the LOWEST visible
      // unread id (5) → nothing hidden below it → no advance.
      const rows: Row[] = [
        { id: 10, kind: "join" }, // hidden, appears first (earlier server_time)
        { id: 5, kind: "privmsg" }, // visible unread, LOWER id, appears later
      ];
      expect(trailingHiddenAdvanceTarget(rows, 4, isVisible)).toBe(4);
    });
  });
});
