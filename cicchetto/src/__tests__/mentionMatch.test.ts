import { describe, expect, it } from "vitest";
import { isMentionableSender, isMentionRow, isOwnRow, matchesWatchlist } from "../lib/mentionMatch";

// #370 — `matchesWatchlist` is the SINGLE client-side match predicate for
// the in-message visual highlight (ScrollbackPane `.scrollback-mention` /
// `.scrollback-highlight`, MentionsWindow) AND the notify mirror
// (pushTriggers `mentioned`). It mirrors the server SSOT
// `Grappa.Mentions.mentioned?/3` = own nick ∪ custom highlight patterns,
// word-boundary, case-insensitive.
//
// The #370 bug was that the visual path only ever received the own nick —
// so a message matching a custom /hilight word fired the (server-side)
// notification but rendered as a plain line. These cases pin the extended
// contract: a custom pattern matches exactly like the own nick does.

describe("matchesWatchlist — own nick ∪ custom highlight patterns (#370)", () => {
  it("matches the own nick at a word boundary (own-nick path unchanged)", () => {
    expect(matchesWatchlist("hey vjt around?", "vjt", [])).toBe(true);
    expect(matchesWatchlist("VJT ping", "vjt", [])).toBe(true);
  });

  it("respects word boundaries for the own nick (no substring match)", () => {
    expect(matchesWatchlist("vjtfoo bar", "vjt", [])).toBe(false);
  });

  it("matches a CUSTOM highlight pattern even when the own nick is absent", () => {
    // The #370 gap: this returned false before patterns were threaded in.
    expect(matchesWatchlist("the deploy is done", "vjt", ["deploy"])).toBe(true);
  });

  it("is case-insensitive on a custom pattern", () => {
    expect(matchesWatchlist("DEPLOY finished", "vjt", ["deploy"])).toBe(true);
  });

  it("respects word boundaries for a custom pattern (no substring match)", () => {
    // "deployment" contains "deploy" but is a different word.
    expect(matchesWatchlist("deployment scheduled", "vjt", ["deploy"])).toBe(false);
  });

  it("matches any one of several patterns", () => {
    expect(matchesWatchlist("ship it", "vjt", ["deploy", "ship", "release"])).toBe(true);
  });

  it("does not match when neither the nick nor any pattern is present", () => {
    expect(matchesWatchlist("just chatting here", "vjt", ["deploy"])).toBe(false);
  });

  it("is false for an empty body regardless of patterns", () => {
    expect(matchesWatchlist("", "vjt", ["deploy"])).toBe(false);
    expect(matchesWatchlist(null, "vjt", ["deploy"])).toBe(false);
  });

  it("tolerates a null own nick and matches on patterns alone", () => {
    // A not-yet-resolved own nick must not blank out custom-word highlights.
    expect(matchesWatchlist("the deploy is done", null, ["deploy"])).toBe(true);
  });

  it("is false when both the nick is null and there are no patterns", () => {
    expect(matchesWatchlist("anything at all", null, [])).toBe(false);
  });
});

