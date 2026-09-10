import { describe, expect, it } from "vitest";
import type { MessageKind, ScrollbackMessage } from "../lib/api";
import {
  countsAsUnreadEvent,
  countsAsUnreadMessage,
  isOperatorOwnedRow,
  type UnreadMeasurement,
  type UnreadRowContext,
  unreadMessagesAfter,
} from "../lib/unreadCount";

// issue 2069 — the contract both unread surfaces are built on.
//
// The sidebar pill and the in-pane divider used to spell this out separately
// and had drifted three ways, in both directions, measured on `b7989f4ba` over
// four fixtures. Those four fixtures are the four describes below, and each
// one is a row class where the two surfaces disagreed:
//
//   fixture                      pill      divider
//   150 rows, 113 msg + 37 JOIN  113       "150 unread messages"
//   5 peer msgs + 5 own msgs     5         "10 unread messages"
//   5 numeric-derived NOTICEs    5         no marker at all
//   50 peer JOINs                (0 msgs)  "50 unread messages"
//
// Pinning them HERE rather than once per surface is the point: a fourth
// consumer inherits the answer instead of re-deriving a fifth.

const CASEMAPPING = "ascii" as const;

const ctxFor = (overrides: Partial<UnreadRowContext>): UnreadRowContext => ({
  ownNick: "vjt",
  casemapping: CASEMAPPING,
  isSelfWindow: false,
  ...overrides,
});

const CTX = ctxFor({});

const row = (
  id: number,
  kind: MessageKind,
  sender: string,
  meta: Record<string, unknown> = {},
): ScrollbackMessage => ({
  id,
  network: "azzurra",
  channel: "#grappa",
  server_time: id,
  kind,
  sender,
  body: `m${id}`,
  meta,
});

/** ids `from`..`to`, every 4th a peer JOIN — the mixed log of the report. */
const mixedRun = (from: number, to: number): ScrollbackMessage[] => {
  const out: ScrollbackMessage[] = [];
  for (let id = from; id <= to; id++) out.push(row(id, id % 4 === 0 ? "join" : "privmsg", "bob"));
  return out;
};

describe("issue 2069 — which rows count as an unread MESSAGE", () => {
  it("counts a peer's message", () => {
    expect(countsAsUnreadMessage(row(1, "privmsg", "bob"), CTX)).toBe(true);
    expect(countsAsUnreadMessage(row(2, "action", "bob"), CTX)).toBe(true);
  });

  it("counts a peer NOTICE — services chatter is real traffic", () => {
    // No `meta.numeric`: a NickServ greeting or another user's /notice is
    // unsolicited, and the only thing separating it from a reply to the
    // operator's own verb is that field.
    expect(countsAsUnreadMessage(row(3, "notice", "NickServ"), CTX)).toBe(true);
  });

  it("does NOT count a peer's presence row", () => {
    // The divider counted these under a label that says "messages"; the pill
    // never did. The pill was right, and the label is what says so.
    for (const kind of ["join", "part", "quit", "nick_change", "mode", "kick"] as const) {
      expect(countsAsUnreadMessage(row(4, kind, "carol"), CTX)).toBe(false);
    }
  });

  it("does NOT count the operator's OWN message outside the self window", () => {
    // #576 — a line you typed is read by definition.
    expect(countsAsUnreadMessage(row(5, "privmsg", "vjt"), CTX)).toBe(false);
    // The fold is the network's, not a byte compare (#372/#1861).
    expect(countsAsUnreadMessage(row(6, "privmsg", "VJT"), CTX)).toBe(false);
  });

  it("DOES count the operator's own message in the SELF window", () => {
    // #396 — `/msg <ownnick>` is a note-to-self, and its payload is the point.
    // Mirrors the server's `self_window?` carve-out.
    expect(countsAsUnreadMessage(row(7, "privmsg", "vjt"), ctxFor({ isSelfWindow: true }))).toBe(
      true,
    );
  });

  it("does NOT count a numeric-derived NOTICE — the operator asked for it", () => {
    // The one class where the PILL was the wrong surface: `notice` is a
    // content kind, so the derived badge counted a 401 the operator's own
    // `/msg <ghost>` produced. `subscribe.ts` still gates on this predicate,
    // but its gate stopped reaching the badge when the badge became derived.
    expect(countsAsUnreadMessage(row(8, "notice", "irc.azzurra.org", { numeric: 401 }), CTX)).toBe(
      false,
    );
  });

  it("treats every operator-owned class the same way", () => {
    expect(isOperatorOwnedRow(row(9, "privmsg", "vjt"), CTX)).toBe(true);
    expect(isOperatorOwnedRow(row(10, "join", "vjt"), CTX)).toBe(true);
    expect(isOperatorOwnedRow(row(11, "notice", "srv", { numeric: 401 }), CTX)).toBe(true);
    expect(isOperatorOwnedRow(row(12, "privmsg", "bob"), CTX)).toBe(false);
    expect(isOperatorOwnedRow(row(13, "join", "carol"), CTX)).toBe(false);
  });

  it("has no opinion when the own nick is unknown", () => {
    // Pre-login / a network not yet in the store. `nickEquals` is null-safe
    // and the answer must be "count it", not "exclude everything".
    const anon = ctxFor({ ownNick: null });
    expect(countsAsUnreadMessage(row(14, "privmsg", "vjt"), anon)).toBe(true);
    expect(isOperatorOwnedRow(row(15, "join", "vjt"), anon)).toBe(false);
  });
});

