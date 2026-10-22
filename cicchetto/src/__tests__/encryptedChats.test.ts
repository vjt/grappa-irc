// issue 2430 — the encrypted chats as the UI sees them: the glue between
// grappa's doors, the E2E client and the device's stores. REST is mocked at
// the api module (the boundary) and routed to a fake grappa
// (`helpers/e2eGrappa.ts`); the engine, the account store (made by the real
// bundle sync) and the chat store are real, over in-memory twins of
// IndexedDB and Web Locks. The peer, Bob, is a bare E2E client on the same
// fake grappa.
//
// The store is a page singleton, so every test gets a network of its own
// (its own slug and slot) and a fresh grappa.
import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, type Outbound } from "../lib/e2e/engine";
import { sendLog } from "../lib/e2e/orders";
import { DEFAULT_ISUPPORT, seedIsupport } from "../lib/isupport";
import { Grappa, publishBundle } from "./helpers/e2eGrappa";
import { memoryLock, memoryVault } from "./helpers/e2eVault";
import { olm } from "./helpers/olm";

vi.mock("../lib/api", () => {
  class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string) {
      super(`${status} ${code}`);
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApiError,
    sendE2e: vi.fn(),
    listE2eInbox: vi.fn(),
    ackE2eInbox: vi.fn(),
    clearE2eKeys: vi.fn(),
    getE2eKeys: vi.fn(),
    uploadE2eKeys: vi.fn(),
  };
});

type Net = { id: number; slug: string; nick: string };
const [bearer, setBearer] = createSignal<string | null>(null);
const [me, setMe] = createSignal<{ kind: string; id: string } | null>(null);
const [list, setList] = createSignal<Net[] | undefined>(undefined);
vi.mock("../lib/auth", () => ({ token: () => bearer() }));
vi.mock("../lib/networks", () => ({
  user: () => me(),
  networks: () => list(),
  networkBySlug: (slug: string) => list()?.find((n) => n.slug === slug),
}));
vi.mock("../lib/e2e/olm", () => ({ loadOlm: async () => olm() }));

// Web Locks, which jsdom has not, for the page's own liveness lock.
(await import("./helpers/e2eVault")).installPageLocks();

// IndexedDB + Web Locks, which jsdom has neither of: one vault per store name.
vi.mock("../lib/e2e/accountStore", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/e2e/accountStore")>();
  const helpers = await import("./helpers/e2eVault");
  const vaults = new Map<string, ReturnType<typeof helpers.memoryVault>>();
  return {
    ...real,
    indexedDbVault: (_lock: unknown, name: string) => {
      const vault = vaults.get(name) ?? helpers.memoryVault();
      vaults.set(name, vault);
      return vault;
    },
    webLock: helpers.memoryLock(),
  };
});

const api = await import("../lib/api");
const { accountStore } = await import("../lib/e2e/accountStore");
const { chatStore } = await import("../lib/e2e/chatStore");
const { e2eClient } = await import("../lib/e2e/client");
const { OUTQ_TTL_MS } = await import("../lib/e2e/engine");
const { SAS_TIMEOUT_MS } = await import("../lib/e2e/sas");
const { browserE2e } = await import("../lib/e2e/browser");
const { accountSlot } = await import("../lib/e2e/bundleSync");
const chats = await import("../lib/encryptedChats");

const ME = { kind: "user", id: "0b5e" };
/** The send door's refusals as grappa's FallbackController answers them: status, token. */
const STATUS: Record<string, number> = {
  "rate-limited": 429,
  "too-large": 413,
  "too-late": 422,
  refused: 400,
};
const CODE: Record<string, string> = { "too-late": "too_late" };

let grappa: Grappa;
let net: Net;
let netCount = 0;

