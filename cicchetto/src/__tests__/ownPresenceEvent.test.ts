import { describe, expect, it } from "vitest";
import type { ScrollbackMessage } from "../lib/api";
import { isOwnPresenceEvent } from "../lib/ownPresenceEvent";

const baseMsg: ScrollbackMessage = {
  id: 1,
  network: "freenode",
  channel: "#grappa",
  server_time: 1_700_000_000_000,
  kind: "join",
  sender: "alice",
  body: null,
  meta: {},
};

describe("isOwnPresenceEvent", () => {
  it("returns true for kind:'join' from own nick", () => {
    expect(isOwnPresenceEvent({ ...baseMsg, kind: "join", sender: "alice" }, "alice")).toBe(true);
  });

  it("returns true for kind:'part' from own nick", () => {
    expect(isOwnPresenceEvent({ ...baseMsg, kind: "part", sender: "alice" }, "alice")).toBe(true);
  });

  it("returns true for kind:'quit' from own nick", () => {
    expect(isOwnPresenceEvent({ ...baseMsg, kind: "quit", sender: "alice" }, "alice")).toBe(true);
  });

  it("returns true for kind:'nick_change' from own nick", () => {
    expect(isOwnPresenceEvent({ ...baseMsg, kind: "nick_change", sender: "alice" }, "alice")).toBe(
      true,
    );
  });

  it("returns true for kind:'mode' from own nick", () => {
    expect(isOwnPresenceEvent({ ...baseMsg, kind: "mode", sender: "alice" }, "alice")).toBe(true);
  });

  it("returns true for kind:'kick' from own nick (operator kicked)", () => {
    expect(isOwnPresenceEvent({ ...baseMsg, kind: "kick", sender: "alice" }, "alice")).toBe(true);
  });

  it("returns false for presence kind from peer nick", () => {
    expect(isOwnPresenceEvent({ ...baseMsg, kind: "join", sender: "bob" }, "alice")).toBe(false);
    expect(isOwnPresenceEvent({ ...baseMsg, kind: "part", sender: "bob" }, "alice")).toBe(false);
  });

  it("returns false for content kinds even from own nick", () => {
    expect(isOwnPresenceEvent({ ...baseMsg, kind: "privmsg", sender: "alice" }, "alice")).toBe(
      false,
    );
    expect(isOwnPresenceEvent({ ...baseMsg, kind: "notice", sender: "alice" }, "alice")).toBe(
      false,
    );
    expect(isOwnPresenceEvent({ ...baseMsg, kind: "action", sender: "alice" }, "alice")).toBe(
      false,
    );
  });

  it("returns false when ownNick is null (no comparison possible)", () => {
    expect(isOwnPresenceEvent({ ...baseMsg, kind: "join", sender: "alice" }, null)).toBe(false);
  });

  it("is case-insensitive (RFC 2812 nicks via nickEquals)", () => {
    expect(isOwnPresenceEvent({ ...baseMsg, kind: "join", sender: "Alice" }, "alice")).toBe(true);
    expect(isOwnPresenceEvent({ ...baseMsg, kind: "part", sender: "ALICE" }, "alice")).toBe(true);
  });

  it("kind:'topic' is NOT in the presence set (delivered via topic_changed WS event)", () => {
    expect(isOwnPresenceEvent({ ...baseMsg, kind: "topic", sender: "alice" }, "alice")).toBe(false);
  });
});
