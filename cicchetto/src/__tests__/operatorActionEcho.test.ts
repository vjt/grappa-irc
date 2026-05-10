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
});
