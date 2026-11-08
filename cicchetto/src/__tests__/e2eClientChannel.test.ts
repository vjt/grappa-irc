// issue 2430 — the E2E client's channel steps over a fake grappa v2
// (`helpers/e2eClients.ts`): the real engines, identity sync, account and
// chat stores over in-memory twins of IndexedDB and Web Locks, grappa's
// REST mocked at the api module and answered by the fake — extended here
// with channels (`helpers/e2eGrappa.ts`'s `joinChannel`), so a channel
// `:msg` fans out to every member's listed devices with the folded
// channel named, own on the sender's own devices.
//
// The roster the client audits against is the test's own: each side's
// `ctx.channelMembers` reads it, as the members store would in the app.
// The protocol version is the module signal (`serverProtocol.ts`): 63
// unless a test sets it lower.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetServerProtocolForTests,
  setServerProtocol,
} from "../lib/serverProtocol";
import {
  chat,
  inboxOf,
  latestGrappa,
  pair,
} from "./helpers/e2eClients";
import { routeApi } from "./helpers/e2eGrappa";
import { olm } from "./helpers/olm";

vi.mock("../lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/api")>();
  return {
    ApiError: real.ApiError,
    registerE2eDevice: vi.fn(),
    listE2eDevices: vi.fn(),
    removeE2eDevice: vi.fn(),
    getE2eList: vi.fn(),
    putE2eList: vi.fn(),
    getE2eDeviceKeys: vi.fn(),
    uploadE2eDeviceKeys: vi.fn(),
    listE2eDeviceInbox: vi.fn(),
    ackE2eDeviceInbox: vi.fn(),
    sendE2e: vi.fn(),
    clearE2eKeys: vi.fn(),
    claimE2eDeviceKeys: vi.fn(),
    copyE2e: vi.fn(),
  };
});
// The identity sync's module reads the page's login; these tests hand it
// everything it needs as arguments.
vi.mock("../lib/auth", () => ({ token: () => null }));
vi.mock("../lib/networks", () => ({ user: () => null, networks: () => undefined }));
vi.mock("../lib/e2e/olm", () => ({ loadOlm: async () => olm() }));

const api = await import("../lib/api");

beforeEach(() => {
  routeApi(api, () => latestGrappa());
  setServerProtocol(63);
});

