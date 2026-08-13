// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { addQuoteCommand, addQuoteToCompose } from "../lib/addQuote";
import type { ScrollbackMessage } from "../lib/api";
import { channelKey } from "../lib/channelKey";
import { getDraft, setDraft } from "../lib/compose";
import { replyQuote } from "../lib/replyQuote";

// #1107 — the `!addquote` menu item: it drops `!addquote ` plus the message
// text into the compose box and stops there. cic never sends it and never
// interprets it; whatever bot sits in the channel does.
//
// THE PAYLOAD CARRIES THE SENDER, in the form the scrollback rendered — #1264
// reverses #1107's bare-body ruling. `<nick> body` for speech, `* nick body`
// for an action: what gets quoted is what the operator READ. There is still no
// `<< ` tail, which belongs to Reply and not to an archive.
//
// The reversed rule is pinned by its own assertion below, as the old one was,
// so the next reshaping has to trip over it rather than reword a string.

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

describe("addQuoteCommand", () => {
  it("prefixes the bot command and the sender's nick", () => {
    expect(addQuoteCommand(msg({}))).toBe("!addquote <vjt> ciao mondo");
  });

  // #1264's ruling, pinned on its own — the inverse of the assertion #1107 put
  // here. Co-killed with the shape above by a bare-body implementation, and
  // kept for the same reason the old one was: the attribution is the POINT of
  // the payload, not an incidental part of the string.
  it("carries the sender — the payload is never the bare body", () => {
    expect(addQuoteCommand(msg({ sender: "vjt", body: "ciao mondo" }))).toContain("vjt");
  });

  // The two kinds differ in the HEAD, and both heads are the ones the
  // scrollback renders — that equivalence is the whole ruling, so it is
  // asserted against `replyQuote`'s head rather than against a literal that
  // could drift away from it silently.
  it("gives an action the rendered `* nick` head, not `<nick>`", () => {
    expect(
      addQuoteCommand(msg({ kind: "action", body: "\x01ACTION pees over the fence\x01" })),
    ).toBe("!addquote * vjt pees over the fence");
  });

  it("heads the payload exactly as Reply heads its quote", () => {
    for (const kind of ["privmsg", "notice", "action"] as const) {
      const body = kind === "action" ? "\x01ACTION waves\x01" : "waves";
      const head = replyQuote(msg({ kind, body }))?.split(" waves")[0];
      expect(addQuoteCommand(msg({ kind, body }))).toBe(`!addquote ${head} waves`);
    }
  });

  // The wire body can carry mIRC control bytes (\x02 bold, \x03 colour…). The
  // operator is quoting what they SEE, and a control byte round-tripped through
  // compose would be re-sent as formatting they never chose.
  it("strips mIRC control codes out of the quoted body", () => {
    expect(addQuoteCommand(msg({ body: "\x02bold\x02 plain" }))).toBe("!addquote <vjt> bold plain");
  });

  it("refuses a presence row", () => {
    expect(addQuoteCommand(msg({ kind: "join", body: null }))).toBeNull();
  });

  // The arm above is VACUOUS with respect to the content-kind gate, measured:
  // deleting `isContentKind` from `quotableBody` leaves it green, because a
  // JOIN's null body is refused one line later by the empty-body check. A PART
  // is the row that separates them — it carries its reason in `body`, so only
  // the kind gate stands between `!addquote Leaving` and the quote database.
  it("refuses a PART even though it carries a reason in its body", () => {
    expect(addQuoteCommand(msg({ kind: "part", body: "Leaving" }))).toBeNull();
  });

  it("refuses a row whose body is empty or whitespace", () => {
    expect(addQuoteCommand(msg({ body: "" }))).toBeNull();
    expect(addQuoteCommand(msg({ body: "   " }))).toBeNull();
    expect(addQuoteCommand(msg({ body: null }))).toBeNull();
  });

  // Same posture as Reply: an authorless content row is not somebody being
  // quoted, so the item stays disabled rather than producing an orphan quote.
  it("refuses a row with no sender", () => {
    expect(addQuoteCommand(msg({ sender: "" }))).toBeNull();
  });

  it("quotes a notice like speech — it has an author and a body", () => {
    expect(addQuoteCommand(msg({ kind: "notice" }))).toBe("!addquote <vjt> ciao mondo");
  });

  // An action's stored body is the raw `\x01ACTION …\x01` wire form (the
  // CLAUDE.md "preserved as-is" rule). `mircPlainText` deliberately leaves \x01
  // alone, so without the unwrap both delimiters and the verb would ride into
  // the compose box — the #1126 defect, at a second door.
  it("unwraps a CTCP action down to its text", () => {
    expect(addQuoteCommand(msg({ kind: "action", body: "\x01ACTION si dà alla fuga\x01" }))).toBe(
      "!addquote * vjt si dà alla fuga",
    );
  });

  // The protocol half of the same defect, asserted separately: a \x01 we
  // generated inside an ordinary PRIVMSG. Co-killed with the shape above by a
  // missing unwrap, kept because it is the byte-level statement.
  it("leaves no \\x01 and no ACTION verb in the command", () => {
    const cmd = addQuoteCommand(msg({ kind: "action", body: "\x01ACTION waves\x01" })) ?? "";
    expect(cmd).not.toContain("\x01");
    expect(cmd).not.toContain("ACTION");
  });

  it("refuses an action whose envelope is empty", () => {
    expect(addQuoteCommand(msg({ kind: "action", body: "\x01ACTION \x01" }))).toBeNull();
  });

  // #1123's rule, inherited: the body being quoted may itself be a reply,
  // carrying the quote it answered plus the `<< ` tail. Quoting the whole hop
  // into a quote DATABASE is worse than into a reply — the stored quote would
  // attribute someone else's line to this sender forever.
  it("drops a previous reply-quote out of the body", () => {
    expect(addQuoteCommand(msg({ sender: "alice", body: "<bob> original<< answer" }))).toBe(
      "!addquote <alice> answer",
    );
  });

  it("refuses a body that is only a previous reply-quote", () => {
    expect(addQuoteCommand(msg({ sender: "alice", body: "<bob> original<< " }))).toBeNull();
  });

  // `<<` is ordinary text and must not be mistaken for a quote tail.
  it("leaves a shift expression alone", () => {
    expect(addQuoteCommand(msg({ body: "shift << 2 gives four" }))).toBe(
      "!addquote <vjt> shift << 2 gives four",
    );
  });
});

