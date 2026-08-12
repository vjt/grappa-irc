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
      channels: ["#grappa"],
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
      channels: ["#priv"],
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
      channels: ["#sniffo"],
      key: null,
    });
  });

  it("/j sniffo → alias of /join + auto-prepend", () => {
    expect(parseSlash("/j sniffo")).toEqual({
      kind: "join",
      channels: ["#sniffo"],
      key: null,
    });
  });

  it("/j #sniffo → alias, no double prepend", () => {
    expect(parseSlash("/j #sniffo")).toEqual({
      kind: "join",
      channels: ["#sniffo"],
      key: null,
    });
  });

  it("/j sniffo secret → alias + key", () => {
    expect(parseSlash("/j sniffo secret")).toEqual({
      kind: "join",
      channels: ["#sniffo"],
      key: "secret",
    });
  });

  it("/join &local → does not double-prepend on & prefix", () => {
    expect(parseSlash("/join &local")).toEqual({
      kind: "join",
      channels: ["&local"],
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

  it("/j #foo,#bar → parser splits the comma-list into channels[]", () => {
    expect(parseSlash("/j #foo,#bar")).toEqual({
      kind: "join",
      channels: ["#foo", "#bar"],
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

  // #1208 — the reported defect. Without a sigil test the first word of a
  // bare reason was taken as the target, so the user got "The request was
  // malformed." about a channel called "non" that they never typed. Every
  // IRC client resolves this ambiguity by sigil: no sigil ⇒ it is the reason.
  it("/part with a sigil-less first token is all reason, not a target (#1208)", () => {
    expect(parseSlash("/part non trovo utili le bestemmie")).toEqual({
      kind: "part",
      channel: null,
      reason: "non trovo utili le bestemmie",
    });
  });

  it("/part with a single sigil-less word is a reason, not a channel (#1208)", () => {
    expect(parseSlash("/part ciao")).toEqual({
      kind: "part",
      channel: null,
      reason: "ciao",
    });
  });

  // Unlike /join, /part must NOT auto-prepend `#` to a bare name: doing so
  // is what created the phantom target. The three non-`#` RFC sigils still
  // name a channel, so they keep the target arm.
  it.each(["&local", "+modeless", "!safe"])(
    "/part %s is a target, not a reason (#1208)",
    (chan) => {
      expect(parseSlash(`/part ${chan} ciao`)).toEqual({
        kind: "part",
        channel: chan,
        reason: "ciao",
      });
    },
  );
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

// #1225 — /notice <target> <text>. Same grammar as /msg, one deliberate
// divergence: the target may be a CHANNEL. `/notice #chan text` is legal IRC
// and is the form an operator actually reaches for, whereas /msg refuses a
// channel because a PRIVMSG addressed by name opened a phantom query window.
// A notice opens no window at all, so the reason for /msg's refusal does not
// exist here.
describe("parseSlash — /notice (#1225)", () => {
  it("/notice <nick> <body>", () => {
    expect(parseSlash("/notice alice heads up")).toEqual({
      kind: "notice",
      target: "alice",
      body: "heads up",
    });
  });

  it.each(["#foo", "&local", "!12345chan", "+modeless"])(
    "/notice to a channel (%s) is ACCEPTED, unlike /msg",
    (chan) => {
      expect(parseSlash(`/notice ${chan} rehash in 5`)).toEqual({
        kind: "notice",
        target: chan,
        body: "rehash in 5",
      });
    },
  );

  it("/notice preserves interior spacing of the body", () => {
    expect(parseSlash("/notice bob ciao  a   tutti")).toEqual({
      kind: "notice",
      target: "bob",
      body: "ciao  a   tutti",
    });
  });

  // Pin the MESSAGE, not just the error shape: an unregistered verb also
  // yields {kind:"error", verb:"notice"} ("unknown command: /notice"), so a
  // shape-only assertion passes with the feature absent.
  it("/notice missing target → usage error, not unknown-command", () => {
    const r = parseSlash("/notice");
    expect(r).toMatchObject({ kind: "error", verb: "notice" });
    const { message } = r as { message: string };
    expect(message).not.toMatch(/unknown command/i);
    expect(message).toMatch(/\/notice requires/i);
  });

  it("/notice missing body → usage error, not unknown-command", () => {
    const r = parseSlash("/notice alice");
    expect(r).toMatchObject({ kind: "error", verb: "notice" });
    const { message } = r as { message: string };
    expect(message).not.toMatch(/unknown command/i);
    expect(message).toMatch(/text|body|message/i);
  });

  // Alias parity (issue point 3): `/n` is ALREADY /names (#122). A notice
  // alias would silently steal a verb that has shipped for a year, so /notice
  // ships without a short form. Pin it — the collision is invisible until
  // someone's /n stops listing members.
  it("/n stays /names — no alias collision with /notice", () => {
    expect(parseSlash("/n #grappa")).toEqual({ kind: "names", target: "#grappa" });
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

  // #12/#343 — /msg is for nicks (queries). grappa does not relay a PRIVMSG to
  // a channel addressed by name, so a channel-shaped target opened a phantom
  // query window keyed by a channel name whose own-send never rendered.
  // Reject every IRC channel sigil (# & ! +) up front, not just '#'. #343: the
  // refusal STAYS but the message must be EXPLICIT — say THAT it is refused,
  // WHY (/msg addresses nicks), and WHAT to type instead (open/join the
  // channel window). Pin that actionable guidance so it can never regress to
  // the bare "not supported" string.
  it.each(["#foo", "&local", "!12345chan", "+modeless"])(
    "/msg to a channel (%s) is rejected with explicit guidance (#12/#343)",
    (chan) => {
      const r = parseSlash(`/msg ${chan} hello`);
      expect(r).toMatchObject({ kind: "error", verb: "msg" });
      const { message } = r as { message: string };
      expect(message).toMatch(/channel/i);
      // Actionable guidance — the whole point of #343.
      expect(message).toMatch(/open|join|window|type/i);
      // Names the offending target so the user knows what was refused.
      expect(message).toContain(chan);
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

  // #557 — /kill <nick> [reason]: first-class operator KILL. Same grammar as
  // /kick (first token = nick, remainder = reason), but the target is a NICK
  // with NO channel — compose.ts composes `KILL <nick> :<reason>` and the
  // trailing colon is added downstream, never typed by the user. Non-oper
  // feedback is the server's 481; cic does NOT client-gate.
  it("/kill <nick> bare (no reason)", () => {
    expect(parseSlash("/kill spammer")).toEqual({ kind: "kill", nick: "spammer", reason: "" });
  });

  it("/kill <nick> <reason with spaces> (full reason, colon composed downstream)", () => {
    expect(parseSlash("/kill spammer flooding the channel")).toEqual({
      kind: "kill",
      nick: "spammer",
      reason: "flooding the channel",
    });
  });

  it("/kill missing nick → error", () => {
    expect(parseSlash("/kill")).toMatchObject({
      kind: "error",
      verb: "kill",
      message: "/kill requires a nick",
    });
  });

  it("/banlist bare → banlist for the current channel (null), mode b", () => {
    expect(parseSlash("/banlist")).toEqual({ kind: "banlist", channel: null, mode: "b" });
  });

  // #1251 — `/banlist [#chan] [mode]`: both optional, classified by SHAPE so
  // either order works. The mode test wins over the channel test because a
  // `+`-sigil channel named `+e` is extinct while `/banlist +e` is obvious.
  it("/banlist <mode> → that list on the current channel", () => {
    expect(parseSlash("/banlist e")).toEqual({ kind: "banlist", channel: null, mode: "e" });
    expect(parseSlash("/banlist +e")).toEqual({ kind: "banlist", channel: null, mode: "e" });
    expect(parseSlash("/banlist I")).toEqual({ kind: "banlist", channel: null, mode: "I" });
  });

  it("/banlist #chan <mode> → that list on that channel, either token order", () => {
    expect(parseSlash("/banlist #sniffo z")).toEqual({
      kind: "banlist",
      channel: "#sniffo",
      mode: "z",
    });

    expect(parseSlash("/banlist q #sniffo")).toEqual({
      kind: "banlist",
      channel: "#sniffo",
      mode: "q",
    });
  });

  // The letter's CASE is the mode's identity: `I` (invex) and `i`
  // (invite-only) are different modes.
  it("/banlist keeps the mode letter's case", () => {
    expect(parseSlash("/banlist I")).toEqual({ kind: "banlist", channel: null, mode: "I" });
    expect(parseSlash("/banlist i")).toEqual({ kind: "banlist", channel: null, mode: "i" });
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

  // #536/#1251 — the list-mode QUERY form of /mode (a single letter,
  // optionally signed, NO mask) must open the list modal instead of putting
  // a raw MODE on the wire whose reply rows nothing collects. Since #1251
  // that decision needs the network's 005 (which letters are type A), so the
  // PARSER keeps the literal shape and compose.ts intercepts — see
  // "list-mode query interception" in compose.test.ts for the behaviour.
  // These cases pin that the parser hands compose everything it needs: the
  // channel (or its absence), the SIGN, and the empty param list.
  it("/mode #chan +b (list-mode query, no mask) → mode, verbatim, for compose to intercept", () => {
    expect(parseSlash("/mode #sniffo +b")).toEqual({
      kind: "mode",
      target: "#sniffo",
      modes: "+b",
      params: [],
    });
  });

  it("/mode #chan b (unsigned list-mode query) → mode, sign absent, params empty", () => {
    expect(parseSlash("/mode #sniffo b")).toEqual({
      kind: "mode",
      target: "#sniffo",
      modes: "b",
      params: [],
    });
  });

  // The sign is CARRIED, not normalised: `-m` with no param is a real mode
  // change on a flag mode, so a parser that dropped the sign would turn a
  // removal into an addition on every non-list letter.
  it("/mode #chan -b (signed list-mode query) → mode, sign preserved", () => {
    expect(parseSlash("/mode #sniffo -b")).toEqual({
      kind: "mode",
      target: "#sniffo",
      modes: "-b",
      params: [],
    });
  });

  it("/mode +b (bare list-mode query, no channel) → mode-apply-current", () => {
    expect(parseSlash("/mode +b")).toEqual({
      kind: "mode-apply-current",
      modes: "+b",
      params: [],
    });
  });

  it("/mode -b (bare signed list-mode query) → mode-apply-current, sign preserved", () => {
    expect(parseSlash("/mode -b")).toEqual({
      kind: "mode-apply-current",
      modes: "-b",
      params: [],
    });
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

  // #536/#1251 boundary guards — the query discriminator is ONE letter,
  // exact. `+bb` (repeated), `+be` (two list letters at once) and uppercase
  // `+B` (a DISTINCT, case-sensitive mode on bahamut) are mode changes, and
  // compose's interception regex must never swallow them either.
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

  // #992 — /admin [<target>] (RFC 2812 §3.4.4), the fourth member of the
  // #127/#374 server-text family. Same optional-single-token grammar as
  // /motd: bahamut routes both through the same `hunt_server`
  // (src/s_serv.c m_admin:2683), so bare = the current server's A:line and
  // a target routes the query through that server.
  it("/admin bare → admin with no target", () => {
    expect(parseSlash("/admin")).toEqual({ kind: "admin", target: null });
  });

  it("/admin <server> → admin carrying the target server", () => {
    expect(parseSlash("/admin void.azzurra.chat")).toEqual({
      kind: "admin",
      target: "void.azzurra.chat",
    });
  });

  it("/admin <server> <extra> → only the first token is the target", () => {
    expect(parseSlash("/admin void.azzurra.chat junk")).toEqual({
      kind: "admin",
      target: "void.azzurra.chat",
    });
  });
});

// #581 — /recover [network]: guided "recover my identity". Optional first
// token is the network slug (bare → current window's network, resolved in
// compose.ts). Same optional-arg grammar as /links.
describe("parseSlash — /recover (#581)", () => {
  it("/recover bare → recover with no network", () => {
    expect(parseSlash("/recover")).toEqual({ kind: "recover", network: null });
  });

  it("/recover <network> → recover carrying the network slug", () => {
    expect(parseSlash("/recover azzurra")).toEqual({ kind: "recover", network: "azzurra" });
  });

  // Trailing tokens past the first are ignored (recover takes one network arg).
  it("/recover <network> <extra> → only the first token is the network", () => {
    expect(parseSlash("/recover azzurra junk")).toEqual({ kind: "recover", network: "azzurra" });
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

describe("parseSlash — /lusers (P-0d, args #579)", () => {
  it("parses bare /lusers (no mask, no server)", () => {
    expect(parseSlash("/lusers")).toEqual({ kind: "lusers", mask: null, server: null });
  });

  it("/lusers <mask> → mask, null server", () => {
    expect(parseSlash("/lusers *.azzurra.org")).toEqual({
      kind: "lusers",
      mask: "*.azzurra.org",
      server: null,
    });
  });

  it("/lusers <mask> <server> → both, in RFC 2812 §3.4.2 order", () => {
    expect(parseSlash("/lusers *.azzurra.org void.azzurra.chat")).toEqual({
      kind: "lusers",
      mask: "*.azzurra.org",
      server: "void.azzurra.chat",
    });
  });

  it("ignores tokens past the second (LUSERS is a 2-slot wire frame)", () => {
    expect(parseSlash("/lusers *.azzurra.org void.azzurra.chat junk")).toEqual({
      kind: "lusers",
      mask: "*.azzurra.org",
      server: "void.azzurra.chat",
    });
  });

  // #579 — the client mirror of the server's `:invalid_line` for a server
  // with no mask (grappa_channel `validate_lusers_args/2`): the positional
  // parse cannot BUILD that shape, so there is nothing to reject at runtime.
  // This pins that property — it fails the moment the handler reads the first
  // token as the server (i.e. copies /whois's `<server> <nick>` order, which
  // for a one-token form yields exactly the rejected mask-less shape).
  it("never yields a server without a mask, for any argument shape", () => {
    for (const line of [
      "/lusers",
      "/lusers *.azzurra.org",
      "/lusers void.azzurra.chat",
      "/lusers *.azzurra.org void.azzurra.chat",
      "/lusers *.azzurra.org void.azzurra.chat junk",
      "/lusers    *.azzurra.org   void.azzurra.chat  ",
    ]) {
      const cmd = parseSlash(line);
      expect(cmd.kind).toBe("lusers");
      if (cmd.kind !== "lusers") continue;
      if (cmd.server !== null) expect(cmd.mask).not.toBeNull();
    }
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

// #1047 — `$N-` ("argument N and everything after"). The grammar gap that made
// "first arg is a target, the rest is free text" unwritable: with `$*` the
// target came twice, with `$2` the reason was truncated to its first word.
//
// SPACING RULING (the decision #1047 delegates): `$N-` joins the
// WHITESPACE-COLLAPSED token list with single spaces — the same list `$1..$9`
// pull from — NOT the raw tail `$*` substitutes. So `$1-` and `$*` cover the
// same arguments and differ ONLY in spacing normalisation. Chosen for
// consistency with the positional form `$N-` extends; the alternative
// (raw-slice like `$*`) would have made `$1-` a synonym of `$*` and left `$2-`
// with no defensible spelling of "where does arg 2 start in the raw string".
// Both spellings are pinned side by side below so the difference is a
// documented contract, not an accident someone later "fixes".
describe("#1047 — expandAlias `$N-` range placeholder", () => {
  it("$2- takes argument 2 and everything after it (the kick motivating example)", () => {
    expect(expandAlias("k", "spammer go away and stay away", { k: "kick $1 $2-" })).toEqual({
      verb: "kick",
      rest: "spammer go away and stay away",
    });
  });

  it("$2- is not $2: the tail is whole, not truncated to one word", () => {
    // Pre-#1047 this yielded "#chan hello-" ($2 substituted, `-` left literal).
    expect(expandAlias("mm", "#chan hello there world", { mm: "msg $1 $2-" })).toEqual({
      verb: "msg",
      rest: "#chan hello there world",
    });
  });

  it("$1- and $* cover the same args and differ ONLY in spacing normalisation", () => {
    const rest = "one   two \t three";
    expect(expandAlias("a", rest, { a: "cmd $1-" })).toEqual({
      verb: "cmd",
      rest: "one two three",
    });
    expect(expandAlias("a", rest, { a: "cmd $*" })).toEqual({
      verb: "cmd",
      rest: "one   two \t three",
    });
  });

  it("an out-of-range $N- expands to the empty string (silent, matching $N)", () => {
    // Only two args, so `$5-` has nothing to join — no error, no literal left.
    expect(expandAlias("a", "one two", { a: "cmd $1 $5-" })).toEqual({
      verb: "cmd",
      rest: "one",
    });
  });

  it("$N- with no args at all is silently empty", () => {
    expect(expandAlias("a", "", { a: "cmd $1-" })).toEqual({ verb: "cmd", rest: "" });
  });

  it("$9- reaches the ninth argument and its tail", () => {
    const rest = "a1 a2 a3 a4 a5 a6 a7 a8 a9 a10 a11";
    expect(expandAlias("a", rest, { a: "cmd $9-" })).toEqual({
      verb: "cmd",
      rest: "a9 a10 a11",
    });
  });

  it("a template whose ONLY placeholder is $N- suppresses the verbatim append", () => {
    // The no-placeholder rule appends the rest; `$3-` must count as a
    // placeholder or `/a x y z` would expand to `cmd z x y z`.
    expect(expandAlias("a", "x y z", { a: "cmd $3-" })).toEqual({ verb: "cmd", rest: "z" });
  });

  it("$N- is greedy over a following literal dash", () => {
    // mIRC/irssi shape: the `-` binds to the placeholder, never to the text
    // after it. `$1-tail` is "all args" then "tail", not "$1" then "-tail".
    expect(expandAlias("a", "x y", { a: "cmd $1-tail" })).toEqual({
      verb: "cmd",
      rest: "x ytail",
    });
  });

  it("$10 is still $1 then a literal 0 (the range dash didn't widen the digits)", () => {
    expect(expandAlias("a", "x", { a: "cmd $10" })).toEqual({ verb: "cmd", rest: "x0" });
    expect(expandAlias("a", "x y", { a: "cmd $1-0" })).toEqual({ verb: "cmd", rest: "x y0" });
  });

  it("end-to-end: an alias with $N- reaches DISPATCH with the whole reason", () => {
    expect(parseSlash("/k spammer go away and stay away", { k: "kick $1 $2-" })).toEqual({
      kind: "kick",
      nick: "spammer",
      reason: "go away and stay away",
    });
  });
});

// #591 — /ctcp <target> <VERB> [args]. Pure-parser shape: first token is the
// target, second is the CTCP verb (uppercased per convention), the trimmed
// remainder is the (optional) args. compose.ts builds the \x01VERB args\x01
// frame — the parser stays framing-free (no \x01, no SolidJS).
describe("parseSlash — /ctcp (#591)", () => {
  it("/ctcp <target> <verb> uppercases the verb, empty args", () => {
    expect(parseSlash("/ctcp bob version")).toEqual({
      kind: "ctcp",
      target: "bob",
      verb: "VERSION",
      args: "",
    });
  });

  it("/ctcp <target> <verb> <args> uppercases verb, preserves arg case + spaces", () => {
    expect(parseSlash("/ctcp #chan action waves at Everyone")).toEqual({
      kind: "ctcp",
      target: "#chan",
      verb: "ACTION",
      args: "waves at Everyone",
    });
  });

  it("/ctcp bare → error (target + verb required)", () => {
    expect(parseSlash("/ctcp")).toEqual({
      kind: "error",
      verb: "ctcp",
      message: "/ctcp requires a target and a verb",
    });
  });

  it("/ctcp <target> with no verb → error", () => {
    expect(parseSlash("/ctcp bob")).toEqual({
      kind: "error",
      verb: "ctcp",
      message: "/ctcp requires a target and a verb",
    });
  });
});

// #591 — /ping <target>: sugar for CTCP PING with a client timestamp. The
// parser only carries the target; compose.ts stamps the outbound token and
// owns the reply-correlation state (RTT is synthesized locally in the source
// window, not routed as a NOTICE).
describe("parseSlash — /ping (#591)", () => {
  it("/ping <target> parses to {kind:'ping', target}", () => {
    expect(parseSlash("/ping bob")).toEqual({ kind: "ping", target: "bob" });
  });

  it("/ping bare → error (target required)", () => {
    expect(parseSlash("/ping")).toEqual({
      kind: "error",
      verb: "ping",
      message: "/ping requires a target",
    });
  });

  it("/ping <target> <extra> ignores trailing tokens", () => {
    expect(parseSlash("/ping bob junk here")).toEqual({ kind: "ping", target: "bob" });
  });
});

// #431 — /ame and /amsg: the mIRC "say it in every channel" pair. The parser's
// whole job is the body; WHICH channels, the confirm gate and the pacing all
// live in compose.ts (this module stays pure — no store reads).
describe("parseSlash — /ame + /amsg fan-out (#431)", () => {
  it("/ame <text> parses to {kind:'ame', body}", () => {
    expect(parseSlash("/ame waves at everyone")).toEqual({
      kind: "ame",
      body: "waves at everyone",
    });
  });

  it("/amsg <text> parses to {kind:'amsg', body}", () => {
    expect(parseSlash("/amsg back in ten")).toEqual({ kind: "amsg", body: "back in ten" });
  });

  // Unlike /me (whose empty body is a legal, if pointless, one-window ACTION),
  // an empty fan-out is N empty frames the send door refuses one at a time.
  it("bare /ame → error (a body is required)", () => {
    expect(parseSlash("/ame")).toEqual({
      kind: "error",
      verb: "ame",
      message: "/ame requires a message",
    });
  });

  it("bare /amsg → error (a body is required)", () => {
    expect(parseSlash("/amsg")).toEqual({
      kind: "error",
      verb: "amsg",
      message: "/amsg requires a message",
    });
  });

  // #431 constraint 4 as MEASURED, not as the issue text spells it: the issue
  // says builtins are "never shadowed by a user alias (#427)", but #427 ruled
  // the opposite — an alias shadows ANY builtin except the fixed two-name
  // repair surface (/alias, /unalias). /ame is a builtin, so it inherits the
  // rule that actually exists. Adding "ame" to NON_SHADOWABLE_VERBS kills this.
  it("a user alias shadows /ame like any other builtin — #427", () => {
    expect(parseSlash("/ame hello", { ame: "me" })).toEqual({ kind: "me", body: "hello" });
  });
});
