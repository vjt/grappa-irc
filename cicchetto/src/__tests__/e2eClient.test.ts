// issue 2430 — cic's E2E client between one device's doors on grappa (its
// inbox, the inbox's acknowledgement, the send door) and what the user sees
// (the chat history). Clients over a fake grappa v2 (`helpers/e2eClients.ts`):
// the engines, the identity sync, the account store and the chat store are
// the real ones over in-memory twins of IndexedDB and Web Locks; grappa's
// REST is mocked at the api module (the boundary) and answered by the fake.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountStore, open, seal } from "../lib/e2e/accountStore";
import { chatStore } from "../lib/e2e/chatStore";
import {
  e2eClient,
  IdentityElsewhereError,
  NoAccountError,
  SIBLINGS_TTL_MS,
} from "../lib/e2e/client";
import { KEYREQ_RETRY_MS, LIST_TAG, OUTQ_TTL_MS } from "../lib/e2e/engine";
import { ORDER_TAG, UNCONFIRMED } from "../lib/e2e/orders";
import { SAS_TAG } from "../lib/e2e/sas";
import { decodePayload } from "../lib/e2e/wire";
import {
  chat,
  inboxOf,
  inject,
  inners,
  latestGrappa,
  ownOf,
  pair,
  rowsOf,
  SCOPE,
  type Side,
  SLOT,
  World,
} from "./helpers/e2eClients";
import { FRAME_BUDGET_BASE } from "./helpers/e2eDevices";
import { routeApi } from "./helpers/e2eGrappa";
import { memoryLock, memoryVault } from "./helpers/e2eVault";
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
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

const bodies = async (side: Side, nick: string) =>
  (await rowsOf(side, nick)).map((r) => (r.kind === "in" || r.kind === "out" ? r.body : r.kind));
const states = async (side: Side, nick: string) =>
  (await rowsOf(side, nick)).flatMap((r) => (r.kind === "out" ? [[r.state, r.reason]] : []));
/** What `nick`'s devices handed grappa's send door: verb, address, and the message's tag. */
const sendsBy = (w: World, nick: string) =>
  w.grappa.sends.filter((s) => s.by === nick).map((s) => [s.verb, s.to, s.tag]);