// #1786 — a term whose own edge is punctuation could never match, because both
// ports wrapped every term in `\b…\b` unconditionally.
//
// `\b` is a TRANSITION between a word char and a non-word one. On `QUACK!` the
// trailing `\b` therefore demands a word character immediately AFTER the `!`,
// which end-of-line and a space both fail — so the term was inert. Found in
// prod: a whole watchlist of `["QUACK!","flap!","quack!"]`, listed as active by
// the settings pane and silently matching nothing, forever.
//
// The cure makes each anchor conditional on the term's OWN edge: `\b` where the
// edge character is a word char (it is satisfiable there), a lookaround where
// it is not. THE TRUTH TABLE BELOW IS SHARED with `test/grappa/mentions_test.exs`
// — a case added here without its server twin is exactly how the two ports
// drift, which is the failure `mentionMatch.ts`'s own header exists to prevent.
describe("matchesWatchlist — a punctuated edge still anchors (#1786)", () => {
  it("matches a term ending in punctuation, mid-line and at end of body", () => {
    expect(matchesWatchlist("say QUACK! now", null, ["QUACK!"])).toBe(true);
    expect(matchesWatchlist("QUACK!", null, ["QUACK!"])).toBe(true);
  });

  it("matches a term starting in punctuation — a command-prefix highlight", () => {
    expect(matchesWatchlist("!list please", null, ["!list"])).toBe(true);
    expect(matchesWatchlist("!list", null, ["!list"])).toBe(true);
  });

  it("matches a term punctuated at BOTH edges", () => {
    expect(matchesWatchlist("run (deploy) now", null, ["(deploy)"])).toBe(true);
  });

  // ── the two discriminating cases ────────────────────────────────────────
  // Everything above passes just as well if the anchor is DROPPED on a
  // punctuated edge instead of replaced by a lookaround. These two do not:
  // they are the only cases that can tell "not glued to a word" from "no rule
  // at all", and without them the cheap wrong fix ships green.
  it("does not match a punctuation-led term glued to the end of a word", () => {
    expect(matchesWatchlist("foo!list", null, ["!list"])).toBe(false);
  });

  it("does not match a punctuation-tailed term glued to the start of a word", () => {
    expect(matchesWatchlist("QUACK!x", null, ["QUACK!"])).toBe(false);
  });

  // ── the rule that must NOT move ─────────────────────────────────────────
  it("still refuses a substring match on a word-edged term", () => {
    expect(matchesWatchlist("vjt123 is here", "vjt", [])).toBe(false);
    expect(matchesWatchlist("QUACKING!", null, ["QUACK!"])).toBe(false);
  });

  it("still escapes regex metacharacters rather than honouring them", () => {
    // `5+1` is word-edged at BOTH ends, so both anchors stay `\b` — the
    // conditional must not disturb the terms that already worked.
    expect(matchesWatchlist("got 5+1 alerts", "vjt", ["5+1"])).toBe(true);
    expect(matchesWatchlist("got 555 alerts", "vjt", ["5+1"])).toBe(false);
  });
});

// issue 1908 — a colour code glued to the term deletes the boundary the term
// needs, so a watchlist keyword never matches a bot that colours its output.
//
// The defect is NOT "control bytes in the body". `\x02` and friends carry no
// arguments and are not word characters, so `\b` still has its transition on
// both sides of the term — measured in the field on `rex`, a bold-only bot
// whose 139 bold lines match fine. It is specifically the COLOUR byte dragging
// its numeric arguments into the text: `\x03` `1` `5` before `QUACK` reads to
// the regex as `...15QUACK`, and the digits ARE word characters.
//
// The cure is a projection, not an anchor change: match against
// `mircPlainText(body)`, the SAME `parseMircFormat` the render uses, so there
// is no second stripper to drift from. The #1786 anchor rule is untouched.
//
// THE TRUTH TABLE BELOW IS SHARED with `test/grappa/mentions_test.exs` — a
// case added here without its server twin is exactly how the two ports drift,
// and here that drift would put the visual highlight and the OS push back into
// disagreement, which is the divergence #370 closed.
describe("matchesWatchlist — mIRC formatting is stripped before matching (1908)", () => {
  it("matches through a colour code glued to the term — the field case", () => {
    // The duck bot's real body: \x03 1 5 immediately before the Q.
    expect(matchesWatchlist("\x0315QUACK!", null, ["QUACK"])).toBe(true);
  });

  it("strips every colour-code spelling from the report", () => {
    for (const args of ["04", "4", "04,01", "99", "00"]) {
      expect(matchesWatchlist(`\x03${args}QUACK!`, null, ["QUACK"])).toBe(true);
    }
  });

  it("leaves a bare colour byte harmless, as it already was", () => {
    expect(matchesWatchlist("\x03QUACK!", null, ["QUACK"])).toBe(true);
  });

  it("keeps matching the plain line from the same bot — no regression", () => {
    expect(matchesWatchlist("\\o< *quack* The duck waddles away safely.", null, ["QUACK"])).toBe(
      true,
    );
  });

  it("keeps bold harmless: the contrast bot matches on every edge", () => {
    const body = "Title: \x02Merry Sky Weather Forecast\x02";
    for (const term of ["Merry", "Weather", "Forecast"]) {
      expect(matchesWatchlist(body, null, [term])).toBe(true);
    }
  });

  it("removes the argument-free attribute bytes too", () => {
    expect(matchesWatchlist("\x0fQUACK!", null, ["QUACK"])).toBe(true);
  });

  // ── the discriminating case ────────────────────────────────────────────
  // Everything above also passes if the "cure" were to loosen the anchor
  // instead of stripping. This one does not: after a genuine strip the body is
  // `QUACK!`, so a term that includes the colour ARGUMENTS must now MISS. A
  // loosened anchor would keep matching it against the raw bytes.
  it("strips rather than loosening — a term spelling the colour args now misses", () => {
    expect(matchesWatchlist("\x0315QUACK!", null, ["15QUACK"])).toBe(false);
  });

  // ── the rules that must NOT move ───────────────────────────────────────
  it("keeps the #1786 discriminating pair, formatted or not", () => {
    expect(matchesWatchlist("foo!list", null, ["!list"])).toBe(false);
    expect(matchesWatchlist("\x0315foo!list", null, ["!list"])).toBe(false);
  });

  it("still refuses a substring match on a formatted body", () => {
    expect(matchesWatchlist("\x0315QUACKING!", null, ["QUACK!"])).toBe(false);
  });

  it("does not remove digits that are real text", () => {
    // The projection consumes digits only as colour ARGUMENTS.
    expect(matchesWatchlist("15 ducks seen", null, ["15"])).toBe(true);
  });
});

