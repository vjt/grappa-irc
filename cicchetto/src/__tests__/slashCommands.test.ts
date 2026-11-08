import { describe, expect, it } from "vitest";
import { keysOf, noKeys } from "../lib/byKey";
import { DEFAULT_CHANTYPES } from "../lib/chantypes";
import {
  BUILTIN_VERBS,
  expandAlias,
  isNonShadowableVerb,
  MAX_ALIAS_DEPTH,
  parseSlash,
  type SlashCommand,
  splitSlash,
} from "../lib/slashCommands";

// No aliases, the RFC sigils: what most cases here parse against. parseSlash
// takes both explicitly; this names the common pair once.
const parsePlain = (input: string): SlashCommand => parseSlash(input, noKeys(), DEFAULT_CHANTYPES);

describe("parseSlash — basics", () => {
  it("non-slash body parses as privmsg", () => {
    expect(parsePlain("hello world")).toEqual({ kind: "privmsg", body: "hello world" });
  });

  it("empty body is :empty", () => {
    expect(parsePlain("")).toEqual({ kind: "empty" });
    expect(parsePlain("  ")).toEqual({ kind: "empty" });
  });

  it("body starting with // is a literal privmsg starting with /", () => {
    expect(parsePlain("//me literal")).toEqual({ kind: "privmsg", body: "/me literal" });
  });

  it("unknown verb surfaces as error with the original verb", () => {
    const result = parsePlain("/notarealverbatall foo");
    expect(result).toMatchObject({ kind: "error", verb: "notarealverbatall" });
  });

  // issue 2453 — a verb is the user's to type, and `constructor` and
  // `__proto__` are valid ones; "bob" runs first as the control.
  it.each(["bob", "constructor", "__proto__", "Constructor"])(
    "/%s, neither a command nor an alias, is an unknown command",
    (verb) => {
      expect(parsePlain(`/${verb} x`)).toEqual({
        kind: "error",
        verb,
        message: `unknown command: /${verb}`,
      });
    },
  );
});

describe("parseSlash — /whois (C2)", () => {
  it("/whois <nick> parses to {kind: 'whois', nick, server: null}", () => {
    expect(parsePlain("/whois alice")).toEqual({ kind: "whois", nick: "alice", server: null });
  });

  // #198 — two-arg RFC form `/whois <server> <nick>`: first token is the
  // target server the query routes through, second is the nick.
  it("/whois <server> <nick> → {kind: 'whois', nick, server} (#198)", () => {
    expect(parsePlain("/whois irc.azzurra.org bob")).toEqual({
      kind: "whois",
      nick: "bob",
      server: "irc.azzurra.org",
    });
  });

  // #198 — extra tokens past the second are ignored (WHOIS is a 2-slot
  // wire frame: <server> <nick>), so `/w <server> <nick> junk` still
  // routes server+nick.
  it("/whois <server> <nick> <junk> ignores trailing tokens (#198)", () => {
    expect(parsePlain("/whois irc.azzurra.org bob extra")).toEqual({
      kind: "whois",
      nick: "bob",
      server: "irc.azzurra.org",
    });
  });

  // #122 — bare /whois no longer errors in the parser; the consumer
  // resolves the current query window's nick (context-default).
  it("/whois bare → {kind: 'whois', nick: null, server: null} (context-default in compose)", () => {
    expect(parsePlain("/whois")).toEqual({ kind: "whois", nick: null, server: null });
  });

  // #122 — /w is the post-init alias of /whois.
  it("/w <nick> → same as /whois", () => {
    expect(parsePlain("/w alice")).toEqual({ kind: "whois", nick: "alice", server: null });
  });

  // #198 — the /w alias shares the parser, so the two-arg form works too.
  it("/w <server> <nick> → same two-arg form (#198)", () => {
    expect(parsePlain("/w irc.azzurra.org bob")).toEqual({
      kind: "whois",
      nick: "bob",
      server: "irc.azzurra.org",
    });
  });

  it("/w bare → {kind: 'whois', nick: null, server: null}", () => {
    expect(parsePlain("/w")).toEqual({ kind: "whois", nick: null, server: null });
  });
});

describe("parseSlash — /whowas (P-0c)", () => {
  it("/whowas <nick> parses to {kind: 'whowas', nick}", () => {
    expect(parsePlain("/whowas alice")).toEqual({ kind: "whowas", nick: "alice" });
  });

  it("/whowas bare → error (nick required)", () => {
    expect(parsePlain("/whowas")).toMatchObject({ kind: "error", verb: "whowas" });
  });
});

describe("parseSlash — /me", () => {
  it("/me <action>", () => {
    expect(parsePlain("/me waves")).toEqual({ kind: "me", body: "waves" });
  });
});

