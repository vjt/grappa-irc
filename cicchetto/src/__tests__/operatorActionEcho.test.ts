import { describe, expect, it } from "vitest";
import type { ScrollbackMessage } from "../lib/api";
import { isOperatorActionEcho } from "../lib/operatorActionEcho";

const baseMsg: ScrollbackMessage = {
  id: 1,
  network: "freenode",
  channel: "#grappa",
  server_time: 1_700_000_000_000,
  kind: "privmsg",
  sender: "alice",
  body: "hi",
  meta: {},
};

describe("isOperatorActionEcho", () => {
  it("returns true for kind:'notice' with meta.numeric set", () => {
    expect(
      isOperatorActionEcho({
        ...baseMsg,
        kind: "notice",
        meta: { numeric: 401, severity: "error" },
      }),
    ).toBe(true);
  });

  it("returns true for any numeric (info numerics like 305 RPL_UNAWAY too)", () => {
    expect(
      isOperatorActionEcho({
        ...baseMsg,
        kind: "notice",
        meta: { numeric: 305, severity: "ok" },
      }),
    ).toBe(true);
  });

  it("returns false for kind:'notice' without meta.numeric (peer NOTICE)", () => {
    expect(isOperatorActionEcho({ ...baseMsg, kind: "notice", meta: {} })).toBe(false);
  });

  it("returns false when meta.numeric is non-numeric (defensive)", () => {
    expect(
      isOperatorActionEcho({
        ...baseMsg,
        kind: "notice",
        meta: { numeric: "401" as unknown as number },
      }),
    ).toBe(false);
  });

  it("returns false for kind:'privmsg' even with meta.numeric (the kind gate matters)", () => {
    expect(
      isOperatorActionEcho({
        ...baseMsg,
        kind: "privmsg",
        meta: { numeric: 401 },
      }),
    ).toBe(false);
  });

  // CP20 regression — the $server window EXISTS to surface routed server
  // numerics (MOTD, RPL_NOWAWAY 306, untargeted NOTICEs, lifecycle events).
  // Suppressing those rows would silence the badge that's the whole point
  // of the window. The "operator-action echo" semantic is:
  //   "row produced by my action that landed where I already am" — true
  //   for /msg-to-ghost → 401 in the ghost query window (CP20 bug).
  // For /away → 306 routed to $server, the operator is on #bofh; the row
  // landing in $server IS the user-visible feedback they should see.
  // The boundary is the routing target, not the row's `meta.numeric`.
  it("returns false for $server-routed numeric notices (CP20 regression)", () => {
    expect(
      isOperatorActionEcho({
        ...baseMsg,
        channel: "$server",
        kind: "notice",
        meta: { numeric: 306, severity: "ok" },
      }),
    ).toBe(false);
  });

  // Symmetry: same numeric routed to a non-$server window IS still echo
  // (CP20 original 401 ghost-DM scenario survives the predicate refinement).
  it("still returns true for non-$server numeric notices (CP20 original case)", () => {
    expect(
      isOperatorActionEcho({
        ...baseMsg,
        channel: "ghost",
        kind: "notice",
        meta: { numeric: 401, severity: "error" },
      }),
    ).toBe(true);
  });
});
