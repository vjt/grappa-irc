// issue 2430 — a channel row whose read throws, at each place the drain
// reads one: the live row, a held row retried when its key arrives on the
// same page, and a held row whose key arrived outside the drain. The step
// is a module seam (`receiveChannel`), wrapped here so a test can make it
// throw on one payload; everything else is the real client over the fake
// grappa (`helpers/e2eClients.ts`), as in `e2eClientChannel.test.ts`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { epochFor } from "../lib/e2e/groupSessions";
import { __resetServerProtocolForTests, setServerProtocol } from "../lib/serverProtocol";
import { chat, inboxOf, latestGrappa, ownOf, pair, type Side, SLOT } from "./helpers/e2eClients";
import { routeApi } from "./helpers/e2eGrappa";
import { olm } from "./helpers/olm";

const seam = vi.hoisted(() => ({
  /** The payload whose read throws `boom`, or null: every read runs for real. */
  throwOn: null as string | null,
  boom: new Error("the step threw"),
}));

vi.mock("../lib/e2e/channelE2e", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/e2e/channelE2e")>();
  return {
    ...real,
    receiveChannel: async (...args: Parameters<typeof real.receiveChannel>) => {
      if (args[5] === seam.throwOn) throw seam.boom;
      return real.receiveChannel(...args);
    },
  };
});
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
vi.mock("../lib/auth", () => ({ token: () => null }));
vi.mock("../lib/networks", () => ({ user: () => null, networks: () => undefined }));
vi.mock("../lib/e2e/olm", () => ({ loadOlm: async () => olm() }));

const api = await import("../lib/api");

beforeEach(() => {
  routeApi(api, () => latestGrappa());
  setServerProtocol(63);
  seam.throwOn = null;
});