describe("issue 2069 — the EVENTS bucket is the same rule, other side", () => {
  it("counts a peer's presence row and no message", () => {
    expect(countsAsUnreadEvent(row(1, "join", "carol"), CTX)).toBe(true);
    expect(countsAsUnreadEvent(row(2, "privmsg", "bob"), CTX)).toBe(false);
  });

  it("does NOT count the operator's own presence row", () => {
    // A `/part → /join` cycle used to bump the faint pill by two: the badge is
    // derived from the store, and `subscribe.ts`'s own-presence gate has not
    // reached it since that change.
    expect(countsAsUnreadEvent(row(3, "part", "vjt"), CTX)).toBe(false);
    expect(countsAsUnreadEvent(row(4, "join", "vjt"), CTX)).toBe(false);
  });

  it("splits the two buckets with no row in both and none in neither", () => {
    // The property that makes "messages + events" a partition of the rows the
    // operator did not cause — which is what lets the two pills be read
    // together without double-counting.
    const rows = [
      ...mixedRun(1, 40),
      row(41, "privmsg", "vjt"),
      row(42, "join", "vjt"),
      row(43, "notice", "srv", { numeric: 366 }),
      row(44, "notice", "NickServ"),
    ];
    for (const r of rows) {
      const m = countsAsUnreadMessage(r, CTX);
      const e = countsAsUnreadEvent(r, CTX);
      expect(m && e).toBe(false);
      expect(m || e).toBe(!isOperatorOwnedRow(r, CTX));
    }
  });
});

describe("issue 2069 — counting the region after a cursor", () => {
  // The reported fixture: 150 rows past the cursor, 113 of them messages.
  const rows = mixedRun(951, 1150);

  it("answers in the CONTENT unit, which is what the label claims", () => {
    expect(unreadMessagesAfter(rows, 1000, null, undefined, CTX)).toBe(113);
  });

  it("honours an upper bound — the divider's frozen session top", () => {
    // Rows past the freeze are live-read by definition and must not renumber
    // the line under a reader. The pill passes `null` here for the opposite
    // reason: it is the live answer.
    // ids 1001..1100 is 100 rows, 25 of them JOINs (every fourth) → 75.
    expect(unreadMessagesAfter(rows, 1000, 1100, undefined, CTX)).toBe(75);
  });

  it("spends a server measurement the pane cannot answer from its rows", () => {
    // Symptom B: the pane holds one page out of thousands. Counting the rows
    // reports the fetch page.
    const measured: UnreadMeasurement = { at: 1000, count: 3750, through: 1150 };
    expect(unreadMessagesAfter(rows, 1000, null, measured, CTX)).toBe(3750);
  });

  it("subtracts what the cursor has read, instead of discarding the answer", () => {
    // The step that used to drop the count to the page size and then to zero.
    const measured: UnreadMeasurement = { at: 1000, count: 3750, through: 1150 };
    // The cursor walked 1000 → 1100, which is 75 messages of the measured
    // region (the same 75 as the bounded arm above), so 3675 remain.
    expect(unreadMessagesAfter(rows, 1100, null, measured, CTX)).toBe(3675);
  });

  it("stands the measurement down past the run the pane can account for", () => {
    // An own send lands the cursor at the tip, past thousands of rows the pane
    // never held: nothing local can say how much of the region it consumed, so
    // the record must stop answering rather than subtract only what it holds.
    const measured: UnreadMeasurement = { at: 1000, count: 3750, through: 1150 };
    expect(unreadMessagesAfter(rows, 9000, null, measured, CTX)).toBe(0);
  });

  it("ignores a measurement anchored above the cursor", () => {
    const measured: UnreadMeasurement = { at: 1100, count: 3750, through: 1150 };
    expect(unreadMessagesAfter(rows, 1000, null, measured, CTX)).toBe(113);
  });

  it("lets local truth overtake the measurement once the region is back", () => {
    // A FLOOR, not a replacement: no separate retirement to remember.
    const measured: UnreadMeasurement = { at: 1000, count: 10, through: 1150 };
    expect(unreadMessagesAfter(rows, 1000, null, measured, CTX)).toBe(113);
  });

  it("never answers negative", () => {
    const measured: UnreadMeasurement = { at: 950, count: 1, through: 1150 };
    expect(unreadMessagesAfter(rows, 1150, null, measured, CTX)).toBe(0);
  });

  it("counts nothing in a window whose unread run is all peer presence", () => {
    const presenceOnly = [
      row(1000, "privmsg", "bob"),
      ...Array.from({ length: 50 }, (_, i) => row(1001 + i, "join", `peer${i}`)),
    ];
    expect(unreadMessagesAfter(presenceOnly, 1000, null, undefined, CTX)).toBe(0);
  });
});
