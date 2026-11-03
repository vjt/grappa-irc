// issue 2430 — the encrypted queries' history on this device: what it keeps,
// what it refuses to add twice, and what it lets the database see. The vault
// and the lock are the in-memory twins of IndexedDB and Web Locks; the
// sealing is the real AES-GCM.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_ROWS_MAX,
  type ChatChange,
  type ChatRow,
  chatStore,
  type IdentityCheck,
  type WirePayload,
} from "../lib/e2e/chatStore";
import { memoryLock, memoryVault } from "./helpers/e2eVault";

const SLOT = "user:0b5e:1";
const KEY = "A".repeat(43);

const inRow = (id: string, body: string): ChatRow => ({
  kind: "in",
  id,
  at: 1,
  nick: "Bob",
  ed25519: KEY,
  body,
});

const add = (nick: string, row: ChatRow, unread = true): ChatChange => ({
  op: "add",
  nick,
  row,
  unread,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chatStore", () => {
  it("keeps what is added, in order, per chat, and answers the chats it touched", async () => {
    const chats = chatStore(memoryVault(), memoryLock());

    const touched = await chats.apply(SLOT, [
      add("Bob", inRow("in:1:0", "one")),
      add("carol", { kind: "undecryptable", id: "in:2:0", at: 2, nick: "carol" }),
      add("bob", inRow("in:3:0", "two")),
    ]);

    expect(touched).toEqual(["bob", "carol"]);
    expect((await chats.rows(SLOT, "BOB")).map((r) => r.id)).toEqual(["in:1:0", "in:3:0"]);
    expect(await chats.chats(SLOT)).toEqual({
      bob: { nick: "Bob", open: true, unread: 2 },
      carol: { nick: "carol", open: true, unread: 1 },
    });
  });

  it("never adds a row whose id is already there, and counts it once", async () => {
    const chats = chatStore(memoryVault(), memoryLock());

    await chats.apply(SLOT, [add("bob", inRow("in:1:0", "one"))]);
    await chats.apply(SLOT, [add("bob", inRow("in:1:0", "one"))]);

    expect(await chats.rows(SLOT, "bob")).toHaveLength(1);
    expect((await chats.chats(SLOT)).bob?.unread).toBe(1);
  });

  it("moves an outgoing row along; an `out` for a chat that does not exist creates nothing", async () => {
    const chats = chatStore(memoryVault(), memoryLock());
    const out: ChatRow = {
      kind: "out",
      id: "t1",
      at: 1,
      body: "hi",
      state: "sending",
      reason: null,
    };
    await chats.apply(SLOT, [add("bob", out, false)]);

    const touched = await chats.apply(SLOT, [
      { op: "out", nick: "bob", id: "t1", state: "failed", reason: "rate-limited", wire: null },
      { op: "out", nick: "nobody", id: "t9", state: "sent", reason: null, wire: null },
    ]);

    expect(touched).toEqual(["bob"]);
    expect(await chats.rows(SLOT, "bob")).toEqual([
      { ...out, state: "failed", reason: "rate-limited" },
    ]);
    expect(Object.keys(await chats.chats(SLOT))).toEqual(["bob"]);
  });

  it("never moves a sent message back to waiting: a re-send after a NACK waits for keys, the row stays sent", async () => {
    const chats = chatStore(memoryVault(), memoryLock());
    const out: ChatRow = {
      kind: "out",
      id: "t1",
      at: 1,
      body: "hi",
      state: "sending",
      reason: null,
    };
    await chats.apply(SLOT, [add("bob", out, false)]);
    const move = (state: "queued" | "sending" | "sent" | "failed"): ChatChange => ({
      op: "out",
      nick: "bob",
      id: "t1",
      state,
      reason: state === "failed" ? "keys-timeout" : null,
      wire: null,
    });
    const state = async () => (await chats.rows(SLOT, "bob"))[0];

    await chats.apply(SLOT, [move("queued")]);
    expect(await state()).toEqual({ ...out, state: "queued" });
    await chats.apply(SLOT, [move("sent")]);
    await chats.apply(SLOT, [move("queued")]);
    await chats.apply(SLOT, [move("sending")]);
    expect(await state()).toEqual({ ...out, state: "sent" });

    // Lost after all (the re-send never reached the device): failed.
    await chats.apply(SLOT, [move("failed")]);
    expect(await state()).toEqual({ ...out, state: "failed", reason: "keys-timeout" });
  });

  it("keeps each payload an outgoing row went as, in the order grappa took them; a move with none keeps them (issue 2513)", async () => {
    const chats = chatStore(memoryVault(), memoryLock());
    const out: ChatRow = {
      kind: "out",
      id: "t1",
      at: 1,
      body: "hi",
      state: "sending",
      reason: null,
    };
    await chats.apply(SLOT, [add("bob", out, false)]);
    const first: WirePayload = { verb: "pkmsg", msgid: "Zm9vYmFyYmF", payload: '{"bodies":{}}' };
    const again: WirePayload = { verb: "msg", msgid: "YmF6cXV4cXV", payload: '{"ck":"x"}' };
    const sent = (wire: WirePayload | null): ChatChange => ({
      op: "out",
      nick: "bob",
      id: "t1",
      state: "sent",
      reason: null,
      wire,
    });
    const state = async () => (await chats.rows(SLOT, "bob"))[0];

    await chats.apply(SLOT, [sent(first)]);
    expect(await state()).toEqual({ ...out, state: "sent", wire: [first] });
    // A re-send after a NACK goes as a second payload.
    await chats.apply(SLOT, [sent(again)]);
    expect(await state()).toEqual({ ...out, state: "sent", wire: [first, again] });
    await chats.apply(SLOT, [
      { op: "out", nick: "bob", id: "t1", state: "failed", reason: "unreadable", wire: null },
    ]);
    expect(await state()).toEqual({
      ...out,
      state: "failed",
      reason: "unreadable",
      wire: [first, again],
    });
  });

  it("reopens a closed chat on a new row, and `read` clears its count", async () => {
    const chats = chatStore(memoryVault(), memoryLock());
    await chats.apply(SLOT, [add("Bob", inRow("in:1:0", "one"))]);
    await chats.close(SLOT, "bob");
    expect((await chats.chats(SLOT)).bob).toEqual({ nick: "Bob", open: false, unread: 1 });

    await chats.apply(SLOT, [add("bob", inRow("in:2:0", "two"))]);
    expect((await chats.chats(SLOT)).bob).toEqual({ nick: "Bob", open: true, unread: 2 });

    await chats.read(SLOT, "bob");
    expect((await chats.chats(SLOT)).bob?.unread).toBe(0);
    expect(await chats.rows(SLOT, "bob")).toHaveLength(2);
  });

  // issue 2485 — the window shows messages, an alarm's step card and a peer's
  // request to compare emoji; the rest of the key's history is the rail's
  // state, and a row nobody will see must not open a chat or badge it.
  it("a row the window does not show neither reopens a closed chat nor counts as unread", async () => {
    const chats = chatStore(memoryVault(), memoryLock());
    await chats.apply(SLOT, [add("Bob", inRow("in:1:0", "one"))]);
    await chats.close(SLOT, "bob");

    await chats.apply(SLOT, [
      add("bob", { kind: "sas_cancelled", id: "s1", at: 2, nick: "bob", by: "peer", reason: "x" }),
      add("bob", { kind: "sas_asked", id: "s2", at: 3, nick: "bob", by: "you" }, false),
      add("bob", { kind: "verified", id: "s3", at: 4, nick: "bob", ed25519: KEY }, false),
      add("bob", { kind: "pinned", id: "p1", at: 5, nick: "bob", ed25519: KEY }, false),
      add("bob", { kind: "accepted", id: "p2", at: 6, nick: "bob", ed25519: KEY }, false),
    ]);

    expect((await chats.chats(SLOT)).bob).toEqual({ nick: "Bob", open: false, unread: 1 });
    expect(await chats.rows(SLOT, "bob")).toHaveLength(6);
  });

  it("a peer's request to compare emoji and a key alarm reopen a closed chat and count", async () => {
    const chats = chatStore(memoryVault(), memoryLock());
    await chats.apply(SLOT, [add("Bob", inRow("in:1:0", "one"))]);
    await chats.close(SLOT, "bob");

    await chats.apply(SLOT, [
      add("bob", { kind: "sas_asked", id: "s1", at: 2, nick: "bob", by: "peer" }),
    ]);
    expect((await chats.chats(SLOT)).bob).toEqual({ nick: "Bob", open: true, unread: 2 });

    await chats.close(SLOT, "bob");
    await chats.apply(SLOT, [
      add("bob", { kind: "key_alarm", id: "a1", at: 3, nick: "bob", presented: KEY }),
    ]);
    expect((await chats.chats(SLOT)).bob).toEqual({ nick: "Bob", open: true, unread: 3 });
  });

  it("a row the window does not show, for a nick with no chat, keeps it on a closed one", async () => {
    const chats = chatStore(memoryVault(), memoryLock());

    await chats.apply(SLOT, [
      add("Bob", {
        kind: "sas_cancelled",
        id: "s1",
        at: 2,
        nick: "Bob",
        by: "you",
        reason: "timeout",
      }),
    ]);

    expect(await chats.chats(SLOT)).toEqual({ bob: { nick: "Bob", open: false, unread: 0 } });
  });

  it("an identity check alone leaves the chat's sealed rows as they were", async () => {
    const vault = memoryVault();
    const chats = chatStore(vault, memoryLock());
    await chats.apply(SLOT, [add("Bob", inRow("in:1:0", "one"))]);
    const before = new Map(vault.records);

    const check: IdentityCheck = {
      at: 10,
      network: "AzzurraNet",
      channel: "#grappa",
      passed: true,
      reason: null,
    };
    await chats.apply(SLOT, [{ op: "check", nick: "bob", check }]);

    // The index is sealed again (it holds the check); the record of rows is not.
    const changed = [...vault.records].filter(([key, sealed]) => before.get(key) !== sealed);
    expect(changed.map(([key]) => key)).toEqual([`index:${SLOT}`]);
  });

  it("keeps the last identity check on the chat: no row, no unread, a closed chat stays closed", async () => {
    const chats = chatStore(memoryVault(), memoryLock());
    await chats.apply(SLOT, [add("Bob", inRow("in:1:0", "one"))]);
    await chats.close(SLOT, "bob");
    const first: IdentityCheck = {
      at: 10,
      network: "AzzurraNet",
      channel: "#grappa",
      passed: true,
      reason: null,
    };
    const second: IdentityCheck = { ...first, at: 20, passed: false, reason: "not-sent" };

    const touched = await chats.apply(SLOT, [{ op: "check", nick: "BOB", check: first }]);
    await chats.apply(SLOT, [{ op: "check", nick: "bob", check: second }]);

    expect(touched).toEqual(["bob"]);
    expect((await chats.chats(SLOT)).bob).toEqual({
      nick: "Bob",
      open: false,
      unread: 1,
      check: second,
    });
    expect((await chats.rows(SLOT, "bob")).map((r) => r.id)).toEqual(["in:1:0"]);
  });

  it("keeps an identity check from a nick with no chat on a closed, empty one", async () => {
    const chats = chatStore(memoryVault(), memoryLock());
    const check: IdentityCheck = {
      at: 10,
      network: "AzzurraNet",
      channel: "#grappa",
      passed: true,
      reason: null,
    };

    await chats.apply(SLOT, [{ op: "check", nick: "Bob", check }]);

    expect(await chats.chats(SLOT)).toEqual({
      bob: { nick: "Bob", open: false, unread: 0, check },
    });
    expect(await chats.rows(SLOT, "bob")).toEqual([]);
  });

  it("opens an empty chat, under the nick as typed", async () => {
    const chats = chatStore(memoryVault(), memoryLock());

    await chats.open(SLOT, "Bob");

    expect(await chats.chats(SLOT)).toEqual({ bob: { nick: "Bob", open: true, unread: 0 } });
    expect(await chats.rows(SLOT, "bob")).toEqual([]);
  });

  it("keeps the newest rows past its bound", async () => {
    const chats = chatStore(memoryVault(), memoryLock());
    const changes = Array.from({ length: CHAT_ROWS_MAX + 2 }, (_, i) =>
      add("bob", inRow(`in:${i}:0`, `m${i}`)),
    );

    await chats.apply(SLOT, changes);

    const rows = await chats.rows(SLOT, "bob");
    expect(rows).toHaveLength(CHAT_ROWS_MAX);
    expect(rows[0]?.id).toBe("in:2:0");
    expect(rows.at(-1)?.id).toBe(`in:${CHAT_ROWS_MAX + 1}:0`);
  });

  it("lets two writers of one slot both land", async () => {
    const chats = chatStore(memoryVault(), memoryLock());

    await Promise.all([
      chats.apply(SLOT, [add("bob", inRow("in:1:0", "one"))]),
      chats.apply(SLOT, [add("carol", inRow("in:2:0", "two"))]),
      chats.apply(SLOT, [add("bob", inRow("in:3:0", "three"))]),
    ]);

    expect(Object.keys(await chats.chats(SLOT)).sort()).toEqual(["bob", "carol"]);
    expect(await chats.rows(SLOT, "bob")).toHaveLength(2);
  });

  it("deletes a chat: its rows and its entry go, its record leaves the vault, the others stay", async () => {
    const vault = memoryVault();
    const chats = chatStore(vault, memoryLock());
    await chats.apply(SLOT, [
      add("Bob", inRow("in:1:0", "one")),
      add("carol", { kind: "undecryptable", id: "in:2:0", at: 2, nick: "carol" }),
    ]);
    expect(vault.records.size).toBe(3);

    await chats.remove(SLOT, "BOB");

    expect(await chats.chats(SLOT)).toEqual({ carol: { nick: "carol", open: true, unread: 1 } });
    expect(await chats.rows(SLOT, "bob")).toEqual([]);
    expect(await chats.rows(SLOT, "carol")).toHaveLength(1);
    // The index and carol's record: bob's sealed rows are gone, not orphaned.
    expect(vault.records.size).toBe(2);
  });

  it("starts a deleted chat over, empty, when it is written to again", async () => {
    const chats = chatStore(memoryVault(), memoryLock());
    await chats.apply(SLOT, [add("bob", inRow("in:1:0", "one"))]);
    await chats.remove(SLOT, "bob");

    await chats.apply(SLOT, [add("Bob", inRow("in:2:0", "two"))]);

    expect((await chats.rows(SLOT, "bob")).map((r) => r.id)).toEqual(["in:2:0"]);
    expect(await chats.chats(SLOT)).toEqual({ bob: { nick: "Bob", open: true, unread: 1 } });
  });

  it("deleting a chat that is not there changes nothing", async () => {
    const vault = memoryVault();
    const chats = chatStore(vault, memoryLock());
    await chats.apply(SLOT, [add("bob", inRow("in:1:0", "one"))]);

    await chats.remove(SLOT, "carol");

    expect(Object.keys(await chats.chats(SLOT))).toEqual(["bob"]);
    expect(vault.records.size).toBe(2);
  });

  it("a delete in one tab and a write in another both land", async () => {
    const vault = memoryVault();
    const lock = memoryLock();
    const tab1 = chatStore(vault, lock);
    const tab2 = chatStore(vault, lock);
    await tab1.apply(SLOT, [add("bob", inRow("in:1:0", "one"))]);

    await Promise.all([
      tab2.remove(SLOT, "bob"),
      tab1.apply(SLOT, [add("carol", inRow("in:2:0", "two"))]),
    ]);

    expect(Object.keys(await tab1.chats(SLOT))).toEqual(["carol"]);
    expect(await tab2.rows(SLOT, "carol")).toHaveLength(1);
  });

  it("says nothing in the clear: opaque keys, sealed records", async () => {
    const vault = memoryVault();
    const chats = chatStore(vault, memoryLock());

    await chats.apply(SLOT, [add("Bob", inRow("in:1:0", "the launch codes"))]);

    const keys = [...vault.records.keys()];
    expect(keys).toHaveLength(2);
    expect(keys.join(" ")).not.toMatch(/bob/i);
    const text = (bytes: ArrayBuffer) => new TextDecoder("latin1").decode(bytes);
    for (const sealed of vault.records.values()) {
      expect(text(sealed.ciphertext)).not.toMatch(/launch|bob/i);
    }
  });

  it("starts a chat over when its record no longer opens", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const vault = memoryVault();
    const chats = chatStore(vault, memoryLock());
    await chats.apply(SLOT, [add("bob", inRow("in:1:0", "one"))]);

    vault.rekey();

    expect(await chats.chats(SLOT)).toEqual({});
    expect(warn).toHaveBeenCalled();
    await chats.apply(SLOT, [add("bob", inRow("in:2:0", "two"))]);
    expect((await chats.rows(SLOT, "bob")).map((r) => r.id)).toEqual(["in:2:0"]);
  });
});
