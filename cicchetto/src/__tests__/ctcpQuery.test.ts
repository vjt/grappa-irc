import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";

// Boundary stubs. The seam's whole job is WHICH two calls it makes and in WHAT
// ORDER, so both collaborators are spies: the send door (scrollback.sendMessage,
// whose own REST plumbing is pinned in scrollback.test.ts) and the correlation
// store (pingCorrelation's two registers — the token-keyed one for PING and the
// verb-keyed one for everything else — whose matching rules are pinned in
// pingCorrelation.test.ts).
vi.mock("../lib/scrollback", () => ({
  sendMessage: vi.fn(),
}));

vi.mock("../lib/pingCorrelation", () => ({
  registerPing: vi.fn(),
  resolvePing: vi.fn(),
  registerCtcpQuery: vi.fn(),
  resolveCtcpReply: vi.fn(),
}));

// The invariant fields of a dispatch. `verb` / `args` are supplied per test —
// they are the axis under test.
const QUERY = {
  networkSlug: "freenode",
  networkId: 1,
  sourceChannel: "#a",
  targetNick: "bob",
  sentAtMs: 1706743200000,
};

describe("sendCtcpQuery — #1192", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The shape every verb shares: the frame is echoed in the SOURCE window (the
  // one the operator is looking at) with the wire recipient in the 4th
  // `ctcpTarget` arg — the #640 contract that keeps a control-surface probe from
  // minting a query window for the peer.
  it("frames a non-PING verb into the SOURCE window with the recipient in ctcpTarget", async () => {
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();
    const { sendCtcpQuery } = await import("../lib/ctcpQuery");

    await sendCtcpQuery({ ...QUERY, verb: "VERSION", args: "" });

    expect(sb.sendMessage).toHaveBeenCalledWith("freenode", "#a", "\x01VERSION\x01", {
      kind: "ctcp",
      target: "bob",
    });
  });

  // #719 — a non-PING verb registers too, in the VERB-keyed table, against the
  // SOURCE window. Without this the question echoed in one window and the answer
  // rendered in $server. The ping table must stay out of it: its key is a token,
  // and a verb landing there would be claimable by any reply echoing that string.
  it("registers a non-PING verb in the VERB table, keyed on the source window", async () => {
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();
    const pc = await import("../lib/pingCorrelation");
    const { sendCtcpQuery } = await import("../lib/ctcpQuery");

    await sendCtcpQuery({ ...QUERY, verb: "VERSION", args: "" });

    expect(pc.registerCtcpQuery).toHaveBeenCalledWith(
      1,
      "bob",
      "VERSION",
      channelKey("freenode", "#a"),
      "#a",
      1706743200000,
    );
    expect(pc.registerPing).not.toHaveBeenCalled();
  });

  // The converse: PING keys on its token and must NOT also take a verb entry, or
  // a peer's PING reply could be claimed twice — once for the RTT, once as a
  // plain re-keyed row.
  it("registers a PING in the token table only, never the verb table", async () => {
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();
    const pc = await import("../lib/pingCorrelation");
    const { sendCtcpQuery } = await import("../lib/ctcpQuery");

    await sendCtcpQuery({ ...QUERY, verb: "PING", args: "tok-719" });

    expect(pc.registerPing).toHaveBeenCalled();
    expect(pc.registerCtcpQuery).not.toHaveBeenCalled();
  });

  // #600's ordering is the seam's whole reason to exist, and it now has to hold
  // on the branch #719 added — not just on the PING branch it was written for.
  // A VERSION reply comes back on the already-open WS just as readily.
  it("registers a non-PING verb BEFORE the send resolves", async () => {
    const sb = await import("../lib/scrollback");
    const pc = await import("../lib/pingCorrelation");
    let releaseSend!: () => void;
    vi.mocked(sb.sendMessage).mockReturnValue(
      new Promise<void>((resolve) => {
        releaseSend = resolve;
      }),
    );
    const { sendCtcpQuery } = await import("../lib/ctcpQuery");

    const inFlight = sendCtcpQuery({ ...QUERY, verb: "VERSION", args: "" });
    await Promise.resolve();
    await Promise.resolve();

    expect(sb.sendMessage).toHaveBeenCalled();
    expect(pc.registerCtcpQuery).toHaveBeenCalled();

    releaseSend();
    await inFlight;
  });

  // Args are the caller's bytes, passed through untouched — the seam is not a
  // parser. `\x01VERB args\x01`, one space, no re-quoting.
  it("carries args into the frame verbatim", async () => {
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();
    const { sendCtcpQuery } = await import("../lib/ctcpQuery");

    await sendCtcpQuery({ ...QUERY, verb: "CLIENTINFO", args: "PING TIME" });

    expect(sb.sendMessage).toHaveBeenCalledWith("freenode", "#a", "\x01CLIENTINFO PING TIME\x01", {
      kind: "ctcp",
      target: "bob",
    });
  });

  // PING correlates. The token is the caller's `args` — opaque to this seam and
  // to the store — and the pending entry is keyed on the SOURCE window so the
  // RTT line lands where the operator asked the question.
  it("registers a PING against the source window, keyed on the caller's token", async () => {
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();
    const pc = await import("../lib/pingCorrelation");
    const { sendCtcpQuery } = await import("../lib/ctcpQuery");

    // A token that is deliberately NOT the timestamp. `/ping` happens to mint
    // `String(Date.now())`, and asserting against that value here would let a
    // seam that ignored the caller and re-read the clock pass anyway.
    await sendCtcpQuery({ ...QUERY, verb: "PING", args: "tok-591" });

    expect(pc.registerPing).toHaveBeenCalledWith(
      1,
      "bob",
      "tok-591",
      channelKey("freenode", "#a"),
      "#a",
      1706743200000,
    );
  });

  // A BARE ping — what a menu item sends, and what `/ctcp bob PING` has always
  // put on the wire. The seam must NOT mint a token to make correlation easier
  // for itself: `/ctcp` is the raw escape hatch and has to send the bytes the
  // operator asked for. Correlation still works, through the #637 token-less
  // fallback (the peer echoes a bare `\x01PING\x01`, which resolves the empty
  // token).
  it("sends a bare PING unframed by an invented token, and still registers it", async () => {
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();
    const pc = await import("../lib/pingCorrelation");
    const { sendCtcpQuery } = await import("../lib/ctcpQuery");

    await sendCtcpQuery({ ...QUERY, verb: "PING", args: "" });

    expect(sb.sendMessage).toHaveBeenCalledWith("freenode", "#a", "\x01PING\x01", {
      kind: "ctcp",
      target: "bob",
    });
    expect(pc.registerPing).toHaveBeenCalledWith(
      1,
      "bob",
      "",
      channelKey("freenode", "#a"),
      "#a",
      1706743200000,
    );
  });

  // The verb reaches this seam from two directions — a parser that upper-cases
  // (slashCommands) and a menu that passes a literal. Fold before the comparison
  // so a lower-cased PING is still a PING; the alternative is a silently
  // uncorrelated ping whose reply falls out in $server.
  it("correlates a lower-cased ping verb", async () => {
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();
    const pc = await import("../lib/pingCorrelation");
    const { sendCtcpQuery } = await import("../lib/ctcpQuery");

    await sendCtcpQuery({ ...QUERY, verb: "ping", args: "tok" });

    expect(pc.registerPing).toHaveBeenCalled();
  });

  // #600 — the ordering this seam exists to make unloseable.
  //
  // `sendMessage` is a REST POST. Its ack can resolve AFTER the peer's CTCP PING
  // reply has already been processed on the separate, already-open WS. If the
  // registration waited on the send, `maybeConsumeCtcpReply → resolvePing` would
  // find no pending entry and drop the RTT — the deterministic CI timeout #600
  // diagnosed, invisible on a fast local box. compose.ts got this right by hand;
  // a second caller (the #1192 nick menu) is exactly how a hand-held invariant
  // drifts, which is why the ordering now lives HERE and not at the call sites.
  //
  // Modelled with a send that never settles: if registration is behind the
  // await, these assertions run against zero calls.
  it("registers the pending BEFORE the send resolves", async () => {
    const sb = await import("../lib/scrollback");
    const pc = await import("../lib/pingCorrelation");
    let releaseSend!: () => void;
    vi.mocked(sb.sendMessage).mockReturnValue(
      new Promise<void>((resolve) => {
        releaseSend = resolve;
      }),
    );
    const { sendCtcpQuery } = await import("../lib/ctcpQuery");

    const inFlight = sendCtcpQuery({ ...QUERY, verb: "PING", args: "tok" });
    // Flush microtasks so the seam reaches — and blocks on — the send await.
    await Promise.resolve();
    await Promise.resolve();

    expect(sb.sendMessage).toHaveBeenCalled();
    expect(pc.registerPing).toHaveBeenCalled();

    releaseSend();
    await inFlight;
  });
});
