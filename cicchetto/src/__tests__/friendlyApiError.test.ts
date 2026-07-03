import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api";
import { friendlyApiError } from "../lib/friendlyApiError";

// U-3 (UD3) — exhaustive matrix over the typed-error wire tokens
// the server emits via FallbackController. Adding a new arm to
// friendlyApiError MUST add a matrix entry here so silent-drops
// (unmapped arm in production code, but no test = no canary)
// can't happen. Per `feedback_no_localized_strings_server_side` +
// the `project_no_silent_drops_closed` exhaustiveness lesson.
//
// We assert a SUBSTRING (not full equality) so copy tweaks don't
// require N test edits — the matrix's contract is "the code has
// a human-readable arm that includes a recognisable phrase," not
// the exact wording.

const CASES: Array<{ code: string; matches: RegExp; info?: Record<string, unknown> }> = [
  { code: "invalid_credentials", matches: /invalid name or password/i },
  // U-3: ip_cap_exceeded → device-scoped copy
  { code: "too_many_sessions", matches: /at the session limit for this network from this device/i },
  // visitor_cap_exceeded / user_cap_exceeded both wire to network_busy
  { code: "network_busy", matches: /this network is at capacity/i },
  // network_circuit_open carries retry_after
  {
    code: "network_unreachable",
    matches: /retry in 42 seconds/i,
    info: { retry_after: 42 },
  },
  { code: "network_unreachable", matches: /can't reach the network right now/i },
  { code: "connect_timeout", matches: /handshake didn't complete/i },
  { code: "welcome_timeout", matches: /responding slowly/i },
  { code: "probe_timeout", matches: /internal timeout/i },
  { code: "service_degraded", matches: /temporarily unavailable/i },
  { code: "captcha_failed", matches: /captcha challenge failed/i },
  { code: "captcha_required", matches: /verification temporarily unavailable/i },
  // T32 connect/disconnect compose-time errors (U-3 newly mapped)
  { code: "not_connected", matches: /isn't in a state to connect or disconnect/i },
  { code: "upstream_unreachable", matches: /couldn't reach the upstream irc server/i },
  // #40 — 433 nick-in-use at login, and visitor /nick rename collision
  { code: "nick_in_use", matches: /already in use on this network/i },
  { code: "forbidden", matches: /isn't allowed to perform that action/i },
  { code: "not_found", matches: /that network or resource doesn't exist/i },
  { code: "bad_request", matches: /the request was malformed/i },
  { code: "internal", matches: /server hit an internal error/i },
  // Cic M3 reviewer fix: previously-unmapped FallbackController arms.
  { code: "unauthorized", matches: /your session expired/i },
  {
    code: "validation_failed",
    matches: /please fix: nick: can't be blank/i,
    info: { field_errors: { nick: ["can't be blank"] } },
  },
  {
    code: "validation_failed",
    matches: /please fix: nick: too short, must be unique/i,
    info: { field_errors: { nick: ["too short", "must be unique"] } },
  },
  // validation_failed without info → generic copy fallback.
  { code: "validation_failed", matches: /the request was invalid/i },
  { code: "cannot_disconnect_self", matches: /can't disconnect or terminate your own session/i },
];

describe("friendlyApiError", () => {
  for (const { code, matches, info } of CASES) {
    it(`maps ${code}${info !== undefined ? " (with info)" : ""} to human copy`, () => {
      const err = new ApiError(500, code, info ?? {});
      expect(friendlyApiError(err)).toMatch(matches);
    });
  }

  it("falls through to ApiError.message for unknown wire tokens", () => {
    // S47 strict-equality regression — substring containment must NOT
    // collide with the closed-union arms. Defaulting to err.message
    // (`<status> <code>`) is loud enough that an unmapped arm is
    // operator-visible (no silent drop).
    const err = new ApiError(500, "some_unmapped_token");
    expect(friendlyApiError(err)).toBe("500 some_unmapped_token");
  });

  it("network_unreachable without retry_after info uses generic copy", () => {
    const err = new ApiError(503, "network_unreachable", {});
    expect(friendlyApiError(err)).toBe("We can't reach the network right now.");
  });
});
