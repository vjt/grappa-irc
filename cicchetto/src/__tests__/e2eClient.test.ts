// issue 2430 — cic's E2E client between grappa's three doors (the inbox, its
// acknowledgement, the send door) and what the user sees (the chat history).
// Two clients over a fake grappa that does what the real one does with
// them: a per-recipient inbox with AUTOINCREMENT ids and paging, a msgid per
// accepted send, a KEYREQ answered from the target's uploaded bundle, and a
// refusal when told to. The engines, the account store and the chat store are
// the real ones over in-memory twins of IndexedDB and Web Locks.
import { describe, expect, it } from "vitest";
import { type AccountStore, accountStore } from "../lib/e2e/accountStore";
import { type ChatRow, type ChatStore, chatStore, type DoorRefusal } from "../lib/e2e/chatStore";
import {
  type Door,
  type E2eContext,
  e2eClient,
  type InboxMessage,
  NoAccountError,
} from "../lib/e2e/client";
import { OUTQ_TTL_MS, type Outbound } from "../lib/e2e/engine";
import { topUp } from "../lib/e2e/keyBundle";
import { base64Unpadded, fold } from "../lib/e2e/wire";
import { type MemoryVault, memoryLock, memoryVault } from "./helpers/e2eVault";
import { olm } from "./helpers/olm";

const SLOT = "user:0b5e:1";

class Grappa {
  inboxes = new Map<string, InboxMessage[]>();
  bundles = new Map<string, { otks: string[]; fallback: string }>();
  nextId = 1;
  pageSize = 100;
  /** Every send the door took, with who sent it. */
  sends: (Outbound & { by: string })[] = [];
  refuse: (o: Outbound) => DoorRefusal | undefined = () => undefined;
  failAck = false;

  private inbox(nick: string): InboxMessage[] {
    const key = fold(nick);
    const found = this.inboxes.get(key) ?? [];
    this.inboxes.set(key, found);
    return found;
  }

  deliver(to: string, m: Omit<InboxMessage, "id">): void {
    this.inbox(to).push({ ...m, id: this.nextId++ });
  }

  door(nick: string): Door {
    return {
      inbox: async (after) =>
        this.inbox(nick)
          .filter((m) => m.id > after)
          .slice(0, this.pageSize),
      ack: async (ids) => {
        if (this.failAck) throw new Error("ack refused");
        this.inboxes.set(
          fold(nick),
          this.inbox(nick).filter((m) => !ids.includes(m.id)),
        );
      },
      send: async (o) => {
        const refused = this.refuse(o);
        if (refused !== undefined) return { refused };
        this.sends.push({ ...o, by: nick });
        const msgid = base64Unpadded(crypto.getRandomValues(new Uint8Array(8)));
        if (o.verb === "keyreq") {
          const bundle = this.bundles.get(fold(o.target));
          if (bundle !== undefined) {
            this.deliver(nick, {
              from: o.target,
              verb: "keys",
              msgid,
              payload: bundle.otks.shift() ?? bundle.fallback,
            });
          }
        } else {
          this.deliver(o.target, { from: nick, verb: o.verb, msgid, payload: o.payload });
        }
        return { msgid };
      },
    };
  }
}

type Side = {
  nick: string;
  ctx: E2eContext;
  vault: MemoryVault;
  chatVault: MemoryVault;
  accounts: AccountStore;
  chats: ChatStore;
  client: ReturnType<typeof e2eClient>;
};

class World {
  now = 1_700_000_000_000;
  grappa = new Grappa();

  /** A cic on `nick`, with its key bundle on grappa. */
  async join(nick: string): Promise<Side> {
    const vault = memoryVault();
    const lock = memoryLock();
    const accounts = accountStore(olm(), vault, lock);
    const chatVault = memoryVault();
    const chats = chatStore(chatVault, lock);
    await accounts.withAccount(SLOT, async ({ account }) => {
      const upload = topUp(account, { one_time_keys: 0, fallback: false });
      if (upload === null || upload.fallback === null) throw new Error("no bundle built");
      account.mark_keys_as_published();
      this.grappa.bundles.set(fold(nick), {
        otks: [...upload.one_time_keys],
        fallback: upload.fallback,
      });
    });
    return {
      nick,
      ctx: { slot: SLOT, ownNick: nick, door: this.grappa.door(nick) },
      vault,
      chatVault,
      accounts,
      chats,
      client: e2eClient(olm(), accounts, chats, () => this.now),
    };
  }
}

const rowsOf = (side: Side, nick: string): Promise<ChatRow[]> => side.chats.rows(SLOT, nick);
const bodies = async (side: Side, nick: string) =>
  (await rowsOf(side, nick)).map((r) => (r.kind === "in" || r.kind === "out" ? r.body : r.kind));
const states = async (side: Side, nick: string) =>
  (await rowsOf(side, nick)).flatMap((r) => (r.kind === "out" ? [[r.state, r.reason]] : []));

async function pair(): Promise<{ w: World; a: Side; b: Side }> {
  const w = new World();
  return { w, a: await w.join("alice"), b: await w.join("Bob") };
}

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

    expect(await a.client.pin(a.ctx, "Bob", key)).toEqual({ result: "pinned", chats: ["bob"] });

    expect(await rowsOf(a, "bob")).toEqual([
      expect.objectContaining({ kind: "pinned", nick: "Bob", ed25519: key }),
    ]);
    const own = await a.accounts.withAccount(SLOT, async ({ account }) => account.ed25519_key());
    expect(await a.client.identity(a.ctx, ["bob", "carol"])).toEqual({
      own,
      peers: { bob: { ed25519: key, verified: true }, carol: null },
    });
  });

  it("writes nothing for a key it refuses", async () => {
    const { a } = await pair();

    expect(await a.client.pin(a.ctx, "bob", "not a key")).toEqual({ result: "bad-key", chats: [] });

    expect(await a.chats.chats(SLOT)).toEqual({});
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
    );
    const ctx = { slot: SLOT, ownNick: "alice", door: w.grappa.door("alice") };

    await expect(client.drain(ctx)).rejects.toBeInstanceOf(NoAccountError);
    await expect(client.send(ctx, "bob", "hi")).rejects.toBeInstanceOf(NoAccountError);
    await expect(client.identity(ctx, ["bob"])).rejects.toBeInstanceOf(NoAccountError);

    expect(vault.records.size).toBe(0);
  });
});