afterEach(() => {
  __resetServerProtocolForTests();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

const CHANNEL = "#grappa";

/** The roster, as the members store would hold it, shared by every side. */
function rosterFor(members: string[]): (channel: string) => string[] | undefined {
  const roster = new Map([[CHANNEL, members]]);
  return (channel) => roster.get(channel);
}

describe("e2eClient channel", () => {
  it("sends to the channel under a new epoch, and the member drains it and reads it", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    w.grappa.joinChannel(CHANNEL, a.nick);
    w.grappa.joinChannel(CHANNEL, b.nick);
    const roster = rosterFor(["alice", "Bob"]);
    a.ctx.channelMembers = roster;
    b.ctx.channelMembers = roster;

    const before = w.grappa.sends.length;
    const sent = await a.client.sendChannel(a.ctx, CHANNEL, "ciao a tutti", ["alice", "Bob"]);
    expect(sent.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_rotated", reason: "created" }),
      expect.objectContaining({ kind: "channel_key_sent", to: "Bob" }),
    ]);
    // The key goes pairwise first, then the one channel message.
    const after = w.grappa.sends.slice(before);
    expect(after.filter((s) => s.target === CHANNEL)).toHaveLength(1);
    expect(after.at(-1)).toEqual(expect.objectContaining({ target: CHANNEL, to: "*" }));
    expect(after.some((s) => s.target === "Bob")).toBe(true);

    const read = await b.client.drain(b.ctx);
    expect(read.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_key_received", from: "alice" }),
      expect.objectContaining({
        kind: "channel_received",
        from: "alice",
        counter: 0,
        body: "ciao a tutti",
      }),
    ]);
    expect(await inboxOf(w, b)).toEqual([]);

    // Our own channel message comes back to our own devices, and the
    // drain skips it: the send path already showed it.
    const own = await a.client.drain(a.ctx);
    expect(own.channelE2e).toBeUndefined();
    expect(await inboxOf(w, a)).toEqual([]);
  });

  it("a join or part on a channel with no epoch mints nothing", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    w.grappa.joinChannel(CHANNEL, a.nick);
    w.grappa.joinChannel(CHANNEL, b.nick);
    const roster = rosterFor(["alice", "Bob"]);
    a.ctx.channelMembers = roster;
    b.ctx.channelMembers = roster;
    const before = w.grappa.sends.length;

    const joined = await a.client.channelMembersChanged(a.ctx, CHANNEL, "carol", null, [
      "alice",
      "Bob",
      "carol",
    ]);
    expect(joined.channelE2e).toBeUndefined();
    const left = await a.client.channelMembersChanged(a.ctx, CHANNEL, null, "carol", [
      "alice",
      "Bob",
    ]);
    expect(left.channelE2e).toBeUndefined();
    expect(w.grappa.sends.length).toBe(before);
  });

  it("a join on an encrypted channel sends nothing: the newcomer asks with a key request", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    w.grappa.joinChannel(CHANNEL, a.nick);
    w.grappa.joinChannel(CHANNEL, b.nick);
    const roster = rosterFor(["alice", "Bob"]);
    a.ctx.channelMembers = roster;
    b.ctx.channelMembers = roster;
    await a.client.sendChannel(a.ctx, CHANNEL, "ciao a tutti", ["alice", "Bob"]);
    const before = w.grappa.sends.length;

    const joined = await a.client.channelMembersChanged(a.ctx, CHANNEL, "carol", null, [
      "alice",
      "Bob",
      "carol",
    ]);
    expect(joined.channelE2e).toBeUndefined();
    expect(w.grappa.sends.length).toBe(before);
  });

  it("a leave rotates the epoch, the remaining member reads on, the departed one cannot", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    const c = await w.join("carol");
    await chat(a, c);
    for (const side of [a, b, c]) w.grappa.joinChannel(CHANNEL, side.nick);
    const roster = rosterFor(["alice", "Bob", "carol"]);
    for (const side of [a, b, c]) side.ctx.channelMembers = roster;

    await a.client.sendChannel(a.ctx, CHANNEL, "ciao a tutti", ["alice", "Bob", "carol"]);
    await b.client.drain(b.ctx);
    await c.client.drain(c.ctx);

    // Alice is the folded-nick-first remaining holder, so she rotates.
    const left = await a.client.channelMembersChanged(a.ctx, CHANNEL, null, "Bob", [
      "alice",
      "carol",
    ]);
    expect(left.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_rotated", reason: "member-left" }),
      expect.objectContaining({ kind: "channel_key_sent", to: "carol" }),
    ]);
    await c.client.drain(c.ctx);

    await a.client.sendChannel(a.ctx, CHANNEL, "dopo l'addio", ["alice", "carol"]);
    const carolRead = await c.client.drain(c.ctx);
    expect(carolRead.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_received", body: "dopo l'addio" }),
    ]);
    // The transport still delivers to Bob here — the epoch is what locks
    // him out, not the delivery: he holds the old epoch, the new message
    // names a new sid.
    const bobRead = await b.client.drain(b.ctx);
    expect(bobRead.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_undecryptable", reason: "no-session" }),
    ]);
  });

  it("a refused channel message is reported, not lost", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    w.grappa.joinChannel(CHANNEL, a.nick);
    w.grappa.joinChannel(CHANNEL, b.nick);
    const roster = rosterFor(["alice", "Bob"]);
    a.ctx.channelMembers = roster;
    b.ctx.channelMembers = roster;
    w.grappa.refuse = (o) => (o.target === CHANNEL ? "refused" : undefined);

    const sent = await a.client.sendChannel(a.ctx, CHANNEL, "ciao a tutti", ["alice", "Bob"]);
    expect(sent.channelE2e).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "channel_key_sent", to: "Bob" }),
        expect.objectContaining({
          kind: "channel_dropped",
          channel: CHANNEL,
          reason: "send-refused",
          detail: "refused",
        }),
      ]),
    );
  });

  it("a refused gkey DM is a failed key, not a sent one", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    w.grappa.joinChannel(CHANNEL, a.nick);
    w.grappa.joinChannel(CHANNEL, b.nick);
    const roster = rosterFor(["alice", "Bob"]);
    a.ctx.channelMembers = roster;
    b.ctx.channelMembers = roster;
    w.grappa.refuse = (o) => (o.target === "Bob" ? "refused" : undefined);

    const sent = await a.client.sendChannel(a.ctx, CHANNEL, "ciao a tutti", ["alice", "Bob"]);
    expect(sent.channelE2e).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "channel_key_failed", to: "Bob", reason: "refused" }),
      ]),
    );
    expect(sent.channelE2e).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "channel_key_sent" })]),
    );
  });

  it("below protocol 63 no channel line is attempted", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    w.grappa.joinChannel(CHANNEL, a.nick);
    w.grappa.joinChannel(CHANNEL, b.nick);
    const roster = rosterFor(["alice", "Bob"]);
    a.ctx.channelMembers = roster;
    b.ctx.channelMembers = roster;
    setServerProtocol(62);
    const before = w.grappa.sends.length;

    const sent = await a.client.sendChannel(a.ctx, CHANNEL, "ciao a tutti", ["alice", "Bob"]);
    expect(sent.channelE2e).toEqual([
      { kind: "channel_dropped", channel: CHANNEL, reason: "protocol-too-old" },
    ]);
    const asked = await b.client.requestChannelKey(b.ctx, CHANNEL);
    expect(asked.channelE2e).toEqual([
      { kind: "channel_dropped", channel: CHANNEL, reason: "protocol-too-old" },
    ]);
    expect(w.grappa.sends.length).toBe(before);
  });

  it("a newcomer asks for the key on the channel, and a holder answers it", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    w.grappa.joinChannel(CHANNEL, a.nick);
    const roster = rosterFor(["alice"]);
    a.ctx.channelMembers = roster;
    b.ctx.channelMembers = roster;
    await a.client.sendChannel(a.ctx, CHANNEL, "ciao a tutti", ["alice"]);

    w.grappa.joinChannel(CHANNEL, b.nick);
    const before = w.grappa.sends.length;
    const asked = await b.client.requestChannelKey(b.ctx, CHANNEL);
    expect(asked.channelE2e).toEqual([{ kind: "channel_key_requested", channel: CHANNEL }]);
    expect(w.grappa.sends.slice(before).map((s) => [s.target, s.to])).toEqual([[CHANNEL, "*"]]);

    const answered = await a.client.drain(a.ctx);
    expect(answered.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_key_sent", to: "Bob" }),
    ]);
    const keyed = await b.client.drain(b.ctx);
    expect(keyed.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_key_received", from: "alice" }),
    ]);

    await a.client.sendChannel(a.ctx, CHANNEL, "ora mi leggi", ["alice", "Bob"]);
    const read = await b.client.drain(b.ctx);
    expect(read.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_received", body: "ora mi leggi" }),
    ]);
  });

  it("the audit rotates when a holder left while every cic was closed", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    w.grappa.joinChannel(CHANNEL, a.nick);
    w.grappa.joinChannel(CHANNEL, b.nick);
    const roster = rosterFor(["alice", "Bob"]);
    a.ctx.channelMembers = roster;
    b.ctx.channelMembers = roster;
    await a.client.sendChannel(a.ctx, CHANNEL, "ciao a tutti", ["alice", "Bob"]);

    const fresh = await a.client.auditChannelEpoch(a.ctx, CHANNEL, ["alice", "Bob"]);
    expect(fresh.channelE2e).toBeUndefined();
    const stale = await a.client.auditChannelEpoch(a.ctx, CHANNEL, ["alice"]);
    expect(stale.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_rotated", reason: "member-left" }),
    ]);
  });
});