describe("e2eClient", () => {
  it("sends through the keys, the peer reads it in its chat, and once the list asks are answered both inboxes are empty", async () => {
    const { w, a, b } = await pair();
    const alice = await ownOf(a);
    const bob = await ownOf(b);

    const sent = await a.client.send(a.ctx, "bob", "hello");
    expect(sent.chats).toEqual(["bob"]);
    expect(await states(a, "bob")).toEqual([["queued", null]]);
    expect(sent.waiting).toBe(true);

    const drained = await a.client.drain(a.ctx);
    expect(drained.waiting).toBe(false);
    expect(await states(a, "bob")).toEqual([["sent", null]]);

    const read = await b.client.drain(b.ctx);
    expect(read).toEqual({ chats: ["alice"], pkmsgs: 1, waiting: false, unknownDevice: false });
    expect(await rowsOf(b, "alice")).toEqual([
      expect.objectContaining({ kind: "in", nick: "alice", body: "hello", ed25519: alice.master }),
    ]);
    expect((await b.chats.chats(SLOT)).alice).toEqual({ nick: "alice", open: true, unread: 1 });

    // Bob's device asked alice's for the list her message named; she answers it.
    await a.client.drain(a.ctx);
    await b.client.drain(b.ctx);
    expect(await inboxOf(w, a)).toEqual([]);
    expect(await inboxOf(w, b)).toEqual([]);
    const tag = w.grappa.sends.find((s) => s.verb === "pkmsg")?.tag;
    expect(sendsBy(w, "alice")).toEqual([
      ["keyreq", "*", undefined],
      ["pkmsg", bob.did, tag],
      ["msg", bob.did, LIST_TAG],
    ]);
    expect(sendsBy(w, "Bob")).toEqual([["msg", alice.did, LIST_TAG]]);
  });

  it("a message to a subject with two devices reaches each: each device drains its own inbox, and an answer from either reads as the subject", async () => {
    const { w, a, b } = await pair();
    const b2 = await w.pairDevice(b);
    const bob = await ownOf(b);
    const second = await ownOf(b2);

    await a.client.send(a.ctx, "bob", "hello");
    await a.client.drain(a.ctx);

    // One pre-key message to both devices, a body for each.
    const pkmsgs = w.grappa.sends.filter((s) => s.by === "alice" && s.verb === "pkmsg");
    expect(pkmsgs.map((s) => s.to)).toEqual(["*"]);
    expect(Object.keys(decodePayload(pkmsgs[0]?.payload ?? "").bodies as object).sort()).toEqual(
      [bob.did, second.did].sort(),
    );
    expect(await b.client.drain(b.ctx)).toEqual(
      expect.objectContaining({ chats: ["alice"], pkmsgs: 1 }),
    );
    expect(await b2.client.drain(b2.ctx)).toEqual(
      expect.objectContaining({ chats: ["alice"], pkmsgs: 1 }),
    );
    expect(await bodies(b, "alice")).toEqual(["hello"]);
    expect(await bodies(b2, "alice")).toEqual(["hello"]);

    await b2.client.send(b2.ctx, "alice", "from the second");
    await a.client.drain(a.ctx);

    expect(await bodies(a, "bob")).toEqual(["hello", "from the second"]);
    expect((await rowsOf(a, "bob"))[1]).toEqual(
      expect.objectContaining({ kind: "in", nick: "Bob", ed25519: bob.master }),
    );
    expect((await a.client.identity(a.ctx, ["bob"])).peers.bob).toEqual({
      master: bob.master,
      verified: false,
      devices: 2,
    });
  });

  it("an answer goes straight out on the session, and the conversation keeps its order", async () => {
    const { a, b } = await pair();
    await a.client.send(a.ctx, "bob", "hello");
    await a.client.drain(a.ctx);
    await b.client.drain(b.ctx);

    await b.client.send(b.ctx, "alice", "hi back");
    await a.client.drain(a.ctx);
    await a.client.send(a.ctx, "bob", "again");
    await b.client.drain(b.ctx);

    expect(await bodies(a, "bob")).toEqual(["hello", "hi back", "again"]);
    expect(await bodies(b, "alice")).toEqual(["hello", "hi back", "again"]);
  });

  it("drains past a page, in id order", async () => {
    const { w, a, b } = await pair();
    w.grappa.pageSize = 2;
    await a.client.send(a.ctx, "bob", "one");
    await a.client.drain(a.ctx);
    await b.client.drain(b.ctx);
    await b.client.send(b.ctx, "alice", "two");
    await b.client.send(b.ctx, "alice", "three");
    await b.client.send(b.ctx, "alice", "four");

    await a.client.drain(a.ctx);

    expect(await bodies(a, "bob")).toEqual(["one", "two", "three", "four"]);
    expect(await inboxOf(w, a)).toEqual([]);
  });

  it("an inbox message processed again after a failed acknowledgement adds nothing", async () => {
    const { w, a, b } = await pair();
    const alice = await ownOf(a);
    await a.client.send(a.ctx, "bob", "hello");
    await a.client.drain(a.ctx);
    w.grappa.failAck = true;

    await expect(b.client.drain(b.ctx)).rejects.toThrow("ack refused");
    w.grappa.failAck = false;
    await b.client.drain(b.ctx);

    expect(await bodies(b, "alice")).toEqual(["hello"]);
    expect(await inboxOf(w, b)).toEqual([]);
    // Not taken for a lost session (no NACK), and not answered twice: the
    // list ask the message brought went once.
    expect(sendsBy(w, "Bob")).toEqual([["msg", alice.did, LIST_TAG]]);
  });

  it("writes a decrypted message down before the state that spent its key", async () => {
    const { w, a, b } = await pair();
    const alice = await ownOf(a);
    await a.client.send(a.ctx, "bob", "hello");
    await a.client.drain(a.ctx);
    const store = b.chatVault.store;
    // The tab dies writing the chat. Had the state that spent the message's
    // key been stored first, the message would be gone for good.
    b.chatVault.store = async () => {
      throw new Error("tab closed");
    };

    await expect(b.client.drain(b.ctx)).rejects.toThrow("tab closed");
    expect(sendsBy(w, "Bob")).toEqual([]);
    b.chatVault.store = store;
    await b.client.drain(b.ctx);

    expect(await bodies(b, "alice")).toEqual(["hello"]);
    expect(sendsBy(w, "Bob")).toEqual([["msg", alice.did, LIST_TAG]]);
    // The state that was finally stored is the one that opened it.
    await b.client.send(b.ctx, "alice", "hi");
    await a.client.drain(a.ctx);
    expect(await bodies(a, "bob")).toEqual(["hello", "hi"]);
  });

  it("stores the ratchet step before its ciphertext leaves", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    const store = a.vault.store;
    const before = w.grappa.sends.length;
    // The tab dies once the message is on its way.
    a.vault.store = async (slot, sealed) => {
      if (w.grappa.sends.length > before) throw new Error("tab closed");
      return store(slot, sealed);
    };

    await expect(a.client.send(a.ctx, "bob", "one")).rejects.toThrow("tab closed");
    a.vault.store = store;
    await a.client.send(a.ctx, "bob", "two");
    await b.client.drain(b.ctx);

    // Sent from a state that had not moved, "two" would reuse the key "one"
    // spent, and bob could not read it.
    expect(await bodies(b, "alice")).toEqual(["hello", "hi", "one", "two"]);
  });

  it("marks a message grappa refused as failed, with grappa's reason", async () => {
    const { w, a, b } = await pair();
    await a.client.send(a.ctx, "bob", "hello");
    await a.client.drain(a.ctx);
    w.grappa.refuse = (o) => (o.verb === "msg" || o.verb === "pkmsg" ? "rate-limited" : undefined);

    await a.client.send(a.ctx, "bob", "refused");

    expect(await states(a, "bob")).toEqual([
      ["sent", null],
      ["failed", "rate-limited"],
    ]);
    w.grappa.refuse = () => undefined;
    await b.client.drain(b.ctx);
    expect(await bodies(b, "alice")).toEqual(["hello"]);
  });

  it("a message one payload of which grappa refused reads sent while another payload went, and failed once none did", async () => {
    const { w, a, b } = await pair();
    const b2 = await w.pairDevice(b);
    // Bob's first device answers, his second does not: alice writes the
    // first a normal message and the second a pre-key one.
    await chat(a, b);
    w.grappa.refuse = (o) => (o.verb === "pkmsg" ? "rate-limited" : undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await a.client.send(a.ctx, "bob", "half");
    expect(await states(a, "bob")).toEqual([
      ["sent", null],
      ["sent", null],
    ]);
    expect(warn).toHaveBeenCalledWith(
      "[e2e] grappa refused a pkmsg to bob (rate-limited); another copy is on its way",
    );

    w.grappa.refuse = (o) => (o.verb === "pkmsg" || o.verb === "msg" ? "too-large" : undefined);
    await a.client.send(a.ctx, "bob", "none");
    expect(await states(a, "bob")).toEqual([
      ["sent", null],
      ["sent", null],
      ["failed", "too-large"],
    ]);

    w.grappa.refuse = () => undefined;
    await b.client.drain(b.ctx);
    await b2.client.drain(b2.ctx);
    expect(await bodies(b, "alice")).toEqual(["hello", "hi", "half"]);
    // Bob's own "hi" reaches his second device as a copy (S1); "half" not.
    expect(await bodies(b2, "alice")).toEqual(["hello", "hi"]);
  });

  it("marks a message whose keys never came as failed, on a tick, and stops waiting", async () => {
    const { w, a } = await pair();

    const sent = await a.client.send(a.ctx, "nobody", "anyone there?");
    expect(sent.waiting).toBe(true);
    w.now += OUTQ_TTL_MS;
    const ticked = await a.client.tick(a.ctx);

    expect(ticked).toEqual({ chats: ["nobody"], pkmsgs: 0, waiting: false, unknownDevice: false });
    expect(await states(a, "nobody")).toEqual([["failed", "keys-timeout"]]);
  });

  it("asks again on a tick for keys grappa left unanswered, and the message goes once they come", async () => {
    const { w, a, b } = await pair();
    const keyreqs = () => w.grappa.sends.filter((s) => s.verb === "keyreq").length;
    let quiet = true;
    w.grappa.unanswered = () => quiet;

    await a.client.send(a.ctx, "bob", "hello");
    quiet = false;
    w.now += KEYREQ_RETRY_MS - 1;
    await a.client.tick(a.ctx);
    expect(keyreqs()).toBe(1);
    w.now += 1;
    const ticked = await a.client.tick(a.ctx);
    expect(keyreqs()).toBe(2);
    expect(ticked.waiting).toBe(true);

    await a.client.drain(a.ctx);
    await b.client.drain(b.ctx);
    expect(await states(a, "bob")).toEqual([["sent", null]]);
    expect(await bodies(b, "alice")).toEqual(["hello"]);
  });

  it("a drain past the retry time asks again for keys too, and sends the request", async () => {
    const { w, a, b } = await pair();
    const keyreqs = () => w.grappa.sends.filter((s) => s.verb === "keyreq").length;
    let quiet = true;
    w.grappa.unanswered = () => quiet;
    await a.client.send(a.ctx, "bob", "hello");
    quiet = false;

    w.now += KEYREQ_RETRY_MS;
    await a.client.drain(a.ctx);
    expect(keyreqs()).toBe(2);
    await a.client.drain(a.ctx);
    await b.client.drain(b.ctx);
    expect(await bodies(b, "alice")).toEqual(["hello"]);
  });

  it("refuses a message to our own nick on the spot", async () => {
    const { a } = await pair();

    await a.client.send(a.ctx, "ALICE", "me");

    expect(await states(a, "alice")).toEqual([["failed", "own-nick"]]);
  });

  it("refuses a message while grappa has published no line size, and queues nothing", async () => {
    const { w, a } = await pair();
    a.ctx.frameBudgetBase = null;

    const sent = await a.client.send(a.ctx, "bob", "too soon");

    expect(await states(a, "bob")).toEqual([["failed", "no-budget"]]);
    expect(sent.waiting).toBe(false);
    expect(w.grappa.sends).toEqual([]);
  });

  it("tells the recipient of a message it cannot read and NACKs it; the sender re-keys and sends it again, its row staying sent", async () => {
    const { w, a, b } = await pair();
    const alice = await ownOf(a);
    await chat(a, b);
    // Bob loses his sessions; alice's next message arrives on one.
    await b.accounts.withAccount(SLOT, async ({ state }) => {
      state.sessions = {};
    });

    await a.client.send(a.ctx, "bob", "lost");
    await b.client.drain(b.ctx);

    expect(await bodies(b, "alice")).toEqual(["hello", "hi", "undecryptable"]);
    expect(sendsBy(w, "Bob").filter(([verb]) => verb === "nack")).toEqual([
      ["nack", alice.did, undefined],
    ]);

    // Past the KEYREQ budget the first contact spent: the NACK re-keys at
    // once, and its KEYREQ goes unanswered for now.
    let quiet = true;
    w.grappa.unanswered = () => quiet;
    w.now += KEYREQ_RETRY_MS;
    await a.client.drain(a.ctx);
    // The message went, and waits for keys to go again: never back to queued.
    expect(await states(a, "bob")).toEqual([
      ["sent", null],
      ["sent", null],
    ]);
    quiet = false;
    w.now += KEYREQ_RETRY_MS;
    expect((await a.client.tick(a.ctx)).waiting).toBe(true);
    await a.client.drain(a.ctx);
    await b.client.drain(b.ctx);

    expect(await bodies(b, "alice")).toEqual(["hello", "hi", "undecryptable", "lost"]);
    expect(await states(a, "bob")).toEqual([
      ["sent", null],
      ["sent", null],
    ]);
  });

  it("shows the alarm in the chat when a new master speaks for a pinned nick", async () => {
    const { w, a, b } = await pair();
    await a.client.send(a.ctx, "bob", "hello");
    await a.client.drain(a.ctx);
    await b.client.drain(b.ctx);
    // Bob starts a new identity in another browser, and writes first.
    const b2 = await w.rejoin("Bob");

    await b2.client.send(b2.ctx, "alice", "it's me, honest");
    await b2.client.drain(b2.ctx);
    await a.client.drain(a.ctx);

    const rows = await rowsOf(a, "bob");
    expect(rows.map((r) => r.kind)).toEqual(["out", "key_alarm"]);
    expect(rows[1]).toEqual(
      expect.objectContaining({
        kind: "key_alarm",
        nick: "Bob",
        presented: (await ownOf(b2)).master,
      }),
    );
    expect(await bodies(a, "bob")).not.toContain("it's me, honest");
  });

  it("pins a master by hand: the chat says so, the identity reads verified, and our own key is our master", async () => {
    const { a, b } = await pair();
    const bob = await ownOf(b);
    const alice = await ownOf(a);
    const device = await a.accounts.withAccount(SLOT, async ({ account }) => account.ed25519_key());

    expect(await a.client.pin(a.ctx, "Bob", bob.master, true)).toEqual({
      result: "pinned",
      chats: ["bob"],
      pkmsgs: 0,
      waiting: true,
      unknownDevice: false,
    });

    expect(await rowsOf(a, "bob")).toEqual([
      expect.objectContaining({ kind: "pinned", nick: "Bob", ed25519: bob.master }),
    ]);
    const identity = await a.client.identity(a.ctx, ["bob", "carol"]);
    expect(identity).toEqual({
      own: alice.master,
      peers: { bob: { master: bob.master, verified: true, devices: 0 }, carol: null },
      sas: { bob: null, carol: null },
    });
    expect(identity.own).not.toBe(device);
    // The keys the pin asked for bring its device.
    await a.client.drain(a.ctx);
    expect((await a.client.identity(a.ctx, ["bob"])).peers.bob?.devices).toBe(1);
  });

  it("takes the alarm's master unverified: the chat says so, and the identity reads not verified", async () => {
    const { a, b } = await pair();
    const bob = await ownOf(b);

    expect(await a.client.pin(a.ctx, "Bob", bob.master, false)).toEqual({
      result: "pinned",
      chats: ["bob"],
      pkmsgs: 0,
      waiting: true,
      unknownDevice: false,
    });

    expect(await rowsOf(a, "bob")).toEqual([
      expect.objectContaining({ kind: "accepted", nick: "Bob", ed25519: bob.master }),
    ]);
    expect((await a.client.identity(a.ctx, ["bob"])).peers).toEqual({
      bob: { master: bob.master, verified: false, devices: 0 },
    });
  });

  it("taking a master already verified (under another nick) says it is pinned, not unverified", async () => {
    const { a, b } = await pair();
    const bob = await ownOf(b);
    await a.client.pin(a.ctx, "carol", bob.master, true);

    await a.client.pin(a.ctx, "Bob", bob.master, false);

    expect(await rowsOf(a, "bob")).toEqual([
      expect.objectContaining({ kind: "pinned", nick: "Bob", ed25519: bob.master }),
    ]);
    expect((await a.client.identity(a.ctx, ["bob"])).peers).toEqual({
      bob: { master: bob.master, verified: true, devices: 0 },
    });
  });

  it("writes nothing for a key it refuses", async () => {
    const { a } = await pair();

    expect(await a.client.pin(a.ctx, "bob", "not a key", true)).toEqual({
      result: "bad-key",
      chats: [],
      pkmsgs: 0,
      waiting: false,
      unknownDevice: false,
    });

    expect(await a.chats.chats(SLOT)).toEqual({});
  });

  it("a list ask a pin holds back keeps an idle slot on the clock, and goes on the tick that can send it", async () => {
    const { w, a, b } = await pair();
    const bob = await ownOf(b);
    // No live upstream session yet: grappa has published no line size.
    a.ctx.frameBudgetBase = null;

    const pinned = await a.client.pin(a.ctx, "Bob", bob.master, true);
    expect(pinned.waiting).toBe(true);
    expect(w.grappa.sends).toEqual([]);
    expect((await a.client.tick(a.ctx)).waiting).toBe(true);
    expect(w.grappa.sends).toEqual([]);

    a.ctx.frameBudgetBase = FRAME_BUDGET_BASE;
    expect((await a.client.tick(a.ctx)).waiting).toBe(true);
    expect(sendsBy(w, "alice")).toEqual([["keyreq", "*", undefined]]);
    // The keys come: the ask goes, on the lane of list traffic.
    expect((await a.client.drain(a.ctx)).waiting).toBe(false);
    expect(
      w.grappa.sends.filter((s) => s.by === "alice").map((s) => [s.verb, s.to, s.tag, s.priority]),
    ).toEqual([
      ["keyreq", "*", undefined, "control"],
      ["pkmsg", bob.did, LIST_TAG, "reactive"],
    ]);
  });

  it("pinning the nick to another master by hand ends the SAS that ran with the old one: key-changed, before the pin's row", async () => {
    const { w, a, b } = await pair();
    const carol = await w.join("carol");
    await chat(a, b);
    const started = await a.client.verify(a.ctx, "bob", "start");
    expect(started.waiting).toBe(true);

    await a.client.pin(a.ctx, "bob", (await ownOf(carol)).master, true);

    expect((await a.client.identity(a.ctx, ["bob"])).sas.bob).toBeNull();
    expect(await a.accounts.withAccount(SLOT, async ({ state }) => state.sas)).toEqual({});
    expect((await rowsOf(a, "bob")).map((r) => r.kind)).toEqual([
      "out",
      "in",
      "sas_asked",
      "sas_cancelled",
      "pinned",
    ]);
    expect(await rowsOf(a, "bob")).toContainEqual(
      expect.objectContaining({ kind: "sas_cancelled", by: "you", reason: "key-changed" }),
    );
  });

  it("re-pinning the nick to the master it is pinned to ends no SAS", async () => {
    const { a, b } = await pair();
    await chat(a, b);
    await a.client.verify(a.ctx, "bob", "start");

    await a.client.pin(a.ctx, "bob", (await ownOf(b)).master, true);

    expect((await a.client.identity(a.ctx, ["bob"])).sas.bob).toEqual(
      expect.objectContaining({ role: "a", phase: "started" }),
    );
  });

  it("a SAS step grappa refuses writes no row and is only logged: the SAS waits for its time", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    w.grappa.refuse = (o) => (o.verb === "msg" ? "rate-limited" : undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await a.client.verify(a.ctx, "bob", "start");

    expect(warn).toHaveBeenCalledWith(
      "[e2e] a SAS step to bob was not sent (rate-limited); the SAS will time out",
    );
    expect((await rowsOf(a, "bob")).map((r) => r.kind)).toEqual(["out", "in", "sas_asked"]);
    expect((await a.client.identity(a.ctx, ["bob"])).sas.bob).toEqual(
      expect.objectContaining({ phase: "started" }),
    );
    w.grappa.refuse = () => undefined;
    await b.client.drain(b.ctx);
    expect((await b.client.identity(b.ctx, ["alice"])).sas.alice).toBeNull();
    expect(w.grappa.sends.filter((s) => s.tag === SAS_TAG)).toEqual([]);
  });

  it("deletes a chat: its rows and the plaintext go, the pin and the sessions stay", async () => {
    const { w, a, b } = await pair();
    const bob = await ownOf(b);
    await a.client.pin(a.ctx, "Bob", bob.master, true);
    await a.client.send(a.ctx, "bob", "the launch codes");
    await a.client.drain(a.ctx);
    await b.client.drain(b.ctx);
    const keyreqs = () => w.grappa.sends.filter((s) => s.verb === "keyreq").length;
    const asked = keyreqs();
    const stored = () => a.accounts.withAccount(SLOT, async ({ state }) => JSON.stringify(state));
    // Kept for a re-send after a NACK: the plaintext is in the account record.
    expect(await stored()).toMatch(/launch codes/);

    expect(await a.client.deleteChat(a.ctx, "BOB")).toEqual(["bob"]);

    expect(await rowsOf(a, "bob")).toEqual([]);
    expect(await a.chats.chats(SLOT)).toEqual({});
    expect(await stored()).not.toMatch(/launch codes/);
    expect((await a.client.identity(a.ctx, ["bob"])).peers).toEqual({
      bob: { master: bob.master, verified: true, devices: 1 },
    });
    // The next message goes on the session already open: no new first contact.
    await a.client.send(a.ctx, "bob", "again");
    await b.client.drain(b.ctx);
    expect(keyreqs()).toBe(asked);
    expect(await bodies(b, "alice")).toEqual(["the launch codes", "again"]);
    expect(await bodies(a, "bob")).toEqual(["again"]);
  });

  it("never sends a message that waited for keys when its chat was deleted", async () => {
    const { w, a, b } = await pair();
    let quiet = true;
    w.grappa.unanswered = () => quiet;
    await a.client.send(a.ctx, "bob", "never");

    await a.client.deleteChat(a.ctx, "bob");
    quiet = false;
    w.now += KEYREQ_RETRY_MS;
    const ticked = await a.client.tick(a.ctx);
    await a.client.drain(a.ctx);
    await b.client.drain(b.ctx);

    expect(ticked.waiting).toBe(false);
    expect(await rowsOf(b, "alice")).toEqual([]);
    expect(await a.chats.chats(SLOT)).toEqual({});
  });

  it("has dropped the plaintext already when deleting the rows fails", async () => {
    const { a, b } = await pair();
    await a.client.send(a.ctx, "bob", "the launch codes");
    await a.client.drain(a.ctx);
    await b.client.drain(b.ctx);
    a.chats.remove = async () => {
      throw new Error("the chat store is gone");
    };
    const stored = () => a.accounts.withAccount(SLOT, async ({ state }) => JSON.stringify(state));
    expect(await stored()).toMatch(/launch codes/);

    await expect(a.client.deleteChat(a.ctx, "bob")).rejects.toThrow("the chat store is gone");

    expect(await stored()).not.toMatch(/launch codes/);
    expect(await bodies(a, "bob")).toEqual(["the launch codes"]);
  });

  it("never creates an account: that is the identity sync's, which never makes one over grappa's", async () => {
    const w = new World();
    const vault = memoryVault();
    const lock = memoryLock();
    const client = e2eClient(
      olm(),
      accountStore(olm(), vault, lock),
      chatStore(memoryVault(), lock),
      () => w.now,
      { page: "page-0", secrets: new Map(), alive: async () => new Set(["page-0"]) },
    );
    const ctx = {
      slot: SLOT,
      ownNick: "alice",
      frameBudgetBase: FRAME_BUDGET_BASE,
      door: (did: string) => w.grappa.door("alice", did),
      orders: () => "not-sent" as const,
    };

    await expect(client.drain(ctx)).rejects.toBeInstanceOf(NoAccountError);
    await expect(client.send(ctx, "bob", "hi")).rejects.toBeInstanceOf(NoAccountError);
    await expect(client.identity(ctx, ["bob"])).rejects.toBeInstanceOf(NoAccountError);

    expect(vault.records.size).toBe(0);
  });

  it("runs nothing on a record that holds no identity: elsewhere, and nothing stored or sent", async () => {
    const w = new World();
    const a = await w.join("alice");
    // What a replace leaves when its new identity failed after grappa's DELETE.
    await a.accounts.withAccount(SLOT, async (session) => {
      session.master = null;
      session.own = null;
    });
    const held = a.vault.records.get(SLOT);

    await expect(a.client.drain(a.ctx)).rejects.toBeInstanceOf(IdentityElsewhereError);
    await expect(a.client.send(a.ctx, "bob", "hi")).rejects.toBeInstanceOf(IdentityElsewhereError);
    await expect(a.client.identity(a.ctx, ["bob"])).rejects.toBeInstanceOf(IdentityElsewhereError);

    expect(a.vault.records.get(SLOT)).toBe(held);
    expect(w.grappa.sends).toEqual([]);
  });

  it("takes a record from an earlier shape of the identity, with no certificate version, for none: nothing is sent from it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const w = new World();
    const a = await w.join("alice");
    const sealed = a.vault.records.get(SLOT);
    if (sealed === undefined) throw new Error("no record");
    const key = await a.vault.wrappingKey();
    const record = JSON.parse(await open(key, SLOT, sealed)) as { own: Record<string, unknown> };
    delete record.own.certVer;
    a.vault.records.set(SLOT, await seal(key, SLOT, JSON.stringify(record)));

    await expect(a.client.send(a.ctx, "bob", "hi")).rejects.toBeInstanceOf(NoAccountError);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("cannot be opened; starting a new one"),
      expect.anything(),
    );
    expect(w.grappa.sends).toEqual([]);
  });
});

