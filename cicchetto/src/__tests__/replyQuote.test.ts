// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { ScrollbackMessage } from "../lib/api";
import { channelKey } from "../lib/channelKey";
import { getDraft, setDraft } from "../lib/compose";
import { appendToCompose } from "../lib/composeAppend";
import {
  REPLY_QUOTE_BODY_LIMIT,
  REPLY_QUOTE_ELLIPSIS,
  REPLY_QUOTE_TAIL,
  replyQuote,
  replyToMessage,
} from "../lib/replyQuote";

// #1067 — the reply verb: a swipe (or the menu's Reply item) drops
// `<nick> quoted message<< ` into the compose box with the caret at the end,
// ready for the answer to be typed straight after it.

const NET = "azzurra";
const CHAN = "#grappa";
const KEY = channelKey(NET, CHAN);

function msg(over: Partial<ScrollbackMessage>): ScrollbackMessage {
  return {
    id: 1,
    network: NET,
    channel: CHAN,
    server_time: 1_700_000_000_000,
    kind: "privmsg",
    sender: "vjt",
    body: "ciao mondo",
    meta: {},
    ...over,
  } as ScrollbackMessage;
}

function mountCompose(): HTMLTextAreaElement {
  const box = document.createElement("div");
  box.className = "compose-box";
  const ta = document.createElement("textarea");
  box.appendChild(ta);
  document.body.appendChild(box);
  return ta;
}

beforeEach(() => {
  document.body.innerHTML = "";
  setDraft(KEY, "");
});

describe("replyQuote", () => {
  it("renders the irssi-shaped quote the issue specifies", () => {
    expect(replyQuote(msg({}))).toBe("<vjt> ciao mondo << ");
  });

  // The body on the wire can carry mIRC colour/bold control bytes; the operator
  // is quoting what they SEE, and a control byte pasted into compose would be
  // re-sent verbatim as formatting they never chose.
  it("strips mIRC control codes out of the quoted body", () => {
    expect(replyQuote(msg({ body: "\x02bold\x02 plain" }))).toBe("<vjt> bold plain << ");
  });

  // Presence rows (join/part/quit/mode/…) have no author speaking and often no
  // body at all — there is nothing to quote, and `<vjt> << ` is not a reply.
  it("refuses a presence row", () => {
    expect(replyQuote(msg({ kind: "join", body: null }))).toBeNull();
  });

  it("refuses a row whose body is empty or whitespace", () => {
    expect(replyQuote(msg({ body: "" }))).toBeNull();
    expect(replyQuote(msg({ body: "   " }))).toBeNull();
    expect(replyQuote(msg({ body: null }))).toBeNull();
  });

  it("refuses a row with no sender", () => {
    expect(replyQuote(msg({ sender: "" }))).toBeNull();
  });

  it("quotes a notice like speech — it has an author and a body", () => {
    expect(replyQuote(msg({ kind: "notice" }))).toBe("<vjt> ciao mondo << ");
  });

  // #1126 — a real action row carries the wire envelope (`\x01ACTION …\x01`);
  // the server stores it verbatim per the CLAUDE.md "preserved as-is" rule.
  // The pre-#1126 quote ran the raw body through `mircPlainText`, which leaves
  // \x01 alone by design, so BOTH the `ACTION` verb and the two delimiters
  // ended up in the compose box and from there onto the wire.
  it("quotes an action in ACTION form, envelope stripped — #1126", () => {
    expect(replyQuote(msg({ kind: "action", body: "\x01ACTION si dà alla fuga\x01" }))).toBe(
      "* vjt si dà alla fuga << ",
    );
  });

  // The delimiters are the protocol half of the defect: a \x01 we generated
  // inside an ordinary PRIVMSG. Asserted separately from the shape above so a
  // future reshaping of the quote cannot quietly take the guard with it.
  it("leaves no \\x01 in the quote of an action — #1126", () => {
    const quote = replyQuote(msg({ kind: "action", body: "\x01ACTION waves\x01" })) ?? "";
    expect(quote).not.toContain("\x01");
    expect(quote).not.toContain("ACTION");
  });

  // `stripCtcpAction` is deliberately defensive about a missing envelope (a
  // future server-side pre-strip, or a row persisted before the wire form was
  // stored). The action SHAPE must not depend on the envelope being there.
  it("still uses action form when the envelope is absent — #1126", () => {
    expect(replyQuote(msg({ kind: "action", body: "ciao mondo" }))).toBe("* vjt ciao mondo << ");
  });

  // An envelope with nothing inside is not a quotable action: after the strip
  // the body is empty, and `* vjt << ` is not a reply to anything.
  it("refuses an action whose envelope is empty — #1126", () => {
    expect(replyQuote(msg({ kind: "action", body: "\x01ACTION \x01" }))).toBeNull();
  });
});

