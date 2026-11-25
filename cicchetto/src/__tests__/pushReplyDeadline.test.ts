import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPLY_DEADLINE_MS } from "../lib/transportFailure";

// issue 2738 — every client→server push that expects an answer must SETTLE,
// answer or not. Before the cure 26 of the 30 promise helpers had no
// `timeout` arm: phoenix.js ends a push that gets no reply ONLY by firing its
// "timeout" hooks, so a helper with none stayed pending forever, and the
// composer awaiting it at the head of the #904 outbox stayed locked until a
// reload.
//
// These cases run the REAL phoenix (1.8.x, the pinned client) against a fake
// WebSocket, not a mocked `Push`: what is being pinned is phoenix's own push
// semantics, so a phoenix upgrade that changes them goes red here. The fake
// answers `phx_join` and `heartbeat` and DROPS every other client frame — the
// half-open socket / stalled server the issue describes.

type Frame = [string | null, string | null, string, string, unknown];

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState: number = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  readonly sent: Frame[] = [];

  constructor(url: string | URL, _protocols?: string | string[]) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Frame;
    this.sent.push(frame);
    const [joinRef, ref, topic, event] = frame;
    if (event === "phx_join" || event === "heartbeat") {
      const reply: Frame = [joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }];
      this.onmessage?.({ data: JSON.stringify(reply) });
    }
    // Anything else: no reply, ever.
  }

  // The link dies under the client (not a clean close it asked for).
  drop(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1006, reason: "", wasClean: false });
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  events(): string[] {
    return this.sent.map((f) => f[3]);
  }
}

type Socket = typeof import("../lib/socket");
// The failure classes as socket.ts sees them: `vi.resetModules` hands every
// test a fresh module graph, so a class imported at the top of this file is a
// different constructor from the one socket.ts throws.
type Failures = typeof import("../lib/transportFailure");

// One case per promise helper. The guard below fails if socket.ts grows a
// `push*` export that is in neither this table nor FIRE_AND_FORGET, so a new
// helper cannot skip the question.
const REPLY_HELPERS: Record<string, (s: Socket) => Promise<unknown>> = {
  pushAwaySet: (s) => s.pushAwaySet("azzurra", "lunch"),
  pushAwayUnset: (s) => s.pushAwayUnset("azzurra"),
  pushChannelOp: (s) => s.pushChannelOp(1, "#grappa", ["alice"]),
  pushChannelDeop: (s) => s.pushChannelDeop(1, "#grappa", ["alice"]),
  pushChannelVoice: (s) => s.pushChannelVoice(1, "#grappa", ["alice"]),
  pushChannelDevoice: (s) => s.pushChannelDevoice(1, "#grappa", ["alice"]),
  pushChannelKick: (s) => s.pushChannelKick(1, "#grappa", "alice", "out"),
  pushChannelBan: (s) => s.pushChannelBan(1, "#grappa", "*!*@spam.example"),
  pushChannelUnban: (s) => s.pushChannelUnban(1, "#grappa", "*!*@spam.example"),
  resolveUserhost: (s) => s.resolveUserhost(1, "alice"),
  pushChannelInvite: (s) => s.pushChannelInvite(1, "#grappa", "alice"),
  pushChannelUmode: (s) => s.pushChannelUmode(1, "+i"),
  pushChannelMode: (s) => s.pushChannelMode(1, "#grappa", "+m", []),
  pushChannelTopicClear: (s) => s.pushChannelTopicClear(1, "#grappa"),
  pushOper: (s) => s.pushOper(1, "vjt", "hunter2"),
  pushRaw: (s) => s.pushRaw(1, "VERSION"),
  pushWhois: (s) => s.pushWhois(1, "alice", null, "user"),
  pushWhowas: (s) => s.pushWhowas(1, "alice"),
  pushWho: (s) => s.pushWho(1, "#grappa"),
  pushLusers: (s) => s.pushLusers(1, null, null),
  pushInfo: (s) => s.pushInfo(1),
  pushVersion: (s) => s.pushVersion(1),
  pushMotd: (s) => s.pushMotd(1, null),
  pushAdmin: (s) => s.pushAdmin(1, null),
  pushLinks: (s) => s.pushLinks(1, null),
  pushRecover: (s) => s.pushRecover(1),
  pushNames: (s) => s.pushNames(1, "#grappa"),
  pushWatchlistAdd: (s) => s.pushWatchlistAdd("grappa"),
  pushWatchlistDel: (s) => s.pushWatchlistDel("grappa"),
  pushWatchlistList: (s) => s.pushWatchlistList(),
};

