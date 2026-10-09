import { describe, expect, it } from "vitest";
import { AUTO_AWAY_PRESETS, formatAutoAwaySeconds, siteDefaultLabel } from "../lib/autoAwayLadder";

// issue 2359 — the words for an auto-away window, in the wire's encoding.

describe("formatAutoAwaySeconds", () => {
  it("reads 0 as off", () => {
    expect(formatAutoAwaySeconds(0)).toBe("off");
  });

  it("reads every ladder rung as its preset label", () => {
    for (const preset of AUTO_AWAY_PRESETS) {
      expect(formatAutoAwaySeconds(preset.seconds)).toBe(preset.label);
    }
  });

  // The boot fallback is operator config and need not sit on the ladder.
  it("reads an off-ladder value in the largest unit that divides it EXACTLY", () => {
    expect(formatAutoAwaySeconds(1)).toBe("1 second");
    expect(formatAutoAwaySeconds(2)).toBe("2 seconds");
    expect(formatAutoAwaySeconds(90)).toBe("90 seconds");
    expect(formatAutoAwaySeconds(120)).toBe("2 minutes");
    expect(formatAutoAwaySeconds(7200)).toBe("2 hours");
    expect(formatAutoAwaySeconds(3660)).toBe("61 minutes");
  });
});

describe("siteDefaultLabel", () => {
  it("is bare when the server has said nothing — never a guessed number", () => {
    expect(siteDefaultLabel(null)).toBe("use site default");
  });

  it("carries the server's value otherwise", () => {
    expect(siteDefaultLabel(600)).toBe("use site default (10 minutes)");
    expect(siteDefaultLabel(0)).toBe("use site default (off)");
  });
});
