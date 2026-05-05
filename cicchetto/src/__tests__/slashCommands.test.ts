import { describe, expect, it } from "vitest";
import { parseSlash } from "../lib/slashCommands";

describe("parseSlash — basics", () => {
  it("non-slash body parses as privmsg", () => {
    expect(parseSlash("hello world")).toEqual({ kind: "privmsg", body: "hello world" });
  });

  it("empty body is :empty", () => {
    expect(parseSlash("")).toEqual({ kind: "empty" });
    expect(parseSlash("  ")).toEqual({ kind: "empty" });
  });

  it("body starting with // is a literal privmsg starting with /", () => {
    expect(parseSlash("//me literal")).toEqual({ kind: "privmsg", body: "/me literal" });
  });

  it("unknown verb surfaces as error with the original verb", () => {
    const result = parseSlash("/whois alice");
    expect(result).toMatchObject({ kind: "error", verb: "whois" });
  });
});

describe("parseSlash — /me", () => {
  it("/me <action>", () => {
    expect(parseSlash("/me waves")).toEqual({ kind: "me", body: "waves" });
  });
});

describe("parseSlash — /join", () => {
  it("/join <channel>", () => {
    expect(parseSlash("/join #grappa")).toEqual({ kind: "join", channel: "#grappa" });
  });

  it("/join missing channel → error", () => {
    expect(parseSlash("/join")).toMatchObject({ kind: "error", verb: "join" });
  });
});

describe("parseSlash — /part", () => {
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
});

describe("parseSlash — /topic", () => {
  it("/topic bare → show cached topic", () => {
    expect(parseSlash("/topic")).toEqual({ kind: "topic-show" });
  });

  it("/topic -delete → clear topic", () => {
    expect(parseSlash("/topic -delete")).toEqual({ kind: "topic-clear" });
  });

  it("/topic <text> → set topic", () => {
    expect(parseSlash("/topic ciao mondo")).toEqual({
      kind: "topic-set",
      text: "ciao mondo",
    });
  });
});

describe("parseSlash — /nick", () => {
  it("/nick <new>", () => {
    expect(parseSlash("/nick vjt-away")).toEqual({ kind: "nick", nick: "vjt-away" });
  });

  it("/nick missing arg → error", () => {
    expect(parseSlash("/nick")).toMatchObject({ kind: "error", verb: "nick" });
  });
});

describe("parseSlash — /msg", () => {
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

  it("/msg missing target → error", () => {
    expect(parseSlash("/msg")).toMatchObject({ kind: "error", verb: "msg" });
  });

  it("/msg missing body → error", () => {
    expect(parseSlash("/msg alice")).toMatchObject({ kind: "error", verb: "msg" });
  });
});

describe("parseSlash — /query and /q (DM aliases)", () => {
  it("/query <nick> → open query window without message", () => {
    expect(parseSlash("/query alice")).toEqual({ kind: "query", target: "alice" });
  });

  it("/q <nick> → same as /query", () => {
    expect(parseSlash("/q alice")).toEqual({ kind: "query", target: "alice" });
  });

  it("/query missing nick → error", () => {
    expect(parseSlash("/query")).toMatchObject({ kind: "error", verb: "query" });
  });

  it("/q missing nick → error", () => {
    expect(parseSlash("/q")).toMatchObject({ kind: "error", verb: "q" });
  });
});

describe("parseSlash — T32 verbs (/quit /disconnect /connect)", () => {
  it("/quit bare → reason: null", () => {
    expect(parseSlash("/quit")).toEqual({ kind: "quit", reason: null });
  });

  it("/quit with reason text → reason: string", () => {
    expect(parseSlash("/quit going offline")).toEqual({
      kind: "quit",
      reason: "going offline",
    });
  });

  it("/disconnect bare → network: null, reason: null", () => {
    expect(parseSlash("/disconnect")).toEqual({
      kind: "disconnect",
      network: null,
      reason: null,
    });
  });

  it("/disconnect <netslug> → network: slug, reason: null", () => {
    expect(parseSlash("/disconnect libera")).toEqual({
      kind: "disconnect",
      network: "libera",
      reason: null,
    });
  });

  it("/disconnect <netslug> <reason...> → network: slug, reason: rest of args", () => {
    expect(parseSlash("/disconnect libera going offline now")).toEqual({
      kind: "disconnect",
      network: "libera",
      reason: "going offline now",
    });
  });

  it("/connect <netslug> → network: slug", () => {
    expect(parseSlash("/connect libera")).toEqual({ kind: "connect", network: "libera" });
  });

  it("/connect bare → error (network arg required)", () => {
    const result = parseSlash("/connect");
    expect(result).toMatchObject({ kind: "error", verb: "connect" });
  });
});