beforeEach(() => {
  grappa = new Grappa();
  netCount += 1;
  net = { id: netCount, slug: `net${netCount}`, nick: "alice" };
  setList([net]);
  setMe(ME);
  setBearer("tok");
  const door = () => grappa.door(net.nick);
  vi.mocked(api.listE2eInbox).mockImplementation(async (_t, slug, after) => ({
    messages: (await door().inbox(after)).map((m) => ({
      ...m,
      kind: "e2e_message" as const,
      network: slug,
    })),
  }));
  vi.mocked(api.ackE2eInbox).mockImplementation((_t, _s, ids) => door().ack(ids));
  vi.mocked(api.sendE2e).mockImplementation(async (_t, _s, out) => {
    const answer = await door().send(out as Outbound);
    if ("refused" in answer) {
      throw new api.ApiError(STATUS[answer.refused] ?? 500, CODE[answer.refused] ?? answer.refused);
    }
    return answer;
  });
  vi.mocked(api.clearE2eKeys).mockImplementation(async () => {
    grappa.bundles.delete(net.nick);
  });
  vi.mocked(api.getE2eKeys).mockImplementation(async () => grappa.held(net.nick));
  vi.mocked(api.uploadE2eKeys).mockImplementation(async (_t, _s, upload) => {
    grappa.upload(net.nick, upload);
    return grappa.held(net.nick);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

const slot = () => accountSlot(ME, net.id);

/** Bob: a bare E2E client with his bundle on grappa. */
async function bob() {
  const lock = memoryLock();
  const accounts = accountStore(olm(), memoryVault(), lock);
  const store = chatStore(memoryVault(), lock);
  await publishBundle(grappa, "Bob", accounts, "bob-slot");
  const client = e2eClient(olm(), accounts, store, Date.now, {
    page: "bob-page",
    secrets: new Map(),
    alive: async () => new Set(["bob-page"]),
  });
  const ctx = {
    slot: "bob-slot",
    ownNick: "Bob",
    door: grappa.door("Bob"),
    orders: async () => false,
  };
  const bodies = async () =>
    (await store.rows("bob-slot", net.nick)).flatMap((r) => (r.kind === "in" ? [r.body] : []));
  const fingerprint = async () => (await client.identity(ctx, [])).own;
  // An inner message of Bob's own making, on his session: a bot's CHAL.
  const inject = (inner: Record<string, unknown>) =>
    accounts.withAccount("bob-slot", async ({ account, state }) => {
      const engine = new Engine(olm(), account, state, "Bob", Date.now);
      for (const out of engine.send(net.nick, inner, "chal", null).outbound) {
        await ctx.door.send(out);
      }
    });
  return { client, ctx, bodies, fingerprint, inject };
}

const outStates = () =>
  (chats.encryptedRows(net.slug, "Bob") ?? []).flatMap((r) =>
    r.kind === "out" ? [[r.body, r.state, r.reason]] : [],
  );

describe("encrypted chats", () => {
  it("a slot with no account syncs the key bundle first (only the sync makes one), then drains", async () => {
    await chats.drainE2e(net.slug);

    expect(api.clearE2eKeys).toHaveBeenCalledTimes(1);
    expect(grappa.held(net.nick).fallback).toBe(true);
    expect(api.listE2eInbox).toHaveBeenCalled();
  });

  it("a message from Bob lands in his chat, unread, the inbox empties, and the spent key is replaced", async () => {
    await chats.drainE2e(net.slug);
    const full = grappa.held(net.nick).one_time_keys;
    const b = await bob();

    await b.client.send(b.ctx, net.nick, "ciao alice");
    await b.client.drain(b.ctx); // the KEYS: Bob's PKMSG goes out
    await chats.drainE2e(net.slug);

    expect(chats.encryptedChatsFor(net.slug)).toEqual([{ key: "bob", nick: "Bob", unread: 1 }]);
    expect(grappa.inboxes.get(net.nick)).toEqual([]);
    expect(grappa.held(net.nick).one_time_keys).toBe(full);

    await chats.loadEncryptedChat(net.slug, "bob");
    expect(chats.encryptedRows(net.slug, "Bob")?.map((r) => r.kind === "in" && r.body)).toEqual([
      "ciao alice",
    ]);
    // Never pinned by hand: the key is trusted on first use, not verified.
    expect(
      chats.trustOf(
        chats.encryptedRows(net.slug, "Bob") ?? [],
        chats.encryptedTrust(net.slug, "Bob"),
      ),
    ).toBe("unverified");
  });

  it("a message to Bob waits for his keys, then goes, and he reads it", async () => {
    await chats.drainE2e(net.slug);
    const b = await bob();
    await chats.openEncryptedChat(net.slug, "Bob");
    await chats.loadEncryptedChat(net.slug, "Bob");

    await chats.sendEncrypted(net.slug, "Bob", "ciao bob");
    expect(outStates()).toEqual([["ciao bob", "queued", null]]);

    await chats.drainE2e(net.slug); // the KEYS grappa answered with
    expect(outStates()).toEqual([["ciao bob", "sent", null]]);
    await b.client.drain(b.ctx);
    expect(await b.bodies()).toEqual(["ciao bob"]);
  });

  it.each(["rate-limited", "too-large", "too-late", "refused"] as const)(
    "a send door refusal (%s) marks the message failed with its reason",
    async (reason) => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await chats.drainE2e(net.slug);
      await bob();
      await chats.loadEncryptedChat(net.slug, "Bob");
      grappa.refuse = (o) => (o.verb === "keyreq" ? undefined : reason);

      await chats.sendEncrypted(net.slug, "Bob", "ciao bob");
      await chats.drainE2e(net.slug);

      expect(outStates()).toEqual([["ciao bob", "failed", reason]]);
    },
  );

  // 2430 "Authorising orders": Bob, playing a bot, saw "Bob: ping" from
  // alice in #grappa and asks her cic whether she sent it.
  describe("an order challenge", () => {
    const LINE = "Bob: ping";
    const sha256 = async (body: string) =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
    const chal = async () => ({
      t: "chal",
      network: "AzzurraNet",
      channel: "#grappa",
      sender_mask: "alice!~alice@azzurra.example",
      line_sha256: await sha256(LINE),
      nonce: "bm9uY2Uwbm9uY2Uw",
      expires_at: Math.floor(Date.now() / 1000) + 15,
    });
    const acks = () =>
      vi.mocked(api.sendE2e).mock.calls.filter(([, , out]) => out.expires_at !== undefined);

    async function talking() {
      await chats.drainE2e(net.slug);
      const b = await bob();
      await b.client.send(b.ctx, net.nick, "ciao alice");
      await b.client.drain(b.ctx);
      await chats.drainE2e(net.slug);
      return b;
    }

    it("is ACKed with its deadline when this device sent the line on that network", async () => {
      const b = await talking();
      seedIsupport(net.id, { ...DEFAULT_ISUPPORT, network: "AzzurraNet" });
      sendLog.record({ slug: net.slug, target: "#grappa", body: LINE, at: Date.now() });
      const asked = await chal();

      await b.inject(asked);
      await chats.drainE2e(net.slug);

      expect(acks()).toEqual([
        [
          "tok",
          net.slug,
          expect.objectContaining({ priority: "control", expires_at: asked.expires_at }),
        ],
      ]);
    });

    it("goes unanswered on a network that never said its name (fail closed)", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const b = await talking();
      seedIsupport(net.id, { ...DEFAULT_ISUPPORT, network: null });
      sendLog.record({ slug: net.slug, target: "#grappa", body: LINE, at: Date.now() });

      await b.inject(await chal());
      await chats.drainE2e(net.slug);

      expect(acks()).toEqual([]);
      expect(grappa.inboxes.get(net.nick)).toEqual([]);
    });
  });

  it("a message grappa dropped after accepting it turns failed with the reason", async () => {
    await chats.drainE2e(net.slug);
    await bob();
    await chats.loadEncryptedChat(net.slug, "Bob");
    await chats.sendEncrypted(net.slug, "Bob", "ciao bob");
    await chats.drainE2e(net.slug);
    const msgid = grappa.sends.at(-1)?.msgid ?? "";

    await chats.encryptedSendDropped(net.slug, msgid, "session_ended");

    expect(outStates()).toEqual([["ciao bob", "failed", "session-ended"]]);
  });

  it("pins Bob's key by hand: the pin is shown and the badge reads verified", async () => {
    await chats.drainE2e(net.slug);
    const b = await bob();
    await chats.loadEncryptedChat(net.slug, "Bob");

    expect(await chats.pinEncryptedKey(net.slug, "Bob", await b.fingerprint(), true)).toBe(
      "pinned",
    );

    const rows = chats.encryptedRows(net.slug, "Bob") ?? [];
    expect(rows.map((r) => r.kind)).toEqual(["pinned"]);
    expect(chats.encryptedTrust(net.slug, "Bob")).toEqual({
      ed25519: await b.fingerprint(),
      verified: true,
    });
    expect(chats.trustOf(rows, chats.encryptedTrust(net.slug, "Bob"))).toBe("verified");
  });

  it("takes a key unverified: the chat says so, and the badge reads not verified", async () => {
    await chats.drainE2e(net.slug);
    const b = await bob();
    await chats.loadEncryptedChat(net.slug, "Bob");

    expect(await chats.pinEncryptedKey(net.slug, "Bob", await b.fingerprint(), false)).toBe(
      "pinned",
    );

    const rows = chats.encryptedRows(net.slug, "Bob") ?? [];
    expect(rows.map((r) => r.kind)).toEqual(["accepted"]);
    expect(chats.trustOf(rows, chats.encryptedTrust(net.slug, "Bob"))).toBe("unverified");
  });

  it("compares emoji with Bob: the request, the same 7 emoji on both sides, the match, the badge", async () => {
    await chats.drainE2e(net.slug);
    const b = await bob();
    await b.client.send(b.ctx, net.nick, "ciao alice");
    await b.client.drain(b.ctx);
    await chats.drainE2e(net.slug);
    await chats.loadEncryptedChat(net.slug, "Bob");

    await chats.verifyEncrypted(net.slug, "Bob", "start");
    expect(chats.encryptedSas(net.slug, "Bob")).toEqual(
      expect.objectContaining({ role: "a", phase: "started", here: true }),
    );
    await b.client.drain(b.ctx);
    await b.client.verify(b.ctx, net.nick, "accept");
    await chats.drainE2e(net.slug);
    await b.client.drain(b.ctx);
    await chats.drainE2e(net.slug);

    const emoji = chats.encryptedSas(net.slug, "Bob")?.emoji;
    expect(emoji).toHaveLength(7);
    expect((await b.client.identity(b.ctx, [net.nick])).sas.alice?.emoji).toEqual(emoji);

    await chats.verifyEncrypted(net.slug, "Bob", "match");
    await b.client.drain(b.ctx);
    await b.client.verify(b.ctx, net.nick, "match");
    await chats.drainE2e(net.slug);

    expect(chats.encryptedSas(net.slug, "Bob")).toBeNull();
    const rows = chats.encryptedRows(net.slug, "Bob") ?? [];
    expect(rows.map((r) => r.kind)).toEqual(["in", "sas_asked", "verified"]);
    expect(chats.trustOf(rows, chats.encryptedTrust(net.slug, "Bob"))).toBe("verified");
  });

  it("refuses a pin that is not a key, or is our own, and writes nothing", async () => {
    await chats.drainE2e(net.slug);
    await chats.loadEncryptedChat(net.slug, "Bob");
    const own = chats.ownKey(net.slug);
    expect(own).toMatch(/^[A-Za-z0-9+/]{43}$/);

    expect(await chats.pinEncryptedKey(net.slug, "Bob", "not a key", true)).toBe("bad-key");
    expect(await chats.pinEncryptedKey(net.slug, "Bob", own ?? "", true)).toBe("own-key");
    expect(chats.encryptedRows(net.slug, "Bob")).toEqual([]);
  });

  it("drains asked for while one runs take the inbox once more after it, not once each", async () => {
    await chats.drainE2e(net.slug);
    vi.mocked(api.listE2eInbox).mockClear();

    await Promise.all([
      chats.drainE2e(net.slug),
      chats.drainE2e(net.slug),
      chats.drainE2e(net.slug),
    ]);

    // One run (one empty page) and the one more it owes.
    expect(api.listE2eInbox).toHaveBeenCalledTimes(2);
  });

  it("reads a chat again when another tab says it changed it, and ignores another identity's", async () => {
    await chats.drainE2e(net.slug);
    const { chats: store } = await browserE2e();
    const other = new BroadcastChannel("grappa-e2e-chats");
    const reads = vi.spyOn(store, "chats");
    try {
      // Another login in this browser, on a network with the same slug.
      other.postMessage({ slug: net.slug, slot: "user:someone-else:1", chats: ["carol"] });
      await store.open(slot(), "Dave");
      other.postMessage({ slug: net.slug, slot: slot(), chats: ["dave"] });

      await vi.waitFor(() =>
        expect(chats.encryptedChatsFor(net.slug).map((c) => c.nick)).toEqual(["Dave"]),
      );
      // Delivered in order: the first message read nothing.
      expect(reads).toHaveBeenCalledTimes(1);
    } finally {
      reads.mockRestore();
      other.close();
    }
  });

  it("a message whose keys never come is marked failed by the tick", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const dispose = createRoot((dispose) => {
      chats.mountEncryptedChats();
      return dispose;
    });
    try {
      await chats.drainE2e(net.slug);
      await chats.loadEncryptedChat(net.slug, "Bob");
      await chats.sendEncrypted(net.slug, "Bob", "anyone?"); // no bundle: no KEYS
      expect(outStates()).toEqual([["anyone?", "queued", null]]);

      vi.setSystemTime(Date.now() + OUTQ_TTL_MS + 1);
      vi.advanceTimersByTime(chats.TICK_MS);

      await vi.waitFor(() => expect(outStates()).toEqual([["anyone?", "failed", "keys-timeout"]]));
    } finally {
      dispose();
    }
  });

  it("a SAS nobody answers is ended by the tick after 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const dispose = createRoot((dispose) => {
      chats.mountEncryptedChats();
      return dispose;
    });
    try {
      await chats.drainE2e(net.slug);
      const b = await bob();
      await b.client.send(b.ctx, net.nick, "ciao alice");
      await b.client.drain(b.ctx);
      await chats.drainE2e(net.slug);
      await chats.loadEncryptedChat(net.slug, "Bob");
      await chats.verifyEncrypted(net.slug, "Bob", "start"); // Bob never answers: a bot

      vi.setSystemTime(Date.now() + SAS_TIMEOUT_MS);
      vi.advanceTimersByTime(chats.TICK_MS);

      await vi.waitFor(() => expect(chats.encryptedSas(net.slug, "Bob")).toBeNull());
      expect(chats.encryptedRows(net.slug, "Bob")?.at(-1)).toEqual(
        expect.objectContaining({ kind: "sas_cancelled", by: "you", reason: "timeout" }),
      );
    } finally {
      dispose();
    }
  });

  it("a tab that only reads a SAS another tab started ticks it too: that page gone, it ends", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const dispose = createRoot((dispose) => {
      chats.mountEncryptedChats();
      return dispose;
    });
    try {
      await chats.drainE2e(net.slug);
      const b = await bob();
      await b.client.send(b.ctx, net.nick, "ciao alice");
      await b.client.drain(b.ctx);
      await chats.drainE2e(net.slug);
      // Another tab of this cic starts it, and its page goes away.
      const { olm: binding, accounts, chats: store } = await browserE2e();
      const other = e2eClient(binding, accounts, store, Date.now, {
        page: "closed-page",
        secrets: new Map(),
        alive: async () => new Set(),
      });
      await other.verify(
        { slot: slot(), ownNick: net.nick, door: grappa.door(net.nick), orders: async () => false },
        "Bob",
        "start",
      );
      await chats.loadEncryptedChat(net.slug, "Bob");
      expect(chats.encryptedSas(net.slug, "Bob")).not.toBeNull();

      vi.advanceTimersByTime(chats.TICK_MS);

      await vi.waitFor(() => expect(chats.encryptedSas(net.slug, "Bob")).toBeNull());
      expect(chats.encryptedRows(net.slug, "Bob")?.at(-1)).toEqual(
        expect.objectContaining({ kind: "sas_cancelled", by: "you", reason: "page-gone" }),
      );
    } finally {
      dispose();
    }
  });

  it("on mount, drains the inbox of each network as the list brings it, once per login", async () => {
    await chats.drainE2e(net.slug); // the account
    const b = await bob();
    await b.client.send(b.ctx, net.nick, "while you were away");
    await b.client.drain(b.ctx);
    setList(undefined);
    vi.mocked(api.listE2eInbox).mockClear();

    const dispose = createRoot((dispose) => {
      chats.mountEncryptedChats();
      return dispose;
    });
    try {
      setList([net]);
      await vi.waitFor(() =>
        expect(chats.encryptedChatsFor(net.slug)).toEqual([{ key: "bob", nick: "Bob", unread: 1 }]),
      );
      const drains = vi.mocked(api.listE2eInbox).mock.calls.length;
      setList([{ ...net }]);
      await Promise.resolve();
      expect(vi.mocked(api.listE2eInbox).mock.calls.length).toBe(drains);
    } finally {
      dispose();
    }
  });

  it("deletes Bob's chat: its rows go in every tab, the badge's pin stays, a new message starts over", async () => {
    await chats.drainE2e(net.slug);
    const b = await bob();
    await b.client.send(b.ctx, net.nick, "ciao alice");
    await b.client.drain(b.ctx);
    await chats.drainE2e(net.slug);
    await chats.loadEncryptedChat(net.slug, "Bob");
    const pinned = chats.encryptedTrust(net.slug, "Bob");
    expect(await chats.encryptedChatHasRows(net.slug, "bob")).toBe(true);
    const other = new BroadcastChannel("grappa-e2e-chats");
    const told: unknown[] = [];
    other.addEventListener("message", (event) => told.push(event.data));
    try {
      await chats.deleteEncryptedChat(net.slug, "BOB");

      expect(chats.encryptedChatsFor(net.slug)).toEqual([]);
      expect(chats.encryptedChat(net.slug, "Bob")).toBeUndefined();
      expect(chats.encryptedRows(net.slug, "Bob")).toEqual([]);
      expect(await chats.encryptedChatHasRows(net.slug, "bob")).toBe(false);
      expect(chats.encryptedTrust(net.slug, "Bob")).toEqual(pinned);
      await vi.waitFor(() =>
        expect(told).toEqual([{ slug: net.slug, slot: slot(), chats: ["bob"] }]),
      );
    } finally {
      other.close();
    }

    await b.client.send(b.ctx, net.nick, "still there?");
    await chats.drainE2e(net.slug);
    expect(chats.encryptedChatsFor(net.slug)).toEqual([{ key: "bob", nick: "Bob", unread: 1 }]);
    expect(chats.encryptedRows(net.slug, "Bob")?.map((r) => r.kind === "in" && r.body)).toEqual([
      "still there?",
    ]);
  });

  it("a new identity sees none of the last one's chats", async () => {
    await chats.drainE2e(net.slug);
    await chats.openEncryptedChat(net.slug, "Bob");
    expect(chats.encryptedChatsFor(net.slug)).toHaveLength(1);

    setBearer("another-token");

    expect(chats.encryptedChatsFor(net.slug)).toEqual([]);
  });
});

