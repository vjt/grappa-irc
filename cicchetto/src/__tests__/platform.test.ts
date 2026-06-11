// Contract under test: the iOS-standalone escape hatch for the media
// viewer's "open in browser" anchor (dogfood bug, 2026-06-11). iOS
// standalone navigates in-scope links IN PLACE regardless of
// target=_blank — the only way a same-origin link can leave the PWA is
// the x-safari-https:// scheme handoff (real Safari, iOS 17+).
// `isStandalonePwa` + `safariEscapeHref` are the two platform-side
// halves of that gate.

import { afterEach, describe, expect, it, vi } from "vitest";
import { isStandalonePwa, safariEscapeHref } from "../lib/platform";

// jsdom has neither window.matchMedia nor navigator.standalone —
// both stubs define-then-delete so each test states its own platform.
function stubNavigatorStandalone(value: boolean): void {
  Object.defineProperty(navigator, "standalone", { value, configurable: true });
}

function stubMatchMedia(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    value: (query: string) => ({ matches, media: query }),
    configurable: true,
  });
}

afterEach(() => {
  // Stubs fully removed (not set to undefined) — restores the jsdom
  // baseline where these properties are absent.
  delete (navigator as Navigator & { standalone?: boolean }).standalone;
  delete (window as { matchMedia?: unknown }).matchMedia;
  vi.restoreAllMocks();
});

describe("isStandalonePwa", () => {
  it("is false when neither display-mode nor navigator.standalone signal standalone", () => {
    stubMatchMedia(false);
    expect(isStandalonePwa()).toBe(false);
  });

  it("is true when the display-mode media query matches (installed PWA, modern engines)", () => {
    stubMatchMedia(true);
    expect(isStandalonePwa()).toBe(true);
  });

  it("is true via the proprietary navigator.standalone (iOS Safari pre-17)", () => {
    stubMatchMedia(false);
    stubNavigatorStandalone(true);
    expect(isStandalonePwa()).toBe(true);
  });

  it("survives environments without matchMedia at all (jsdom)", () => {
    expect(isStandalonePwa()).toBe(false);
  });
});

describe("safariEscapeHref", () => {
  it("rewrites https: to x-safari-https:", () => {
    expect(safariEscapeHref("https://grappa.example/uploads/abc")).toBe(
      "x-safari-https://grappa.example/uploads/abc",
    );
  });

  it("rewrites http: to x-safari-http:", () => {
    expect(safariEscapeHref("http://grappa.example/uploads/abc")).toBe(
      "x-safari-http://grappa.example/uploads/abc",
    );
  });

  it("leaves non-http(s) hrefs unchanged (total function — never mangles)", () => {
    expect(safariEscapeHref("blob:https://grappa.example/xyz")).toBe(
      "blob:https://grappa.example/xyz",
    );
  });
});
