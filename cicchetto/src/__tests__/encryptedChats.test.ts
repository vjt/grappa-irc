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
import type { Outbound } from "../lib/e2e/engine";
import { Grappa, publishBundle } from "./helpers/e2eGrappa";
import { memoryLock, memoryVault } from "./helpers/e2eVault";
import { olm } from "./helpers/olm";

vi.mock("../lib/api", () => {
  class ApiError extends Error {
    readonly status: number;
    constructor(status: number, code: string) {
      super(`${status} ${code}`);
      this.status = status;
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
const { browserE2e } = await import("../lib/e2e/browser");
const { accountSlot } = await import("../lib/e2e/bundleSync");
const chats = await import("../lib/encryptedChats");

const ME = { kind: "user", id: "0b5e" };
/** The send door's refusals as grappa's FallbackController answers them. */
const STATUS: Record<string, number> = { "rate-limited": 429, "too-large": 413, refused: 400 };

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
      throw new api.ApiError(STATUS[answer.refused] ?? 500, answer.refused);
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
  const client = e2eClient(olm(), accounts, store, Date.now);
  const ctx = { slot: "bob-slot", ownNick: "Bob", door: grappa.door("Bob") };
  const bodies = async () =>
    (await store.rows("bob-slot", net.nick)).flatMap((r) => (r.kind === "in" ? [r.body] : []));
  const fingerprint = async () => (await client.identity(ctx, [])).own;
  return { client, ctx, bodies, fingerprint };
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

  it.each(["rate-limited", "too-large", "refused"] as const)(
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

  it("pins Bob's key by hand: the pin is shown and the badge reads verified", async () => {
    await chats.drainE2e(net.slug);
    const b = await bob();
    await chats.loadEncryptedChat(net.slug, "Bob");

    expect(await chats.pinEncryptedKey(net.slug, "Bob", await b.fingerprint())).toBe("pinned");

    const rows = chats.encryptedRows(net.slug, "Bob") ?? [];
    expect(rows.map((r) => r.kind)).toEqual(["pinned"]);
    expect(chats.encryptedTrust(net.slug, "Bob")).toEqual({
      ed25519: await b.fingerprint(),
      verified: true,
    });
    expect(chats.trustOf(rows, chats.encryptedTrust(net.slug, "Bob"))).toBe("verified");
  });

  it("refuses a pin that is not a key, or is our own, and writes nothing", async () => {
    await chats.drainE2e(net.slug);
    await chats.loadEncryptedChat(net.slug, "Bob");
    const own = chats.ownKey(net.slug);
    expect(own).toMatch(/^[A-Za-z0-9+/]{43}$/);

    expect(await chats.pinEncryptedKey(net.slug, "Bob", "not a key")).toBe("bad-key");
    expect(await chats.pinEncryptedKey(net.slug, "Bob", own ?? "")).toBe("own-key");
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
  const row = (kind: "key_alarm" | "pinned", id: string) =>
    kind === "pinned"
      ? { kind, id, at: 0, nick: "Bob", ed25519: "k".repeat(43) }
      : { kind, id, at: 0, nick: "Bob", presented: "x".repeat(43) };

  it("no key yet reads unverified; a pinned-by-hand key reads verified", () => {
    expect(chats.trustOf([], null)).toBe("unverified");
    expect(chats.trustOf([], peer(false))).toBe("unverified");
    expect(chats.trustOf([], peer(true))).toBe("verified");
  });

  it("an alarm since the last pin is an alarm; a pin after it clears it", () => {
    expect(chats.trustOf([row("pinned", "1"), row("key_alarm", "2")], peer(true))).toBe("alarm");
    expect(chats.trustOf([row("key_alarm", "1"), row("pinned", "2")], peer(true))).toBe("verified");
  });
});