// #1123 — replying to a reply used to nest: the quoted body already carried a
// quote plus its `<< ` tail, so every hop dragged the whole history forward and
// the line actually being answered ended up buried mid-string.
describe("replyQuote — a previous quote is dropped (#1123)", () => {
  it("quotes only what the sender wrote, not the quote they were answering", () => {
    expect(replyQuote(msg({ sender: "alice", body: "<bob> original<< answer" }))).toBe(
      "<alice> answer << ",
    );
  });

  // The cut is at the LAST tail, not the first: a body persisted before this
  // fix carries several hops, and stopping at the first `<< ` would keep every
  // one of them but the oldest.
  it("cuts at the last tail, not the first", () => {
    expect(
      replyQuote(msg({ sender: "carol", body: "<alice> <bob> original<< answer<< reply" })),
    ).toBe("<carol> reply << ");
  });

  // #1126 gave actions their own quote head (`* nick …`), so the client emits
  // two shapes and both nest. One bug, both doors.
  it("drops a previous action-shaped quote too", () => {
    expect(replyQuote(msg({ sender: "alice", body: "* bob waves<< sure" }))).toBe(
      "<alice> sure << ",
    );
  });

  it("drops a previous quote inside an action being quoted", () => {
    expect(
      replyQuote(
        msg({ kind: "action", sender: "alice", body: "\x01ACTION <bob> orig<< nods\x01" }),
      ),
    ).toBe("* alice nods << ");
  });

  // Every legal nick special (RFC 2812 `special` plus the tail-only dash),
  // mirroring `Grappa.IRC.Identifier`'s nick regex. A charset invented here
  // instead of derived would silently refuse to strip these.
  it("recognises a head with every legal nick special", () => {
    expect(replyQuote(msg({ sender: "alice", body: "<_a[b]\\c{d}|e^f`g-1> quoted<< mine" }))).toBe(
      "<alice> mine << ",
    );
  });

  // 30 chars is the cap the server's nick regex enforces; a head at the cap is
  // a real nick and must still be recognised.
  it("recognises a head at the 30-char nick cap", () => {
    const nick = `n${"x".repeat(29)}`;
    expect(nick).toHaveLength(30);
    expect(replyQuote(msg({ sender: "alice", body: `<${nick}> quoted<< mine` }))).toBe(
      "<alice> mine << ",
    );
  });

  // A body that is nothing BUT a previous quote leaves the sender with no words
  // of their own; `<alice> <bob> orig<<<< ` is not a reply to anything. Both
  // spellings are asserted, but they are ONE input: the body is trimmed before
  // the cut, so the tail sits flush against the end either way — which is also
  // how a wire that eats trailing whitespace delivers it.
  it("refuses a body that is only a previous quote", () => {
    expect(replyQuote(msg({ sender: "alice", body: "<bob> original<< " }))).toBeNull();
    expect(replyQuote(msg({ sender: "alice", body: "<bob> original<<" }))).toBeNull();
  });

  // The cut consumes exactly one space of the tail, so anything the sender
  // typed after a wider gap would arrive with the gap still on it.
  it("does not carry the gap after the tail into the new quote", () => {
    expect(replyQuote(msg({ sender: "alice", body: "<bob> original<<   spaced" }))).toBe(
      "<alice> spaced << ",
    );
  });
});