afterEach(() => {
  __resetServerProtocolForTests();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

const CHANNEL = "#grappa";

function rosterFor(members: string[]): (channel: string) => string[] | undefined {
  const roster = new Map([[CHANNEL, members]]);
  return (channel) => roster.get(channel);
}

const heldOf = (side: Side) =>
  side.accounts.withAccount(SLOT, async ({ state }) => state.groups.held);

const undecryptable = (from: string, at: number) => ({
  kind: "channel_undecryptable",
  channel: CHANNEL,
  from,
  sid: null,
  at,
  reason: "decryption-failed",
});

/**
 * Bob holds a row of Alice's under the epoch she minted, and the key DM
 * never reached his drain: it stayed below the watermark, and only the
 * channel row arrived.
 */
async function rowHeldBeforeItsKey() {
  const { w, a, b } = await pair();
  await chat(a, b);
  w.grappa.joinChannel(CHANNEL, a.nick);
  w.grappa.joinChannel(CHANNEL, b.nick);
  const roster = rosterFor(["alice", "Bob"]);
  a.ctx.channelMembers = roster;
  b.ctx.channelMembers = roster;
  await a.client.createChannelEpoch(a.ctx, CHANNEL, ["alice", "Bob"]);
  await a.client.sendChannel(a.ctx, CHANNEL, "ciao a tutti", ["alice", "Bob"]);
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
  const held = await heldOf(b);
  expect(held).toEqual([expect.objectContaining({ channel: CHANNEL, from: "alice" })]);
  return { w, a, b, payload: held[0]?.payload ?? "" };
}

/**
 * Bob left; the remaining member that did not rotate drained the
 * rotation's key and the first row under it while its roster was
 * unknown, so it holds both. Its roster seed then imports the key —
 * outside any drain — and the row still waits.
 */
async function rowHeldUnderASeededKey() {
  const { w, a, b } = await pair();
  await chat(a, b);
  const c = await w.join("carol");
  await chat(a, c);
  for (const side of [a, b, c]) w.grappa.joinChannel(CHANNEL, side.nick);
  const roster = rosterFor(["alice", "Bob", "carol"]);
  for (const side of [a, b, c]) side.ctx.channelMembers = roster;
  await b.client.requestChannelKey(b.ctx, CHANNEL);
  await c.client.requestChannelKey(c.ctx, CHANNEL);
  await a.client.drain(a.ctx);
  await a.client.createChannelEpoch(a.ctx, CHANNEL, ["alice", "Bob", "carol"]);
  await b.client.drain(b.ctx);
  await c.client.drain(c.ctx);

  // The designated rotator is the first holder did in sorted order: the
  // fake grappa assigns the dids, so find it.
  const rotator = (await ownOf(a)).did < (await ownOf(c)).did ? a : c;
  const other = rotator === a ? c : a;
  const before = await other.accounts.withAccount(
    SLOT,
    async ({ state }) => epochFor(state.groups, CHANNEL)?.sid,
  );
  other.ctx.channelMembers = () => undefined;
  await rotator.client.channelMembersChanged(rotator.ctx, CHANNEL, null, "Bob", ["alice", "carol"]);
  await rotator.client.sendChannel(rotator.ctx, CHANNEL, "dopo l'addio", ["alice", "carol"]);
  const blind = await other.client.drain(other.ctx);
  expect(blind.channelE2e).toBeUndefined();
  const held = await heldOf(other);
  expect(held).toEqual([expect.objectContaining({ channel: CHANNEL, from: rotator.nick })]);

  other.ctx.channelMembers = rosterFor(["alice", "carol"]);
  other.ctx.topicTagFor = (channel) => (channel === CHANNEL ? "alice" : null);
  await other.client.seedChannel(other.ctx, CHANNEL, ["alice", "carol"]);
  const after = await other.accounts.withAccount(
    SLOT,
    async ({ state }) => epochFor(state.groups, CHANNEL)?.sid,
  );
  expect(after).toBe(held[0]?.sid);
  expect(after).not.toBe(before);
  expect(await heldOf(other)).toHaveLength(1);
  return { w, rotator, other, payload: held[0]?.payload ?? "" };
}

describe("a channel row whose read throws", () => {
  it("a live row surfaces as undecryptable, logged as an error, and is acknowledged", async () => {
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
    const line = w.grappa.sends.at(-1);
    expect(line).toEqual(expect.objectContaining({ target: CHANNEL, to: "*" }));
    seam.throwOn = line?.payload ?? "";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const read = await b.client.drain(b.ctx);
    expect(read.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_key_received", from: "alice" }),
      undecryptable("alice", w.now),
    ]);
    expect(errors).toHaveBeenCalledWith(expect.any(String), seam.boom);
    expect(await inboxOf(w, b)).toEqual([]);
    expect(await heldOf(b)).toEqual([]);
    const again = await b.client.drain(b.ctx);
    expect(again.channelE2e).toBeUndefined();
  });

  it("a held row retried when its key arrives surfaces as undecryptable, logged as an error", async () => {
    const { w, a, b, payload } = await rowHeldBeforeItsKey();
    await b.client.requestChannelKey(b.ctx, CHANNEL);
    await a.client.drain(a.ctx);
    seam.throwOn = payload;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const read = await b.client.drain(b.ctx);
    expect(read.channelE2e).toEqual([
      expect.objectContaining({ kind: "channel_key_received", from: "alice" }),
      undecryptable("alice", w.now),
    ]);
    expect(errors).toHaveBeenCalledWith(expect.any(String), seam.boom);
    expect(await inboxOf(w, b)).toEqual([]);
    expect(await heldOf(b)).toEqual([]);
    const again = await b.client.drain(b.ctx);
    expect(again.channelE2e).toBeUndefined();
  });

  it("a held row whose key arrived outside the drain is read by the next drain", async () => {
    const { rotator, other } = await rowHeldUnderASeededKey();

    const read = await other.client.drain(other.ctx);
    expect(read.channelE2e).toEqual([
      expect.objectContaining({
        kind: "channel_received",
        from: rotator.nick,
        body: "dopo l'addio",
      }),
    ]);
    expect(await heldOf(other)).toEqual([]);
  });

  it("a held row whose key arrived outside the drain surfaces as undecryptable, logged as an error", async () => {
    const { w, rotator, other, payload } = await rowHeldUnderASeededKey();
    seam.throwOn = payload;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const read = await other.client.drain(other.ctx);
    expect(read.channelE2e).toEqual([undecryptable(rotator.nick, w.now)]);
    expect(errors).toHaveBeenCalledWith(expect.any(String), seam.boom);
    expect(await inboxOf(w, other)).toEqual([]);
    expect(await heldOf(other)).toEqual([]);
    const again = await other.client.drain(other.ctx);
    expect(again.channelE2e).toBeUndefined();
  });
});
