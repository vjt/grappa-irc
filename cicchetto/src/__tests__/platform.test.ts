// Contract under test: the iOS-standalone escape hatch for same-origin
// links (dogfood bug, 2026-06-11). iOS standalone navigates in-scope
// links IN PLACE regardless of target=_blank — the only way a
// same-origin link can leave the PWA is the x-safari-https:// scheme
// handoff (real Safari, iOS 17+). `isStandalonePwa` + `safariEscapeHref`
// are the probe halves; `escapePwaHref` is the composed policy
// (THE meaningful gate — review fix: one named export, so the next
// escape surface can't recompose the halves wrong); and
// `maybeEscapePwaClick` is the shared click handler.
//
// The escaping branch of `maybeEscapePwaClick` calls
// `window.location.assign`, which jsdom makes unforgeable
// (readonly Location) AND unimplemented — it can be neither spied nor
// allowed to run cleanly. The decision logic is fully pinned here via
// `escapePwaHref` + the no-op paths; component tests pin the wiring by
// mocking `maybeEscapePwaClick` at the module boundary; the assign
// line itself is device-dogfood territory.

import { afterEach, describe, expect, it } from "vitest";
import {
  escapePwaHref,
  isStandalonePwa,
  maybeEscapePwaClick,
  safariEscapeHref,
} from "../lib/platform";
import {
  resetPlatformStubs,
  stubIosStandalone,
  stubMatchMedia,
  stubNavigatorStandalone,
} from "./helpers/platformStubs";

afterEach(resetPlatformStubs);

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

describe("escapePwaHref — the composed gate", () => {
  const HREF = "https://grappa.example/uploads/abcdefghijklmnopqrstuvwxyz";

  it("iOS standalone: returns the x-safari rewrite", () => {
    stubIosStandalone(true);
    expect(escapePwaHref(HREF)).toBe(`x-safari-${HREF}`);
  });

  it("iOS browser tab (not standalone): null — target=_blank already works there", () => {
    stubIosStandalone(false);
    expect(escapePwaHref(HREF)).toBe(null);
  });

  it("non-iOS standalone PWA (Android/desktop install): null — an x-safari href is inert there", () => {
    stubMatchMedia(true);
    expect(escapePwaHref(HREF)).toBe(null);
  });

  it("iOS standalone with a non-http(s) href: null — nothing to escape", () => {
    stubIosStandalone(true);
    expect(escapePwaHref("blob:https://grappa.example/xyz")).toBe(null);
  });
});

describe("maybeEscapePwaClick — no-op paths", () => {
  const HREF = "https://grappa.example/uploads/abcdefghijklmnopqrstuvwxyz";

  it("modifier click is never escaped even on iOS standalone (browser-native semantics stand)", () => {
    stubIosStandalone(true);
    const e = new MouseEvent("click", { cancelable: true, ctrlKey: true });
    expect(maybeEscapePwaClick(e, HREF)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });

  it("gate off (desktop): plain click is not escaped — the anchor's target=_blank stands", () => {
    const e = new MouseEvent("click", { cancelable: true });
    expect(maybeEscapePwaClick(e, HREF)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });
});