describe("trustOf", () => {
  const peer = (verified: boolean) => ({ ed25519: "k".repeat(43), verified });
  const row = (kind: "key_alarm" | "pinned" | "accepted" | "verified", id: string) =>
    kind === "key_alarm"
      ? { kind, id, at: 0, nick: "Bob", presented: "x".repeat(43) }
      : { kind, id, at: 0, nick: "Bob", ed25519: "k".repeat(43) };

  it("no key yet reads unverified; a pinned-by-hand key reads verified", () => {
    expect(chats.trustOf([], null)).toBe("unverified");
    expect(chats.trustOf([], peer(false))).toBe("unverified");
    expect(chats.trustOf([], peer(true))).toBe("verified");
  });

  it("an alarm since the last pin is an alarm; a pin after it clears it", () => {
    expect(chats.trustOf([row("pinned", "1"), row("key_alarm", "2")], peer(true))).toBe("alarm");
    expect(chats.trustOf([row("key_alarm", "1"), row("pinned", "2")], peer(true))).toBe("verified");
  });

  it("taking the key or verifying it by SAS answers the alarm as a pin does", () => {
    expect(chats.trustOf([row("key_alarm", "1"), row("accepted", "2")], peer(false))).toBe(
      "unverified",
    );
    expect(chats.trustOf([row("key_alarm", "1"), row("verified", "2")], peer(true))).toBe(
      "verified",
    );
  });
});