describe("replyQuote — what must NOT be mistaken for a quote (#1123)", () => {
  // `<<` is ordinary text: a bare substring search would eat a real message,
  // which is worse than the nesting it fixes.
  it("leaves a shift expression alone", () => {
    expect(replyQuote(msg({ body: "shift << 2 gives four" }))).toBe(
      "<vjt> shift << 2 gives four << ",
    );
  });

  it("leaves a heredoc alone", () => {
    expect(replyQuote(msg({ body: "cat <<EOF > f" }))).toBe("<vjt> cat <<EOF > f << ");
  });

  it("leaves a leading angle bracket that is not a nick head alone", () => {
    expect(replyQuote(msg({ body: "<3 you << me" }))).toBe("<vjt> <3 you << me << ");
    expect(replyQuote(msg({ body: "<two words> a << b" }))).toBe("<vjt> <two words> a << b << ");
  });

  // The head must be at position 0. `appendToCompose` drops the quote AFTER an
  // existing draft, so a mid-string quote means the leading text is the
  // sender's own words — cutting there would delete what they wrote.
  it("leaves a quote that is not at the start of the body alone", () => {
    expect(replyQuote(msg({ sender: "alice", body: "bozza <bob> ciao<< risposta" }))).toBe(
      "<alice> bozza <bob> ciao<< risposta << ",
    );
  });
});

