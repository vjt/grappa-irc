// issue 2430 — cic's E2E client between grappa's three doors (the inbox, its
// acknowledgement, the send door) and what the user sees (the chat history).
// Two clients over a fake grappa (`helpers/e2eClients.ts`): the engines, the
// account store and the chat store are the real ones over in-memory twins of
// IndexedDB and Web Locks.
import { describe, expect, it } from "vitest";
import { accountStore } from "../lib/e2e/accountStore";
import { chatStore } from "../lib/e2e/chatStore";
import { e2eClient, NoAccountError } from "../lib/e2e/client";
import { KEYREQ_RETRY_MS, OUTQ_TTL_MS } from "../lib/e2e/engine";
import { ORDER_TAG } from "../lib/e2e/orders";
import { chat, inject, inners, pair, rowsOf, type Side, SLOT, World } from "./helpers/e2eClients";
import { memoryLock, memoryVault } from "./helpers/e2eVault";
import { olm } from "./helpers/olm";

const bodies = async (side: Side, nick: string) =>
  (await rowsOf(side, nick)).map((r) => (r.kind === "in" || r.kind === "out" ? r.body : r.kind));
const states = async (side: Side, nick: string) =>
  (await rowsOf(side, nick)).flatMap((r) => (r.kind === "out" ? [[r.state, r.reason]] : []));