describe("parseSlash — /join", () => {
  it("/join <channel> (no key)", () => {
    expect(parsePlain("/join #grappa")).toEqual({
      kind: "join",
      channels: ["#grappa"],
      key: null,
    });
  });

  it("/join missing channel → error", () => {
    expect(parsePlain("/join")).toMatchObject({ kind: "error", verb: "join" });
  });

  // UX-4 bucket F: +k channel-key support.
  it("/join <channel> <key> threads key", () => {
    expect(parsePlain("/join #priv secret")).toEqual({
      kind: "join",
      channels: ["#priv"],
      key: "secret",
    });
  });

  it("/join <channel> <key> <extra> → error (too many args)", () => {
    expect(parsePlain("/join #priv secret junk")).toMatchObject({
      kind: "error",
      verb: "join",
    });
  });

  // Bundle B (issue follow-up #30 pre-work): bare-name UX
  it("/join sniffo → auto-prepends # (UX shortcut)", () => {
    expect(parsePlain("/join sniffo")).toEqual({
      kind: "join",
      channels: ["#sniffo"],
      key: null,
    });
  });

  it("/j sniffo → alias of /join + auto-prepend", () => {
    expect(parsePlain("/j sniffo")).toEqual({
      kind: "join",
      channels: ["#sniffo"],
      key: null,
    });
  });

  it("/j #sniffo → alias, no double prepend", () => {
    expect(parsePlain("/j #sniffo")).toEqual({
      kind: "join",
      channels: ["#sniffo"],
      key: null,
    });
  });

  it("/j sniffo secret → alias + key", () => {
    expect(parsePlain("/j sniffo secret")).toEqual({
      kind: "join",
      channels: ["#sniffo"],
      key: "secret",
    });
  });

  it("/join &local → does not double-prepend on & prefix", () => {
    expect(parsePlain("/join &local")).toEqual({
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
    expect(parsePlain("/j foo,bar")).toMatchObject({
      kind: "error",
      verb: "j",
    });
  });

  it("/j #foo,#bar → parser splits the comma-list into channels[]", () => {
    expect(parsePlain("/j #foo,#bar")).toEqual({
      kind: "join",
      channels: ["#foo", "#bar"],
      key: null,
    });
  });

  // issue 2229 — the comma guard above used to be gated on the WHOLE token
  // (`!isChannelName(raw) && raw.includes(",")`), and `isChannelName` reads
  // only the first byte. A sigil on the HEAD therefore vouched for the whole
  // list: `/join #0,0` parsed clean, the POST left with `#0,0`, and the
  // server refused the ENTIRE line (`validate_channel_list/1` validates every
  // element and fails the row — #382, deliberate: no partial JOIN), so the
  // operator got the generic "The request was malformed." with nothing
  // naming the element at fault. The check is per element now.
  it("/join #0,0 → error: a sigil on the head does not vouch for the tail (2229)", () => {
    const r = parsePlain("/join #0,0");
    expect(r).toMatchObject({ kind: "error", verb: "join" });
    const { message } = r as { message: string };
    // Names the offending element and hands back a paste-ready list.
    expect(message).toContain('"0"');
    expect(message).toContain("#0,#0");
  });

  // The all-bare form keeps the SAME message shape — one code path, not a
  // second guard that says the same thing differently.
  it("/j foo,bar → the per-element error names the first bare element (2229)", () => {
    const r = parsePlain("/j foo,bar");
    expect(r).toMatchObject({ kind: "error", verb: "j" });
    const { message } = r as { message: string };
    expect(message).toContain('"bar"');
    expect(message).toContain("#foo,#bar");
  });

  // The suggestion must not re-prefix an element that already carries a
  // sigil — the old whole-token message did (`/j a,#b` proposed `#a,##b`).
  it("/j #a,b,#c → suggestion sigils only the bare element (2229)", () => {
    const r = parsePlain("/j #a,b,#c");
    expect(r).toMatchObject({ kind: "error", verb: "j" });
    const { message } = r as { message: string };
    expect(message).toContain('"b"');
    expect(message).toContain("#a,#b,#c");
    expect(message).not.toContain("##");
  });

  // 2229, vjt's ruling. A bare HEAD inside a comma-list stays an error even
  // though the auto-prepend would make the list well-formed (`a,#b` → `#a,#b`
  // — every element sigilled, nothing the server would refuse). Issue 2229 is
  // a REPORTING slice; widening what PARSES is a different one, and the
  // widening would be SILENT: two channels joined on a spelling nobody
  // approved. The refusal also keeps the message's own promise — it says
  // "spell each channel out", so it cannot then accept a list that is not.
  //
  // Note this is NOT the old guard restored: that one produced `#a,##b` here,
  // double-sigilling an element that already had one. The refusal is back; the
  // broken suggestion is not.
  it("/j a,#b → a bare head in a comma-list is refused, not auto-prepended (2229)", () => {
    const r = parsePlain("/j a,#b");
    expect(r).toMatchObject({ kind: "error", verb: "j" });
    const { message } = r as { message: string };
    expect(message).toContain('"a"');
    expect(message).toContain("#a,#b");
    expect(message).not.toContain("##");
  });

  // RFC 2812 3.2.1: a JOIN target of exactly `0` means "leave all channels".
  // The bare-name prepend turns a solitary `0` into `#0`, so it never reaches
  // the wire as the special form; the per-element check is what keeps it out
  // of a LIST (`#0,0`) too. Pinned because the arm's comment claims it.
  it("/join 0 → the bare-name prepend keeps the RFC 'leave all' form off the wire", () => {
    expect(parsePlain("/join 0")).toEqual({ kind: "join", channels: ["#0"], key: null });
  });

  // A trailing comma leaves an EMPTY element. It has no sigil, so it is
  // refused — and the suggestion drops it rather than proposing a lone `#`.
  it("/join #a, → the empty element is refused and dropped from the suggestion (2229)", () => {
    const r = parsePlain("/join #a,");
    expect(r).toMatchObject({ kind: "error", verb: "join" });
    const { message } = r as { message: string };
    expect(message).toContain("/join #a)");
  });

  // The sigils are DATA (#1255): on a network advertising CHANTYPES=#, `&b`
  // is a NICK, so the list is refused there and accepted on the RFC default.
  it("/join #a,&b → refused when the network advertises CHANTYPES=# only (2229)", () => {
    expect(parseSlash("/join #a,&b", noKeys(), ["#"])).toMatchObject({
      kind: "error",
      verb: "join",
    });
    expect(parsePlain("/join #a,&b")).toEqual({
      kind: "join",
      channels: ["#a", "&b"],
      key: null,
    });
  });
});

describe("parseSlash — /part", () => {
  it("/part with explicit channel", () => {
    expect(parsePlain("/part #grappa")).toEqual({
      kind: "part",
      channel: "#grappa",
      reason: null,
    });
  });

  it("/part with no args parses as part-current (channel: null)", () => {
    expect(parsePlain("/part")).toEqual({
      kind: "part",
      channel: null,
      reason: null,
    });
  });

  it("/part with reason", () => {
    expect(parsePlain("/part #grappa byebye")).toEqual({
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
    expect(parsePlain("/part non trovo utili le bestemmie")).toEqual({
      kind: "part",
      channel: null,
      reason: "non trovo utili le bestemmie",
    });
  });

  it("/part with a single sigil-less word is a reason, not a channel (#1208)", () => {
    expect(parsePlain("/part ciao")).toEqual({
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
      expect(parsePlain(`/part ${chan} ciao`)).toEqual({
        kind: "part",
        channel: chan,
        reason: "ciao",
      });
    },
  );
});

describe("parseSlash — /topic (context-aware, #23)", () => {
  it("/topic bare → show {channel: null} (resolves to current channel in compose)", () => {
    expect(parsePlain("/topic")).toEqual({ kind: "topic-show", channel: null });
  });

  it("/topic -delete → clear {channel: null} (current channel)", () => {
    expect(parsePlain("/topic -delete")).toEqual({ kind: "topic-clear", channel: null });
  });

  it("/topic <text> → set {channel: null} (current channel)", () => {
    expect(parsePlain("/topic ciao mondo")).toEqual({
      kind: "topic-set",
      channel: null,
      text: "ciao mondo",
    });
  });

  it("/topic #chan → show {channel: '#chan'}", () => {
    expect(parsePlain("/topic #sniffo")).toEqual({ kind: "topic-show", channel: "#sniffo" });
  });

  it("/topic #chan <text> → set {channel: '#chan', text}", () => {
    expect(parsePlain("/topic #sniffo hello world")).toEqual({
      kind: "topic-set",
      channel: "#sniffo",
      text: "hello world",
    });
  });

  it("/topic #chan -delete → clear {channel: '#chan'}", () => {
    expect(parsePlain("/topic #sniffo -delete")).toEqual({
      kind: "topic-clear",
      channel: "#sniffo",
    });
  });

  it("/topic &local <text> → set on local-scope channel (& prefix)", () => {
    expect(parsePlain("/topic &local hello")).toEqual({
      kind: "topic-set",
      channel: "&local",
      text: "hello",
    });
  });

  it("/topic body that happens to start with a non-channel char stays current-channel set", () => {
    expect(parsePlain("/topic foo bar")).toEqual({
      kind: "topic-set",
      channel: null,
      text: "foo bar",
    });
  });

  // Review fix #4: bare-# escape for topic bodies that legitimately
  // start with a channel sigil. `/topic # <body>` says "no channel
  // arg — `<body>` is the body even if it starts with #/&/+/!".
  it("/topic # <body that starts with #> → current-channel set, no channel-arg extraction", () => {
    expect(parsePlain("/topic # #urgent maintenance")).toEqual({
      kind: "topic-set",
      channel: null,
      text: "#urgent maintenance",
    });
  });

  it("/topic # <body that starts with !> → current-channel set", () => {
    expect(parsePlain("/topic # !announce downtime")).toEqual({
      kind: "topic-set",
      channel: null,
      text: "!announce downtime",
    });
  });

  it("/topic # -delete → clears current channel (escape applies to control verbs too)", () => {
    expect(parsePlain("/topic # -delete")).toEqual({
      kind: "topic-clear",
      channel: null,
    });
  });

  it("/topic # (bare escape, nothing after) → show current channel", () => {
    expect(parsePlain("/topic #")).toEqual({ kind: "topic-show", channel: null });
  });
});

describe("parseSlash — /nick", () => {
  it("/nick <new>", () => {
    expect(parsePlain("/nick vjt-away")).toEqual({ kind: "nick", nick: "vjt-away" });
  });

  it("/nick missing arg → error", () => {
    expect(parsePlain("/nick")).toMatchObject({ kind: "error", verb: "nick" });
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
    expect(parsePlain("/notice alice heads up")).toEqual({
      kind: "notice",
      target: "alice",
      body: "heads up",
    });
  });

  it.each(["#foo", "&local", "!12345chan", "+modeless"])(
    "/notice to a channel (%s) is ACCEPTED, unlike /msg",
    (chan) => {
      expect(parsePlain(`/notice ${chan} rehash in 5`)).toEqual({
        kind: "notice",
        target: chan,
        body: "rehash in 5",
      });
    },
  );

  it("/notice preserves interior spacing of the body", () => {
    expect(parsePlain("/notice bob ciao  a   tutti")).toEqual({
      kind: "notice",
      target: "bob",
      body: "ciao  a   tutti",
    });
  });

  // Pin the MESSAGE, not just the error shape: an unregistered verb also
  // yields {kind:"error", verb:"notice"} ("unknown command: /notice"), so a
  // shape-only assertion passes with the feature absent.
  it("/notice missing target → usage error, not unknown-command", () => {
    const r = parsePlain("/notice");
    expect(r).toMatchObject({ kind: "error", verb: "notice" });
    const { message } = r as { message: string };
    expect(message).not.toMatch(/unknown command/i);
    expect(message).toMatch(/\/notice requires/i);
  });

  it("/notice missing body → usage error, not unknown-command", () => {
    const r = parsePlain("/notice alice");
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
    expect(parsePlain("/n #grappa")).toEqual({ kind: "names", target: "#grappa" });
  });
});

describe("parseSlash — /msg", () => {
  it("/msg <target> <body>", () => {
    expect(parsePlain("/msg alice ciao!")).toEqual({
      kind: "msg",
      target: "alice",
      body: "ciao!",
    });
  });

  it("/msg with body containing spaces preserved", () => {
    expect(parsePlain("/msg bob ciao a tutti")).toEqual({
      kind: "msg",
      target: "bob",
      body: "ciao a tutti",
    });
  });

  it("/msg missing target → error", () => {
    expect(parsePlain("/msg")).toMatchObject({ kind: "error", verb: "msg" });
  });

  it("/msg missing body → error", () => {
    expect(parsePlain("/msg alice")).toMatchObject({ kind: "error", verb: "msg" });
  });

  // #12/#343 — /msg is for nicks (queries). grappa does not relay a PRIVMSG to
  // a channel addressed by name, so a channel-shaped target opened a phantom
  // query window keyed by a channel name whose own-send never rendered.
  // Reject every IRC channel sigil (# & ! +) up front, not just '#'. #343: the
  // refusal STAYS but the message must be EXPLICIT — say THAT it is refused,
  // WHY (/msg addresses nicks), and WHAT to type instead (open/join the
  // channel window). Pin that actionable guidance so it can never regress to
  // the bare "not supported" string.
  // issue 2179 — `+#chan` is in this list on purpose, and it is the ONE shape
  // the ops-only cure does NOT reach. `@#chan` and `%#chan` open with a
  // MEMBERSHIP sigil and pass this guard, so compose peels them with the
  // network's `PREFIX=`; `+#chan` opens with a CHANTYPE and is refused here,
  // before compose sees anything to peel. Telling the two apart needs a
  // per-network fact this pure function deliberately does not have, on a
  // target genuinely ambiguous with a legal channel name. Declared gap, not a
  // regression: refused before 2179, refused after.
  it.each(["#foo", "&local", "!12345chan", "+modeless", "+#chan"])(
    "/msg to a channel (%s) is rejected with explicit guidance (#12/#343)",
    (chan) => {
      const r = parsePlain(`/msg ${chan} hello`);
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

// issue 2430 — /equery <nick>: the target as typed; bare is `null`, which
// compose refuses (no bare close: the encrypted window's × closes it).
describe("parseSlash — /equery", () => {
  it("/equery <nick> → open an encrypted query", () => {
    expect(parsePlain("/equery Bob")).toEqual({ kind: "equery", target: "Bob" });
  });

  it("/equery bare → {target: null}", () => {
    expect(parsePlain("/equery")).toEqual({ kind: "equery", target: null });
  });
});

describe("parseSlash — /query and /q (DM aliases)", () => {
  it("/query <nick> → open query window without message", () => {
    expect(parsePlain("/query alice")).toEqual({ kind: "query", target: "alice" });
  });

  it("/q <nick> → same as /query", () => {
    expect(parsePlain("/q alice")).toEqual({ kind: "query", target: "alice" });
  });

  // Bundle B: bare /query / /q now parses to {target: null}. compose.ts
  // resolves: on a query window → close; elsewhere → error.
  it("/query bare → {target: null} (close-current-query semantics in compose)", () => {
    expect(parsePlain("/query")).toEqual({ kind: "query", target: null });
  });

  it("/q bare → {target: null}", () => {
    expect(parsePlain("/q")).toEqual({ kind: "query", target: null });
  });
});

describe("parseSlash — T32 verbs (/quit /disconnect /connect)", () => {
  it("/quit bare → reason: null", () => {
    expect(parsePlain("/quit")).toEqual({ kind: "quit", reason: null });
  });

  it("/quit with reason text → reason: string", () => {
    expect(parsePlain("/quit going offline")).toEqual({
      kind: "quit",
      reason: "going offline",
    });
  });

  it("/disconnect bare → network: null, reason: null", () => {
    expect(parsePlain("/disconnect")).toEqual({
      kind: "disconnect",
      network: null,
      reason: null,
    });
  });

  it("/disconnect <netslug> → network: slug, reason: null", () => {
    expect(parsePlain("/disconnect libera")).toEqual({
      kind: "disconnect",
      network: "libera",
      reason: null,
    });
  });

  it("/disconnect <netslug> <reason...> → network: slug, reason: rest of args", () => {
    expect(parsePlain("/disconnect libera going offline now")).toEqual({
      kind: "disconnect",
      network: "libera",
      reason: "going offline now",
    });
  });

  it("/connect <netslug> → network: slug", () => {
    expect(parsePlain("/connect libera")).toEqual({ kind: "connect", network: "libera" });
  });

  it("/connect bare → error (network arg required)", () => {
    const result = parsePlain("/connect");
    expect(result).toMatchObject({ kind: "error", verb: "connect" });
  });
});

// #1796 — the bounce pair, and they are scoped to DIFFERENT things on purpose:
// `/reconnect` is NETWORK-scoped (park then unpark), `/cycle` is CHANNEL-scoped
// (part then join). That is irssi's own split (`RECONNECT <tag>` /
// `CYCLE [<channel>] [<message>]`) and cic, which is irssi-shaped, must not
// invert it. Each verb therefore inherits the grammar of the verb it is the
// round trip of — `/reconnect` from `/disconnect`, `/cycle` from `/part`.
describe("parseSlash — /reconnect + /cycle (#1796)", () => {
  it("/reconnect bare → network: null, reason: null", () => {
    expect(parsePlain("/reconnect")).toEqual({
      kind: "reconnect",
      network: null,
      reason: null,
    });
  });

  it("/reconnect <netslug> → network: slug, reason: null", () => {
    expect(parsePlain("/reconnect libera")).toEqual({
      kind: "reconnect",
      network: "libera",
      reason: null,
    });
  });

  it("/reconnect <netslug> <reason...> → network: slug, reason: rest of args", () => {
    expect(parsePlain("/reconnect libera rolling a fresh vhost")).toEqual({
      kind: "reconnect",
      network: "libera",
      reason: "rolling a fresh vhost",
    });
  });

  // The first token is ALWAYS the slug, exactly as `/disconnect` reads it. A
  // network name carries no sigil, so the channel heuristic below cannot apply
  // here and the two verbs must not be "made consistent" with each other: an
  // operator alternating between them would otherwise get a different answer
  // to the same first word.
  it("/reconnect reads its first token as a slug, never as a reason", () => {
    expect(parsePlain("/reconnect brb")).toEqual({
      kind: "reconnect",
      network: "brb",
      reason: null,
    });
  });

  it("/cycle bare → channel: null, reason: null (the current window)", () => {
    expect(parsePlain("/cycle")).toEqual({ kind: "cycle", channel: null, reason: null });
  });

  it("/cycle #chan → channel target, no message", () => {
    expect(parsePlain("/cycle #grappa")).toEqual({
      kind: "cycle",
      channel: "#grappa",
      reason: null,
    });
  });

  it("/cycle #chan <message> → target plus the PART message", () => {
    expect(parsePlain("/cycle #grappa brb")).toEqual({
      kind: "cycle",
      channel: "#grappa",
      reason: "brb",
    });
  });

  // The #1208 sigil rule, inherited: a first token without a channel sigil is
  // the MESSAGE, not a target. `/cycle brb` must not manufacture a channel
  // named `brb` — that is the exact defect #1208 fixed for `/part`, and a
  // second verb with the same grammar is precisely how it would come back.
  it("/cycle with a sigil-less first token is all message, not a target (#1208)", () => {
    expect(parsePlain("/cycle brb")).toEqual({
      kind: "cycle",
      channel: null,
      reason: "brb",
    });
  });

  it("/cycle with a sigil-less multi-word message keeps the whole text (#1208)", () => {
    expect(parsePlain("/cycle non trovo utili le bestemmie")).toEqual({
      kind: "cycle",
      channel: null,
      reason: "non trovo utili le bestemmie",
    });
  });

  it.each(["&local", "+modeless", "!safe"])("/cycle %s is a target, not a message", (chan) => {
    expect(parsePlain(`/cycle ${chan} brb`)).toEqual({
      kind: "cycle",
      channel: chan,
      reason: "brb",
    });
  });
});

describe("parseSlash — /away", () => {
  it("/away bare → unset explicit away", () => {
    expect(parsePlain("/away")).toEqual({ kind: "away", action: "unset" });
  });

  it("/away <reason text> → set with reason", () => {
    expect(parsePlain("/away brb coffee")).toEqual({
      kind: "away",
      action: "set",
      reason: "brb coffee",
    });
  });

  it("/away :reason (irssi-style colon prefix) → strips leading colon", () => {
    expect(parsePlain("/away :gone fishing")).toEqual({
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
    expect(parsePlain("/away :")).toEqual({ kind: "away", action: "unset" });
  });

  it("/away    (only whitespace after verb) → unset (empty rest)", () => {
    expect(parsePlain("/away   ")).toEqual({ kind: "away", action: "unset" });
  });
});

describe("parseSlash — channel ops verbs", () => {
  it("/op <nick> → op with one nick", () => {
    expect(parsePlain("/op alice")).toEqual({ kind: "op", nicks: ["alice"] });
  });

  it("/op <nick1> <nick2> → op with multiple nicks", () => {
    expect(parsePlain("/op alice bob carol")).toEqual({
      kind: "op",
      nicks: ["alice", "bob", "carol"],
    });
  });

  it("/op missing nicks → error", () => {
    expect(parsePlain("/op")).toMatchObject({ kind: "error", verb: "op" });
  });

  it("/deop <nick>", () => {
    expect(parsePlain("/deop alice")).toEqual({ kind: "deop", nicks: ["alice"] });
  });

  it("/deop missing nicks → error", () => {
    expect(parsePlain("/deop")).toMatchObject({ kind: "error", verb: "deop" });
  });

  it("/voice <nick>", () => {
    expect(parsePlain("/voice alice")).toEqual({ kind: "voice", nicks: ["alice"] });
  });

  it("/voice missing nicks → error", () => {
    expect(parsePlain("/voice")).toMatchObject({ kind: "error", verb: "voice" });
  });

  it("/devoice <nick>", () => {
    expect(parsePlain("/devoice alice")).toEqual({ kind: "devoice", nicks: ["alice"] });
  });

  it("/devoice missing nicks → error", () => {
    expect(parsePlain("/devoice")).toMatchObject({ kind: "error", verb: "devoice" });
  });

  it("/kick <nick> bare (no reason)", () => {
    expect(parsePlain("/kick alice")).toEqual({ kind: "kick", nick: "alice", reason: "" });
  });

  it("/kick <nick> <reason>", () => {
    expect(parsePlain("/kick alice bye bye")).toEqual({
      kind: "kick",
      nick: "alice",
      reason: "bye bye",
    });
  });

  it("/kick missing nick → error", () => {
    expect(parsePlain("/kick")).toMatchObject({ kind: "error", verb: "kick" });
  });

  it("/ban <mask>", () => {
    expect(parsePlain("/ban *!*@evil.com")).toEqual({ kind: "ban", mask: "*!*@evil.com" });
  });

  it("/ban <nick> (bare nick for WHOIS-cache mask derivation server-side)", () => {
    expect(parsePlain("/ban alice")).toEqual({ kind: "ban", mask: "alice" });
  });

  it("/ban missing mask → error", () => {
    expect(parsePlain("/ban")).toMatchObject({ kind: "error", verb: "ban" });
  });

  it("/unban <mask>", () => {
    expect(parsePlain("/unban *!*@evil.com")).toEqual({ kind: "unban", mask: "*!*@evil.com" });
  });

  it("/unban missing mask → error", () => {
    expect(parsePlain("/unban")).toMatchObject({ kind: "error", verb: "unban" });
  });

  // #386 — /kb <nick> [reason] kickban. Same grammar as /kick (first token
  // is the nick, the rest is the reason); the ban-mask derivation + MODE+KICK
  // sequencing live in compose.ts. /kickban is an irssi-spelling alias.
  it("/kb <nick> bare (no reason)", () => {
    expect(parsePlain("/kb alice")).toEqual({ kind: "kb", nick: "alice", reason: "" });
  });

  it("/kb <nick> <reason>", () => {
    expect(parsePlain("/kb alice spam spam spam")).toEqual({
      kind: "kb",
      nick: "alice",
      reason: "spam spam spam",
    });
  });

  it("/kb missing nick → error", () => {
    expect(parsePlain("/kb")).toMatchObject({ kind: "error", verb: "kb" });
  });

  it("/kickban is an alias of /kb", () => {
    expect(parsePlain("/kickban alice rude")).toEqual({
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
    expect(parsePlain("/kill spammer")).toEqual({ kind: "kill", nick: "spammer", reason: "" });
  });

  it("/kill <nick> <reason with spaces> (full reason, colon composed downstream)", () => {
    expect(parsePlain("/kill spammer flooding the channel")).toEqual({
      kind: "kill",
      nick: "spammer",
      reason: "flooding the channel",
    });
  });

  it("/kill missing nick → error", () => {
    expect(parsePlain("/kill")).toMatchObject({
      kind: "error",
      verb: "kill",
      message: "/kill requires a nick",
    });
  });

  it("/banlist bare → banlist for the current channel (null), mode b", () => {
    expect(parsePlain("/banlist")).toEqual({ kind: "banlist", channel: null, mode: "b" });
  });

  // #1251 — `/banlist [#chan] [mode]`: both optional, classified by SHAPE so
  // either order works. The mode test wins over the channel test because a
  // `+`-sigil channel named `+e` is extinct while `/banlist +e` is obvious.
  it("/banlist <mode> → that list on the current channel", () => {
    expect(parsePlain("/banlist e")).toEqual({ kind: "banlist", channel: null, mode: "e" });
    expect(parsePlain("/banlist +e")).toEqual({ kind: "banlist", channel: null, mode: "e" });
    expect(parsePlain("/banlist I")).toEqual({ kind: "banlist", channel: null, mode: "I" });
  });

  it("/banlist #chan <mode> → that list on that channel, either token order", () => {
    expect(parsePlain("/banlist #sniffo z")).toEqual({
      kind: "banlist",
      channel: "#sniffo",
      mode: "z",
    });

    expect(parsePlain("/banlist q #sniffo")).toEqual({
      kind: "banlist",
      channel: "#sniffo",
      mode: "q",
    });
  });

  // The letter's CASE is the mode's identity: `I` (invex) and `i`
  // (invite-only) are different modes.
  it("/banlist keeps the mode letter's case", () => {
    expect(parsePlain("/banlist I")).toEqual({ kind: "banlist", channel: null, mode: "I" });
    expect(parsePlain("/banlist i")).toEqual({ kind: "banlist", channel: null, mode: "i" });
  });

  it("/invite <nick>", () => {
    expect(parsePlain("/invite alice")).toEqual({ kind: "invite", nick: "alice", channel: null });
  });

  it("/invite <nick> <#chan>", () => {
    expect(parsePlain("/invite alice #secret")).toEqual({
      kind: "invite",
      nick: "alice",
      channel: "#secret",
    });
  });

  it("/invite missing nick → error", () => {
    expect(parsePlain("/invite")).toMatchObject({ kind: "error", verb: "invite" });
  });

  it("/umode <modes>", () => {
    expect(parsePlain("/umode +i")).toEqual({ kind: "umode", modes: "+i" });
  });

  // #229 — bare /umode opens the umode viewer/editor modal (was an error
  // pre-#229). Mirror of bare /mode opening the channel-mode modal.
  it("/umode (bare) → umode-view (open the umode modal)", () => {
    expect(parsePlain("/umode")).toEqual({ kind: "umode-view" });
  });

  it("/mode <target> <modes>", () => {
    expect(parsePlain("/mode #sniffo +o-v")).toEqual({
      kind: "mode",
      target: "#sniffo",
      modes: "+o-v",
      params: [],
    });
  });

  it("/mode <target> <modes> <params...>", () => {
    expect(parsePlain("/mode #sniffo +o-v alice rofl")).toEqual({
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
    expect(parsePlain("/mode vjt-grappa")).toEqual({
      kind: "umode-target-view",
      target: "vjt-grappa",
    });
  });

  it("/mode <nick> <modes> still executes a user-MODE change directly", () => {
    expect(parsePlain("/mode vjt-grappa +i")).toEqual({
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
    expect(parsePlain("/mode")).toEqual({ kind: "mode-view", channel: null });
  });

  it("/mode #chan (channel, no modes) → mode-view for that channel", () => {
    expect(parsePlain("/mode #sniffo")).toEqual({ kind: "mode-view", channel: "#sniffo" });
  });

  it("/mode +s (bare modes, no channel) → apply to current channel", () => {
    expect(parsePlain("/mode +s")).toEqual({
      kind: "mode-apply-current",
      modes: "+s",
      params: [],
    });
  });

  it("/mode -l+k secret (bare modes with params) → apply to current channel", () => {
    expect(parsePlain("/mode -l+k secret")).toEqual({
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
    expect(parsePlain("/mode #sniffo +b")).toEqual({
      kind: "mode",
      target: "#sniffo",
      modes: "+b",
      params: [],
    });
  });

  it("/mode #chan b (unsigned list-mode query) → mode, sign absent, params empty", () => {
    expect(parsePlain("/mode #sniffo b")).toEqual({
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
    expect(parsePlain("/mode #sniffo -b")).toEqual({
      kind: "mode",
      target: "#sniffo",
      modes: "-b",
      params: [],
    });
  });

  it("/mode +b (bare list-mode query, no channel) → mode-apply-current", () => {
    expect(parsePlain("/mode +b")).toEqual({
      kind: "mode-apply-current",
      modes: "+b",
      params: [],
    });
  });

  it("/mode -b (bare signed list-mode query) → mode-apply-current, sign preserved", () => {
    expect(parsePlain("/mode -b")).toEqual({
      kind: "mode-apply-current",
      modes: "-b",
      params: [],
    });
  });

  // A mask parameter turns the list-mode letter into a MUTATION, not a
  // query — it must keep executing raw, unchanged (#536 constraint).
  it("/mode #chan +b <mask> (mask present) → mode (mutation, unchanged)", () => {
    expect(parsePlain("/mode #sniffo +b nick!*@*")).toEqual({
      kind: "mode",
      target: "#sniffo",
      modes: "+b",
      params: ["nick!*@*"],
    });
  });

  it("/mode +b <mask> (bare, mask present) → mode-apply-current (mutation, unchanged)", () => {
    expect(parsePlain("/mode +b nick!*@*")).toEqual({
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
    expect(parsePlain("/mode b")).toEqual({ kind: "umode-target-view", target: "b" });
  });

  // #536/#1251 boundary guards — the query discriminator is ONE letter,
  // exact. `+bb` (repeated), `+be` (two list letters at once) and uppercase
  // `+B` (a DISTINCT, case-sensitive mode on bahamut) are mode changes, and
  // compose's interception regex must never swallow them either.
  it("/mode #chan +bb (repeated letter) → mode (not a banlist query)", () => {
    expect(parsePlain("/mode #sniffo +bb")).toEqual({
      kind: "mode",
      target: "#sniffo",
      modes: "+bb",
      params: [],
    });
  });

  it("/mode #chan +be (combined list letters) → mode (not a banlist query)", () => {
    expect(parsePlain("/mode #sniffo +be")).toEqual({
      kind: "mode",
      target: "#sniffo",
      modes: "+be",
      params: [],
    });
  });

  it("/mode #chan +B (uppercase, distinct mode letter) → mode (not a banlist query)", () => {
    expect(parsePlain("/mode #sniffo +B")).toEqual({
      kind: "mode",
      target: "#sniffo",
      modes: "+B",
      params: [],
    });
  });
});

describe("parseSlash — info verbs (TODO — server-side missing)", () => {
  it("/who bare → who with no target", () => {
    expect(parsePlain("/who")).toEqual({ kind: "who", target: null });
  });

  it("/who <target>", () => {
    expect(parsePlain("/who alice")).toEqual({ kind: "who", target: "alice" });
  });

  // #540 — /who must forward its FULL argument list, not just the first
  // token. bahamut's extended WHO takes flag args (`+s <server>`, `+A
  // <away-msg>`, `+c <channel>`, `+H <maxhits>`); `/who +s server.azzurra.chat`
  // must reach the wire as `WHO +s server.azzurra.chat`. Pre-#540 the parser
  // kept only `+s`, so the server arg was eaten → 522 ERR_WHOSYNTAX.
  it("/who +s <server> → forwards the full arg string (#540)", () => {
    expect(parsePlain("/who +s server.azzurra.chat")).toEqual({
      kind: "who",
      target: "+s server.azzurra.chat",
    });
  });

  // #540 — a channel target with a trailing flag also forwards intact.
  it("/who #chan +c → forwards flags after the channel (#540)", () => {
    expect(parsePlain("/who #grappa +c")).toEqual({
      kind: "who",
      target: "#grappa +c",
    });
  });

  it("/names bare → names with no target", () => {
    expect(parsePlain("/names")).toEqual({ kind: "names", target: null });
  });

  it("/names <target>", () => {
    expect(parsePlain("/names #grappa")).toEqual({ kind: "names", target: "#grappa" });
  });

  // #122 — /n is the post-init alias of /names.
  it("/n bare → same as /names with no target", () => {
    expect(parsePlain("/n")).toEqual({ kind: "names", target: null });
  });

  it("/n <target> → same as /names", () => {
    expect(parsePlain("/n #grappa")).toEqual({ kind: "names", target: "#grappa" });
  });

  it("/list bare → list with no pattern", () => {
    expect(parsePlain("/list")).toEqual({ kind: "list", pattern: null });
  });

  it("/list <pattern>", () => {
    expect(parsePlain("/list *grappa*")).toEqual({ kind: "list", pattern: "*grappa*" });
  });

  it("/links bare → links with no pattern", () => {
    expect(parsePlain("/links")).toEqual({ kind: "links", pattern: null });
  });

  it("/links <pattern>", () => {
    expect(parsePlain("/links *.irc.net")).toEqual({ kind: "links", pattern: "*.irc.net" });
  });

  // #374 — /motd carries an optional target server (RFC 2812 §3.4.1
  // `MOTD [<target>]`). Bare /motd = current server's MOTD (target null);
  // /motd <server> routes the MOTD query through that server. Pre-#374 the
  // argument was silently dropped, so the user got the wrong server's MOTD
  // with no error. MOTD takes a single target token (unlike /who, which
  // after #540 forwards its full multi-token arg string).
  it("/motd bare → motd with no target", () => {
    expect(parsePlain("/motd")).toEqual({ kind: "motd", target: null });
  });

  it("/motd <server> → motd carrying the target server", () => {
    expect(parsePlain("/motd void.azzurra.chat")).toEqual({
      kind: "motd",
      target: "void.azzurra.chat",
    });
  });

  // Trailing tokens past the first are ignored (MOTD takes a single target).
  it("/motd <server> <extra> → only the first token is the target", () => {
    expect(parsePlain("/motd void.azzurra.chat junk")).toEqual({
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
    expect(parsePlain("/admin")).toEqual({ kind: "admin", target: null });
  });

  it("/admin <server> → admin carrying the target server", () => {
    expect(parsePlain("/admin void.azzurra.chat")).toEqual({
      kind: "admin",
      target: "void.azzurra.chat",
    });
  });

  it("/admin <server> <extra> → only the first token is the target", () => {
    expect(parsePlain("/admin void.azzurra.chat junk")).toEqual({
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
    expect(parsePlain("/recover")).toEqual({ kind: "recover", network: null });
  });

  it("/recover <network> → recover carrying the network slug", () => {
    expect(parsePlain("/recover azzurra")).toEqual({ kind: "recover", network: "azzurra" });
  });

  // Trailing tokens past the first are ignored (recover takes one network arg).
  it("/recover <network> <extra> → only the first token is the network", () => {
    expect(parsePlain("/recover azzurra junk")).toEqual({ kind: "recover", network: "azzurra" });
  });
});

// #356 — keyword highlight is classic-IRC irssi-shaped now: /hilight
// canonical, /highlight alias, /dehilight remove. irssi-direct (the whole
// rest is one pattern, no add/del/list subverb). A BARE form opens the
// unified watch-lists settings section instead of erroring.
describe("parseSlash — keyword highlight (/hilight, /highlight alias, /dehilight) — #356", () => {
  it("/hilight <pattern> → watchlist add", () => {
    expect(parsePlain("/hilight myname")).toEqual({
      kind: "watchlist",
      action: "add",
      pattern: "myname",
    });
  });

  it("/highlight <pattern> → same as /hilight (alias)", () => {
    expect(parsePlain("/highlight myname")).toEqual({
      kind: "watchlist",
      action: "add",
      pattern: "myname",
    });
  });

  it("/hilight keeps a multi-word pattern intact (whole rest is one pattern)", () => {
    expect(parsePlain("/hilight foo bar")).toEqual({
      kind: "watchlist",
      action: "add",
      pattern: "foo bar",
    });
  });

  it("/dehilight <pattern> → watchlist del", () => {
    expect(parsePlain("/dehilight myname")).toEqual({
      kind: "watchlist",
      action: "del",
      pattern: "myname",
    });
  });

  it("bare /hilight → open-settings (watchlists)", () => {
    expect(parsePlain("/hilight")).toEqual({ kind: "open-settings", section: "watchlists" });
  });

  it("bare /highlight → open-settings (watchlists)", () => {
    expect(parsePlain("/highlight")).toEqual({ kind: "open-settings", section: "watchlists" });
  });

  it("bare /dehilight → open-settings (watchlists)", () => {
    expect(parsePlain("/dehilight")).toEqual({ kind: "open-settings", section: "watchlists" });
  });
});

// #1958 — /credits: the end titles, one verb deep. No arguments, no wire.
describe("parseSlash — /credits (#1958)", () => {
  it("bare /credits → open-credits", () => {
    expect(parsePlain("/credits")).toEqual({ kind: "open-credits" });
  });

  it("trailing text is ignored, like the rest of the no-arg family", () => {
    expect(parsePlain("/credits please")).toEqual({ kind: "open-credits" });
    expect(parsePlain("/CREDITS")).toEqual({ kind: "open-credits" });
  });

  // The issue's first open question, answered: /credits is NOT on the
  // non-shadowable deny list, so a user alias takes precedence over it.
  it("a user alias may shadow /credits", () => {
    expect(parseSlash("/credits", keysOf({ credits: "np" }), DEFAULT_CHANTYPES)).toEqual({
      kind: "np",
    });
  });
});

describe("parseSlash — /lusers (P-0d, args #579)", () => {
  it("parses bare /lusers (no mask, no server)", () => {
    expect(parsePlain("/lusers")).toEqual({ kind: "lusers", mask: null, server: null });
  });

  it("/lusers <mask> → mask, null server", () => {
    expect(parsePlain("/lusers *.azzurra.org")).toEqual({
      kind: "lusers",
      mask: "*.azzurra.org",
      server: null,
    });
  });

  it("/lusers <mask> <server> → both, in RFC 2812 §3.4.2 order", () => {
    expect(parsePlain("/lusers *.azzurra.org void.azzurra.chat")).toEqual({
      kind: "lusers",
      mask: "*.azzurra.org",
      server: "void.azzurra.chat",
    });
  });

  it("ignores tokens past the second (LUSERS is a 2-slot wire frame)", () => {
    expect(parsePlain("/lusers *.azzurra.org void.azzurra.chat junk")).toEqual({
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
      const cmd = parsePlain(line);
      expect(cmd.kind).toBe("lusers");
      if (cmd.kind !== "lusers") continue;
      if (cmd.server !== null) expect(cmd.mask).not.toBeNull();
    }
  });
});

describe("parseSlash — /stats (#155)", () => {
  it("parses bare /stats (no query, no target)", () => {
    expect(parsePlain("/stats")).toEqual({ kind: "stats", query: null, target: null });
  });

  it("/stats <query> → query, null target", () => {
    expect(parsePlain("/stats m")).toEqual({ kind: "stats", query: "m", target: null });
  });

  it("/stats <query> <server> → query + target", () => {
    expect(parsePlain("/stats m irc.example.net")).toEqual({
      kind: "stats",
      query: "m",
      target: "irc.example.net",
    });
  });

  it("ignores any tokens past the server target (STATS is 2-arg upstream)", () => {
    expect(parsePlain("/stats u irc.example.net junk")).toEqual({
      kind: "stats",
      query: "u",
      target: "irc.example.net",
    });
  });
});

describe("parseSlash — /rehash (#155, #375)", () => {
  it("parses bare /rehash → null opt (full ircd.conf reload)", () => {
    expect(parsePlain("/rehash")).toEqual({ kind: "rehash", opt: null });
  });

  // #375 — the option (MOTD / DNS / GC / TKLINE / …) must survive parsing.
  // Pre-fix it was silently dropped (bare REHASH → full reload); mirrors
  // /stats + #374's /motd first-token-only grammar.
  it("/rehash MOTD → opt: 'MOTD' (scoped reload)", () => {
    expect(parsePlain("/rehash MOTD")).toEqual({ kind: "rehash", opt: "MOTD" });
  });

  it("keeps only the first token (REHASH takes one option upstream)", () => {
    expect(parsePlain("/rehash DNS extra junk")).toEqual({ kind: "rehash", opt: "DNS" });
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
    expect(parsePlain(`/${verb} HELP`)).toEqual({
      kind: "msg",
      target,
      body: "HELP",
    });
  });

  it("/ns IDENTIFY preserves the rest verbatim (multi-token body)", () => {
    expect(parsePlain("/ns IDENTIFY hunter2 backup_pw")).toEqual({
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
    expect(parsePlain(`/${verb}`)).toEqual({ kind: "service-modal", service });
  });
});

describe("parseSlash — /quote", () => {
  it("/quote <line> → {line}", () => {
    expect(parsePlain("/quote PING :foo.bar")).toEqual({
      kind: "quote",
      line: "PING :foo.bar",
    });
  });

  it("/quote bare → error", () => {
    expect(parsePlain("/quote")).toMatchObject({ kind: "error", verb: "quote" });
  });

  it("/quote with multi-token line preserves the whole tail", () => {
    expect(parsePlain("/quote PRIVMSG #x :hello world")).toEqual({
      kind: "quote",
      line: "PRIVMSG #x :hello world",
    });
  });
});

// issue 2230 — /raw is an alias of /quote. compose.ts's server-window
// refusal has always advertised "Try /raw <line>" while only /quote
// existed, so the advertised escape hatch answered `unknown command`.
// The pin is BEHAVIOURAL: /raw must produce the same SlashCommand /quote
// does, not merely be present in DISPATCH.
describe("parseSlash — /raw (alias of /quote, issue 2230)", () => {
  it("/raw <line> → {kind: 'quote', line} — the /quote shape, not a new kind", () => {
    expect(parsePlain("/raw PING :foo.bar")).toEqual({
      kind: "quote",
      line: "PING :foo.bar",
    });
  });

  it("/raw with multi-token line preserves the whole tail", () => {
    expect(parsePlain("/raw PRIVMSG #x :hello world")).toEqual({
      kind: "quote",
      line: "PRIVMSG #x :hello world",
    });
  });

  it("/raw and /quote parse the same tail to the same command", () => {
    expect(parsePlain("/raw PRIVMSG #x :hello world")).toEqual(
      parsePlain("/quote PRIVMSG #x :hello world"),
    );
  });

  // The alias inherits /quote's emptiness rejection — MESSAGE included.
  // Pinning only {kind: "error", verb: "raw"} would be a mirror: an
  // unaliased /raw already errors with `unknown command: /raw` and
  // satisfies that shape. The message is what separates "routed into the
  // /quote handler" from "fell off the dispatcher", and it is read off
  // /quote itself rather than retyped. `verb` stays the verb AS TYPED
  // (the dispatcher passes `expanded.verb` through), so it differs.
  it("/raw bare → /quote's own rejection, not `unknown command`", () => {
    const quoteBare = parsePlain("/quote");
    expect(quoteBare.kind).toBe("error");
    if (quoteBare.kind !== "error") return;
    expect(parsePlain("/raw")).toEqual({ ...quoteBare, verb: "raw" });
  });
});

describe("parseSlash — /oper", () => {
  it("/oper <name> <password> → {name, password}", () => {
    expect(parsePlain("/oper vjt s3cret")).toEqual({
      kind: "oper",
      name: "vjt",
      password: "s3cret",
    });
  });

  it("/oper bare → error", () => {
    expect(parsePlain("/oper")).toMatchObject({ kind: "error", verb: "oper" });
  });

  it("/oper <name> (no password) → error", () => {
    expect(parsePlain("/oper vjt")).toMatchObject({ kind: "error", verb: "oper" });
  });

  it("/oper rejects multi-word password (IRC OPER takes a single token)", () => {
    expect(parsePlain("/oper vjt this is my passphrase")).toMatchObject({
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
// #162 — /ignore + /unignore, the server-honoured mask list. irssi-direct:
// one mask per call; a bare /ignore opens the ignore-list settings sub-page
// (like bare /hilight). Levels are deliberately NOT parsed.
//
// issue 2294 REVERSED what the trailing text means, and the old posture had
// a test of its own ("a trailing token is not a second one" — it was
// DISCARDED). Everything after the mask is now ONE optional glob over the
// message text, which is what makes a single author behind a relay bot
// ignorable. The test below is that old one rewritten to the new meaning,
// not deleted: the discard was the behaviour, and the behaviour changed.
describe("parseSlash — /ignore + /unignore (#162, issue 2294)", () => {
  it("/ignore <mask> → ignore add, with no text pattern", () => {
    expect(parsePlain("/ignore spambot")).toEqual({
      kind: "ignore",
      action: "add",
      mask: "spambot",
      textPattern: null,
    });
  });

  it("/ignore keeps a full nick!user@host mask verbatim — normalisation is the server's", () => {
    expect(parsePlain("/ignore *!*@Evil.Example")).toEqual({
      kind: "ignore",
      action: "add",
      mask: "*!*@Evil.Example",
      textPattern: null,
    });
  });

  it("everything after the mask is ONE text pattern, spaces and all", () => {
    expect(parsePlain("/ignore Gazzurbo!*@* <SomeNick> ciao *")).toEqual({
      kind: "ignore",
      action: "add",
      mask: "Gazzurbo!*@*",
      textPattern: "<SomeNick> ciao *",
    });
  });

  it("a pattern of only whitespace is no pattern, not an empty one", () => {
    expect(parsePlain("/ignore spambot    ")).toEqual({
      kind: "ignore",
      action: "add",
      mask: "spambot",
      textPattern: null,
    });
  });

  it("bare /ignore → open the ignore-list settings sub-page", () => {
    expect(parsePlain("/ignore")).toEqual({ kind: "open-settings", section: "ignores" });
  });

  it("/unignore <mask> → ignore del", () => {
    expect(parsePlain("/unignore spambot")).toEqual({
      kind: "ignore",
      action: "del",
      mask: "spambot",
      textPattern: null,
    });
  });

  it("/unignore carries the pattern too — a removal names the PAIR it removes", () => {
    expect(parsePlain("/unignore Gazzurbo!*@* <SomeNick>*")).toEqual({
      kind: "ignore",
      action: "del",
      mask: "Gazzurbo!*@*",
      textPattern: "<SomeNick>*",
    });
  });

  it("bare /unignore is a parser error, not a silent list", () => {
    expect(parsePlain("/unignore")).toEqual({
      kind: "error",
      verb: "unignore",
      message: "/unignore requires a mask",
    });
  });
});

describe("parseSlash — /notify + /watch presence (#356: irssi-direct, bare → settings)", () => {
  it("/notify <nick> → notify add", () => {
    expect(parsePlain("/notify Foo")).toEqual({ kind: "notify", action: "add", nicks: ["Foo"] });
  });

  it("/notify <nick> <nick> … → notify add all of them", () => {
    expect(parsePlain("/notify Foo Bar baz")).toEqual({
      kind: "notify",
      action: "add",
      nicks: ["Foo", "Bar", "baz"],
    });
  });

  it("/watch <nick> → same as /notify (presence alias, #356)", () => {
    expect(parsePlain("/watch gigi")).toEqual({ kind: "notify", action: "add", nicks: ["gigi"] });
  });

  it("bare /notify → open-settings (watchlists) — was `list` pre-#356", () => {
    expect(parsePlain("/notify")).toEqual({ kind: "open-settings", section: "watchlists" });
  });

  it("bare /watch → open-settings (watchlists) — was an error pre-#356", () => {
    expect(parsePlain("/watch")).toEqual({ kind: "open-settings", section: "watchlists" });
  });
});

// #1480 — `/beep`, vjt's shape: bare opens the settings, `on`/`off` are
// shorthands for two presets, anything else is a preset name.
describe("parseSlash — /beep (#1480)", () => {
  it("bare /beep opens the settings sub-page that holds the picker", () => {
    expect(parsePlain("/beep")).toEqual({ kind: "open-settings", section: "push" });
  });

  it("/beep on selects the 440 Hz tone, NOT the default", () => {
    // The discriminating pair. `on` and the DEFAULT are different values since
    // this issue: the shipped state is silence and `on` is the opt-in. A
    // handler that resolved `on` to "the default preset" would make `/beep on`
    // mean `/beep off`, and both tests below would still pass individually.
    expect(parsePlain("/beep on")).toEqual({ kind: "beep", sound: "tone" });
  });

  it("/beep off selects silence", () => {
    expect(parsePlain("/beep off")).toEqual({ kind: "beep", sound: "none" });
  });

  it("/beep <preset> selects that preset by name", () => {
    expect(parsePlain("/beep icq")).toEqual({ kind: "beep", sound: "icq" });
    expect(parsePlain("/beep xp_notify")).toEqual({ kind: "beep", sound: "xp_notify" });
  });

  it("the preset name is case-insensitive, like every other verb argument here", () => {
    expect(parsePlain("/beep XP_Ding")).toEqual({ kind: "beep", sound: "xp_ding" });
  });

  it("an unknown name errors and names the set rather than just refusing", () => {
    const result = parsePlain("/beep airhorn");
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("unreachable");
    // The operator asked for a sound by name; "unknown preset" would send them
    // to the settings drawer to find out what the names are.
    expect(result.message).toContain("airhorn");
    expect(result.message).toContain("xp_ding");
  });

  it("//beep is a literal message, not the verb (the #427 escape holds)", () => {
    expect(parsePlain("//beep off")).toEqual({ kind: "privmsg", body: "/beep off" });
  });
});

describe("#385 — expandAlias grammar", () => {
  it("positional $1 substitution (whois-with-idle motivating example)", () => {
    // /wii foo → whois foo foo. This also pins the NO-implicit-append half of
    // the rule: the expansion carries a placeholder, so the raw rest is not
    // appended on top of it — that would read `foo foo foo`. The sibling case
    // below pins the other half, the append when there is no placeholder.
    expect(expandAlias("wii", "foo", keysOf({ wii: "whois $1 $1" }))).toEqual({
      verb: "whois",
      rest: "foo foo",
    });
  });

  it("implicit verbatim append when the expansion has no placeholder", () => {
    // alias w whois + /w foo bar → whois foo bar
    expect(expandAlias("w2", "foo bar", keysOf({ w2: "whois" }))).toEqual({
      verb: "whois",
      rest: "foo bar",
    });
  });

  it("$* expands to all remaining args verbatim", () => {
    expect(expandAlias("say", "hello there world", keysOf({ say: "msg #chan $*" }))).toEqual({
      verb: "msg",
      rest: "#chan hello there world",
    });
  });

  it("a missing positional expands to the empty string (silent)", () => {
    // /wii (no args) → whois  (both $1 empty) → trims to just the verb
    expect(expandAlias("wii", "", keysOf({ wii: "whois $1 $1" }))).toEqual({
      verb: "whois",
      rest: "",
    });
  });

  it("matches alias names case-insensitively", () => {
    // typed /WII foo — the motivating example is upper-case
    expect(expandAlias("WII", "foo", keysOf({ wii: "whois $1 $1" }))).toEqual({
      verb: "whois",
      rest: "foo foo",
    });
  });

  it("leaves a non-alias verb untouched", () => {
    expect(expandAlias("whois", "foo", keysOf({ wii: "whois $1 $1" }))).toEqual({
      verb: "whois",
      rest: "foo",
    });
  });

  // #427 — REVERSES #385 decision #3. A user alias whose name collides with a
  // builtin now SHADOWS it: the alias expands (alias wins). The one exception
  // is the two-verb deny list (alias/unalias) covered below.
  it("a same-named alias shadows a builtin (alias wins) — #427", () => {
    expect(expandAlias("whois", "foo", keysOf({ whois: "quote EVIL" }))).toEqual({
      verb: "quote",
      rest: "EVIL foo",
    });
  });

  // #427 — /alias and /unalias are the in-client repair surface and are NOT
  // shadowable. Even if the map holds one (settings UI can store a dead entry),
  // the expander refuses it: the real handler always wins.
  it("/alias and /unalias are never shadowed (repair path intact) — #427", () => {
    expect(expandAlias("alias", "x y", keysOf({ alias: "quote EVIL" }))).toEqual({
      verb: "alias",
      rest: "x y",
    });
    expect(expandAlias("unalias", "x", keysOf({ unalias: "quote EVIL" }))).toEqual({
      verb: "unalias",
      rest: "x",
    });
  });

  it("expands alias → alias chains", () => {
    // /a x → b x → whois x x
    expect(expandAlias("a", "x", keysOf({ a: "b $1", b: "whois $1 $1" }))).toEqual({
      verb: "whois",
      rest: "x x",
    });
  });

  it("errors (naming the chain) when a cycle exceeds MAX_ALIAS_DEPTH", () => {
    const out = expandAlias("loop", "x", keysOf({ loop: "loop $1" }));
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
    expect(expandAlias("a1", "", keysOf(map))).toEqual({ verb: "whois", rest: "" });
  });
});

describe("#385 — parseSlash with user aliases (end-to-end)", () => {
  it("an expanded alias flows through the normal DISPATCH path", () => {
    // /wii foo → whois foo foo → the whois command
    expect(parseSlash("/wii foo", keysOf({ wii: "whois $1 $1" }), DEFAULT_CHANTYPES)).toEqual({
      kind: "whois",
      nick: "foo",
      server: "foo",
    });
  });

  it("no aliases (default arg) → unchanged behaviour", () => {
    expect(parsePlain("/whois alice")).toEqual({ kind: "whois", nick: "alice", server: null });
  });

  it("a cyclic alias surfaces an inline error", () => {
    const out = parseSlash("/loop x", keysOf({ loop: "loop $1" }), DEFAULT_CHANTYPES);
    expect(out).toMatchObject({ kind: "error", verb: "loop" });
  });

  it("tolerates a leading slash in the expansion (equivalent forms)", () => {
    expect(parseSlash("/wii foo", keysOf({ wii: "/whois $1 $1" }), DEFAULT_CHANTYPES)).toEqual({
      kind: "whois",
      nick: "foo",
      server: "foo",
    });
  });

  // #427 — a user alias shadowing a builtin flows through the shadow, not the
  // builtin. /join is aliased to /whois; typing /join <nick> runs whois.
  it("a builtin is shadowed end-to-end when a same-named alias exists — #427", () => {
    expect(parseSlash("/join alice", keysOf({ join: "whois" }), DEFAULT_CHANTYPES)).toEqual({
      kind: "whois",
      nick: "alice",
      server: null,
    });
  });

  // #427 — the deny list holds end-to-end: even with an alias entry, /alias and
  // /unalias resolve to their real handlers (repair path intact).
  it("/alias and /unalias resolve to their real handlers despite an alias entry — #427", () => {
    expect(parseSlash("/alias", keysOf({ alias: "whois" }), DEFAULT_CHANTYPES)).toEqual({
      kind: "open-settings",
      section: "aliases",
    });
    expect(parseSlash("/unalias wii", keysOf({ unalias: "whois" }), DEFAULT_CHANTYPES)).toEqual({
      kind: "unalias",
      name: "wii",
    });
  });
});

describe("#385 — /alias + /unalias", () => {
  it("bare /alias deep-links into the aliases settings sub-page", () => {
    expect(parsePlain("/alias")).toEqual({ kind: "open-settings", section: "aliases" });
  });

  it("/alias <name> <expansion> defines (name lowercased, leading slash stripped)", () => {
    expect(parsePlain("/alias WII whois $1 $1")).toEqual({
      kind: "alias-define",
      name: "wii",
      expansion: "whois $1 $1",
    });
    // Leading slash stripped from the expansion (ww is not a builtin).
    expect(parsePlain("/alias ww /whois")).toEqual({
      kind: "alias-define",
      name: "ww",
      expansion: "whois",
    });
  });

  // #427 — a name colliding with a builtin is now ALLOWED (shadowing). /whois,
  // /q, /w, /join etc. define normally.
  it("allows an alias name that collides with a builtin (shadowing) — #427", () => {
    expect(parsePlain("/alias whois quote EVIL")).toEqual({
      kind: "alias-define",
      name: "whois",
      expansion: "quote EVIL",
    });
    expect(parsePlain("/alias w foo")).toMatchObject({ kind: "alias-define", name: "w" });
    expect(parsePlain("/alias join foo")).toMatchObject({ kind: "alias-define", name: "join" });
  });

  // #427 — the only two verbs that CANNOT be shadowed: /alias and /unalias
  // (the command-side repair surface). Rejected inline at define time.
  it("rejects aliasing /alias or /unalias (deny list) — #427", () => {
    expect(parsePlain("/alias alias something")).toMatchObject({ kind: "error", verb: "alias" });
    expect(parsePlain("/alias unalias something")).toMatchObject({ kind: "error", verb: "alias" });
    // Case-insensitive: the name is lowercased before the check.
    expect(parsePlain("/alias ALIAS something")).toMatchObject({ kind: "error", verb: "alias" });
  });

  it("rejects a missing expansion", () => {
    expect(parsePlain("/alias wii")).toMatchObject({ kind: "error", verb: "alias" });
  });

  it("/unalias <name> removes (name lowercased)", () => {
    expect(parsePlain("/unalias WII")).toEqual({ kind: "unalias", name: "wii" });
  });

  it("bare /unalias errors with usage", () => {
    expect(parsePlain("/unalias")).toMatchObject({ kind: "error", verb: "unalias" });
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
    expect(expandAlias("a", "x", keysOf({ a: "cmd $10" }))).toEqual({ verb: "cmd", rest: "x0" });
  });

  it("adjacent placeholders $1$2 concatenate", () => {
    expect(expandAlias("a", "foo bar", keysOf({ a: "cmd $1$2" }))).toEqual({
      verb: "cmd",
      rest: "foobar",
    });
  });

  it("a $ not followed by a digit/star is literal → no-placeholder append", () => {
    // `$x` is not a placeholder, so the template has NONE → rest is appended.
    expect(expandAlias("e", "foo", keysOf({ e: "echo $x" }))).toEqual({
      verb: "echo",
      rest: "$x foo",
    });
  });

  it("$* with empty rest collapses to nothing", () => {
    expect(expandAlias("s", "", keysOf({ s: "msg #c $*" }))).toEqual({ verb: "msg", rest: "#c" });
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
    expect(expandAlias("k", "spammer go away and stay away", keysOf({ k: "kick $1 $2-" }))).toEqual(
      {
        verb: "kick",
        rest: "spammer go away and stay away",
      },
    );
  });

  it("$2- is not $2: the tail is whole, not truncated to one word", () => {
    // Pre-#1047 this yielded "#chan hello-" ($2 substituted, `-` left literal).
    expect(expandAlias("mm", "#chan hello there world", keysOf({ mm: "msg $1 $2-" }))).toEqual({
      verb: "msg",
      rest: "#chan hello there world",
    });
  });

  it("$1- and $* cover the same args and differ ONLY in spacing normalisation", () => {
    const rest = "one   two \t three";
    expect(expandAlias("a", rest, keysOf({ a: "cmd $1-" }))).toEqual({
      verb: "cmd",
      rest: "one two three",
    });
    expect(expandAlias("a", rest, keysOf({ a: "cmd $*" }))).toEqual({
      verb: "cmd",
      rest: "one   two \t three",
    });
  });

  it("an out-of-range $N- expands to the empty string (silent, matching $N)", () => {
    // Only two args, so `$5-` has nothing to join — no error, no literal left.
    expect(expandAlias("a", "one two", keysOf({ a: "cmd $1 $5-" }))).toEqual({
      verb: "cmd",
      rest: "one",
    });
  });

  it("$N- with no args at all is silently empty", () => {
    expect(expandAlias("a", "", keysOf({ a: "cmd $1-" }))).toEqual({ verb: "cmd", rest: "" });
  });

  it("$9- reaches the ninth argument and its tail", () => {
    const rest = "a1 a2 a3 a4 a5 a6 a7 a8 a9 a10 a11";
    expect(expandAlias("a", rest, keysOf({ a: "cmd $9-" }))).toEqual({
      verb: "cmd",
      rest: "a9 a10 a11",
    });
  });

  it("a template whose ONLY placeholder is $N- suppresses the verbatim append", () => {
    // The no-placeholder rule appends the rest; `$3-` must count as a
    // placeholder or `/a x y z` would expand to `cmd z x y z`.
    expect(expandAlias("a", "x y z", keysOf({ a: "cmd $3-" }))).toEqual({ verb: "cmd", rest: "z" });
  });

  it("$N- is greedy over a following literal dash", () => {
    // mIRC/irssi shape: the `-` binds to the placeholder, never to the text
    // after it. `$1-tail` is "all args" then "tail", not "$1" then "-tail".
    expect(expandAlias("a", "x y", keysOf({ a: "cmd $1-tail" }))).toEqual({
      verb: "cmd",
      rest: "x ytail",
    });
  });

  it("$10 is still $1 then a literal 0 (the range dash didn't widen the digits)", () => {
    expect(expandAlias("a", "x", keysOf({ a: "cmd $10" }))).toEqual({ verb: "cmd", rest: "x0" });
    expect(expandAlias("a", "x y", keysOf({ a: "cmd $1-0" }))).toEqual({
      verb: "cmd",
      rest: "x y0",
    });
  });

  it("end-to-end: an alias with $N- reaches DISPATCH with the whole reason", () => {
    expect(
      parseSlash(
        "/k spammer go away and stay away",
        keysOf({ k: "kick $1 $2-" }),
        DEFAULT_CHANTYPES,
      ),
    ).toEqual({
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
    expect(parsePlain("/ctcp bob version")).toEqual({
      kind: "ctcp",
      target: "bob",
      verb: "VERSION",
      args: "",
    });
  });

  it("/ctcp <target> <verb> <args> uppercases verb, preserves arg case + spaces", () => {
    expect(parsePlain("/ctcp #chan action waves at Everyone")).toEqual({
      kind: "ctcp",
      target: "#chan",
      verb: "ACTION",
      args: "waves at Everyone",
    });
  });

  it("/ctcp bare → error (target + verb required)", () => {
    expect(parsePlain("/ctcp")).toEqual({
      kind: "error",
      verb: "ctcp",
      message: "/ctcp requires a target and a verb",
    });
  });

  it("/ctcp <target> with no verb → error", () => {
    expect(parsePlain("/ctcp bob")).toEqual({
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
    expect(parsePlain("/ping bob")).toEqual({ kind: "ping", target: "bob" });
  });

  it("/ping bare → error (target required)", () => {
    expect(parsePlain("/ping")).toEqual({
      kind: "error",
      verb: "ping",
      message: "/ping requires a target",
    });
  });

  it("/ping <target> <extra> ignores trailing tokens", () => {
    expect(parsePlain("/ping bob junk here")).toEqual({ kind: "ping", target: "bob" });
  });
});

// #431 — /ame and /amsg: the mIRC "say it in every channel" pair. The parser's
// whole job is the body; WHICH channels, the confirm gate and the pacing all
// live in compose.ts (this module stays pure — no store reads).
describe("parseSlash — /ame + /amsg fan-out (#431)", () => {
  it("/ame <text> parses to {kind:'ame', body}", () => {
    expect(parsePlain("/ame waves at everyone")).toEqual({
      kind: "ame",
      body: "waves at everyone",
    });
  });

  it("/amsg <text> parses to {kind:'amsg', body}", () => {
    expect(parsePlain("/amsg back in ten")).toEqual({ kind: "amsg", body: "back in ten" });
  });

  // Unlike /me (whose empty body is a legal, if pointless, one-window ACTION),
  // an empty fan-out is N empty frames the send door refuses one at a time.
  it("bare /ame → error (a body is required)", () => {
    expect(parsePlain("/ame")).toEqual({
      kind: "error",
      verb: "ame",
      message: "/ame requires a message",
    });
  });

  it("bare /amsg → error (a body is required)", () => {
    expect(parsePlain("/amsg")).toEqual({
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
    expect(parseSlash("/ame hello", keysOf({ ame: "me" }), DEFAULT_CHANTYPES)).toEqual({
      kind: "me",
      body: "hello",
    });
  });
});

// #1255 — the parser used to hardcode the RFC 2812 sigil class, so on a
// network advertising `CHANTYPES=#` it read `&foo` as a channel and built a
// JOIN the ircd refuses. The sigils now arrive as DATA, the same way the
// alias map does, so the parser stays pure and the answer stays per-network.
describe("parseSlash — network-advertised CHANTYPES (#1255)", () => {
  const HASH_ONLY = ["#"];

  it("defaults to the RFC class when no sigils are passed (pre-005 behaviour)", () => {
    // Every one of the 200-odd pure call sites in this file relies on this:
    // absent sigils must mean exactly what the literal used to mean.
    expect(parsePlain("/part &local bye")).toEqual({
      kind: "part",
      channel: "&local",
      reason: "bye",
    });
  });

  it("/part treats an unadvertised sigil as the start of the reason", () => {
    // The #1043 shape: `/part` with a non-channel first token must NOT
    // manufacture a channel — it parts the current window with that text as
    // the reason. On a `CHANTYPES=#` network, `&local` is not a channel.
    expect(parseSlash("/part &local bye", noKeys(), HASH_ONLY)).toEqual({
      kind: "part",
      channel: null,
      reason: "&local bye",
    });
  });

  it("/part still recognises an advertised sigil", () => {
    expect(parseSlash("/part #italia bye", noKeys(), HASH_ONLY)).toEqual({
      kind: "part",
      channel: "#italia",
      reason: "bye",
    });
  });

  // #1796 — `/cycle` answers the per-network question the same way `/part`
  // does, because it is the same arm. Pinned separately anyway: "they share an
  // arm" is an implementation detail, and a future split that gave `/cycle` a
  // hardcoded sigil class would pass every test above this one.
  it("/cycle treats an unadvertised sigil as the start of the message", () => {
    expect(parseSlash("/cycle &local bye", noKeys(), HASH_ONLY)).toEqual({
      kind: "cycle",
      channel: null,
      reason: "&local bye",
    });
  });

  it("/cycle still recognises an advertised sigil", () => {
    expect(parseSlash("/cycle #italia bye", noKeys(), HASH_ONLY)).toEqual({
      kind: "cycle",
      channel: "#italia",
      reason: "bye",
    });
  });

  it("/join auto-prepends # to a name wearing an unadvertised sigil", () => {
    // `&local` is a bare name on this network, so it takes the same sugar a
    // bare `sniffo` takes rather than being passed through as a channel.
    expect(parseSlash("/join &local", noKeys(), HASH_ONLY)).toEqual({
      kind: "join",
      channels: ["#&local"],
      key: null,
    });
  });

  it("/topic reads an advertised sigil as the explicit channel, and an unadvertised one as body", () => {
    expect(parseSlash("/topic #italia ciao", noKeys(), HASH_ONLY)).toEqual({
      kind: "topic-set",
      channel: "#italia",
      text: "ciao",
    });
    expect(parseSlash("/topic &local ciao", noKeys(), HASH_ONLY)).toEqual({
      kind: "topic-set",
      channel: null,
      text: "&local ciao",
    });
  });

  it("/mode reads an unadvertised sigil as a target nick, not a channel", () => {
    expect(parseSlash("/mode &local +s", noKeys(), HASH_ONLY)).toEqual({
      kind: "mode",
      target: "&local",
      modes: "+s",
      params: [],
    });
  });

  it("/mode keeps `+` out of the channel set even when the network advertises it", () => {
    // Not the network disagreeing with the RFC: `+` is claimed by the
    // mode-sign disambiguation, so `+s` stays a mode string on a network
    // whose CHANTYPES contains `+`. Removing the filter makes `+s` a channel.
    expect(parseSlash("/mode +s", noKeys(), ["#", "+"])).toEqual({
      kind: "mode-apply-current",
      modes: "+s",
      params: [],
    });
  });
});

describe("parseSlash — /np (#1698)", () => {
  it("takes no arguments", () => {
    expect(parsePlain("/np")).toEqual({ kind: "np" });
  });

  it("ignores trailing tokens rather than erroring on them", () => {
    // The no-arg family's posture (`/info`, `/version`): there is nothing a
    // second token could mean, and refusing one buys the operator a scolding
    // instead of the line they asked for.
    expect(parsePlain("/np right now")).toEqual({ kind: "np" });
  });

  it("stays a plain privmsg behind the literal-slash escape", () => {
    // `//np` is how the operator says "the text /np", per the mIRC escape the
    // parser already implements. A new verb must not steal it.
    expect(parsePlain("//np")).toEqual({ kind: "privmsg", body: "/np" });
  });

  it("can be shadowed by a user alias, like every builtin but /alias", () => {
    // #427's rule, checked on the new verb rather than assumed to apply: the
    // non-shadowable set is a FIXED two names, and /np is not one of them.
    expect(parseSlash("/np", keysOf({ np: "me is listening" }), DEFAULT_CHANTYPES)).toEqual({
      kind: "me",
      body: "is listening",
    });
  });
});

// issue 2428 — /clear: wipe the submitting window's scrollback. No
// arguments, no wire: the target comes from the submission context and the
// row count from the server, so the parser carries nothing.
describe("parseSlash — /clear (issue 2428)", () => {
  it("takes no arguments", () => {
    expect(parsePlain("/clear")).toEqual({ kind: "clear" });
  });

  it("ignores trailing tokens rather than erroring on them", () => {
    // The no-arg family's posture: there is nothing a second token could mean.
    expect(parsePlain("/clear please")).toEqual({ kind: "clear" });
    expect(parsePlain("/CLEAR")).toEqual({ kind: "clear" });
  });

  it("stays a plain privmsg behind the literal-slash escape", () => {
    expect(parsePlain("//clear")).toEqual({ kind: "privmsg", body: "/clear" });
  });

  it("can be shadowed by a user alias, like every builtin but /alias", () => {
    expect(parseSlash("/clear", keysOf({ clear: "me bye" }), DEFAULT_CHANTYPES)).toEqual({
      kind: "me",
      body: "bye",
    });
  });
});

// issue 2584 — what "the verb" of a line is, asked by the parser, by the
// command counter (which posts the verb AS TYPED, before any alias expands)
// and nowhere else: one rule, so the count and the dispatch cannot disagree.
describe("splitSlash (issue 2584)", () => {
  it("splits a command line into the verb as typed and the rest", () => {
    expect(splitSlash("/WhoIs vjt")).toEqual({ verb: "WhoIs", rest: "vjt" });
    expect(splitSlash("  /ns identify secret  ")).toEqual({ verb: "ns", rest: "identify secret" });
    expect(splitSlash("/me\tdances")).toEqual({ verb: "me", rest: "dances" });
    expect(splitSlash("/away")).toEqual({ verb: "away", rest: "" });
    expect(splitSlash("/")).toEqual({ verb: "", rest: "" });
  });

  it("is null for a line that is not a command", () => {
    expect(splitSlash("hello")).toBeNull();
    expect(splitSlash("//me literal")).toBeNull();
    expect(splitSlash("")).toBeNull();
    expect(splitSlash("   ")).toBeNull();
  });
});

describe("BUILTIN_VERBS (issue 2584)", () => {
  it("is every verb the dispatcher answers, aliases of builtins included", () => {
    for (const verb of BUILTIN_VERBS) {
      expect(parsePlain(`/${verb}`)).not.toMatchObject({ message: `unknown command: /${verb}` });
    }
    expect(BUILTIN_VERBS).toEqual(expect.arrayContaining(["whois", "w", "raw", "kickban", "j"]));
    expect(new Set(BUILTIN_VERBS).size).toBe(BUILTIN_VERBS.length);
  });

  it("names no verb the dispatcher does not answer", () => {
    expect(BUILTIN_VERBS).not.toContain("notarealverbatall");
    expect(parsePlain("/notarealverbatall")).toMatchObject({ kind: "error" });
  });
});
