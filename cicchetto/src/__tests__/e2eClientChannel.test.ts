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
import { epochFor, GROUP_ROTATION_INTERVAL_MS, HELD_ROW_TTL_MS } from "../lib/e2e/groupSessions";
import { decodePayload, encodePayload } from "../lib/e2e/wire";
import { __resetServerProtocolForTests, setServerProtocol } from "../lib/serverProtocol";
import { chat, inboxOf, latestGrappa, ownOf, pair, rowsOf, SLOT } from "./helpers/e2eClients";
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

    // Bob asks for the key before Alice mints the epoch: a first epoch is
    // only imported after asking, so the ask has to come first.
    const asked = await b.client.requestChannelKey(b.ctx, CHANNEL);
    expect(asked.channelE2e).toEqual([{ kind: "channel_key_requested", channel: CHANNEL }]);
    const noAnswer = await a.client.drain(a.ctx);
    expect(noAnswer.channelE2e).toBeUndefined();

    const before = w.grappa.sends.length;
    // A first send with no epoch queues the row and asks for the key: it
    // never mints an epoch of its own, and never sends in the clear.
    const sent = await a.client.sendChannel(a.ctx, CHANNEL, "ciao a tutti", ["alice", "Bob"]);
    expect(sent.channelE2e).toEqual([
      { kind: "channel_key_missing", channel: CHANNEL },
      { kind: "channel_key_requested", channel: CHANNEL },
    ]);
    // The explicit mint distributes the key and flushes the queued row.
    const minted = await a.client.createChannelEpoch(a.ctx, CHANNEL, ["alice", "Bob"]);
    expect(minted.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_rotated", reason: "created" }),
      expect.objectContaining({ kind: "channel_key_sent", to: "Bob" }),
    ]);
    // The key goes pairwise first, then the one channel message.
    const after = w.grappa.sends.slice(before);
    expect(after.filter((s) => s.target === CHANNEL)).toHaveLength(2);
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

  it("a row queued without a key goes out when the key arrives through the drain", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    w.grappa.joinChannel(CHANNEL, a.nick);
    w.grappa.joinChannel(CHANNEL, b.nick);
    const roster = rosterFor(["alice", "Bob"]);
    a.ctx.channelMembers = roster;
    b.ctx.channelMembers = roster;

    // Alice sends with no epoch: the row waits in queue, nothing goes out
    // but the key request.
    const queued = await a.client.sendChannel(a.ctx, CHANNEL, "ciao a tutti", ["alice", "Bob"]);
    expect(queued.channelE2e).toEqual([
      { kind: "channel_key_missing", channel: CHANNEL },
      { kind: "channel_key_requested", channel: CHANNEL },
    ]);
    expect(w.grappa.sends.filter((s) => s.target === CHANNEL)).toHaveLength(1);

    // Bob mints the epoch explicitly; Alice's drain imports the key and
    // flushes the queued row under it, in the same drain.
    await b.client.createChannelEpoch(b.ctx, CHANNEL, ["alice", "Bob"]);
    const keyed = await a.client.drain(a.ctx);
    expect(keyed.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_key_received", from: "Bob" }),
    ]);
    const read = await b.client.drain(b.ctx);
    expect(read.channelE2e).toEqual([
      // Bob holds the epoch by now, so he answers Alice's key request
      // (a harmless duplicate: she already imported the key) and then
      // reads the flushed row.
      expect.objectContaining({ kind: "channel_key_sent", to: "alice" }),
      expect.objectContaining({
        kind: "channel_received",
        from: "alice",
        counter: 0,
        body: "ciao a tutti",
      }),
    ]);
    expect(await a.accounts.withAccount(SLOT, async ({ state }) => state.groups.pending)).toEqual(
      [],
    );
  });

  it("a queued row the user cancels never goes out, even once the key arrives", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    w.grappa.joinChannel(CHANNEL, a.nick);
    w.grappa.joinChannel(CHANNEL, b.nick);
    const roster = rosterFor(["alice", "Bob"]);
    a.ctx.channelMembers = roster;
    b.ctx.channelMembers = roster;

    await a.client.sendChannel(a.ctx, CHANNEL, "ciao a tutti", ["alice", "Bob"]);
    const cancelled = await a.client.cancelPendingChannelSends(a.ctx, CHANNEL);
    expect(cancelled.channelE2e).toEqual([
      {
        kind: "channel_dropped",
        channel: CHANNEL,
        reason: "send-cancelled",
        detail: "ciao a tutti",
      },
    ]);
    expect(await a.accounts.withAccount(SLOT, async ({ state }) => state.groups.pending)).toEqual(
      [],
    );

    // The key arrives later, and nothing of the cancelled row goes out:
    // Bob only answers Alice's earlier key request.
    await b.client.createChannelEpoch(b.ctx, CHANNEL, ["alice", "Bob"]);
    await a.client.drain(a.ctx);
    const read = await b.client.drain(b.ctx);
    expect(read.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_key_sent", to: "alice" }),
    ]);
    expect(w.grappa.sends.filter((s) => s.target === CHANNEL)).toHaveLength(1);
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
    await a.client.createChannelEpoch(a.ctx, CHANNEL, ["alice", "Bob"]);
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

    // Bob and Carol ask for the key before Alice mints the epoch: a first
    // epoch is only imported after asking, so the asks come first.
    await b.client.requestChannelKey(b.ctx, CHANNEL);
    await c.client.requestChannelKey(c.ctx, CHANNEL);
    const noAnswer = await a.client.drain(a.ctx);
    expect(noAnswer.channelE2e).toBeUndefined();

    await a.client.createChannelEpoch(a.ctx, CHANNEL, ["alice", "Bob", "carol"]);
    await a.client.sendChannel(a.ctx, CHANNEL, "ciao a tutti", ["alice", "Bob", "carol"]);
    await b.client.drain(b.ctx);
    await c.client.drain(c.ctx);

    // The designated rotator is the first holder did in sorted order —
    // dids are assigned by the fake grappa, so find it instead of
    // assuming Alice sorts first. The departed Bob is not among them.
    const didA = (await ownOf(a)).did;
    const didC = (await ownOf(c)).did;
    const rotator = didA < didC ? a : c;
    const other = rotator === a ? c : a;
    const left = await rotator.client.channelMembersChanged(rotator.ctx, CHANNEL, null, "Bob", [
      "alice",
      "carol",
    ]);
    expect(left.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_rotated", reason: "member-left" }),
      expect.objectContaining({ kind: "channel_key_sent", to: other.nick }),
    ]);
    await other.client.drain(other.ctx);

    await rotator.client.sendChannel(rotator.ctx, CHANNEL, "dopo l'addio", ["alice", "carol"]);
    const otherRead = await other.client.drain(other.ctx);
    expect(otherRead.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_received", body: "dopo l'addio" }),
    ]);
    // The transport still delivers to Bob here — the epoch is what locks
    // him out, not the delivery: he holds the old epoch, the new message
    // names a new sid. The row is held for a key that will never come,
    // so this drain reports nothing; once the hold expires it surfaces
    // as undecryptable.
    const bobRead = await b.client.drain(b.ctx);
    expect(bobRead.channelE2e).toBeUndefined();
    w.now += HELD_ROW_TTL_MS + 1;
    const bobExpired = await b.client.drain(b.ctx);
    expect(bobExpired.channelE2e).toEqual([
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

    const minted = await a.client.createChannelEpoch(a.ctx, CHANNEL, ["alice", "Bob"]);
    expect(minted.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_rotated", reason: "created" }),
      expect.objectContaining({ kind: "channel_key_sent", to: "Bob" }),
    ]);
    const sent = await a.client.sendChannel(a.ctx, CHANNEL, "ciao a tutti", ["alice", "Bob"]);
    expect(sent.channelE2e).toEqual(
      expect.arrayContaining([
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

    const minted = await a.client.createChannelEpoch(a.ctx, CHANNEL, ["alice", "Bob"]);
    expect(minted.channelE2e).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "channel_key_failed", to: "Bob", reason: "refused" }),
      ]),
    );
    expect(minted.channelE2e).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "channel_key_sent" })]),
    );
    const sent = await a.client.sendChannel(a.ctx, CHANNEL, "ciao a tutti", ["alice", "Bob"]);
    // The epoch exists locally even though the key never reached Bob:
    // the row goes out under it, and the send reports nothing.
    expect(sent.channelE2e).toBeUndefined();
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
    await a.client.createChannelEpoch(a.ctx, CHANNEL, ["alice"]);

    w.grappa.joinChannel(CHANNEL, b.nick);
    // The roster moves with the join: Alice answers only an asker on it.
    const joinedRoster = rosterFor(["alice", "Bob"]);
    a.ctx.channelMembers = joinedRoster;
    b.ctx.channelMembers = joinedRoster;
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

  it("a channel message with a tampered signature is undecryptable, never received", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    w.grappa.joinChannel(CHANNEL, a.nick);
    w.grappa.joinChannel(CHANNEL, b.nick);
    const roster = rosterFor(["alice", "Bob"]);
    a.ctx.channelMembers = roster;
    b.ctx.channelMembers = roster;

    // Bob asks first so the epoch imports when Alice answers the send.
    await b.client.requestChannelKey(b.ctx, CHANNEL);
    await a.client.drain(a.ctx);
    await a.client.createChannelEpoch(a.ctx, CHANNEL, ["alice", "Bob"]);
    await a.client.sendChannel(a.ctx, CHANNEL, "secret", ["alice", "Bob"]);

    // Tamper the signature of the genuine channel :msg on its way to
    // Bob's drain: the first base64 character of the signature flips, so
    // the bytes no longer match what Alice signed.
    const realDoor = b.ctx.door;
    b.ctx.door = (did) => {
      const door = realDoor(did);
      const realInbox = door.inbox;
      return {
        ...door,
        inbox: async (after) => {
          const page = await realInbox(after);
          return page.map((m) => {
            if (m.channel !== CHANNEL) return m;
            const envelope = decodePayload(m.payload);
            const sig = String(envelope.sig);
            return {
              ...m,
              payload: encodePayload({
                ...envelope,
                sig: `${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`,
              }),
            };
          });
        },
      };
    };

    const read = await b.client.drain(b.ctx);
    // The key arrives, the line does not: a verifier that always said yes
    // would read it instead, so this test dies on that mutant.
    expect(read.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_key_received", from: "alice" }),
      {
        kind: "channel_undecryptable",
        channel: CHANNEL,
        from: "alice",
        sid: expect.any(String),
        reason: "bad-signature",
      },
    ]);
  });

  it("our own rejoin drops the dead epoch and asks for the key again", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    w.grappa.joinChannel(CHANNEL, a.nick);
    w.grappa.joinChannel(CHANNEL, b.nick);
    const roster = rosterFor(["alice", "Bob"]);
    a.ctx.channelMembers = roster;
    b.ctx.channelMembers = roster;
    await b.client.requestChannelKey(b.ctx, CHANNEL);
    await a.client.drain(a.ctx);
    await a.client.createChannelEpoch(a.ctx, CHANNEL, ["alice", "Bob"]);
    await a.client.sendChannel(a.ctx, CHANNEL, "ciao a tutti", ["alice", "Bob"]);
    await b.client.drain(b.ctx);

    // Alice leaves and rejoins while her cic was closed: the epoch she
    // held predates the rotation the others did without her, so it goes
    // and she asks for the key again instead of speaking under it.
    const rejoined = await a.client.channelMembersChanged(a.ctx, CHANNEL, "alice", null, [
      "alice",
      "Bob",
    ]);
    expect(rejoined.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_dropped", reason: "rejoined" }),
      { kind: "channel_key_requested", channel: CHANNEL },
    ]);
    expect(w.grappa.sends.at(-1)).toEqual(expect.objectContaining({ target: CHANNEL, to: "*" }));
  });

  it("our own first join asks for the key when we hold no epoch", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    w.grappa.joinChannel(CHANNEL, a.nick);
    w.grappa.joinChannel(CHANNEL, b.nick);
    const roster = rosterFor(["alice", "Bob"]);
    a.ctx.channelMembers = roster;
    b.ctx.channelMembers = roster;

    const joined = await a.client.channelMembersChanged(a.ctx, CHANNEL, "alice", null, [
      "alice",
      "Bob",
    ]);
    expect(joined.channelE2e).toEqual([{ kind: "channel_key_requested", channel: CHANNEL }]);
    expect(w.grappa.sends.at(-1)).toEqual(expect.objectContaining({ target: CHANNEL, to: "*" }));
  });

  it("a roster seed audits and asks in one operation, and stays silent off a tagged channel", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    w.grappa.joinChannel(CHANNEL, a.nick);
    w.grappa.joinChannel(CHANNEL, b.nick);
    const roster = rosterFor(["alice", "Bob"]);
    a.ctx.channelMembers = roster;
    b.ctx.channelMembers = roster;
    // Only #grappa advertises the tag here.
    a.ctx.topicTagFor = (channel) => (channel === CHANNEL ? "alice" : null);

    // No epoch held: the seed asks, once, on the channel itself.
    const seeded = await a.client.seedChannel(a.ctx, CHANNEL, ["alice", "Bob"]);
    expect(seeded.channelE2e).toEqual([{ kind: "channel_key_requested", channel: CHANNEL }]);
    expect(w.grappa.sends.filter((s) => s.target === CHANNEL)).toHaveLength(1);

    // The epoch is held now and every holder is still a member: the
    // seed is quiet.
    await b.client.requestChannelKey(b.ctx, CHANNEL);
    await a.client.drain(a.ctx);
    await a.client.createChannelEpoch(a.ctx, CHANNEL, ["alice", "Bob"]);
    await a.client.sendChannel(a.ctx, CHANNEL, "ciao a tutti", ["alice", "Bob"]);
    await b.client.drain(b.ctx);
    const quiet = await a.client.seedChannel(a.ctx, CHANNEL, ["alice", "Bob"]);
    expect(quiet.channelE2e).toBeUndefined();

    // A holder left while every cic was closed: the seed rotates.
    const stale = await a.client.seedChannel(a.ctx, CHANNEL, ["alice"]);
    expect(stale.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_rotated", reason: "member-left" }),
    ]);

    // Off a tagged channel the seed opens nothing at all: no event, no
    // send, and the sealed record is never even loaded.
    const stores = vi.spyOn(a.vault, "store");
    stores.mockClear();
    const untagged = await a.client.seedChannel(a.ctx, "#sbiffo", ["alice", "Bob"]);
    expect(untagged.channelE2e).toBeUndefined();
    expect(w.grappa.sends.filter((s) => s.target === "#sbiffo")).toHaveLength(0);
    expect(stores).not.toHaveBeenCalled();
  });

  it("the audit rotates when a holder left while every cic was closed", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    w.grappa.joinChannel(CHANNEL, a.nick);
    w.grappa.joinChannel(CHANNEL, b.nick);
    const roster = rosterFor(["alice", "Bob"]);
    a.ctx.channelMembers = roster;
    b.ctx.channelMembers = roster;
    await a.client.createChannelEpoch(a.ctx, CHANNEL, ["alice", "Bob"]);
    await a.client.sendChannel(a.ctx, CHANNEL, "ciao a tutti", ["alice", "Bob"]);

    const fresh = await a.client.auditChannelEpoch(a.ctx, CHANNEL, ["alice", "Bob"]);
    expect(fresh.channelE2e).toBeUndefined();
    const stale = await a.client.auditChannelEpoch(a.ctx, CHANNEL, ["alice"]);
    expect(stale.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_rotated", reason: "member-left" }),
    ]);
  });

  it("a non-designated send rotates the stale epoch before sending, never under it", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    w.grappa.joinChannel(CHANNEL, a.nick);
    w.grappa.joinChannel(CHANNEL, b.nick);
    const roster = rosterFor(["alice", "Bob"]);
    a.ctx.channelMembers = roster;
    b.ctx.channelMembers = roster;
    await b.client.requestChannelKey(b.ctx, CHANNEL);
    await a.client.drain(a.ctx);
    // Carol holds the epoch too, but no side of hers exists here: she is
    // the departed holder the roster no longer names.
    await a.client.createChannelEpoch(a.ctx, CHANNEL, ["alice", "Bob", "carol"]);
    await a.client.sendChannel(a.ctx, CHANNEL, "ciao a tutti", ["alice", "Bob", "carol"]);
    await b.client.drain(b.ctx);
    const oldSid = await b.accounts.withAccount(
      SLOT,
      async ({ state }) => epochFor(state.groups, CHANNEL)?.sid,
    );

    // Bob sends with carol gone from the roster: Alice sorts first, so
    // Bob is not the designated rotator — and still rotates before
    // sending, instead of speaking under the epoch carol still reads.
    const sent = await b.client.sendChannel(b.ctx, CHANNEL, "after carol left", ["alice", "Bob"]);
    const newSid = await b.accounts.withAccount(
      SLOT,
      async ({ state }) => epochFor(state.groups, CHANNEL)?.sid,
    );
    expect(newSid).not.toBe(oldSid);
    expect(sent.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_rotated", oldSid, reason: "member-left" }),
      expect.objectContaining({ kind: "channel_key_sent", to: "alice", sid: newSid }),
    ]);
    // The new key goes pairwise to Alice first, then the row under the new epoch.
    const after = w.grappa.sends.filter((s) => s.target === CHANNEL);
    expect(after.at(-1)).toEqual(expect.objectContaining({ target: CHANNEL, to: "*" }));
    expect(decodePayload(after.at(-1)?.payload ?? "").sid).toBe(newSid);
    // Carol holds no key for the new epoch: its holders are Alice and Bob alone.
    const holders = await b.accounts.withAccount(
      SLOT,
      async ({ state }) => epochFor(state.groups, CHANNEL)?.holders,
    );
    expect(holders?.sort()).toEqual([(await ownOf(a)).did, (await ownOf(b)).did].sort());
    // Alice drains the rotation and reads the row under the new epoch.
    const read = await a.client.drain(a.ctx);
    expect(read.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_key_received", from: "Bob", sid: newSid }),
      expect.objectContaining({
        kind: "channel_received",
        from: "Bob",
        body: "after carol left",
      }),
    ]);
  });

  it("a seed that no longer names us drops the dead epoch and asks for the key again", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    w.grappa.joinChannel(CHANNEL, a.nick);
    w.grappa.joinChannel(CHANNEL, b.nick);
    const roster = rosterFor(["alice", "Bob"]);
    a.ctx.channelMembers = roster;
    b.ctx.channelMembers = roster;
    // Only #grappa advertises the tag here: without it the seed opens
    // nothing at all, and the drop below never runs.
    b.ctx.topicTagFor = (channel) => (channel === CHANNEL ? "alice" : null);
    await b.client.requestChannelKey(b.ctx, CHANNEL);
    await a.client.drain(a.ctx);
    await a.client.createChannelEpoch(a.ctx, CHANNEL, ["alice", "Bob"]);
    await a.client.sendChannel(a.ctx, CHANNEL, "ciao a tutti", ["alice", "Bob"]);
    await b.client.drain(b.ctx);

    // Bob left and rejoined while his cic was closed, so the seed names
    // alice alone: the epoch held before the leave is dead, and the seed
    // drops it and asks for the key again instead of keeping it.
    const seeded = await b.client.seedChannel(b.ctx, CHANNEL, ["alice"]);
    expect(seeded.channelE2e).toEqual([
      { kind: "channel_dropped", channel: CHANNEL, reason: "own-leave" },
      { kind: "channel_key_requested", channel: CHANNEL },
    ]);
    const epoch = await b.accounts.withAccount(SLOT, async ({ state }) =>
      epochFor(state.groups, CHANNEL),
    );
    expect(epoch).toBeUndefined();

    // A later seed that names Bob again asks from no epoch — and Alice,
    // who still holds it, answers, so the rejoin recovers.
    const reseeded = await b.client.seedChannel(b.ctx, CHANNEL, ["alice", "Bob"]);
    expect(reseeded.channelE2e).toEqual([{ kind: "channel_key_requested", channel: CHANNEL }]);
    const answered = await a.client.drain(a.ctx);
    expect(answered.channelE2e).toContainEqual(
      expect.objectContaining({ kind: "channel_key_sent", to: "Bob" }),
    );
  });

  it("a periodic rotation is not stalled by a departed holder's did", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    w.grappa.joinChannel(CHANNEL, a.nick);
    w.grappa.joinChannel(CHANNEL, b.nick);
    const roster = rosterFor(["alice", "Bob"]);
    a.ctx.channelMembers = roster;
    b.ctx.channelMembers = roster;
    await b.client.requestChannelKey(b.ctx, CHANNEL);
    await a.client.drain(a.ctx);
    await a.client.createChannelEpoch(a.ctx, CHANNEL, ["alice", "Bob"]);
    await a.client.sendChannel(a.ctx, CHANNEL, "ciao a tutti", ["alice", "Bob"]);
    await b.client.drain(b.ctx);

    // Bob speaks under the epoch while alice is still on the roster,
    // so his device counts as having spoken under it — then alice
    // leaves without a processed leave event: the roster names Bob
    // alone, and the day passes.
    await b.client.sendChannel(b.ctx, CHANNEL, "spoke", ["alice", "Bob"]);
    b.ctx.channelMembers = rosterFor(["Bob"]);
    w.now += GROUP_ROTATION_INTERVAL_MS;

    // The designated rotator was alice's did — she is gone — so the
    // election falls to Bob, the first REMAINING holder, and the epoch
    // rotates on schedule instead of stalling.
    const ticked = await b.client.tick(b.ctx);
    expect(ticked.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_rotated", reason: "periodic" }),
    ]);
  });
});

