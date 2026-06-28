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
    const result = parseSlash("/notarealverbatall foo");
    expect(result).toMatchObject({ kind: "error", verb: "notarealverbatall" });
  });
});

describe("parseSlash — /whois (C2)", () => {
  it("/whois <nick> parses to {kind: 'whois', nick}", () => {
    expect(parseSlash("/whois alice")).toEqual({ kind: "whois", nick: "alice" });
  });

  // #122 — bare /whois no longer errors in the parser; the consumer
  // resolves the current query window's nick (context-default).
  it("/whois bare → {kind: 'whois', nick: null} (context-default in compose)", () => {
    expect(parseSlash("/whois")).toEqual({ kind: "whois", nick: null });
  });

  // #122 — /w is the post-init alias of /whois.
  it("/w <nick> → same as /whois", () => {
    expect(parseSlash("/w alice")).toEqual({ kind: "whois", nick: "alice" });
  });

  it("/w bare → {kind: 'whois', nick: null}", () => {
    expect(parseSlash("/w")).toEqual({ kind: "whois", nick: null });
  });
});

describe("parseSlash — /whowas (P-0c)", () => {
  it("/whowas <nick> parses to {kind: 'whowas', nick}", () => {
    expect(parseSlash("/whowas alice")).toEqual({ kind: "whowas", nick: "alice" });
  });

  it("/whowas bare → error (nick required)", () => {
    expect(parseSlash("/whowas")).toMatchObject({ kind: "error", verb: "whowas" });
  });
});

describe("parseSlash — /me", () => {
  it("/me <action>", () => {
    expect(parseSlash("/me waves")).toEqual({ kind: "me", body: "waves" });
  });
});

