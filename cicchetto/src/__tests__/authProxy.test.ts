import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  REAUTH_MARKER_KEY,
  REAUTH_PARAM,
  REAUTH_RETRY_WINDOW_MS,
  reauthUrl,
  requestReauth,
  stripReauthParam,
} from "../lib/authProxy";
import { replaceDocument } from "../lib/documentNavigation";

// issue 2531 — the recovery half of an expired auth-proxy session. Whether the
// URL it builds really leaves the service worker is asked of Workbox itself in
// `swNavigationRoute.test.ts`; this file pins the URL, the loop guard and the
// boot-time clean-up.

// jsdom cannot navigate; the seam is mocked and its argument is the assertion.
vi.mock("../lib/documentNavigation", () => ({ replaceDocument: vi.fn() }));

const navigate = replaceDocument as unknown as Mock;

describe("reauthUrl", () => {
  it("adds the marker and keeps everything the URL already carried", () => {
    const url = new URL(reauthUrl("https://grappa.example/login?go=azzurra%2F%23grappa#frag"));

    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("go")).toBe("azzurra/#grappa");
    expect(url.searchParams.get(REAUTH_PARAM)).toBe("1");
    expect(url.hash).toBe("#frag");
  });

  it("does not stack a second marker on a URL that already has one", () => {
    const once = reauthUrl("https://grappa.example/");

    expect(new URL(reauthUrl(once)).searchParams.getAll(REAUTH_PARAM)).toEqual(["1"]);
  });
});

describe("requestReauth", () => {
  const T0 = 1_800_000_000_000;

  beforeEach(() => {
    sessionStorage.clear();
    navigate.mockClear();
  });

  it("navigates to the re-auth URL of the current page and records the attempt", () => {
    expect(requestReauth("auto", T0)).toBe(true);

    expect(navigate).toHaveBeenCalledWith(reauthUrl(window.location.href));
    expect(sessionStorage.getItem(REAUTH_MARKER_KEY)).toBe(String(T0));
  });

  it("refuses a second automatic attempt inside the window", () => {
    requestReauth("auto", T0);
    navigate.mockClear();

    expect(requestReauth("auto", T0 + REAUTH_RETRY_WINDOW_MS - 1)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("allows the next automatic attempt once the window has passed", () => {
    requestReauth("auto", T0);
    navigate.mockClear();

    expect(requestReauth("auto", T0 + REAUTH_RETRY_WINDOW_MS)).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("never refuses a person pressing the button", () => {
    requestReauth("auto", T0);
    navigate.mockClear();

    expect(requestReauth("user", T0 + 1)).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("reads a corrupt marker as no attempt at all", () => {
    sessionStorage.setItem(REAUTH_MARKER_KEY, "not a timestamp");

    expect(requestReauth("auto", T0)).toBe(true);
  });

  // A clock stepped back after an attempt leaves a marker in the future. Read
  // as recent, it would block the automatic attempt for the size of the step
  // plus a window — hours, for the life of the tab.
  it("reads a marker from the future as no attempt at all", () => {
    sessionStorage.setItem(REAUTH_MARKER_KEY, String(T0 + 3_600_000));

    expect(requestReauth("auto", T0)).toBe(true);
  });
});

describe("stripReauthParam", () => {
  const original = window.location.href;

  afterEach(() => {
    window.history.replaceState(null, "", original);
  });

  it("drops the marker from the address bar and keeps the rest", () => {
    window.history.replaceState(null, "", "/?go=azzurra%2F%23grappa&reauth=1#frag");

    stripReauthParam();

    const url = new URL(window.location.href);
    expect(url.searchParams.has(REAUTH_PARAM)).toBe(false);
    expect(url.searchParams.get("go")).toBe("azzurra/#grappa");
    expect(url.hash).toBe("#frag");
  });

  it("leaves a URL without the marker alone", () => {
    window.history.replaceState(null, "", "/?go=azzurra");
    const replace = vi.spyOn(window.history, "replaceState");

    stripReauthParam();

    expect(replace).not.toHaveBeenCalled();
    replace.mockRestore();
  });
});