// 2430 "Authorising orders": Bob plays the bot. He saw a line from alice in
// a channel (or a plaintext PM), and asks her cic inside their session
// whether she sent it. Her cic answers ACK only on a verified session, only
// for a line it sent itself, only to the device that asked, and shows
// nothing either way.
describe("e2eClient, order challenges", () => {
  const LINE = "Bob: ping";
  const sha256 = async (body: string) =>
    Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
  const chal = async (w: World, body: string) => ({
    t: "chal",
    network: "AzzurraNet",
    channel: "#grappa",
    sender_mask: "alice!~alice@azzurra.example",
    line_sha256: await sha256(body),
    nonce: "bm9uY2Uwbm9uY2Uw",
    expires_at: Math.floor(w.now / 1000) + 15,
  });
  const acks = (w: World) => w.grappa.sends.filter((s) => s.by === "alice" && s.tag === ORDER_TAG);
  const sent = (w: World, a: Side, body: string) =>
    a.sent.record({ subject: SCOPE.subject, slug: SCOPE.slug, target: "#grappa", body, at: w.now });
  /** alice pins Bob's master by hand: the session is verified. */
  const verify = async (a: Side, b: Side) => {
    await a.client.pin(a.ctx, b.nick, (await ownOf(b)).master, true);
  };
  /** A session alice and Bob both hold, Bob's master verified on alice's side. */
  const verifiedPair = async () => {
    const p = await pair();
    await chat(p.a, p.b);
    await verify(p.a, p.b);
    return p;
  };

  it("ACKs the line this cic sent, ahead of text, with the CHAL's deadline, and shows nothing", async () => {
    const { w, a, b } = await verifiedPair();
    const rows = await rowsOf(a, "Bob");
    await sent(w, a, LINE);
    w.now += 2_000;

    const asked = await chal(w, LINE);
    await inject(w, b, "alice", asked);
    await a.client.drain(a.ctx);

    expect(acks(w)).toEqual([
      expect.objectContaining({
        target: "Bob",
        verb: "msg",
        to: (await ownOf(b)).did,
        priority: "control",
        expiresAt: asked.expires_at,
      }),
    ]);
    expect(await inners(w, b)).toEqual([{ t: "ack", nonce: "bm9uY2Uwbm9uY2Uw" }]);
    expect(await rowsOf(a, "Bob")).toEqual(rows);
  });

  it("ACKs only to the device the CHAL came from, of a master with two", async () => {
    const { w, a, b } = await pair();
    const b2 = await w.pairDevice(b);
    await chat(a, b);
    await b2.client.drain(b2.ctx);
    await verify(a, b);
    await sent(w, a, LINE);

    await inject(w, b2, "alice", await chal(w, LINE));
    await a.client.drain(a.ctx);

    expect(acks(w).map((s) => [s.verb, s.to])).toEqual([["msg", (await ownOf(b2)).did]]);
    expect(await inners(w, b2)).toEqual([{ t: "ack", nonce: "bm9uY2Uwbm9uY2Uw" }]);
    expect(await inners(w, b)).toEqual([]);
  });

  it("stays silent for a line this cic never sent: no ACK, no row, the inbox drained", async () => {
    const { w, a, b } = await verifiedPair();
    const rows = await rowsOf(a, "Bob");
    await sent(w, a, "Bob: pong");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await inject(w, b, "alice", await chal(w, LINE));
    await a.client.drain(a.ctx);

    expect(warn).toHaveBeenCalledWith(
      `[e2e] order challenge from Bob not confirmed: ${UNCONFIRMED["not-sent"]}`,
    );
    expect(acks(w)).toEqual([]);
    expect(await rowsOf(a, "Bob")).toEqual(rows);
    expect(await inboxOf(w, a)).toEqual([]);
  });

  it("stays silent on a session it has not verified, for a line it did send", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    await sent(w, a, LINE);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await inject(w, b, "alice", await chal(w, LINE));
    await a.client.drain(a.ctx);

    expect(warn).toHaveBeenCalledWith(
      "[e2e] order challenge from Bob not confirmed: their key is not verified",
    );
    expect(acks(w)).toEqual([]);
    expect(await inboxOf(w, a)).toEqual([]);
  });

  it("one sent line confirms one challenge: a second one for the same line gets no ACK", async () => {
    const { w, a, b } = await verifiedPair();
    await sent(w, a, LINE);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await inject(w, b, "alice", { ...(await chal(w, LINE)), nonce: "Zmlyc3Q" });
    await inject(w, b, "alice", { ...(await chal(w, LINE)), nonce: "c2Vjb25k" });
    await a.client.drain(a.ctx);

    expect(await inners(w, b)).toEqual([{ t: "ack", nonce: "Zmlyc3Q" }]);
    expect(warn).toHaveBeenCalledWith(
      `[e2e] order challenge from Bob not confirmed: ${UNCONFIRMED["not-sent"]}`,
    );
  });

  it("drops a malformed challenge without answering it", async () => {
    const { w, a, b } = await verifiedPair();
    await sent(w, a, LINE);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);

    await inject(w, b, "alice", { ...(await chal(w, LINE)), nonce: "" });
    await a.client.drain(a.ctx);

    expect(debug).toHaveBeenCalledWith("[e2e] dropped a malformed order challenge from Bob");
    expect(acks(w)).toEqual([]);
    expect(await inboxOf(w, a)).toEqual([]);
  });

  it("an ACK grappa refuses as too late is dropped, never sent again", async () => {
    const { w, a, b } = await verifiedPair();
    const rows = await rowsOf(a, "Bob");
    await sent(w, a, LINE);
    let tried = 0;
    w.grappa.refuse = (o) => {
      if (o.tag !== ORDER_TAG) return undefined;
      tried += 1;
      return "too-late";
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await inject(w, b, "alice", await chal(w, LINE));
    await a.client.drain(a.ctx);
    expect(tried).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      "[e2e] the ACK of an order to Bob was not sent (too-late); it goes unconfirmed",
    );
    w.grappa.refuse = () => undefined;
    await a.client.tick(a.ctx);
    await a.client.drain(a.ctx);

    expect(tried).toBe(1);
    expect(acks(w)).toEqual([]);
    expect(await rowsOf(a, "Bob")).toEqual(rows);
    // Forgotten: no NACK can name what never left.
    const kept = await a.accounts.withAccount(SLOT, async ({ state }) =>
      state.sent.filter((x) => x.msg.tag === ORDER_TAG),
    );
    expect(kept).toEqual([]);
  });

  it("a message grappa dropped after accepting it turns failed, with the reason", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    await a.client.send(a.ctx, "Bob", "lost on the way");
    const last = w.grappa.sends.at(-1);
    expect(last?.tag).toBeDefined();

    const report = await a.client.dropped(a.ctx, last?.msgid ?? "", "session-ended");

    expect(report.chats).toEqual(["bob"]);
    expect(await states(a, "Bob")).toEqual([
      ["sent", null],
      ["failed", "session-ended"],
    ]);
  });

  it("a drop of a message this device did not send, of an ACK, or of list traffic, changes no row", async () => {
    const { w, a, b } = await verifiedPair();
    await sent(w, a, LINE);
    await inject(w, b, "alice", await chal(w, LINE));
    await a.client.drain(a.ctx);
    const ack = acks(w)[0];
    const list = w.grappa.sends.find((s) => s.by === "alice" && s.tag === LIST_TAG);
    expect(ack).toBeDefined();
    expect(list).toBeDefined();
    const rows = await rowsOf(a, "Bob");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect((await a.client.dropped(a.ctx, "c29tZW9uZS1lbHNl", "late")).chats).toEqual([]);
    expect((await a.client.dropped(a.ctx, ack?.msgid ?? "", "late")).chats).toEqual([]);
    expect((await a.client.dropped(a.ctx, list?.msgid ?? "", "late")).chats).toEqual([]);

    expect(await rowsOf(a, "Bob")).toEqual(rows);
    // The ACK's loss is only logged; the others are no one's to report.
    expect(warn.mock.calls).toEqual([
      ["[e2e] the ACK of an order to Bob was not sent (late); it goes unconfirmed"],
    ]);
  });

  it("a drop of a message whose chat was deleted since is tolerated: the chat stays gone", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    await a.client.send(a.ctx, "Bob", "lost on the way");
    const msgid = w.grappa.sends.at(-1)?.msgid ?? "";
    await a.client.deleteChat(a.ctx, "Bob");

    expect((await a.client.dropped(a.ctx, msgid, "session-ended")).chats).toEqual([]);
    expect(await rowsOf(a, "Bob")).toEqual([]);
  });
});

