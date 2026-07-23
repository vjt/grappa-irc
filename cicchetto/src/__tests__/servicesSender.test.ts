// UX-4 bucket G — servicesSender classifier cic-side mirror tests.
// Server-side source of truth lives in `lib/grappa/irc/identifier.ex`
// (test/grappa/irc/identifier_test.exs). cic mirrors the closed
// allowlist so the compose path can short-circuit `openQueryWindow` /
// focus-shift for `/msg <Xserv>` without round-tripping.

import { describe, expect, it } from "vitest";
import { isServicesSender } from "../lib/servicesSender";

describe("isServicesSender", () => {
  it("accepts the eleven well-known services nicks (case-insensitive)", () => {
    for (const nick of [
      "NickServ",
      "ChanServ",
      "MemoServ",
      "OperServ",
      "BotServ",
      "HostServ",
      "HelpServ",
      "RootServ",
      "SeenServ",
      "StatServ",
      "DebugServ",
    ]) {
      expect(isServicesSender(nick), `expected ${nick} to classify`).toBe(true);
      expect(isServicesSender(nick.toLowerCase())).toBe(true);
      expect(isServicesSender(nick.toUpperCase())).toBe(true);
    }
  });

  it("rejects channel-sigil targets", () => {
    expect(isServicesSender("#nickserv")).toBe(false);
    expect(isServicesSender("&chanserv")).toBe(false);
    expect(isServicesSender("+memoserv")).toBe(false);
    expect(isServicesSender("!operserv")).toBe(false);
    expect(isServicesSender("#dataserv")).toBe(false);
  });

  it("rejects ops nicks ending in -serv (bucket H regression guard)", () => {
    expect(isServicesSender("Conserv")).toBe(false);
    expect(isServicesSender("Dataserv")).toBe(false);
    expect(isServicesSender("Reserv")).toBe(false);
    expect(isServicesSender("bobserv")).toBe(false);
    expect(isServicesSender("conserve")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isServicesSender("")).toBe(false);
  });
});
