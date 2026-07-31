import { describe, expect, it } from "vitest";
import {
  expandAlias,
  isNonShadowableVerb,
  MAX_ALIAS_DEPTH,
  parseSlash,
} from "../lib/slashCommands";

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
  it("/whois <nick> parses to {kind: 'whois', nick, server: null}", () => {
    expect(parseSlash("/whois alice")).toEqual({ kind: "whois", nick: "alice", server: null });
  });

  // #198 — two-arg RFC form `/whois <server> <nick>`: first token is the
  // target server the query routes through, second is the nick.
  it("/whois <server> <nick> → {kind: 'whois', nick, server} (#198)", () => {
    expect(parseSlash("/whois irc.azzurra.org bob")).toEqual({
      kind: "whois",
      nick: "bob",
      server: "irc.azzurra.org",
    });
  });

  // #198 — extra tokens past the second are ignored (WHOIS is a 2-slot
  // wire frame: <server> <nick>), so `/w <server> <nick> junk` still
  // routes server+nick.
  it("/whois <server> <nick> <junk> ignores trailing tokens (#198)", () => {
    expect(parseSlash("/whois irc.azzurra.org bob extra")).toEqual({
      kind: "whois",
      nick: "bob",
      server: "irc.azzurra.org",
    });
  });

  // #122 — bare /whois no longer errors in the parser; the consumer
  // resolves the current query window's nick (context-default).
  it("/whois bare → {kind: 'whois', nick: null, server: null} (context-default in compose)", () => {
    expect(parseSlash("/whois")).toEqual({ kind: "whois", nick: null, server: null });
  });

  // #122 — /w is the post-init alias of /whois.
  it("/w <nick> → same as /whois", () => {
    expect(parseSlash("/w alice")).toEqual({ kind: "whois", nick: "alice", server: null });
  });

  // #198 — the /w alias shares the parser, so the two-arg form works too.
  it("/w <server> <nick> → same two-arg form (#198)", () => {
    expect(parseSlash("/w irc.azzurra.org bob")).toEqual({
      kind: "whois",
      nick: "bob",
      server: "irc.azzurra.org",
    });
  });

  it("/w bare → {kind: 'whois', nick: null, server: null}", () => {
    expect(parseSlash("/w")).toEqual({ kind: "whois", nick: null, server: null });
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
    expect(parseSlash("/topic #sniffo hello world")).toEqual({
      kind: "topic-set",
      channel: "#sniffo",
      text: "hello world",
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
    expect(parseSlash("/topic foo bar")).toEqual({
      kind: "topic-set",
      channel: null,
      text: "foo bar",
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

  // #386 — /kb <nick> [reason] kickban. Same grammar as /kick (first token
  // is the nick, the rest is the reason); the ban-mask derivation + MODE+KICK
  // sequencing live in compose.ts. /kickban is an irssi-spelling alias.
  it("/kb <nick> bare (no reason)", () => {
    expect(parseSlash("/kb alice")).toEqual({ kind: "kb", nick: "alice", reason: "" });
  });

  it("/kb <nick> <reason>", () => {
    expect(parseSlash("/kb alice spam spam spam")).toEqual({
      kind: "kb",
      nick: "alice",
      reason: "spam spam spam",
    });
  });

  it("/kb missing nick → error", () => {
    expect(parseSlash("/kb")).toMatchObject({ kind: "error", verb: "kb" });
  });

  it("/kickban is an alias of /kb", () => {
    expect(parseSlash("/kickban alice rude")).toEqual({
      kind: "kb",
      nick: "alice",
      reason: "rude",
    });
  });

  it("/banlist bare → banlist for the current channel (null)", () => {
    expect(parseSlash("/banlist")).toEqual({ kind: "banlist", channel: null });
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

  // #229 — bare /umode opens the umode viewer/editor modal (was an error
  // pre-#229). Mirror of bare /mode opening the channel-mode modal.
  it("/umode (bare) → umode-view (open the umode modal)", () => {
    expect(parseSlash("/umode")).toEqual({ kind: "umode-view" });
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

  // #229 — /mode <nick> with NO mode args opens the umode modal (was an
  // error pre-#229). The parser stays pure and emits the target;
  // compose.ts resolves it against the operator's own nick.
  it("/mode <nick> (no modes) → umode-target-view carrying the target", () => {
    expect(parseSlash("/mode vjt-grappa")).toEqual({
      kind: "umode-target-view",
      target: "vjt-grappa",
    });
  });

  it("/mode <nick> <modes> still executes a user-MODE change directly", () => {
    expect(parseSlash("/mode vjt-grappa +i")).toEqual({
      kind: "mode",
      target: "vjt-grappa",
      modes: "+i",
      params: [],
    });
  });

  // #216 — no-mode-args forms open the viewer/editor modal instead of
  // executing. The modal only opens when there are NO mode arguments;
  // any `/mode ... +x` form executes directly (above).
  it("/mode (bare) → mode-view for the current channel (null)", () => {
    expect(parseSlash("/mode")).toEqual({ kind: "mode-view", channel: null });
  });

  it("/mode #chan (channel, no modes) → mode-view for that channel", () => {
    expect(parseSlash("/mode #sniffo")).toEqual({ kind: "mode-view", channel: "#sniffo" });
  });

  it("/mode +s (bare modes, no channel) → apply to current channel", () => {
    expect(parseSlash("/mode +s")).toEqual({
      kind: "mode-apply-current",
      modes: "+s",
      params: [],
    });
  });

  it("/mode -l+k secret (bare modes with params) → apply to current channel", () => {
    expect(parseSlash("/mode -l+k secret")).toEqual({
      kind: "mode-apply-current",
      modes: "-l+k",
      params: ["secret"],
    });
  });

  // #536 — a list-mode QUERY form of /mode (the `b` letter, optionally
  // signed, with NO mask param) is the no-args shape: it must open the
  // banlist modal (the /banlist path), NOT execute a raw MODE whose
  // 367/368 reply is silently dropped for lack of banlist_pending. The
  // parser stays pure and emits `banlist` carrying the resolved channel
  // (explicit for `/mode #chan +b`; null = current for `/mode +b`).
  // Scope: `b` only (#536 constraints — +e/+I stay silent).
  it("/mode #chan +b (list-mode query, no mask) → banlist for that channel", () => {
    expect(parseSlash("/mode #sniffo +b")).toEqual({ kind: "banlist", channel: "#sniffo" });
  });

  it("/mode #chan b (unsigned list-mode query) → banlist for that channel", () => {
    expect(parseSlash("/mode #sniffo b")).toEqual({ kind: "banlist", channel: "#sniffo" });
  });

  it("/mode #chan -b (signed list-mode query) → banlist for that channel", () => {
    expect(parseSlash("/mode #sniffo -b")).toEqual({ kind: "banlist", channel: "#sniffo" });
  });

  it("/mode +b (bare list-mode query, no channel) → banlist for the current channel (null)", () => {
    expect(parseSlash("/mode +b")).toEqual({ kind: "banlist", channel: null });
  });

  it("/mode -b (bare signed list-mode query) → banlist for the current channel (null)", () => {
    expect(parseSlash("/mode -b")).toEqual({ kind: "banlist", channel: null });
  });

  // A mask parameter turns the list-mode letter into a MUTATION, not a
  // query — it must keep executing raw, unchanged (#536 constraint).
  it("/mode #chan +b <mask> (mask present) → mode (mutation, unchanged)", () => {
    expect(parseSlash("/mode #sniffo +b nick!*@*")).toEqual({
      kind: "mode",
      target: "#sniffo",
      modes: "+b",
      params: ["nick!*@*"],
    });
  });

  it("/mode +b <mask> (bare, mask present) → mode-apply-current (mutation, unchanged)", () => {
    expect(parseSlash("/mode +b nick!*@*")).toEqual({
      kind: "mode-apply-current",
      modes: "+b",
      params: ["nick!*@*"],
    });
  });

  // #536 challenge-the-spec: bare UNSIGNED /mode b (no channel, no sign)
  // is nick-ambiguous — it stays umode-target-view (nick "b"), NOT
  // banlist. Only signed/channel forms map; scope is locked to the
  // reported /mode #chan +b shape. Guard against accidental widening.
  it("/mode b (bare unsigned, no channel) → umode-target-view (unchanged, out of scope)", () => {
    expect(parseSlash("/mode b")).toEqual({ kind: "umode-target-view", target: "b" });
  });

  // #536 regex-boundary guards — the discriminator is a single `b`, exact.
  // A future careless widening of isBanlistQuery must NOT swallow these:
  // `+bb` (repeated), `+be` (combined list letters — +e is out of scope),
  // and uppercase `+B` (a DISTINCT, case-sensitive mode letter on bahamut)
  // all stay raw MODE executes, not banlist queries.
  it("/mode #chan +bb (repeated letter) → mode (not a banlist query)", () => {
    expect(parseSlash("/mode #sniffo +bb")).toEqual({
      kind: "mode",
      target: "#sniffo",
      modes: "+bb",
      params: [],
    });
  });

  it("/mode #chan +be (combined list letters) → mode (not a banlist query)", () => {
    expect(parseSlash("/mode #sniffo +be")).toEqual({
      kind: "mode",
      target: "#sniffo",
      modes: "+be",
      params: [],
    });
  });

  it("/mode #chan +B (uppercase, distinct mode letter) → mode (not a banlist query)", () => {
    expect(parseSlash("/mode #sniffo +B")).toEqual({
      kind: "mode",
      target: "#sniffo",
      modes: "+B",
      params: [],
    });
  });
});

describe("parseSlash — info verbs (TODO — server-side missing)", () => {
  it("/who bare → who with no target", () => {
    expect(parseSlash("/who")).toEqual({ kind: "who", target: null });
  });

  it("/who <target>", () => {
    expect(parseSlash("/who alice")).toEqual({ kind: "who", target: "alice" });
  });

  // #540 — /who must forward its FULL argument list, not just the first
  // token. bahamut's extended WHO takes flag args (`+s <server>`, `+A
  // <away-msg>`, `+c <channel>`, `+H <maxhits>`); `/who +s server.azzurra.chat`
  // must reach the wire as `WHO +s server.azzurra.chat`. Pre-#540 the parser
  // kept only `+s`, so the server arg was eaten → 522 ERR_WHOSYNTAX.
  it("/who +s <server> → forwards the full arg string (#540)", () => {
    expect(parseSlash("/who +s server.azzurra.chat")).toEqual({
      kind: "who",
      target: "+s server.azzurra.chat",
    });
  });

  // #540 — a channel target with a trailing flag also forwards intact.
  it("/who #chan +c → forwards flags after the channel (#540)", () => {
    expect(parseSlash("/who #grappa +c")).toEqual({
      kind: "who",
      target: "#grappa +c",
    });
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

  // #374 — /motd carries an optional target server (RFC 2812 §3.4.1
  // `MOTD [<target>]`). Bare /motd = current server's MOTD (target null);
  // /motd <server> routes the MOTD query through that server. Pre-#374 the
  // argument was silently dropped, so the user got the wrong server's MOTD
  // with no error. MOTD takes a single target token (unlike /who, which
  // after #540 forwards its full multi-token arg string).
  it("/motd bare → motd with no target", () => {
    expect(parseSlash("/motd")).toEqual({ kind: "motd", target: null });
  });

  it("/motd <server> → motd carrying the target server", () => {
    expect(parseSlash("/motd void.azzurra.chat")).toEqual({
      kind: "motd",
      target: "void.azzurra.chat",
    });
  });

  // Trailing tokens past the first are ignored (MOTD takes a single target).
  it("/motd <server> <extra> → only the first token is the target", () => {
    expect(parseSlash("/motd void.azzurra.chat junk")).toEqual({
      kind: "motd",
      target: "void.azzurra.chat",
    });
  });
});

// #356 — keyword highlight is classic-IRC irssi-shaped now: /hilight
// canonical, /highlight alias, /dehilight remove. irssi-direct (the whole
// rest is one pattern, no add/del/list subverb). A BARE form opens the
// unified watch-lists settings section instead of erroring.
describe("parseSlash — keyword highlight (/hilight, /highlight alias, /dehilight) — #356", () => {
  it("/hilight <pattern> → watchlist add", () => {
    expect(parseSlash("/hilight myname")).toEqual({
      kind: "watchlist",
      action: "add",
      pattern: "myname",
    });
  });

  it("/highlight <pattern> → same as /hilight (alias)", () => {
    expect(parseSlash("/highlight myname")).toEqual({
      kind: "watchlist",
      action: "add",
      pattern: "myname",
    });
  });

  it("/hilight keeps a multi-word pattern intact (whole rest is one pattern)", () => {
    expect(parseSlash("/hilight foo bar")).toEqual({
      kind: "watchlist",
      action: "add",
      pattern: "foo bar",
    });
  });

  it("/dehilight <pattern> → watchlist del", () => {
    expect(parseSlash("/dehilight myname")).toEqual({
      kind: "watchlist",
      action: "del",
      pattern: "myname",
    });
  });

  it("bare /hilight → open-settings (watchlists)", () => {
    expect(parseSlash("/hilight")).toEqual({ kind: "open-settings", section: "watchlists" });
  });

  it("bare /highlight → open-settings (watchlists)", () => {
    expect(parseSlash("/highlight")).toEqual({ kind: "open-settings", section: "watchlists" });
  });

  it("bare /dehilight → open-settings (watchlists)", () => {
    expect(parseSlash("/dehilight")).toEqual({ kind: "open-settings", section: "watchlists" });
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

describe("parseSlash — /stats (#155)", () => {
  it("parses bare /stats (no query, no target)", () => {
    expect(parseSlash("/stats")).toEqual({ kind: "stats", query: null, target: null });
  });

  it("/stats <query> → query, null target", () => {
    expect(parseSlash("/stats m")).toEqual({ kind: "stats", query: "m", target: null });
  });

  it("/stats <query> <server> → query + target", () => {
    expect(parseSlash("/stats m irc.example.net")).toEqual({
      kind: "stats",
      query: "m",
      target: "irc.example.net",
    });
  });

  it("ignores any tokens past the server target (STATS is 2-arg upstream)", () => {
    expect(parseSlash("/stats u irc.example.net junk")).toEqual({
      kind: "stats",
      query: "u",
      target: "irc.example.net",
    });
  });
});

describe("parseSlash — /rehash (#155, #375)", () => {
  it("parses bare /rehash → null opt (full ircd.conf reload)", () => {
    expect(parseSlash("/rehash")).toEqual({ kind: "rehash", opt: null });
  });

  // #375 — the option (MOTD / DNS / GC / TKLINE / …) must survive parsing.
  // Pre-fix it was silently dropped (bare REHASH → full reload); mirrors
  // /stats + #374's /motd first-token-only grammar.
  it("/rehash MOTD → opt: 'MOTD' (scoped reload)", () => {
    expect(parseSlash("/rehash MOTD")).toEqual({ kind: "rehash", opt: "MOTD" });
  });

  it("keeps only the first token (REHASH takes one option upstream)", () => {
    expect(parseSlash("/rehash DNS extra junk")).toEqual({ kind: "rehash", opt: "DNS" });
  });
});

describe("parseSlash — services shortcuts (#20)", () => {
  it.each([
    ["cs", "ChanServ"],
    ["ns", "NickServ"],
    ["ms", "MemoServ"],
    ["os", "OperServ"],
    ["hs", "HelpServ"],
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

  // #290 — a BARE services command opens the dedicated services console
  // modal (titled by the service) instead of erroring. compose.ts fires
  // `help` on open so the service help wall lands in the modal, not the
  // server-window flood; a full command WITH args stays the inline `msg`
  // path above (no unsolicited popup for power users).
  it.each([
    ["cs", "ChanServ"],
    ["ns", "NickServ"],
    ["ms", "MemoServ"],
    ["os", "OperServ"],
    ["hs", "HelpServ"],
    ["rs", "RootServ"],
  ])("/%s bare → service-modal service=%s (#290)", (verb, service) => {
    expect(parseSlash(`/${verb}`)).toEqual({ kind: "service-modal", service });
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

// #247/#356 — /notify presence-watch (server-side per-network list; distinct
// from the keyword highlight family above). #356 made it classic-IRC
// irssi-direct: `/notify <nick> …` adds; /watch is a presence ALIAS (was a
// keyword alias pre-#356); a BARE form opens the watch-lists settings
// section (removal lives there, per-entry ×).
describe("parseSlash — /notify + /watch presence (#356: irssi-direct, bare → settings)", () => {
  it("/notify <nick> → notify add", () => {
    expect(parseSlash("/notify Foo")).toEqual({ kind: "notify", action: "add", nicks: ["Foo"] });
  });

  it("/notify <nick> <nick> … → notify add all of them", () => {
    expect(parseSlash("/notify Foo Bar baz")).toEqual({
      kind: "notify",
      action: "add",
      nicks: ["Foo", "Bar", "baz"],
    });
  });

  it("/watch <nick> → same as /notify (presence alias, #356)", () => {
    expect(parseSlash("/watch gigi")).toEqual({ kind: "notify", action: "add", nicks: ["gigi"] });
  });

  it("bare /notify → open-settings (watchlists) — was `list` pre-#356", () => {
    expect(parseSlash("/notify")).toEqual({ kind: "open-settings", section: "watchlists" });
  });

  it("bare /watch → open-settings (watchlists) — was an error pre-#356", () => {
    expect(parseSlash("/watch")).toEqual({ kind: "open-settings", section: "watchlists" });
  });
});

describe("#385 — expandAlias grammar", () => {
  it("positional $1 substitution (whois-with-idle motivating example)", () => {
    // /wii foo → whois foo foo
    expect(expandAlias("wii", "foo", { wii: "whois $1 $1" })).toEqual({
      verb: "whois",
      rest: "foo foo",
    });
  });

  it("implicit verbatim append when the expansion has no placeholder", () => {
    // alias w whois + /w foo bar → whois foo bar
    expect(expandAlias("w2", "foo bar", { w2: "whois" })).toEqual({
      verb: "whois",
      rest: "foo bar",
    });
  });

  it("no implicit append when a placeholder is present (no triple-arg)", () => {
    // alias wii whois $1 $1 + /wii foo → whois foo foo (NOT foo foo foo)
    expect(expandAlias("wii", "foo", { wii: "whois $1 $1" })).toEqual({
      verb: "whois",
      rest: "foo foo",
    });
  });

  it("$* expands to all remaining args verbatim", () => {
    expect(expandAlias("say", "hello there world", { say: "msg #chan $*" })).toEqual({
      verb: "msg",
      rest: "#chan hello there world",
    });
  });

  it("a missing positional expands to the empty string (silent)", () => {
    // /wii (no args) → whois  (both $1 empty) → trims to just the verb
    expect(expandAlias("wii", "", { wii: "whois $1 $1" })).toEqual({
      verb: "whois",
      rest: "",
    });
  });

  it("matches alias names case-insensitively", () => {
    // typed /WII foo — the motivating example is upper-case
    expect(expandAlias("WII", "foo", { wii: "whois $1 $1" })).toEqual({
      verb: "whois",
      rest: "foo foo",
    });
  });

  it("leaves a non-alias verb untouched", () => {
    expect(expandAlias("whois", "foo", { wii: "whois $1 $1" })).toEqual({
      verb: "whois",
      rest: "foo",
    });
  });

  // #427 — REVERSES #385 decision #3. A user alias whose name collides with a
  // builtin now SHADOWS it: the alias expands (alias wins). The one exception
  // is the two-verb deny list (alias/unalias) covered below.
  it("a same-named alias shadows a builtin (alias wins) — #427", () => {
    expect(expandAlias("whois", "foo", { whois: "quote EVIL" })).toEqual({
      verb: "quote",
      rest: "EVIL foo",
    });
  });

  // #427 — /alias and /unalias are the in-client repair surface and are NOT
  // shadowable. Even if the map holds one (settings UI can store a dead entry),
  // the expander refuses it: the real handler always wins.
  it("/alias and /unalias are never shadowed (repair path intact) — #427", () => {
    expect(expandAlias("alias", "x y", { alias: "quote EVIL" })).toEqual({
      verb: "alias",
      rest: "x y",
    });
    expect(expandAlias("unalias", "x", { unalias: "quote EVIL" })).toEqual({
      verb: "unalias",
      rest: "x",
    });
  });

  it("expands alias → alias chains", () => {
    // /a x → b x → whois x x
    expect(expandAlias("a", "x", { a: "b $1", b: "whois $1 $1" })).toEqual({
      verb: "whois",
      rest: "x x",
    });
  });

  it("errors (naming the chain) when a cycle exceeds MAX_ALIAS_DEPTH", () => {
    const out = expandAlias("loop", "x", { loop: "loop $1" });
    expect(out).toHaveProperty("error");
    if ("error" in out) {
      expect(out.error).toContain("too deep");
      expect(out.error).toContain("loop");
    }
  });

  it("allows a chain up to MAX_ALIAS_DEPTH deep", () => {
    // a1→a2→…→a5→whois — exactly MAX_ALIAS_DEPTH (5) expansions.
    const map: Record<string, string> = { a5: "whois" };
    for (let i = 1; i < MAX_ALIAS_DEPTH; i++) map[`a${i}`] = `a${i + 1}`;
    expect(expandAlias("a1", "", map)).toEqual({ verb: "whois", rest: "" });
  });
});

describe("#385 — parseSlash with user aliases (end-to-end)", () => {
  it("an expanded alias flows through the normal DISPATCH path", () => {
    // /wii foo → whois foo foo → the whois command
    expect(parseSlash("/wii foo", { wii: "whois $1 $1" })).toEqual({
      kind: "whois",
      nick: "foo",
      server: "foo",
    });
  });

  it("no aliases (default arg) → unchanged behaviour", () => {
    expect(parseSlash("/whois alice")).toEqual({ kind: "whois", nick: "alice", server: null });
  });

  it("a cyclic alias surfaces an inline error", () => {
    const out = parseSlash("/loop x", { loop: "loop $1" });
    expect(out).toMatchObject({ kind: "error", verb: "loop" });
  });

  it("tolerates a leading slash in the expansion (equivalent forms)", () => {
    expect(parseSlash("/wii foo", { wii: "/whois $1 $1" })).toEqual({
      kind: "whois",
      nick: "foo",
      server: "foo",
    });
  });

  // #427 — a user alias shadowing a builtin flows through the shadow, not the
  // builtin. /join is aliased to /whois; typing /join <nick> runs whois.
  it("a builtin is shadowed end-to-end when a same-named alias exists — #427", () => {
    expect(parseSlash("/join alice", { join: "whois" })).toEqual({
      kind: "whois",
      nick: "alice",
      server: null,
    });
  });

  // #427 — the deny list holds end-to-end: even with an alias entry, /alias and
  // /unalias resolve to their real handlers (repair path intact).
  it("/alias and /unalias resolve to their real handlers despite an alias entry — #427", () => {
    expect(parseSlash("/alias", { alias: "whois" })).toEqual({
      kind: "open-settings",
      section: "aliases",
    });
    expect(parseSlash("/unalias wii", { unalias: "whois" })).toEqual({
      kind: "unalias",
      name: "wii",
    });
  });
});

describe("#385 — /alias + /unalias", () => {
  it("bare /alias deep-links into the aliases settings sub-page", () => {
    expect(parseSlash("/alias")).toEqual({ kind: "open-settings", section: "aliases" });
  });

  it("/alias <name> <expansion> defines (name lowercased, leading slash stripped)", () => {
    expect(parseSlash("/alias WII whois $1 $1")).toEqual({
      kind: "alias-define",
      name: "wii",
      expansion: "whois $1 $1",
    });
    // Leading slash stripped from the expansion (ww is not a builtin).
    expect(parseSlash("/alias ww /whois")).toEqual({
      kind: "alias-define",
      name: "ww",
      expansion: "whois",
    });
  });

  // #427 — a name colliding with a builtin is now ALLOWED (shadowing). /whois,
  // /q, /w, /join etc. define normally.
  it("allows an alias name that collides with a builtin (shadowing) — #427", () => {
    expect(parseSlash("/alias whois quote EVIL")).toEqual({
      kind: "alias-define",
      name: "whois",
      expansion: "quote EVIL",
    });
    expect(parseSlash("/alias w foo")).toMatchObject({ kind: "alias-define", name: "w" });
    expect(parseSlash("/alias join foo")).toMatchObject({ kind: "alias-define", name: "join" });
  });

  // #427 — the only two verbs that CANNOT be shadowed: /alias and /unalias
  // (the command-side repair surface). Rejected inline at define time.
  it("rejects aliasing /alias or /unalias (deny list) — #427", () => {
    expect(parseSlash("/alias alias something")).toMatchObject({ kind: "error", verb: "alias" });
    expect(parseSlash("/alias unalias something")).toMatchObject({ kind: "error", verb: "alias" });
    // Case-insensitive: the name is lowercased before the check.
    expect(parseSlash("/alias ALIAS something")).toMatchObject({ kind: "error", verb: "alias" });
  });

  it("rejects a missing expansion", () => {
    expect(parseSlash("/alias wii")).toMatchObject({ kind: "error", verb: "alias" });
  });

  it("/unalias <name> removes (name lowercased)", () => {
    expect(parseSlash("/unalias WII")).toEqual({ kind: "unalias", name: "wii" });
  });

  it("bare /unalias errors with usage", () => {
    expect(parseSlash("/unalias")).toMatchObject({ kind: "error", verb: "unalias" });
  });

  // #427 — the non-shadowable predicate is a FIXED two-name set, NOT the live
  // DISPATCH key set (reusing DISPATCH membership would reproduce the old
  // reject-everything behaviour). Only /alias and /unalias are protected.
  it("isNonShadowableVerb protects only /alias and /unalias (case-insensitive) — #427", () => {
    expect(isNonShadowableVerb("alias")).toBe(true);
    expect(isNonShadowableVerb("unalias")).toBe(true);
    expect(isNonShadowableVerb("ALIAS")).toBe(true); // case-insensitive
    // Every other builtin is now shadowable → not protected.
    expect(isNonShadowableVerb("whois")).toBe(false);
    expect(isNonShadowableVerb("join")).toBe(false);
    expect(isNonShadowableVerb("w")).toBe(false);
    expect(isNonShadowableVerb("wii")).toBe(false);
  });
});

describe("#385 — expandAlias grammar edge cases", () => {
  it("$10 → arg1 then a literal 0 (only $1..$9 are placeholders)", () => {
    expect(expandAlias("a", "x", { a: "cmd $10" })).toEqual({ verb: "cmd", rest: "x0" });
  });

  it("adjacent placeholders $1$2 concatenate", () => {
    expect(expandAlias("a", "foo bar", { a: "cmd $1$2" })).toEqual({
      verb: "cmd",
      rest: "foobar",
    });
  });

  it("a $ not followed by a digit/star is literal → no-placeholder append", () => {
    // `$x` is not a placeholder, so the template has NONE → rest is appended.
    expect(expandAlias("e", "foo", { e: "echo $x" })).toEqual({ verb: "echo", rest: "$x foo" });
  });

  it("$* with empty rest collapses to nothing", () => {
    expect(expandAlias("s", "", { s: "msg #c $*" })).toEqual({ verb: "msg", rest: "#c" });
  });
});