describe("channel rotation reaches our other device", () => {
  it("a rotation is copied to our other device, which does not mint a second epoch", async () => {
    const { w, a, b } = await pair();
    const a2 = await w.pairDevice(a);
    await chat(a, b);
    // Bob writes alice first, so both her devices hold a session with him
    // and his list; then Alice's own send to Bob opens the copy session
    // to her second device.
    await b.client.send(b.ctx, "alice", "hi alice");
    for (const side of [b, a, a2, b, a, a2]) await side.client.drain(side.ctx);
    await a.client.send(a.ctx, "Bob", "hi Bob");
    await a2.client.drain(a2.ctx);

    w.grappa.joinChannel(CHANNEL, a.nick);
    w.grappa.joinChannel(CHANNEL, b.nick);
    const roster = rosterFor(["alice", "Bob"]);
    a.ctx.channelMembers = roster;
    a2.ctx.channelMembers = roster;
    b.ctx.channelMembers = roster;

    // The second device asks for the key first: a first epoch is only
    // imported after asking, and the copy carries the same gate.
    const asked = await a2.client.requestChannelKey(a2.ctx, CHANNEL);
    expect(asked.channelE2e).toEqual([{ kind: "channel_key_requested", channel: CHANNEL }]);

    // Alice mints the epoch on her first device and sends to the channel:
    // the gkey DM to Bob is copied to her second device.
    const minted = await a.client.createChannelEpoch(a.ctx, CHANNEL, ["alice", "Bob"]);
    expect(minted.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_rotated", reason: "created" }),
      expect.objectContaining({ kind: "channel_key_sent", to: "Bob" }),
    ]);
    const sent = await a.client.sendChannel(a.ctx, CHANNEL, "ciao a tutti", ["alice", "Bob"]);
    expect(sent.channelE2e).toBeUndefined();
    const epochSid = await a.accounts.withAccount(
      SLOT,
      async ({ state }) => epochFor(state.groups, CHANNEL)?.sid,
    );

    // The second device drains: the copy imports the epoch, and no sent
    // row appears in Bob's chat for a key.
    const read = await a2.client.drain(a2.ctx);
    expect(read.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_key_received", from: "alice" }),
    ]);
    const bobRows = await rowsOf(a2, "Bob");
    expect(
      bobRows.some(
        (r) => r.kind === "out" && typeof r.body === "string" && r.body.includes('"gkey"'),
      ),
    ).toBe(false);

    // The second device sends under the imported epoch: no second
    // rotation, and the line goes out under the same epoch id.
    const second = await a2.client.sendChannel(a2.ctx, CHANNEL, "secondo", ["alice", "Bob"]);
    expect(second.channelE2e).toBeUndefined();
    const a2Sid = await a2.accounts.withAccount(
      SLOT,
      async ({ state }) => epochFor(state.groups, CHANNEL)?.sid,
    );
    expect(a2Sid).toBe(epochSid);
    const last = w.grappa.sends.filter((s) => s.target === CHANNEL).at(-1);
    expect(decodePayload(last?.payload ?? "").sid).toBe(epochSid);
  });
});