// The pushes nobody awaits (vjt's D5: open/close query window are NAMED here;
// whether they grow a listener is issue 2741's call).
const FIRE_AND_FORGET = ["pushOpenQueryWindow", "pushCloseQueryWindow", "pushChannelBanlist"];

type Outcome = { state: "pending" } | { state: "resolved" } | { state: "rejected"; error: unknown };

function track(p: Promise<unknown>): { now: () => Outcome } {
  let outcome: Outcome = { state: "pending" };
  p.then(
    () => {
      outcome = { state: "resolved" };
    },
    (error: unknown) => {
      outcome = { state: "rejected", error };
    },
  );
  return { now: () => outcome };
}

async function joinedUserChannel(): Promise<{ socket: Socket; tf: Failures; ws: FakeWebSocket }> {
  localStorage.setItem("grappa-token", "tok-2738");
  const socket = await import("../lib/socket");
  const tf = await import("../lib/transportFailure");
  socket.joinUser("vjt");
  const ws = FakeWebSocket.instances.at(-1);
  if (ws === undefined) throw new Error("socket.ts never dialled the WebSocket");
  ws.open();
  expect(ws.events()).toContain("phx_join");
  return { socket, tf, ws };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("issue 2738 — a push the server never answers settles at REPLY_DEADLINE_MS", () => {
  it.each(Object.entries(REPLY_HELPERS))(
    "%s rejects NoReply at the deadline",
    async (_name, call) => {
      const { socket, tf, ws } = await joinedUserChannel();
      const sentBefore = ws.sent.length;

      const p = track(call(socket));
      // The frame really went out: this is "sent and unanswered", not "never sent".
      expect(ws.sent.length).toBe(sentBefore + 1);

      // Still waiting just short of the deadline — the client does not give up
      // before the server's own longest bounded wait (D1, N4).
      await vi.advanceTimersByTimeAsync(REPLY_DEADLINE_MS - 1);
      expect(p.now()).toEqual({ state: "pending" });

      await vi.advanceTimersByTimeAsync(1);
      const outcome = p.now();
      expect(outcome.state).toBe("rejected");
      if (outcome.state !== "rejected") return;
      expect(outcome.error).toBeInstanceOf(tf.NoReply);
      expect((outcome.error as InstanceType<Failures["NoReply"]>).deadlineMs).toBe(
        REPLY_DEADLINE_MS,
      );
    },
  );

  it("every push* export is either awaited (and in the table above) or named fire-and-forget", async () => {
    localStorage.setItem("grappa-token", "tok-2738");
    const socket = await import("../lib/socket");
    const pushExports = Object.keys(socket).filter(
      (k) => /^push[A-Z]/.test(k) || k === "resolveUserhost",
    );
    expect(new Set(pushExports)).toEqual(
      new Set([...Object.keys(REPLY_HELPERS), ...FIRE_AND_FORGET]),
    );
  });

  it("a push with no user channel rejects NotConnected at once", async () => {
    const socket = await import("../lib/socket");
    const tf = await import("../lib/transportFailure");
    await expect(socket.pushRaw(1, "VERSION")).rejects.toBeInstanceOf(tf.NotConnected);
  });
});

describe("issue 2738 — a push made while the link is down", () => {
  it("rejects NoReply at the deadline, and is NOT sent late when the channel rejoins", async () => {
    const { socket, tf, ws } = await joinedUserChannel();
    ws.drop();

    // The channel is errored, so phoenix BUFFERS the push — with its timer
    // already running.
    const p = track(socket.pushRaw(1, "KICK #grappa alice"));
    await vi.advanceTimersByTimeAsync(REPLY_DEADLINE_MS);
    const outcome = p.now();
    expect(outcome.state).toBe("rejected");
    if (outcome.state !== "rejected") return;
    expect(outcome.error).toBeInstanceOf(tf.NoReply);

    // phoenix's reconnect dialled a fresh socket meanwhile; let it open and
    // the channel rejoin. A push that already timed out must not go out now,
    // minutes after the operator was told it may not have.
    const next = FakeWebSocket.instances.at(-1);
    expect(next).toBeDefined();
    expect(next).not.toBe(ws);
    next?.open();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(next?.events()).toContain("phx_join");
    expect(next?.events()).not.toContain("raw");
  });
});