// 2430 S1: a text one of alice's devices sends Bob reaches her other devices
// too, as a copy encrypted to each (grappa's copy door, never IRC), and reads
// there as sent, in the chat with Bob. alice has two devices, a and a2, a
// pairing apart; Bob has one.
describe("e2eClient, copies to our other devices", () => {
  /** alice on two devices and Bob on one. */
  const twoDevices = async () => {
    const { w, a, b } = await pair();
    return { w, a, a2: await w.pairDevice(a), b };
  };
  /**
   * Bob writes alice first: both her devices read it, and each holds a
   * session with him and, once he answered their list asks, his list.
   */
  const bobWrites = async ({ a, a2, b }: { a: Side; a2: Side; b: Side }) => {
    await b.client.send(b.ctx, "alice", "hi alice");
    for (const side of [b, a, a2, b, a, a2]) await side.client.drain(side.ctx);
  };
  /** A copy's row: sent, read at `at`, under an id from the inbox item that brought it. */
  const copied = (body: string, at: number) => ({
    kind: "out",
    id: expect.stringMatching(/^copy:\d+:0$/),
    at,
    body,
    state: "sent",
    reason: null,
  });

  it("a text sent on device A shows as a sent out row on device B, in the chat with the same peer", async () => {
    const { w, a, a2, b } = await twoDevices();
    await bobWrites({ a, a2, b });
    const second = await ownOf(a2);

    await a.client.send(a.ctx, "Bob", "hi Bob");
    const drained = await a2.client.drain(a2.ctx);

    expect(drained.chats).toEqual(["bob"]);
    expect(await rowsOf(a2, "bob")).toEqual([
      expect.objectContaining({ kind: "in", body: "hi alice" }),
      copied("hi Bob", w.now),
    ]);
    // alice's own text: the chat counts only Bob's as unread.
    expect((await a2.chats.chats(SLOT)).bob).toEqual({ nick: "Bob", open: true, unread: 1 });
    // Only grappa's copy door carried it: nothing alice handed the send door
    // (IRC) is for her own nick or her other device.
    expect(w.grappa.sends.filter((s) => s.by === "alice" && s.target !== "Bob")).toEqual([]);
    expect(w.grappa.sends.filter((s) => s.by === "alice" && s.to === second.did)).toEqual([]);
    await b.client.drain(b.ctx);
    expect(await bodies(b, "alice")).toEqual(["hi alice", "hi Bob"]);
  });

  it("a text grappa refuses is never copied", async () => {
    const { w, a, a2, b } = await twoDevices();
    await bobWrites({ a, a2, b });
    const copies = vi.spyOn(w.grappa.api, "copyE2e");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    w.grappa.refuse = (o) => (o.verb === "msg" || o.verb === "pkmsg" ? "rate-limited" : undefined);

    // Refused at the door, and lost waiting for keys that never came.
    await a.client.send(a.ctx, "Bob", "refused");
    await a.client.send(a.ctx, "nobody", "anyone there?");
    w.now += OUTQ_TTL_MS;
    await a.client.tick(a.ctx);
    await a2.client.drain(a2.ctx);

    expect(await states(a, "Bob")).toEqual([["failed", "rate-limited"]]);
    expect(await states(a, "nobody")).toEqual([["failed", "keys-timeout"]]);
    expect(copies).not.toHaveBeenCalled();
    expect(await bodies(a2, "bob")).toEqual(["hi alice"]);
    expect((await a2.chats.chats(SLOT)).nobody).toBeUndefined();

    // The next text grappa takes is copied, and only that one.
    w.grappa.refuse = () => undefined;
    await a.client.send(a.ctx, "Bob", "taken");
    await a2.client.drain(a2.ctx);
    expect(await bodies(a2, "bob")).toEqual(["hi alice", "taken"]);
  });

  it("a copy to a peer B never opened creates that chat with the out row", async () => {
    const { w, a, a2 } = await twoDevices();

    // No keys for Bob yet: the text waits for them, and nothing is copied
    // before grappa takes it.
    await a.client.send(a.ctx, "bob", "hello");
    await a2.client.drain(a2.ctx);
    expect(await a2.chats.chats(SLOT)).toEqual({});

    await a.client.drain(a.ctx);
    await a2.client.drain(a2.ctx);

    expect(await a2.chats.chats(SLOT)).toEqual({ bob: { nick: "bob", open: true, unread: 0 } });
    expect(await rowsOf(a2, "bob")).toEqual([copied("hello", w.now)]);
  });

  it("the second device's copy arrives after it claimed A's key once", async () => {
    const { w, a, a2, b } = await twoDevices();
    await bobWrites({ a, a2, b });
    const first = await ownOf(a);
    const claims = vi.spyOn(w.grappa.api, "claimE2eDeviceKeys");

    await a2.client.send(a2.ctx, "Bob", "one");
    await a2.client.send(a2.ctx, "Bob", "two");
    await a.client.drain(a.ctx);

    expect(claims.mock.calls.map(([, , did]) => did)).toEqual([first.did]);
    expect(await bodies(a, "bob")).toEqual(["hi alice", "one", "two"]);
    expect(await states(a, "bob")).toEqual([
      ["sent", null],
      ["sent", null],
    ]);
  });

  it("a text that reaches the peer's second device later, once its keys came, is copied once, with its first payload", async () => {
    const { w, a, a2, b } = await twoDevices();
    const b2 = await w.pairDevice(b);
    // alice holds a session with Bob's first device and his list, which
    // names his second: her text goes to the first now, to the second once
    // its keys come.
    await bobWrites({ a, a2, b });

    await a.client.send(a.ctx, "Bob", "hi Bob");
    await a.client.drain(a.ctx);
    await a2.client.drain(a2.ctx);
    await b2.client.drain(b2.ctx);

    const payloads = w.grappa.sends.filter(
      (s) => s.by === "alice" && s.tag !== undefined && s.tag !== LIST_TAG,
    );
    expect(payloads.map((s) => s.verb)).toEqual(["msg", "pkmsg"]);
    expect(await bodies(b2, "alice")).toContain("hi Bob");
    expect(await rowsOf(a2, "bob")).toEqual([
      expect.objectContaining({ kind: "in", body: "hi alice" }),
      copied("hi Bob", w.now),
    ]);
  });

  it("stores the sibling's ratchet step before its copy leaves", async () => {
    const { w, a, a2, b } = await twoDevices();
    await bobWrites({ a, a2, b });
    await a.client.send(a.ctx, "Bob", "one");
    const copies = vi.spyOn(w.grappa.api, "copyE2e");
    const store = a.vault.store;
    // The tab dies once the copy is on its way.
    a.vault.store = async (slot, sealed) => {
      if (copies.mock.calls.length > 0) throw new Error("tab closed");
      return store(slot, sealed);
    };

    await expect(a.client.send(a.ctx, "Bob", "two")).rejects.toThrow("tab closed");
    a.vault.store = store;
    await a.client.send(a.ctx, "Bob", "three");
    await a2.client.drain(a2.ctx);

    // Copied from a state that had not moved, "three" would reuse the key
    // "two" spent, and alice's other device could not read it.
    expect(await bodies(a2, "bob")).toEqual(["hi alice", "one", "two", "three"]);
  });

  it("re-draining the same inbox page adds the copy row once", async () => {
    const { w, a, a2 } = await twoDevices();
    await a.client.send(a.ctx, "bob", "hello");
    await a.client.drain(a.ctx);
    const store = a2.vault.store;
    // The tab dies storing the state that read the copy, after its row was
    // written: the next drain reads the copy again.
    a2.vault.store = async () => {
      throw new Error("tab closed");
    };
    await expect(a2.client.drain(a2.ctx)).rejects.toThrow("tab closed");
    a2.vault.store = store;
    // Then the acknowledgement fails: the next drain finds the page again.
    w.grappa.failAck = true;
    await expect(a2.client.drain(a2.ctx)).rejects.toThrow("ack refused");
    w.grappa.failAck = false;

    await a2.client.drain(a2.ctx);

    expect(await rowsOf(a2, "bob")).toEqual([copied("hello", w.now)]);
    expect(await inboxOf(w, a2)).toEqual([]);
  });

  it("a refused claim drops the waiting copies and asks no more", async () => {
    const { w, a, a2, b } = await twoDevices();
    await bobWrites({ a, a2, b });
    const second = await ownOf(a2);
    const claims = vi
      .spyOn(w.grappa.api, "claimE2eDeviceKeys")
      .mockRejectedValue(new api.ApiError(409, "keyless_device"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await a.client.send(a.ctx, "Bob", "lost");

    expect(claims).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls).toEqual([
      [
        `[e2e] grappa refused a key of our device ${second.did} (refused); the copies waiting for it are dropped`,
      ],
      ["[e2e] a copy of a text to Bob was not sent to one of our devices: sibling-no-keys"],
    ]);
    // Nothing waits for those keys: no clock, and no claim again.
    w.now += OUTQ_TTL_MS;
    await a.client.tick(a.ctx);
    await a.client.drain(a.ctx);
    expect(claims).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(2);

    // The next text asks for a key of its own, and is copied.
    claims.mockRestore();
    await a.client.send(a.ctx, "Bob", "next");
    await a2.client.drain(a2.ctx);
    expect(await bodies(a2, "bob")).toEqual(["hi alice", "next"]);
  });

  it("a copy grappa refuses is one console line, and is never sent again", async () => {
    const { w, a, a2, b } = await twoDevices();
    await bobWrites({ a, a2, b });
    const second = await ownOf(a2);
    const copies = vi
      .spyOn(w.grappa.api, "copyE2e")
      .mockRejectedValueOnce(new api.ApiError(413, "inbox_full"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await a.client.send(a.ctx, "Bob", "refused copy");
    w.now += OUTQ_TTL_MS;
    await a.client.tick(a.ctx);
    await a.client.drain(a.ctx);

    expect(copies).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls).toEqual([
      [`[e2e] grappa refused a pkmsg copy to our device ${second.did}: too-large`],
    ]);
    expect(await states(a, "Bob")).toEqual([["sent", null]]);

    await a.client.send(a.ctx, "Bob", "next");
    await a2.client.drain(a2.ctx);
    expect(copies).toHaveBeenCalledTimes(2);
    expect(await bodies(a2, "bob")).toEqual(["hi alice", "next"]);
  });

  it("a device paired after the devices were listed gets copies once that listing is a minute old", async () => {
    const { w, a, a2, b } = await twoDevices();
    await bobWrites({ a, a2, b });
    await a.client.send(a.ctx, "Bob", "one");
    const a3 = await w.pairDevice(a);

    await a.client.send(a.ctx, "Bob", "two");
    w.now += SIBLINGS_TTL_MS;
    await a.client.send(a.ctx, "Bob", "three");
    w.now += 1;
    await a.client.send(a.ctx, "Bob", "four");
    await a2.client.drain(a2.ctx);
    await a3.client.drain(a3.ctx);

    expect(await bodies(a2, "bob")).toEqual(["hi alice", "one", "two", "three", "four"]);
    expect(await bodies(a3, "bob")).toEqual(["four"]);
  });

  it("a listing of the devices grappa refuses is one console line, and the next copy lists them again", async () => {
    const { w, a, a2, b } = await twoDevices();
    await bobWrites({ a, a2, b });
    vi.spyOn(w.grappa.api, "listE2eDevices").mockRejectedValueOnce(
      new api.ApiError(503, "db_unavailable"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // No sibling known yet: nothing to copy "one" to.
    await a.client.send(a.ctx, "Bob", "one");
    expect(warn.mock.calls).toEqual([
      ["[e2e] grappa refused the list of our devices (refused); copies go to the known ones"],
    ]);
    await a.client.send(a.ctx, "Bob", "two");
    await a2.client.drain(a2.ctx);

    expect(await bodies(a2, "bob")).toEqual(["hi alice", "two"]);
  });

  it("an own item that is no pkmsg or msg is dropped on the copy path, never read as a peer's", async () => {
    const { w, a, a2 } = await twoDevices();
    const first = await ownOf(a);
    const second = await ownOf(a2);
    vi.spyOn(w.grappa.api, "listE2eDeviceInbox").mockResolvedValueOnce({
      messages: [
        {
          kind: "e2e_message",
          network: "",
          id: 1,
          from: "alice",
          from_did: first.did,
          to_did: second.did,
          verb: "nack",
          msgid: "bXNnaWQ",
          payload: '{"v":2}',
          own: true,
        },
      ],
    });
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);

    const drained = await a2.client.drain(a2.ctx);

    expect(drained.chats).toEqual([]);
    expect(debug.mock.calls).toEqual([
      [`[e2e] dropped an own nack from our device ${first.did}: not a copy`],
    ]);
    expect(w.grappa.sends.filter((s) => s.by === "alice")).toEqual([]);
  });
});