describe("e2eClient", () => {
  it("sends through the keys, the peer reads it in its chat, and both inboxes empty", async () => {
    const { w, a, b } = await pair();

    const sent = await a.client.send(a.ctx, "bob", "hello");
    expect(sent.chats).toEqual(["bob"]);
    expect(await states(a, "bob")).toEqual([["queued", null]]);
    expect(sent.waiting).toBe(true);

    const drained = await a.client.drain(a.ctx);
    expect(drained.waiting).toBe(false);
    expect(await states(a, "bob")).toEqual([["sent", null]]);

    const read = await b.client.drain(b.ctx);
    expect(read).toEqual({ chats: ["alice"], pkmsgs: 1, waiting: false });
    expect(await rowsOf(b, "alice")).toEqual([
      expect.objectContaining({ kind: "in", nick: "alice", body: "hello" }),
    ]);
    expect((await b.chats.chats(SLOT)).alice).toEqual({ nick: "alice", open: true, unread: 1 });
    expect(w.grappa.inboxes.get("alice")).toEqual([]);
    expect(w.grappa.inboxes.get("bob")).toEqual([]);
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
    expect(w.grappa.inboxes.get("alice")).toEqual([]);
  });

  it("an inbox message processed again after a failed acknowledgement adds nothing", async () => {
    const { w, a, b } = await pair();
    await a.client.send(a.ctx, "bob", "hello");
    await a.client.drain(a.ctx);
    w.grappa.failAck = true;

    await expect(b.client.drain(b.ctx)).rejects.toThrow("ack refused");
    w.grappa.failAck = false;
    await b.client.drain(b.ctx);

    expect(await bodies(b, "alice")).toEqual(["hello"]);
    expect(w.grappa.inboxes.get("bob")).toEqual([]);
    // Not taken for a lost session: nothing went back to alice.
    expect(w.grappa.sends.filter((s) => s.by === "Bob")).toEqual([]);
  });

  it("writes a decrypted message down before the state that spent its key", async () => {
    const { w, a, b } = await pair();
    await a.client.send(a.ctx, "bob", "hello");
    await a.client.drain(a.ctx);
    const store = b.chatVault.store;
    // The tab dies writing the chat. Had the state that spent the message's
    // key been stored first, the message would be gone for good.
    b.chatVault.store = async () => {
      throw new Error("tab closed");
    };

    await expect(b.client.drain(b.ctx)).rejects.toThrow("tab closed");
    b.chatVault.store = store;
    await b.client.drain(b.ctx);

    expect(await bodies(b, "alice")).toEqual(["hello"]);
    expect(w.grappa.sends.filter((s) => s.by === "Bob")).toEqual([]);
    // The state that was finally stored is the one that opened it.
    await b.client.send(b.ctx, "alice", "hi");
    await a.client.drain(a.ctx);
    expect(await bodies(a, "bob")).toEqual(["hello", "hi"]);
  });

  it("stores the ratchet step before its ciphertext leaves", async () => {
    const { w, a, b } = await pair();
    await a.client.send(a.ctx, "bob", "hello");
    await a.client.drain(a.ctx);
    await b.client.drain(b.ctx);
    await b.client.send(b.ctx, "alice", "hi");
    await a.client.drain(a.ctx);
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
    await b.client.drain(b.ctx);
    expect(await bodies(b, "alice")).toEqual(["hello"]);
  });

  it("marks a message whose keys never came as failed, on a tick, and stops waiting", async () => {
    const { w, a } = await pair();

    const sent = await a.client.send(a.ctx, "nobody", "anyone there?");
    expect(sent.waiting).toBe(true);
    w.now += OUTQ_TTL_MS;
    const ticked = await a.client.tick(a.ctx);

    expect(ticked).toEqual({ chats: ["nobody"], pkmsgs: 0, waiting: false });
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

  it("tells the recipient of a message it cannot read, and NACKs it", async () => {
    const { w, a, b } = await pair();
    await a.client.send(a.ctx, "bob", "hello");
    await a.client.drain(a.ctx);
    await b.client.drain(b.ctx);
    await b.client.send(b.ctx, "alice", "hi");
    await a.client.drain(a.ctx);
    // Bob loses his sessions; alice's next message arrives on one.
    await b.accounts.withAccount(SLOT, async ({ state }) => {
      state.sessions = {};
    });

    await a.client.send(a.ctx, "bob", "lost");
    await b.client.drain(b.ctx);

    expect(await bodies(b, "alice")).toEqual(["hello", "hi", "undecryptable"]);
    // Bob's answer went on the session alice opened, as a normal message.
    expect(w.grappa.sends.filter((s) => s.by === "Bob").map((s) => s.verb)).toEqual([
      "msg",
      "nack",
    ]);
  });

  it("shows the alarm in the chat when a new key speaks for a pinned nick", async () => {
    const { w, a, b } = await pair();
    await a.client.send(a.ctx, "bob", "hello");
    await a.client.drain(a.ctx);
    await b.client.drain(b.ctx);
    // A new account takes bob's nick and writes first.
    const b2 = await w.join("Bob");

    await b2.client.send(b2.ctx, "alice", "it's me, honest");
    await b2.client.drain(b2.ctx);
    await a.client.drain(a.ctx);

    const rows = await rowsOf(a, "bob");
    expect(rows.map((r) => r.kind)).toEqual(["out", "key_alarm"]);
    expect(rows[1]).toEqual(
      expect.objectContaining({ kind: "key_alarm", nick: "Bob", presented: expect.any(String) }),
    );
    expect(await bodies(a, "bob")).not.toContain("it's me, honest");
  });

  it("pins a key by hand: the chat says so, and the identity reads verified", async () => {
    const { a, b } = await pair();
    const key = await b.accounts.withAccount(SLOT, async ({ account }) => account.ed25519_key());

    expect(await a.client.pin(a.ctx, "Bob", key, true)).toEqual({
      result: "pinned",
      chats: ["bob"],
    });

    expect(await rowsOf(a, "bob")).toEqual([
      expect.objectContaining({ kind: "pinned", nick: "Bob", ed25519: key }),
    ]);
    const own = await a.accounts.withAccount(SLOT, async ({ account }) => account.ed25519_key());
    expect(await a.client.identity(a.ctx, ["bob", "carol"])).toEqual({
      own,
      peers: { bob: { ed25519: key, verified: true }, carol: null },
      sas: { bob: null, carol: null },
    });
  });

  it("takes the alarm's key unverified: the chat says so, and the identity reads not verified", async () => {
    const { a, b } = await pair();
    const key = await b.accounts.withAccount(SLOT, async ({ account }) => account.ed25519_key());

    expect(await a.client.pin(a.ctx, "Bob", key, false)).toEqual({
      result: "pinned",
      chats: ["bob"],
    });

    expect(await rowsOf(a, "bob")).toEqual([
      expect.objectContaining({ kind: "accepted", nick: "Bob", ed25519: key }),
    ]);
    expect((await a.client.identity(a.ctx, ["bob"])).peers).toEqual({
      bob: { ed25519: key, verified: false },
    });
  });

  it("taking a key already verified (under another nick) says it is pinned, not unverified", async () => {
    const { a, b } = await pair();
    const key = await b.accounts.withAccount(SLOT, async ({ account }) => account.ed25519_key());
    await a.client.pin(a.ctx, "carol", key, true);

    await a.client.pin(a.ctx, "Bob", key, false);

    expect(await rowsOf(a, "bob")).toEqual([
      expect.objectContaining({ kind: "pinned", nick: "Bob", ed25519: key }),
    ]);
    expect((await a.client.identity(a.ctx, ["bob"])).peers).toEqual({
      bob: { ed25519: key, verified: true },
    });
  });

  it("writes nothing for a key it refuses", async () => {
    const { a } = await pair();

    expect(await a.client.pin(a.ctx, "bob", "not a key", true)).toEqual({
      result: "bad-key",
      chats: [],
    });

    expect(await a.chats.chats(SLOT)).toEqual({});
  });

  it("deletes a chat: its rows and the plaintext go, the pin and the sessions stay", async () => {
    const { w, a, b } = await pair();
    const key = await b.accounts.withAccount(SLOT, async ({ account }) => account.ed25519_key());
    await a.client.pin(a.ctx, "Bob", key, true);
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
      bob: { ed25519: key, verified: true },
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

  it("never creates an account: that is the bundle sync's, which clears grappa's stale keys", async () => {
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
      door: w.grappa.door("alice"),
      orders: async () => false,
    };

    await expect(client.drain(ctx)).rejects.toBeInstanceOf(NoAccountError);
    await expect(client.send(ctx, "bob", "hi")).rejects.toBeInstanceOf(NoAccountError);
    await expect(client.identity(ctx, ["bob"])).rejects.toBeInstanceOf(NoAccountError);

    expect(vault.records.size).toBe(0);
  });
});

// 2430 "Authorising orders": Bob plays the bot. He saw a line from alice in
// a channel (or a plaintext PM), and asks her cic inside their session
// whether she sent it. Her cic answers ACK only for a line it sent itself,
// and shows nothing either way.
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

  it("ACKs the line this cic sent, ahead of text, with the CHAL's deadline, and shows nothing", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    const rows = await rowsOf(a, "Bob");
    a.sent.record({ slug: "azzurra", target: "#grappa", body: LINE, at: w.now });
    w.now += 2_000;

    const asked = await chal(w, LINE);
    await inject(w, b, "alice", asked);
    await a.client.drain(a.ctx);

    expect(acks(w)).toEqual([
      expect.objectContaining({
        target: "Bob",
        verb: "msg",
        priority: "control",
        expiresAt: asked.expires_at,
      }),
    ]);
    expect(await inners(w, b)).toEqual([{ t: "ack", nonce: "bm9uY2Uwbm9uY2Uw" }]);
    expect(await rowsOf(a, "Bob")).toEqual(rows);
  });

  it("stays silent for a line this cic never sent: no ACK, no row, the inbox drained", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    const rows = await rowsOf(a, "Bob");
    a.sent.record({ slug: "azzurra", target: "#grappa", body: "Bob: pong", at: w.now });

    await inject(w, b, "alice", await chal(w, LINE));
    await a.client.drain(a.ctx);

    expect(acks(w)).toEqual([]);
    expect(await rowsOf(a, "Bob")).toEqual(rows);
    expect(w.grappa.inboxes.get("alice")).toEqual([]);
  });

  it("an ACK grappa refuses as too late is dropped, never sent again", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    const rows = await rowsOf(a, "Bob");
    a.sent.record({ slug: "azzurra", target: "#grappa", body: LINE, at: w.now });
    w.grappa.refuse = (o) => (o.tag === ORDER_TAG ? "too-late" : undefined);

    await inject(w, b, "alice", await chal(w, LINE));
    await a.client.drain(a.ctx);
    w.grappa.refuse = () => undefined;
    await a.client.tick(a.ctx);
    await a.client.drain(a.ctx);

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
    const sent = w.grappa.sends.at(-1);
    expect(sent?.tag).toBeDefined();

    const report = await a.client.dropped(a.ctx, sent?.msgid ?? "", "session-ended");

    expect(report.chats).toEqual(["bob"]);
    expect(await states(a, "Bob")).toEqual([
      ["sent", null],
      ["failed", "session-ended"],
    ]);
  });

  it("a drop of a message this device did not send, or of an ACK, changes no row", async () => {
    const { w, a, b } = await pair();
    await chat(a, b);
    a.sent.record({ slug: "azzurra", target: "#grappa", body: LINE, at: w.now });
    await inject(w, b, "alice", await chal(w, LINE));
    await a.client.drain(a.ctx);
    const ack = acks(w)[0];
    const rows = await rowsOf(a, "Bob");

    expect((await a.client.dropped(a.ctx, "c29tZW9uZS1lbHNl", "late")).chats).toEqual([]);
    expect((await a.client.dropped(a.ctx, ack?.msgid ?? "", "late")).chats).toEqual([]);

    expect(await rowsOf(a, "Bob")).toEqual(rows);
  });
});