describe("parseSlash — /join", () => {
  it("/join <channel> (no key)", () => {
    expect(parseSlash("/join #grappa")).toEqual({
      kind: "join",
      channel: "#grappa",
      key: null,
    });
  });

  it("/join missing channel → error", () => {
    expect(parseSlash("/join")).toMatchObject({ kind: "error", verb: "join" });
  });

  // UX-4 bucket F: +k channel-key support.
  it("/join <channel> <key> threads key", () => {
    expect(parseSlash("/join #priv secret")).toEqual({
      kind: "join",
      channel: "#priv",
      key: "secret",
    });
  });

  it("/join <channel> <key> <extra> → error (too many args)", () => {
    expect(parseSlash("/join #priv secret junk")).toMatchObject({
      kind: "error",
      verb: "join",
    });
  });

  // Bundle B (issue follow-up #30 pre-work): bare-name UX
  it("/join sniffo → auto-prepends # (UX shortcut)", () => {
    expect(parseSlash("/join sniffo")).toEqual({
      kind: "join",
      channel: "#sniffo",
      key: null,
    });
  });

  it("/j sniffo → alias of /join + auto-prepend", () => {
    expect(parseSlash("/j sniffo")).toEqual({
      kind: "join",
      channel: "#sniffo",
      key: null,
    });
  });

  it("/j #sniffo → alias, no double prepend", () => {
    expect(parseSlash("/j #sniffo")).toEqual({
      kind: "join",
      channel: "#sniffo",
      key: null,
    });
  });

  it("/j sniffo secret → alias + key", () => {
    expect(parseSlash("/j sniffo secret")).toEqual({
      kind: "join",
      channel: "#sniffo",
      key: "secret",
    });
  });

  it("/join &local → does not double-prepend on & prefix", () => {
    expect(parseSlash("/join &local")).toEqual({
      kind: "join",
      channel: "&local",
      key: null,
    });
  });

  // Comma-safety (review fix #5): IRC JOIN treats `,` as multi-channel
  // separator; auto-prepending `#` to `foo,bar` would join `#foo`
  // AND `bar` (unprefixed second). Reject the ambiguous shape with
  // a helpful error pointing to the explicit `#foo,#bar` form.
  it("/j foo,bar → error (bare names with commas are ambiguous for multi-join)", () => {
    expect(parseSlash("/j foo,bar")).toMatchObject({
      kind: "error",
      verb: "j",
    });
  });

  it("/j #foo,#bar → passes through (already explicitly multi-prefixed)", () => {
    expect(parseSlash("/j #foo,#bar")).toEqual({
      kind: "join",
      channel: "#foo,#bar",
      key: null,
    });
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

describe("parseSlash — /topic (context-aware, #23)", () => {
  it("/topic bare → show {channel: null} (resolves to current channel in compose)", () => {
    expect(parseSlash("/topic")).toEqual({ kind: "topic-show", channel: null });
  });

  it("/topic -delete → clear {channel: null} (current channel)", () => {
    expect(parseSlash("/topic -delete")).toEqual({ kind: "topic-clear", channel: null });
  });

  it("/topic <text> → set {channel: null} (current channel)", () => {
    expect(parseSlash("/topic ciao mondo")).toEqual({
      kind: "topic-set",
      channel: null,
      text: "ciao mondo",
    });
  });

  it("/topic #chan → show {channel: '#chan'}", () => {
    expect(parseSlash("/topic #sniffo")).toEqual({ kind: "topic-show", channel: "#sniffo" });
  });

  it("/topic #chan <text> → set {channel: '#chan', text}", () => {
    expect(parseSlash("/topic #sniffo porco dio")).toEqual({
      kind: "topic-set",
      channel: "#sniffo",
      text: "porco dio",
    });
  });

  it("/topic #chan -delete → clear {channel: '#chan'}", () => {
    expect(parseSlash("/topic #sniffo -delete")).toEqual({
      kind: "topic-clear",
      channel: "#sniffo",
    });
  });

  it("/topic &local <text> → set on local-scope channel (& prefix)", () => {
    expect(parseSlash("/topic &local hello")).toEqual({
      kind: "topic-set",
      channel: "&local",
      text: "hello",
    });
  });

  it("/topic body that happens to start with a non-channel char stays current-channel set", () => {
    expect(parseSlash("/topic cristo cane")).toEqual({
      kind: "topic-set",
      channel: null,
      text: "cristo cane",
    });
  });

  // Review fix #4: bare-# escape for topic bodies that legitimately
  // start with a channel sigil. `/topic # <body>` says "no channel
  // arg — `<body>` is the body even if it starts with #/&/+/!".
  it("/topic # <body that starts with #> → current-channel set, no channel-arg extraction", () => {
    expect(parseSlash("/topic # #urgent maintenance")).toEqual({
      kind: "topic-set",
      channel: null,
      text: "#urgent maintenance",
    });
  });

  it("/topic # <body that starts with !> → current-channel set", () => {
    expect(parseSlash("/topic # !announce downtime")).toEqual({
      kind: "topic-set",
      channel: null,
      text: "!announce downtime",
    });
  });

  it("/topic # -delete → clears current channel (escape applies to control verbs too)", () => {
    expect(parseSlash("/topic # -delete")).toEqual({
      kind: "topic-clear",
      channel: null,
    });
  });

  it("/topic # (bare escape, nothing after) → show current channel", () => {
    expect(parseSlash("/topic #")).toEqual({ kind: "topic-show", channel: null });
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
    expect(parseSlash("/msg bob ciao a tutti")).toEqual({
      kind: "msg",
      target: "bob",
      body: "ciao a tutti",
    });
  });

  it("/msg missing target → error", () => {
    expect(parseSlash("/msg")).toMatchObject({ kind: "error", verb: "msg" });
  });

  it("/msg missing body → error", () => {
    expect(parseSlash("/msg alice")).toMatchObject({ kind: "error", verb: "msg" });
  });

  // #12 — /msg is for nicks (queries). grappa does not relay a PRIVMSG to a
  // channel addressed by name, so a channel-shaped target opened a phantom
  // query window keyed by a channel name whose own-send never rendered.
  // Reject every IRC channel sigil (# & ! +) up front, not just '#'.
  it.each(["#foo", "&local", "!12345chan", "+modeless"])(
    "/msg to a channel (%s) is rejected (#12)",
    (chan) => {
      const r = parseSlash(`/msg ${chan} hello`);
      expect(r).toMatchObject({ kind: "error", verb: "msg" });
      expect((r as { message: string }).message).toMatch(/channel/i);
    },
  );
});

describe("parseSlash — /query and /q (DM aliases)", () => {
  it("/query <nick> → open query window without message", () => {
    expect(parseSlash("/query alice")).toEqual({ kind: "query", target: "alice" });
  });

  it("/q <nick> → same as /query", () => {
    expect(parseSlash("/q alice")).toEqual({ kind: "query", target: "alice" });
  });

  // Bundle B: bare /query / /q now parses to {target: null}. compose.ts
  // resolves: on a query window → close; elsewhere → error.
  it("/query bare → {target: null} (close-current-query semantics in compose)", () => {
    expect(parseSlash("/query")).toEqual({ kind: "query", target: null });
  });

  it("/q bare → {target: null}", () => {
    expect(parseSlash("/q")).toEqual({ kind: "query", target: null });
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

  it("/away : (bare colon, no text) → unset (empty reason is not a set)", () => {
    // An empty away reason builds `AWAY :` on the wire — the bare-AWAY
    // un-away line (RFC 2812 §4.6). The server (Session.set_explicit_away)
    // rejects it as :invalid_line, and semantically it means the same as
    // bare /away. So an empty reason after the colon-strip → unset, not a
    // set with reason "". (Pre-fix this asserted the buggy set/"" shape.)
    expect(parseSlash("/away :")).toEqual({ kind: "away", action: "unset" });
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

  // #122 — /n is the post-init alias of /names.
  it("/n bare → same as /names with no target", () => {
    expect(parseSlash("/n")).toEqual({ kind: "names", target: null });
  });

  it("/n <target> → same as /names", () => {
    expect(parseSlash("/n #grappa")).toEqual({ kind: "names", target: "#grappa" });
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

describe("parseSlash — /lusers (P-0d)", () => {
  it("parses bare /lusers", () => {
    expect(parseSlash("/lusers")).toEqual({ kind: "lusers" });
  });

  it("ignores any trailing args (LUSERS is param-less)", () => {
    expect(parseSlash("/lusers ignored")).toEqual({ kind: "lusers" });
  });
});

describe("parseSlash — services shortcuts (#20)", () => {
  it.each([
    ["cs", "ChanServ"],
    ["ns", "NickServ"],
    ["ms", "MemoServ"],
    ["os", "OperServ"],
    ["hs", "HostServ"],
    ["rs", "RootServ"],
  ])("/%s <cmd> → msg target=%s", (verb, target) => {
    expect(parseSlash(`/${verb} HELP`)).toEqual({
      kind: "msg",
      target,
      body: "HELP",
    });
  });

  it("/ns IDENTIFY preserves the rest verbatim (multi-token body)", () => {
    expect(parseSlash("/ns IDENTIFY hunter2 backup_pw")).toEqual({
      kind: "msg",
      target: "NickServ",
      body: "IDENTIFY hunter2 backup_pw",
    });
  });

  it.each(["cs", "ns", "ms", "os", "hs", "rs"])("/%s with no body → error", (verb) => {
    expect(parseSlash(`/${verb}`)).toMatchObject({ kind: "error", verb });
  });
});

describe("parseSlash — /quote", () => {
  it("/quote <line> → {line}", () => {
    expect(parseSlash("/quote PING :foo.bar")).toEqual({
      kind: "quote",
      line: "PING :foo.bar",
    });
  });

  it("/quote bare → error", () => {
    expect(parseSlash("/quote")).toMatchObject({ kind: "error", verb: "quote" });
  });

  it("/quote with multi-token line preserves the whole tail", () => {
    expect(parseSlash("/quote PRIVMSG #x :hello world")).toEqual({
      kind: "quote",
      line: "PRIVMSG #x :hello world",
    });
  });
});

describe("parseSlash — /oper", () => {
  it("/oper <name> <password> → {name, password}", () => {
    expect(parseSlash("/oper vjt s3cret")).toEqual({
      kind: "oper",
      name: "vjt",
      password: "s3cret",
    });
  });

  it("/oper bare → error", () => {
    expect(parseSlash("/oper")).toMatchObject({ kind: "error", verb: "oper" });
  });

  it("/oper <name> (no password) → error", () => {
    expect(parseSlash("/oper vjt")).toMatchObject({ kind: "error", verb: "oper" });
  });

  it("/oper rejects multi-word password (IRC OPER takes a single token)", () => {
    expect(parseSlash("/oper vjt this is my passphrase")).toMatchObject({
      kind: "error",
      verb: "oper",
    });
  });
});
