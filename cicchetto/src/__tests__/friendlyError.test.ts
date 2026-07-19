import { describe, expect, it } from "vitest";
import { ApiError, ChannelPushError } from "../lib/api";
import { friendlyError } from "../lib/friendlyError";

// #74 — `friendlyError` is the single dispatcher that maps a thrown error
// from EITHER send door (REST `ApiError` → `friendlyApiError`, WS
// `ChannelPushError` → `friendlyChannelError`) to human copy, with a loud
// generic fallback for an untyped throw. Extracted from compose.ts's submit
// catch so the inline-topic-edit submit reuses the exact same mapping — one
// contract, no copy-paste-with-tweaks.

describe("friendlyError", () => {
  it("maps a typed REST ApiError via friendlyApiError", () => {
    // `invalid_credentials` is a known code with fixed copy.
    expect(friendlyError(new ApiError(401, "invalid_credentials"))).toBe(
      "Invalid name or password.",
    );
  });

  it("maps a typed channel-push error via friendlyChannelError", () => {
    // `invalid_channel` is a known channel-push code with fixed copy.
    expect(friendlyError(new ChannelPushError("invalid_channel"))).toBe(
      "That channel name isn't valid.",
    );
  });

  // #342 — the ingress token-bucket throttle (#340) 429s a flooding send
  // with the SAME `rate_limited` wire token themes' daily quota uses. On the
  // SEND door that token means "slow down", not themes' "try tomorrow".
  // `friendlyError` is the send-door dispatcher, so it owns the throttle copy
  // and overrides `rate_limited` BEFORE delegating to `friendlyApiError`
  // (which keeps the themes-surface copy for ThemeEditor/ThemeGallery that
  // call it directly, bypassing this dispatcher). Any `rate_limited` reaching
  // `friendlyError` is a send-throttle by construction — themes never route
  // through here.
  it("maps a send-door rate_limited to the throttle copy, not themes' quota copy", () => {
    expect(friendlyError(new ApiError(429, "rate_limited"))).toBe(
      "You're sending too fast — the server is throttling you. Slow down and try again in a moment.",
    );
  });

  it("falls back to a loud generic string for an untyped Error", () => {
    expect(friendlyError(new Error("kaboom"))).toBe("send failed");
  });

  it("falls back to the generic string for a non-Error throw", () => {
    expect(friendlyError("just a string")).toBe("send failed");
    expect(friendlyError(undefined)).toBe("send failed");
  });
});