describe("addQuoteToCompose", () => {
  it("fills an empty compose with exactly the command", () => {
    mountCompose();
    addQuoteToCompose(msg({}), NET, CHAN);
    expect(getDraft(KEY)).toBe("!addquote <vjt> ciao mondo");
  });

  // Never destroy work in progress: the command lands AFTER what is already
  // there, the same posture Reply takes.
  it("does not clobber an existing draft", () => {
    mountCompose();
    setDraft(KEY, "bozza ");
    addQuoteToCompose(msg({}), NET, CHAN);
    expect(getDraft(KEY)).toBe("bozza !addquote <vjt> ciao mondo");
  });

  it("writes nothing for an unquotable row", () => {
    mountCompose();
    addQuoteToCompose(msg({ kind: "part", body: null }), NET, CHAN);
    expect(getDraft(KEY)).toBe("");
  });

  // The caret must land at the END and be REVEALED: `!addquote ` plus a body
  // overflows the rows=1 textarea essentially every time, which is why #1107
  // waited on #1105/#1113.
  //
  // A `selectionStart` assertion alone is VACUOUS here, measured: jsdom already
  // parks the caret at the end of a freshly assigned `value`, so it stays green
  // with the reveal deleted from `appendToCompose`. jsdom does no layout either
  // — `scrollHeight` is 0 on every element — so the overflow is stubbed, which
  // is what makes the scroll ASSIGNMENT observable. That a real engine then
  // shows the caret is the e2e's job, not this one's.
  it("reveals the caret by scrolling the overflowing textarea", async () => {
    const ta = mountCompose();
    Object.defineProperty(ta, "scrollHeight", { value: 75, configurable: true });
    setDraft(KEY, "x".repeat(110));
    addQuoteToCompose(msg({}), NET, CHAN);
    ta.value = getDraft(KEY);
    await Promise.resolve();
    expect(ta.scrollTop).toBe(75);
    expect(document.activeElement).toBe(ta);
  });
});