describe("a channel row that arrives before its key", () => {
  it("holds the row, then reads it once the key arrives", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    w.grappa.joinChannel(CHANNEL, a.nick);
    w.grappa.joinChannel(CHANNEL, b.nick);
    const roster = rosterFor(["alice", "Bob"]);
    a.ctx.channelMembers = roster;
    b.ctx.channelMembers = roster;

    const minted = await a.client.createChannelEpoch(a.ctx, CHANNEL, ["alice", "Bob"]);
    expect(minted.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_rotated", reason: "created" }),
      expect.objectContaining({ kind: "channel_key_sent", to: "Bob" }),
    ]);
    const sent = await a.client.sendChannel(a.ctx, CHANNEL, "ciao a tutti", ["alice", "Bob"]);
    expect(sent.channelE2e).toBeUndefined();
    const epochSid = await a.accounts.withAccount(
      SLOT,
      async ({ state }) => epochFor(state.groups, CHANNEL)?.sid,
    );

    // The gkey DM never reaches Bob's drain: it stays stranded below the
    // watermark, and only the channel row arrives — before its key.
    const realDoor = b.ctx.door;
    let filtered = false;
    b.ctx.door = (did) => {
      const door = realDoor(did);
      return {
        ...door,
        inbox: async (after) => {
          const page = await door.inbox(after);
          if (filtered) return page;
          filtered = true;
          return page.filter((m) => m.channel !== null);
        },
      };
    };
    const first = await b.client.drain(b.ctx);
    b.ctx.door = realDoor;
    // Held, not lost and not surfaced: no event, no epoch yet.
    expect(first.channelE2e).toBeUndefined();
    expect(await b.accounts.withAccount(SLOT, async ({ state }) => state.groups.held)).toEqual([
      expect.objectContaining({ channel: CHANNEL, sid: epochSid, from: "alice" }),
    ]);
    expect(
      await b.accounts.withAccount(SLOT, async ({ state }) => epochFor(state.groups, CHANNEL)),
    ).toBeUndefined();

    // Bob asks, Alice answers, and the next drain imports the key and
    // retries the held row under it.
    const asked = await b.client.requestChannelKey(b.ctx, CHANNEL);
    expect(asked.channelE2e).toEqual([{ kind: "channel_key_requested", channel: CHANNEL }]);
    const answered = await a.client.drain(a.ctx);
    expect(answered.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_key_sent", to: "Bob", sid: epochSid }),
    ]);

    const read = await b.client.drain(b.ctx);
    expect(read.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_key_received", from: "alice", sid: epochSid }),
      expect.objectContaining({
        kind: "channel_received",
        from: "alice",
        counter: 0,
        body: "ciao a tutti",
      }),
    ]);
    expect(await b.accounts.withAccount(SLOT, async ({ state }) => state.groups.held)).toEqual([]);
    expect(
      await b.accounts.withAccount(SLOT, async ({ state }) => epochFor(state.groups, CHANNEL)?.sid),
    ).toBe(epochSid);
  });

  it("a row whose key never comes surfaces as undecryptable once it expires", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    w.grappa.joinChannel(CHANNEL, a.nick);
    w.grappa.joinChannel(CHANNEL, b.nick);
    const roster = rosterFor(["alice", "Bob"]);
    a.ctx.channelMembers = roster;
    b.ctx.channelMembers = roster;

    await a.client.createChannelEpoch(a.ctx, CHANNEL, ["alice", "Bob"]);
    await a.client.sendChannel(a.ctx, CHANNEL, "ciao a tutti", ["alice", "Bob"]);
    const epochSid = await a.accounts.withAccount(
      SLOT,
      async ({ state }) => epochFor(state.groups, CHANNEL)?.sid,
    );

    // Same stranding as the retry test: only the row arrives, never the key.
    const realDoor = b.ctx.door;
    let filtered = false;
    b.ctx.door = (did) => {
      const door = realDoor(did);
      return {
        ...door,
        inbox: async (after) => {
          const page = await door.inbox(after);
          if (filtered) return page;
          filtered = true;
          return page.filter((m) => m.channel !== null);
        },
      };
    };
    const first = await b.client.drain(b.ctx);
    b.ctx.door = realDoor;
    expect(first.channelE2e).toBeUndefined();
    expect(await b.accounts.withAccount(SLOT, async ({ state }) => state.groups.held)).toHaveLength(
      1,
    );

    // Past the hold's lifetime, a drain with nothing new in the inbox
    // surfaces the wait as undecryptable instead of holding it forever.
    w.now += HELD_ROW_TTL_MS + 1;
    const expired = await b.client.drain(b.ctx);
    expect(expired.channelE2e).toEqual([
      expect.objectContaining({
        kind: "channel_undecryptable",
        from: "alice",
        sid: epochSid,
        reason: "no-session",
      }),
    ]);
    expect(await b.accounts.withAccount(SLOT, async ({ state }) => state.groups.held)).toEqual([]);
  });
});
