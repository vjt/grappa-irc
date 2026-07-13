import { beforeEach, describe, expect, it, vi } from "vitest";
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
});
