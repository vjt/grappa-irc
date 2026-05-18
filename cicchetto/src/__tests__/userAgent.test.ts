import { describe, expect, it } from "vitest";
import { deviceClassIcon, parseUserAgent } from "../lib/userAgent";

// UX-4 bucket L (2026-05-19) — minimal UA-string parser.
// Tests cover the common modern browsers/platforms in plain UA-string
// form (no UA-CH brand). Misclassification of niche UAs is benign;
// these tests assert the happy paths for the device-list display.

describe("userAgent.parseUserAgent", () => {
  it("returns UNKNOWN placeholder for null", () => {
    expect(parseUserAgent(null)).toEqual({
      browser: "Unknown browser",
      os: "Unknown OS",
      deviceClass: "unknown",
    });
  });

  it("returns UNKNOWN placeholder for empty string", () => {
    expect(parseUserAgent("")).toEqual({
      browser: "Unknown browser",
      os: "Unknown OS",
      deviceClass: "unknown",
    });
  });

  it("parses Chrome on macOS", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    expect(parseUserAgent(ua)).toEqual({
      browser: "Chrome",
      os: "macOS",
      deviceClass: "desktop",
    });
  });

  it("parses Safari on iOS (iPhone)", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    expect(parseUserAgent(ua)).toEqual({
      browser: "Safari",
      os: "iOS",
      deviceClass: "mobile",
    });
  });

  it("parses Chrome on iOS (CriOS) as Chrome (not Safari)", () => {
    // iOS Chrome embeds Safari + Mobile substrings; CriOS is the
    // discriminator. Verify the order-matters guard in detectBrowser.
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1";
    expect(parseUserAgent(ua)).toEqual({
      browser: "Chrome",
      os: "iOS",
      deviceClass: "mobile",
    });
  });

  it("parses Firefox on Linux", () => {
    const ua = "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0";
    expect(parseUserAgent(ua)).toEqual({
      browser: "Firefox",
      os: "Linux",
      deviceClass: "desktop",
    });
  });

  it("parses Edge on Windows (Edg discriminator, not Chrome)", () => {
    // Edge UA embeds Chrome + Safari substrings; Edg/ is the
    // discriminator. Order matters — detectBrowser checks Edg first.
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
    expect(parseUserAgent(ua)).toEqual({
      browser: "Edge",
      os: "Windows",
      deviceClass: "desktop",
    });
  });

  it("parses Chrome on Android (mobile tablet discrimination via Mobile token)", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
    expect(parseUserAgent(ua)).toEqual({
      browser: "Chrome",
      os: "Android",
      deviceClass: "mobile",
    });
  });

  it("parses Safari on iPad as tablet", () => {
    const ua =
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    expect(parseUserAgent(ua)).toEqual({
      browser: "Safari",
      os: "iOS",
      deviceClass: "tablet",
    });
  });

  it("returns Unknown browser + Unknown OS on a totally weird UA", () => {
    expect(parseUserAgent("HypotheticalBot/9000")).toEqual({
      browser: "Unknown browser",
      os: "Unknown OS",
      deviceClass: "unknown",
    });
  });
});

describe("userAgent.deviceClassIcon", () => {
  it("returns 💻 for desktop", () => {
    expect(deviceClassIcon("desktop")).toBe("\u{1F4BB}");
  });

  it("returns 📱 for mobile", () => {
    expect(deviceClassIcon("mobile")).toBe("\u{1F4F1}");
  });

  it("returns 📱 for tablet (same glyph as mobile by design)", () => {
    expect(deviceClassIcon("tablet")).toBe("\u{1F4F1}");
  });

  it("returns ❔ for unknown", () => {
    expect(deviceClassIcon("unknown")).toBe("❔");
  });
});