// #1674 — the SENDER half of the mention rule. Mirror of
// `Grappa.Mentions.mentionable_sender?/1`. Keyed on the sender because
// neither of the alternatives survives: excluding `:notice` silences a
// human `/notice`, and excluding `$server` misses the service's own query
// window, which over-counted identically (measured server-side).
describe("isMentionableSender — a robot cannot mention you (#1674)", () => {
  it("excludes services and the server", () => {
    expect(isMentionableSender("NickServ")).toBe(false);
    expect(isMentionableSender("chanserv")).toBe(false);
    expect(isMentionableSender("nightwish.azzurra.chat")).toBe(false);
  });

  it("keeps every other sender", () => {
    expect(isMentionableSender("bob")).toBe(true);
    // Closed allowlist: real ops nicks merely ending in "serv" stay
    // mentionable (bucket H/S4 regression guard).
    expect(isMentionableSender("Conserv")).toBe(true);
  });

  it("only ever subtracts — an unclassifiable sender stays mentionable", () => {
    expect(isMentionableSender("")).toBe(true);
  });
});

// issue 1481 — the OWN-ROW half, and the row-level rule the three RENDER
// sites fold. The notify port has had this step since #532 C / #868; the
// render port decided from the body alone, so your own line naming your own
// nick highlighted itself back at you.
describe("isOwnRow — sender identity, ASCII fold (issue 1481)", () => {
  it("is true for the operator's own sender, whatever the case", () => {
    expect(isOwnRow("vjt", "vjt")).toBe(true);
    expect(isOwnRow("VJT", "vjt")).toBe(true);
    expect(isOwnRow("vjt", "VJT")).toBe(true);
  });

  it("is false for anybody else", () => {
    expect(isOwnRow("alice", "vjt")).toBe(false);
  });

  it("folds A-Z only — a bracket twin is a DIFFERENT person on bahamut", () => {
    expect(isOwnRow("foo[1]", "foo{1}")).toBe(false);
  });

  it("is false when the own nick is not resolved yet", () => {
    expect(isOwnRow("vjt", null)).toBe(false);
  });
});

describe("isMentionRow — sender conjunct AND body match (issue 1481)", () => {
  it("a peer naming you is a mention", () => {
    expect(isMentionRow({ sender: "alice", body: "hey vjt" }, "vjt", [])).toBe(true);
  });

  it("your OWN line naming your own nick is not", () => {
    expect(isMentionRow({ sender: "vjt", body: "vjt: prova" }, "vjt", [])).toBe(false);
  });

  it("your own line carrying a /hilight word is not either", () => {
    expect(isMentionRow({ sender: "vjt", body: "the deploy is done" }, "vjt", ["deploy"])).toBe(
      false,
    );
  });

  it("the sender fold is ASCII — an own line sent as VJT is still yours", () => {
    expect(isMentionRow({ sender: "VJT", body: "note to self, vjt" }, "vjt", [])).toBe(false);
  });

  it("a peer line that names nobody is still not a mention", () => {
    expect(isMentionRow({ sender: "alice", body: "hello world" }, "vjt", [])).toBe(false);
  });

  it("an unresolved own nick leaves the patterns deciding", () => {
    // `ownNick` null → no row can be "own", and `matchesWatchlist` skips the
    // falsy term, so a /hilight word still fires. Same posture as
    // `matchesWatchlist`'s own null-nick arm above.
    expect(isMentionRow({ sender: "alice", body: "the deploy is done" }, null, ["deploy"])).toBe(
      true,
    );
  });
});
