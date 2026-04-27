import { describe, expect, it } from "vitest";
import { parseSlash } from "../lib/slashCommands";

describe("parseSlash", () => {
  it("non-slash body parses as privmsg", () => {
    expect(parseSlash("hello world")).toEqual({ kind: "privmsg", body: "hello world" });
  });

  it("/me <action>", () => {
    expect(parseSlash("/me waves")).toEqual({ kind: "me", body: "waves" });
  });

  it("/join <channel>", () => {
    expect(parseSlash("/join #grappa")).toEqual({ kind: "join", channel: "#grappa" });
  });

  it("/part with explicit channel", () => {
    expect(parseSlash("/part #grappa")).toEqual({
      kind: "part",
      channel: "#grappa",
      reason: null,
    });
  });

  it("/part with no args parses as part-current (channel: null)", () => {
    expect(parseSlash("/part")).toEqual({
      kind: "part",
      channel: null,
      reason: null,
    });
  });

  it("/part with reason", () => {
    expect(parseSlash("/part #grappa byebye")).toEqual({
      kind: "part",
      channel: "#grappa",
      reason: "byebye",
    });
  });

  it("/topic <body>", () => {
    expect(parseSlash("/topic ciao mondo")).toEqual({
      kind: "topic",
      body: "ciao mondo",
    });
  });

  it("/nick <new>", () => {
    expect(parseSlash("/nick vjt-away")).toEqual({ kind: "nick", nick: "vjt-away" });
  });

  it("/msg <target> <body>", () => {
    expect(parseSlash("/msg alice ciao!")).toEqual({
      kind: "msg",
      target: "alice",
      body: "ciao!",
    });
  });

  it("/msg with body containing spaces preserved", () => {
    expect(parseSlash("/msg #italia ciao a tutti")).toEqual({
      kind: "msg",
      target: "#italia",
      body: "ciao a tutti",
    });
  });

  it("unknown slash command is parsed as :unknown with the original verb", () => {
    expect(parseSlash("/whois alice")).toEqual({ kind: "unknown", verb: "whois", rest: "alice" });
  });

  it("empty body is :empty", () => {
    expect(parseSlash("")).toEqual({ kind: "empty" });
    expect(parseSlash("  ")).toEqual({ kind: "empty" });
  });

  it("body starting with // is a literal privmsg starting with /", () => {
    expect(parseSlash("//me literal")).toEqual({ kind: "privmsg", body: "/me literal" });
  });
});
