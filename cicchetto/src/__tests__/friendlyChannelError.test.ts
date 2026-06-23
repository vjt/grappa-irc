import { describe, expect, it } from "vitest";
import { ChannelPushError } from "../lib/api";
import { friendlyChannelError } from "../lib/friendlyChannelError";

// Issue #62 — exhaustive matrix over the channel-push wire tokens cic
// surfaces from the awaited `/away` pushes (socket.ts pushAwaySet/Unset).
// Adding an arm to friendlyChannelError MUST add a matrix entry here so an
// unmapped arm in production can't ship without a canary. Sibling of
// friendlyApiError.test.ts; same substring-not-equality contract so copy
// tweaks don't churn N tests.

const CASES: Array<{ code: string; matches: RegExp }> = [
  { code: "no_session", matches: /not connected to that network/i },
  { code: "not_explicit", matches: /not marked away/i },
  { code: "network_not_found", matches: /that network doesn't exist/i },
  { code: "user_not_found", matches: /account couldn't be found/i },
  { code: "invalid_reason", matches: /characters that aren't allowed/i },
];

describe("friendlyChannelError", () => {
  for (const { code, matches } of CASES) {
    it(`maps ${code} to human copy`, () => {
      expect(friendlyChannelError(new ChannelPushError(code))).toMatch(matches);
    });
  }

  it("falls through to ChannelPushError.message for unknown wire tokens", () => {
    // Loud fallback — an unmapped arm is operator-visible (no silent drop),
    // mirroring friendlyApiError's `<status> <code>` fallback.
    const err = new ChannelPushError("some_unmapped_token");
    expect(friendlyChannelError(err)).toBe("channel push error: some_unmapped_token");
  });

  it("does NOT map the removed visitor_no_away token (issue #62)", () => {
    // The server no longer emits visitor_no_away (gate removed); cic must
    // not carry a dead arm. It falls through to the loud raw-token message.
    const err = new ChannelPushError("visitor_no_away");
    expect(friendlyChannelError(err)).toBe("channel push error: visitor_no_away");
  });
});
