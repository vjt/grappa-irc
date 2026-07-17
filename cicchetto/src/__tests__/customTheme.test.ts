import { beforeEach, describe, expect, it } from "vitest";
import { getAppliedThemePayload } from "../lib/customTheme";
import type { TokenColors, TokenPayload } from "../lib/themesApi";

// #75 producer path — apply-engine seams the editor depends on.
//
// getAppliedThemePayload() is the editor's snapshot source: the payload
// currently PERSISTED as applied (the localStorage FOUC mirror, written
// on every server-resolved apply). Live preview (`applyCustomTheme`)
// deliberately does NOT touch the cache, so during an editing session
// the cache still holds the pre-edit active theme — exactly what
// cancel/ESC/backdrop must restore.

const CACHE_KEY = "grappa-custom-theme";

function fullColors(): TokenColors {
  const base = [
    "bg",
    "bg_alt",
    "fg",
    "accent",
    "muted",
    "border",
    "mention",
    "mode_op",
    "mode_halfop",
    "mode_voiced",
    "mode_plain",
  ];
  const colors: Record<string, string> = {};
  for (const k of base) colors[k] = "#101010";
  for (let i = 0; i < 16; i++) colors[`nick_${i}`] = "#20a0c0";
  return colors as TokenColors;
}

function payload(over: Partial<TokenPayload> = {}): TokenPayload {
  return {
    colors: fullColors(),
    font_family: "mono-default",
    background: { image_id: null, opacity: 0.3 },
    ...over,
  };
}

describe("customTheme.getAppliedThemePayload", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns null when no theme is cached", () => {
    expect(getAppliedThemePayload()).toBeNull();
  });

  it("returns the cached applied payload", () => {
    const p = payload({ colors: { ...fullColors(), bg: "#abcdef" } });
    localStorage.setItem(CACHE_KEY, JSON.stringify(p));
    expect(getAppliedThemePayload()).toEqual(p);
  });

  it("returns null on a malformed cache (never throws)", () => {
    localStorage.setItem(CACHE_KEY, "{not json");
    expect(getAppliedThemePayload()).toBeNull();
  });

  it("returns null on a wrong-shaped cache", () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ nope: true }));
    expect(getAppliedThemePayload()).toBeNull();
  });
});