describe("parseSlash — /away", () => {
  it("/away bare → unset explicit away", () => {
    expect(parseSlash("/away")).toEqual({ kind: "away", action: "unset" });
  });

  it("/away <reason text> → set with reason", () => {
    expect(parseSlash("/away brb coffee")).toEqual({
      kind: "away",
      action: "set",
      reason: "brb coffee",
    });
  });

  it("/away :reason (irssi-style colon prefix) → strips leading colon", () => {
    expect(parseSlash("/away :gone fishing")).toEqual({
      kind: "away",
      action: "set",
      reason: "gone fishing",
    });
  });

  it("/away : (bare colon, no text) → set with empty string reason", () => {
    expect(parseSlash("/away :")).toEqual({
      kind: "away",
      action: "set",
      reason: "",
    });
  });

  it("/away    (only whitespace after verb) → unset (empty rest)", () => {
    expect(parseSlash("/away   ")).toEqual({ kind: "away", action: "unset" });
  });
});

describe("parseSlash — channel ops verbs", () => {
  it("/op <nick> → op with one nick", () => {
    expect(parseSlash("/op alice")).toEqual({ kind: "op", nicks: ["alice"] });
  });

  it("/op <nick1> <nick2> → op with multiple nicks", () => {
    expect(parseSlash("/op alice bob carol")).toEqual({
      kind: "op",
      nicks: ["alice", "bob", "carol"],
    });
  });

  it("/op missing nicks → error", () => {
    expect(parseSlash("/op")).toMatchObject({ kind: "error", verb: "op" });
  });

  it("/deop <nick>", () => {
    expect(parseSlash("/deop alice")).toEqual({ kind: "deop", nicks: ["alice"] });
  });

  it("/deop missing nicks → error", () => {
    expect(parseSlash("/deop")).toMatchObject({ kind: "error", verb: "deop" });
  });

  it("/voice <nick>", () => {
    expect(parseSlash("/voice alice")).toEqual({ kind: "voice", nicks: ["alice"] });
  });

  it("/voice missing nicks → error", () => {
    expect(parseSlash("/voice")).toMatchObject({ kind: "error", verb: "voice" });
  });

  it("/devoice <nick>", () => {
    expect(parseSlash("/devoice alice")).toEqual({ kind: "devoice", nicks: ["alice"] });
  });

  it("/devoice missing nicks → error", () => {
    expect(parseSlash("/devoice")).toMatchObject({ kind: "error", verb: "devoice" });
  });

  it("/kick <nick> bare (no reason)", () => {
    expect(parseSlash("/kick alice")).toEqual({ kind: "kick", nick: "alice", reason: "" });
  });

  it("/kick <nick> <reason>", () => {
    expect(parseSlash("/kick alice bye bye")).toEqual({
      kind: "kick",
      nick: "alice",
      reason: "bye bye",
    });
  });

  it("/kick missing nick → error", () => {
    expect(parseSlash("/kick")).toMatchObject({ kind: "error", verb: "kick" });
  });

  it("/ban <mask>", () => {
    expect(parseSlash("/ban *!*@evil.com")).toEqual({ kind: "ban", mask: "*!*@evil.com" });
  });

  it("/ban <nick> (bare nick for WHOIS-cache mask derivation server-side)", () => {
    expect(parseSlash("/ban alice")).toEqual({ kind: "ban", mask: "alice" });
  });

  it("/ban missing mask → error", () => {
    expect(parseSlash("/ban")).toMatchObject({ kind: "error", verb: "ban" });
  });

  it("/unban <mask>", () => {
    expect(parseSlash("/unban *!*@evil.com")).toEqual({ kind: "unban", mask: "*!*@evil.com" });
  });

  it("/unban missing mask → error", () => {
    expect(parseSlash("/unban")).toMatchObject({ kind: "error", verb: "unban" });
  });

  it("/banlist bare", () => {
    expect(parseSlash("/banlist")).toEqual({ kind: "banlist" });
  });

  it("/invite <nick>", () => {
    expect(parseSlash("/invite alice")).toEqual({ kind: "invite", nick: "alice", channel: null });
  });

  it("/invite <nick> <#chan>", () => {
    expect(parseSlash("/invite alice #secret")).toEqual({
      kind: "invite",
      nick: "alice",
      channel: "#secret",
    });
  });

  it("/invite missing nick → error", () => {
    expect(parseSlash("/invite")).toMatchObject({ kind: "error", verb: "invite" });
  });

  it("/umode <modes>", () => {
    expect(parseSlash("/umode +i")).toEqual({ kind: "umode", modes: "+i" });
  });

  it("/umode missing modes → error", () => {
    expect(parseSlash("/umode")).toMatchObject({ kind: "error", verb: "umode" });
  });

  it("/mode <target> <modes>", () => {
    expect(parseSlash("/mode #sniffo +o-v")).toEqual({
      kind: "mode",
      target: "#sniffo",
      modes: "+o-v",
      params: [],
    });
  });

  it("/mode <target> <modes> <params...>", () => {
    expect(parseSlash("/mode #sniffo +o-v alice rofl")).toEqual({
      kind: "mode",
      target: "#sniffo",
      modes: "+o-v",
      params: ["alice", "rofl"],
    });
  });

  it("/mode missing target → error", () => {
    expect(parseSlash("/mode")).toMatchObject({ kind: "error", verb: "mode" });
  });

  it("/mode missing modes → error", () => {
    expect(parseSlash("/mode #sniffo")).toMatchObject({ kind: "error", verb: "mode" });
  });
});