// #1235 — vjt: "sul reply limitiamo a 42 i caratteri di cui facciamo reply, se
// sforano mettiamo un ellipsis `...`, e poi mettiamo sempre uno spazio prima
// del `<<` finale". #1277 raised that 42 to 100 — the number moved, every
// reading below did not. The cap lives in the WRAPPER, never in
// `quotableBody`: that helper is shared with `!addquote` (#1107), which
// archives the line and must keep it whole. `addQuote.test.ts` is the control
// group for that.
describe("replyQuote — the quoted body is capped (#1235, #1277)", () => {
  const AT_LIMIT = "a".repeat(REPLY_QUOTE_BODY_LIMIT);

  it("leaves a body at the limit whole, with no ellipsis", () => {
    expect(replyQuote(msg({ body: AT_LIMIT }))).toBe(`<vjt> ${AT_LIMIT} << `);
  });

  // The first body over the limit is where an off-by-one shows: one way it
  // clips a body that fits, the other it lets a 101st character through.
  it("caps the first body that overflows", () => {
    expect(replyQuote(msg({ body: `${AT_LIMIT}b` }))).toBe(`<vjt> ${AT_LIMIT}... << `);
  });

  // The 100 counts BODY characters and the ellipsis is ADDED past them — the
  // quoted run is 103, not 100 with three of them spent on dots.
  it("keeps a full 100 characters and adds the ellipsis after them", () => {
    const quote = replyQuote(msg({ body: "x".repeat(200) })) ?? "";
    const quoted = quote.slice("<vjt> ".length, -REPLY_QUOTE_TAIL.length);
    expect(quoted).toBe(`${"x".repeat(REPLY_QUOTE_BODY_LIMIT)}${REPLY_QUOTE_ELLIPSIS}`);
    expect(quoted).toHaveLength(REPLY_QUOTE_BODY_LIMIT + REPLY_QUOTE_ELLIPSIS.length);
  });

  // Hardcoded on purpose, against the constant: the request spells the marker
  // `...`, and a U+2026 that renders identically would still be a different
  // byte sequence going onto the wire.
  it("marks the overflow with three ASCII dots, not U+2026", () => {
    const quote = replyQuote(msg({ body: "x".repeat(200) })) ?? "";
    expect(quote).toContain("x...");
    expect(quote).not.toContain("…");
  });

  // A flat cut, with no backing off to the last word boundary: that is the
  // request read literally, and a word-boundary rule would make the quote
  // length depend on where the spaces happen to fall. The body is sized by
  // hand against 100 so the cut lands INSIDE the last word — a body that
  // happened to end on a space would pass under either rule.
  it("cuts flat at the limit, mid-word", () => {
    const body = `${"parola ".repeat(14)}spezzata`;
    expect(body).toHaveLength(106);
    expect(replyQuote(msg({ body }))).toBe(`<vjt> ${"parola ".repeat(14)}sp... << `);
  });

  // The cap is on the BODY: a long nick does not eat into what the sender said.
  it("does not count the nick head against the limit", () => {
    const nick = "n".repeat(30);
    expect(replyQuote(msg({ sender: nick, body: AT_LIMIT }))).toBe(`<${nick}> ${AT_LIMIT} << `);
  });

  // The cap runs AFTER the #1123 de-nesting cut, on what the sender actually
  // wrote. Capping first would spend the whole budget on the quote they were
  // answering and truncate their answer to nothing.
  it("counts what the sender wrote, not the quote they were answering", () => {
    const body = `<bob> ${"o".repeat(200)}<< breve`;
    expect(replyQuote(msg({ sender: "alice", body }))).toBe("<alice> breve << ");
  });

  // A UTF-16 slice at 100 can land between the halves of a surrogate pair and
  // emit a lone surrogate — an unpaired code unit in the compose box, and from
  // there onto the wire. The cut counts code points: the emoji is the 100th of
  // them but sits at UTF-16 indices 99 and 100, so a unit-wise `slice(0, 100)`
  // would keep its high surrogate alone.
  it("does not cut an astral character in half", () => {
    const quote = replyQuote(msg({ body: `${"a".repeat(99)}🍺x` })) ?? "";
    expect(quote).toBe(`<vjt> ${"a".repeat(99)}🍺... << `);
    expect(quote.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")).not.toMatch(/[\uD800-\uDFFF]/);
  });
});

// #1235 — the tail grew a leading space. The de-nesting regex
// (`quotableBody.ts`) is `^(?:<nick>|\* nick) [\s\S]*<<(?: |$)`, whose greedy
// head absorbs a space as happily as a word character, so the nesting cut is
// supposed to keep working on BOTH spellings. That is the one thing which would
// silently break every line already persisted, so it is asserted, not assumed.
describe("replyQuote — the spaced tail still de-nests, both spellings (#1235)", () => {
  it("strips a quote persisted with the OLD flush tail", () => {
    expect(replyQuote(msg({ sender: "alice", body: "<bob> original<< answer" }))).toBe(
      "<alice> answer << ",
    );
  });

  it("strips a quote written with the NEW spaced tail", () => {
    expect(replyQuote(msg({ sender: "alice", body: "<bob> original << answer" }))).toBe(
      "<alice> answer << ",
    );
  });

  // The full round trip: what the wrapper emits today, quoted again tomorrow.
  it("round-trips its own output", () => {
    const first = replyQuote(msg({ sender: "bob", body: "original" })) ?? "";
    expect(replyQuote(msg({ sender: "alice", body: `${first}answer` }))).toBe("<alice> answer << ");
  });

  // And the same trip on a CAPPED line, where the tail follows an ellipsis
  // rather than a word — the shape the cap makes commonplace.
  it("round-trips a capped quote", () => {
    const first = replyQuote(msg({ sender: "bob", body: "o".repeat(200) })) ?? "";
    expect(replyQuote(msg({ sender: "alice", body: `${first}answer` }))).toBe("<alice> answer << ");
  });
});

describe("appendToCompose", () => {
  it("appends to the draft and leaves the caret at the very end", async () => {
    const ta = mountCompose();
    setDraft(KEY, "gia scritto ");
    appendToCompose(NET, CHAN, "coda");
    expect(getDraft(KEY)).toBe("gia scritto coda");
    // The caret lands on the next microtask, after the controlled value commits.
    ta.value = getDraft(KEY);
    await Promise.resolve();
    expect(ta.selectionStart).toBe("gia scritto coda".length);
    expect(document.activeElement).toBe(ta);
  });

  // #1105 — the caret is placed at the end, but the rows=1 textarea is an
  // internal scroll container: a draft that wraps leaves it pinned at
  // scrollTop 0 with the caret below the fold. jsdom does no layout, so
  // `scrollHeight` is 0 on every element and a bare assertion here would pass
  // vacuously — the overflow is stubbed so this pins the assignment itself.
  // That a real viewport then shows the caret is the e2e spec's job.
  it("scrolls the overflowing textarea down to the caret", async () => {
    const ta = mountCompose();
    Object.defineProperty(ta, "scrollHeight", { value: 75, configurable: true });
    setDraft(KEY, "x".repeat(110));
    appendToCompose(NET, CHAN, "coda");
    ta.value = getDraft(KEY);
    await Promise.resolve();
    expect(ta.scrollTop).toBe(75);
  });

  it("is a no-op when no compose textarea is mounted", () => {
    setDraft(KEY, "resta");
    appendToCompose(NET, CHAN, "x");
    expect(getDraft(KEY)).toBe("resta");
  });
});

describe("replyToMessage", () => {
  it("fills an empty compose with exactly the quote", () => {
    mountCompose();
    replyToMessage(msg({}), NET, CHAN);
    expect(getDraft(KEY)).toBe("<vjt> ciao mondo << ");
  });

  // Never destroy work in progress: the quote lands AFTER what is already
  // there, so a half-typed line survives the gesture.
  it("does not clobber an existing draft", () => {
    mountCompose();
    setDraft(KEY, "bozza ");
    replyToMessage(msg({}), NET, CHAN);
    expect(getDraft(KEY)).toBe("bozza <vjt> ciao mondo << ");
  });

  it("writes nothing for an unquotable row", () => {
    mountCompose();
    replyToMessage(msg({ kind: "part", body: null }), NET, CHAN);
    expect(getDraft(KEY)).toBe("");
  });

  // #1357 — the line accumulates, the MARKER does not repeat (vjt, 2026-08-15).
  // A second reply used to bury the first tail mid-line, where `<<` reads as
  // part of the quoted text and the answer typed at the caret belongs to the
  // last quote only. The tail's own LEADING space (#1235, so it never sits
  // flush against the last word) is what separates the two quotes afterwards.
  it("keeps both quotes and moves the tail to the end", () => {
    mountCompose();
    replyToMessage(msg({ sender: "a", body: "primo" }), NET, CHAN);
    replyToMessage(msg({ id: 2, sender: "b", body: "secondo" }), NET, CHAN);
    expect(getDraft(KEY)).toBe("<a> primo <b> secondo << ");
  });

  // Stated as a COUNT rather than as a shape, because "one marker" is the
  // ruling — an implementation that emits the right string for two replies and
  // a second tail for three passes the arm above.
  it("leaves exactly one tail after N replies", () => {
    mountCompose();
    for (const sender of ["a", "b", "c"]) {
      replyToMessage(msg({ sender, body: `da ${sender}` }), NET, CHAN);
    }
    expect(getDraft(KEY)).toBe("<a> da a <b> da b <c> da c << ");
    expect(getDraft(KEY).split(REPLY_QUOTE_TAIL.trim())).toHaveLength(2);
  });

  // Acceptance criterion 3: once the operator has typed their answer, the tail
  // is no longer at the end and is no longer OURS to remove — cutting it there
  // would rewrite their sentence, and the new quote must still land after what
  // they wrote. So this line keeps two markers, deliberately: the alternative
  // is mangling text a human typed.
  it("does not touch a tail the operator has already typed past", () => {
    mountCompose();
    setDraft(KEY, "<a> primo << ciao");
    replyToMessage(msg({ sender: "b", body: "secondo" }), NET, CHAN);
    expect(getDraft(KEY)).toBe("<a> primo << ciao<b> secondo << ");
  });
});