describe("parseSlash — info verbs (TODO — server-side missing)", () => {
  it("/who bare → who with no target", () => {
    expect(parseSlash("/who")).toEqual({ kind: "who", target: null });
  });

  it("/who <target>", () => {
    expect(parseSlash("/who alice")).toEqual({ kind: "who", target: "alice" });
  });

  it("/names bare → names with no target", () => {
    expect(parseSlash("/names")).toEqual({ kind: "names", target: null });
  });

  it("/names <target>", () => {
    expect(parseSlash("/names #grappa")).toEqual({ kind: "names", target: "#grappa" });
  });

  it("/list bare → list with no pattern", () => {
    expect(parseSlash("/list")).toEqual({ kind: "list", pattern: null });
  });

  it("/list <pattern>", () => {
    expect(parseSlash("/list *grappa*")).toEqual({ kind: "list", pattern: "*grappa*" });
  });

  it("/links bare → links with no pattern", () => {
    expect(parseSlash("/links")).toEqual({ kind: "links", pattern: null });
  });

  it("/links <pattern>", () => {
    expect(parseSlash("/links *.irc.net")).toEqual({ kind: "links", pattern: "*.irc.net" });
  });
});

describe("parseSlash — watchlist verbs (/watch and /highlight are aliases)", () => {
  it("/watch add <pattern>", () => {
    expect(parseSlash("/watch add myname")).toEqual({
      kind: "watchlist",
      action: "add",
      pattern: "myname",
    });
  });

  it("/highlight add <pattern> — same as /watch add", () => {
    expect(parseSlash("/highlight add myname")).toEqual({
      kind: "watchlist",
      action: "add",
      pattern: "myname",
    });
  });

  it("/watch del <pattern>", () => {
    expect(parseSlash("/watch del myname")).toEqual({
      kind: "watchlist",
      action: "del",
      pattern: "myname",
    });
  });

  it("/highlight del <pattern> — same as /watch del", () => {
    expect(parseSlash("/highlight del myname")).toEqual({
      kind: "watchlist",
      action: "del",
      pattern: "myname",
    });
  });

  it("/watch list", () => {
    expect(parseSlash("/watch list")).toEqual({ kind: "watchlist", action: "list" });
  });

  it("/highlight list — same as /watch list", () => {
    expect(parseSlash("/highlight list")).toEqual({ kind: "watchlist", action: "list" });
  });

  it("/watch bare → error (subverb required)", () => {
    expect(parseSlash("/watch")).toMatchObject({ kind: "error", verb: "watch" });
  });

  it("/watch add missing pattern → error", () => {
    expect(parseSlash("/watch add")).toMatchObject({ kind: "error", verb: "watch" });
  });

  it("/watch del missing pattern → error", () => {
    expect(parseSlash("/watch del")).toMatchObject({ kind: "error", verb: "watch" });
  });

  it("/watch unknown subverb → error", () => {
    expect(parseSlash("/watch foo")).toMatchObject({ kind: "error", verb: "watch" });
  });
});
