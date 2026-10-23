// issue 2430 — the encrypted chats as the UI sees them: the glue between
// this device's doors on grappa, the E2E client and the device's stores.
// REST is mocked at the api module (the boundary) and routed to a fake
// grappa v2 (`helpers/e2eGrappa.ts`), whose bearer is the subject's nick; the
// engine, the account store (made by the real identity sync) and the chat
// store are real, over in-memory twins of IndexedDB and Web Locks. The peer,
// Bob, is a bare E2E client on the same fake grappa.
//
// The store is a page singleton, so every test gets a network of its own
// (its own slug and slot) and a fresh grappa.
import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnIdentity } from "../lib/e2e/accountStore";
import { IdentityElsewhereError } from "../lib/e2e/client";
import { Engine } from "../lib/e2e/engine";
import { sendLog, subjectKey } from "../lib/e2e/orders";
import { DEFAULT_ISUPPORT, seedIsupport } from "../lib/isupport";
import { FRAME_BUDGET_BASE } from "./helpers/e2eDevices";
import { Grappa, routeApi } from "./helpers/e2eGrappa";
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
const { accountSlot, replaceIdentity, syncIdentity } = await import("../lib/e2e/identity");
const chats = await import("../lib/encryptedChats");

const ME = { kind: "user", id: "0b5e" };

let grappa: Grappa;
let net: Net;
let netCount = 0;

/** The network's 005 as grappa published it: its line size known, so messages can be sized. */
const sized = (over: Partial<typeof DEFAULT_ISUPPORT>) =>
  seedIsupport(net.id, { ...DEFAULT_ISUPPORT, frameBudgetBase: FRAME_BUDGET_BASE, ...over });

beforeEach(() => {
  grappa = new Grappa();
  netCount += 1;
  net = { id: netCount, slug: `net${netCount}`, nick: "alice" };
  setList([net]);
  setMe(ME);
  // The fake grappa's bearer is the subject's nick.
  setBearer(net.nick);
  sized({});
  routeApi(api, () => grappa);
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

const slot = () => accountSlot(ME, net.id);

/** This browser's place in alice's identity, as its record holds it. */
async function own(): Promise<OwnIdentity> {
  const { accounts } = await browserE2e();
  const found = await accounts.withAccount(slot(), async (session) => session.own);
  if (found === null) throw new Error("no identity here");
  return found;
}

/** What grappa holds for this browser's device: its key bundle, and its inbox. */
async function held() {
  const { did } = await own();
  return {
    keys: await grappa.api.getE2eDeviceKeys(net.nick, net.slug, did),
    inbox: (await grappa.api.listE2eDeviceInbox(net.nick, net.slug, did, 0)).messages,
  };
}

/** Bob: a bare E2E client, his identity made by the real sync. */
async function bob() {
  const lock = memoryLock();
  const accounts = accountStore(olm(), memoryVault(), lock);
  const store = chatStore(memoryVault(), lock);
  expect(await syncIdentity(accounts, "Bob", "bob-slot", net.slug)).toBe("ready");
  const client = e2eClient(olm(), accounts, store, Date.now, {
    page: "bob-page",
    secrets: new Map(),
    alive: async () => new Set(["bob-page"]),
  });
  const ctx = {
    slot: "bob-slot",
    ownNick: "Bob",
    frameBudgetBase: FRAME_BUDGET_BASE,
    door: (did: string) => grappa.door("Bob", did),
    orders: () => "not-sent" as const,
  };
  const bodies = async () =>
    (await store.rows("bob-slot", net.nick)).flatMap((r) => (r.kind === "in" ? [r.body] : []));
  const master = async () => (await client.identity(ctx, [])).own;
  // An inner message of Bob's own making, on his sessions: a bot's CHAL.
  const inject = (inner: Record<string, unknown>) =>
    accounts.withAccount("bob-slot", async ({ account, own: place, state }) => {
      if (place === null) throw new Error("Bob holds no identity");
      const engine = new Engine(olm(), account, place, state, "Bob", FRAME_BUDGET_BASE, Date.now);
      for (const out of engine.send(net.nick, inner, "chal", null, null).outbound) {
        await ctx.door(place.did).send(out);
      }
    });
  return { client, ctx, bodies, master, inject };
}

const outStates = () =>
  (chats.encryptedRows(net.slug, "Bob") ?? []).flatMap((r) =>
    r.kind === "out" ? [[r.body, r.state, r.reason]] : [],
  );

describe("encrypted chats", () => {
  it("a slot with no account makes its identity first (only the sync makes one), then drains this device's inbox", async () => {
    await chats.drainE2e(net.slug);

    expect(api.putE2eList).toHaveBeenCalledTimes(1);
    expect(api.clearE2eKeys).not.toHaveBeenCalled();
    const { did } = await own();
    expect((await held()).keys.fallback).toBe(true);
    expect(vi.mocked(api.listE2eDeviceInbox).mock.calls.map((call) => call[2])).toEqual([did]);
    expect(chats.identityElsewhere(net.slug)).toBe(false);
  });

  it("a message from Bob lands in his chat, unread, the inbox empties, and the spent key is replaced", async () => {
    await chats.drainE2e(net.slug);
    const full = (await held()).keys.one_time_keys;
    const b = await bob();

    await b.client.send(b.ctx, net.nick, "ciao alice");
    await b.client.drain(b.ctx); // the KEYS: Bob's PKMSG goes out
    await chats.drainE2e(net.slug);

    expect(chats.encryptedChatsFor(net.slug)).toEqual([{ key: "bob", nick: "Bob", unread: 1 }]);
    expect((await held()).inbox).toEqual([]);
    expect((await held()).keys.one_time_keys).toBe(full);

    await chats.loadEncryptedChat(net.slug, "bob");
    expect(chats.encryptedRows(net.slug, "Bob")?.map((r) => r.kind === "in" && r.body)).toEqual([
      "ciao alice",
    ]);
    // Never pinned by hand: the master is trusted on first use, not verified.
    expect(chats.encryptedTrust(net.slug, "Bob")).toEqual({
      master: await b.master(),
      verified: false,
      devices: 1,
    });
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

  it("a message while grappa has published no line size for the network fails at once, and asks for nothing", async () => {
    await chats.drainE2e(net.slug);
    await bob();
    await chats.loadEncryptedChat(net.slug, "Bob");
    sized({ frameBudgetBase: null });

    await chats.sendEncrypted(net.slug, "Bob", "too soon");

    expect(outStates()).toEqual([["too soon", "failed", "no-budget"]]);
    expect(api.sendE2e).not.toHaveBeenCalled();
  });

  it.each(["rate-limited", "too-large", "too-late", "unknown-device", "refused"] as const)(
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
  // alice in #grappa and asks her cic, on a session she verified, whether
  // she sent it.
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
      vi.mocked(api.sendE2e).mock.calls.filter(([, , out]) => out.expiresAt !== null);

    async function talking() {
      await chats.drainE2e(net.slug);
      const b = await bob();
      await b.client.send(b.ctx, net.nick, "ciao alice");
      await b.client.drain(b.ctx);
      await chats.drainE2e(net.slug);
      await chats.pinEncryptedKey(net.slug, "Bob", await b.master(), true);
      return b;
    }
    const sent = (subject: string) =>
      sendLog.record({ subject, slug: net.slug, target: "#grappa", body: LINE, at: Date.now() });

    it("is ACKed with its deadline, to the device that asked, when this device sent the line on that network", async () => {
      const b = await talking();
      sized({ network: "AzzurraNet" });
      await sent(subjectKey(ME));
      const asked = await chal();

      await b.inject(asked);
      await chats.drainE2e(net.slug);

      const bobDid = (await grappa.api.listE2eDevices("Bob", net.slug))[0]?.did;
      expect(acks()).toEqual([
        [
          net.nick,
          net.slug,
          expect.objectContaining({
            priority: "control",
            expiresAt: asked.expires_at,
            from: (await own()).did,
            to: bobDid,
          }),
        ],
      ]);
    });

    it("goes unanswered on a network that never said its name (fail closed)", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const b = await talking();
      sized({ network: null });
      await sent(subjectKey(ME));

      await b.inject(await chal());
      await chats.drainE2e(net.slug);

      expect(acks()).toEqual([]);
      expect((await held()).inbox).toEqual([]);
    });

    it("goes unanswered for a line another login in this browser sent", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const b = await talking();
      sized({ network: "AzzurraNet" });
      await sent(subjectKey({ kind: "user", id: "5ca1ab1e" }));

      await b.inject(await chal());
      await chats.drainE2e(net.slug);

      expect(acks()).toEqual([]);
    });
  });

  it.each([
    ["late", "late"],
    ["send_failed", "send-failed"],
    ["session_ended", "session-ended"],
  ] as const)(
    "a message grappa dropped after accepting it (%s) turns failed with %s",
    async (wire, shown) => {
      await chats.drainE2e(net.slug);
      await bob();
      await chats.loadEncryptedChat(net.slug, "Bob");
      await chats.sendEncrypted(net.slug, "Bob", "ciao bob");
      await chats.drainE2e(net.slug);
      const msgid = grappa.sends.at(-1)?.msgid ?? "";

      await chats.encryptedSendDropped(net.slug, msgid, wire);

      expect(outStates()).toEqual([["ciao bob", "failed", shown]]);
    },
  );

  it("pins Bob's master by hand: the pin is shown and the badge reads verified", async () => {
    await chats.drainE2e(net.slug);
    const b = await bob();
    await chats.loadEncryptedChat(net.slug, "Bob");

    expect(await chats.pinEncryptedKey(net.slug, "Bob", await b.master(), true)).toBe("pinned");

    const rows = chats.encryptedRows(net.slug, "Bob") ?? [];
    expect(rows.map((r) => r.kind)).toEqual(["pinned"]);
    expect(chats.encryptedTrust(net.slug, "Bob")).toEqual({
      master: await b.master(),
      verified: true,
      devices: 0,
    });
    expect(chats.trustOf(rows, chats.encryptedTrust(net.slug, "Bob"))).toBe("verified");
  });

  it("takes a master unverified: the chat says so, and the badge reads not verified", async () => {
    await chats.drainE2e(net.slug);
    const b = await bob();
    await chats.loadEncryptedChat(net.slug, "Bob");

    expect(await chats.pinEncryptedKey(net.slug, "Bob", await b.master(), false)).toBe("pinned");

    const rows = chats.encryptedRows(net.slug, "Bob") ?? [];
    expect(rows.map((r) => r.kind)).toEqual(["accepted"]);
    expect(chats.trustOf(rows, chats.encryptedTrust(net.slug, "Bob"))).toBe("unverified");
  });

  it("a pin whose list ask waits for the network's line size goes out on the next periodic tick", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const dispose = createRoot((dispose) => {
      chats.mountEncryptedChats();
      return dispose;
    });
    try {
      await chats.drainE2e(net.slug);
      const b = await bob();
      sized({ frameBudgetBase: null });

      expect(await chats.pinEncryptedKey(net.slug, "Bob", await b.master(), true)).toBe("pinned");
      expect(api.sendE2e).not.toHaveBeenCalled();

      sized({});
      vi.advanceTimersByTime(chats.TICK_MS);

      await vi.waitFor(() =>
        expect(vi.mocked(api.sendE2e).mock.calls.map(([, , out]) => out.verb)).toEqual(["keyreq"]),
      );
    } finally {
      dispose();
    }
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

  it("refuses a pin that is not a key, or is our own master, and writes nothing", async () => {
    await chats.drainE2e(net.slug);
    await chats.loadEncryptedChat(net.slug, "Bob");
    const ownKey = chats.ownKey(net.slug);
    expect(ownKey).toBe((await own()).master);

    expect(await chats.pinEncryptedKey(net.slug, "Bob", "not a key", true)).toBe("bad-key");
    expect(await chats.pinEncryptedKey(net.slug, "Bob", ownKey ?? "", true)).toBe("own-key");
    expect(chats.encryptedRows(net.slug, "Bob")).toEqual([]);
  });

  it("drains asked for while one runs take the inbox once more after it, not once each", async () => {
    await chats.drainE2e(net.slug);
    vi.mocked(api.listE2eDeviceInbox).mockClear();

    await Promise.all([
      chats.drainE2e(net.slug),
      chats.drainE2e(net.slug),
      chats.drainE2e(net.slug),
    ]);

    // One run (one empty page) and the one more it owes.
    expect(api.listE2eDeviceInbox).toHaveBeenCalledTimes(2);
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
      await chats.sendEncrypted(net.slug, "Bob", "anyone?"); // Bob holds no identity: no KEYS
      expect(outStates()).toEqual([["anyone?", "queued", null]]);

      vi.setSystemTime(Date.now() + OUTQ_TTL_MS + 1);
      vi.advanceTimersByTime(chats.TICK_MS);

      await vi.waitFor(() => expect(outStates()).toEqual([["anyone?", "failed", "keys-timeout"]]));
    } finally {
      dispose();
    }
  });

  it("a network that left the list leaves the tick, and the networks still there are ticked", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const dispose = createRoot((dispose) => {
      chats.mountEncryptedChats();
      return dispose;
    });
    const warn = vi.spyOn(console, "warn");
    try {
      // Something waits on the clock on a network that then goes away.
      const gone = net;
      await chats.drainE2e(gone.slug);
      await chats.sendEncrypted(gone.slug, "Bob", "into the void");
      // Another network: a grappa identity of its own.
      grappa = new Grappa();
      netCount += 1;
      net = { id: netCount, slug: `net${netCount}`, nick: "alice" };
      sized({});
      setList([net]);
      await chats.drainE2e(net.slug);
      await chats.loadEncryptedChat(net.slug, "Bob");
      await chats.sendEncrypted(net.slug, "Bob", "anyone?");

      vi.setSystemTime(Date.now() + OUTQ_TTL_MS + 1);
      vi.advanceTimersByTime(chats.TICK_MS);

      await vi.waitFor(() => expect(outStates()).toEqual([["anyone?", "failed", "keys-timeout"]]));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("a network whose tick fails is logged and ticked again later, and the networks after it are ticked", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    // Two networks at once, each with its own grappa.
    const first = net;
    const firstGrappa = grappa;
    const secondGrappa = new Grappa();
    netCount += 1;
    const second = { id: netCount, slug: `net${netCount}`, nick: "alice" };
    routeApi(api, (slug) => (slug === first.slug ? firstGrappa : secondGrappa));
    seedIsupport(second.id, { ...DEFAULT_ISUPPORT, frameBudgetBase: FRAME_BUDGET_BASE });
    setList([first, second]);
    const dispose = createRoot((dispose) => {
      chats.mountEncryptedChats();
      return dispose;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await chats.drainE2e(first.slug);
      await chats.drainE2e(second.slug);
      await chats.sendEncrypted(first.slug, "Bob", "first");
      await chats.loadEncryptedChat(second.slug, "Bob");
      await chats.sendEncrypted(second.slug, "Bob", "second");
      // The first network's chat store write fails this once.
      const { chats: store } = await browserE2e();
      const apply = store.apply.bind(store);
      const broken = new Error("the chat store is busy");
      const failing = vi.spyOn(store, "apply").mockImplementation(async (slot, changes) => {
        if (slot === accountSlot(ME, first.id)) throw broken;
        return apply(slot, changes);
      });

      vi.setSystemTime(Date.now() + OUTQ_TTL_MS + 1);
      vi.advanceTimersByTime(chats.TICK_MS);

      net = second;
      await vi.waitFor(() => expect(outStates()).toEqual([["second", "failed", "keys-timeout"]]));
      expect(warn).toHaveBeenCalledWith(
        `[e2e] could not check what waits on ${first.slug}`,
        broken,
      );

      // Still waiting: the next tick takes it, to its end (it tells the other tabs last).
      failing.mockRestore();
      const told: { slug: string }[] = [];
      const tabs = new BroadcastChannel("grappa-e2e-chats");
      tabs.addEventListener("message", (event) => told.push(event.data));
      net = first;
      await chats.loadEncryptedChat(first.slug, "Bob");
      vi.advanceTimersByTime(chats.TICK_MS);
      await vi.waitFor(() => expect(told.map((m) => m.slug)).toContain(first.slug));
      tabs.close();
      expect(outStates()).toEqual([["first", "failed", "keys-timeout"]]);
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
        {
          slot: slot(),
          ownNick: net.nick,
          frameBudgetBase: FRAME_BUDGET_BASE,
          door: (did) => grappa.door(net.nick, did),
          orders: () => "not-sent" as const,
        },
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
    await chats.drainE2e(net.slug); // the identity
    const b = await bob();
    await b.client.send(b.ctx, net.nick, "while you were away");
    await b.client.drain(b.ctx);
    setList(undefined);
    vi.mocked(api.listE2eDeviceInbox).mockClear();

    const dispose = createRoot((dispose) => {
      chats.mountEncryptedChats();
      return dispose;
    });
    try {
      setList([net]);
      await vi.waitFor(() =>
        expect(chats.encryptedChatsFor(net.slug)).toEqual([{ key: "bob", nick: "Bob", unread: 1 }]),
      );
      const drains = vi.mocked(api.listE2eDeviceInbox).mock.calls.length;
      setList([{ ...net }]);
      await Promise.resolve();
      expect(vi.mocked(api.listE2eDeviceInbox).mock.calls.length).toBe(drains);
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

// An identity is never replaced silently (vjt 6344779758): a browser that
// holds none of the identity grappa holds reads "elsewhere", runs nothing,
// writes nothing, and starts a new one only when the user says so.
describe("encrypted chats, an identity held elsewhere", () => {
  /** Another browser of alice's made the identity on this network first. */
  async function madeElsewhere(): Promise<void> {
    const other = accountStore(olm(), memoryVault(), memoryLock());
    expect(await syncIdentity(other, net.nick, "another-browser", net.slug)).toBe("ready");
    vi.mocked(api.putE2eList).mockClear();
    vi.mocked(api.registerE2eDevice).mockClear();
  }

  it("reads elsewhere, writes nothing here or on grappa, and runs nothing more on the network", async () => {
    await madeElsewhere();
    const before = await grappa.api.getE2eList(net.nick, net.slug);

    await chats.drainE2e(net.slug);

    expect(chats.identityElsewhere(net.slug)).toBe(true);
    expect(await grappa.api.getE2eList(net.nick, net.slug)).toEqual(before);
    expect(api.registerE2eDevice).not.toHaveBeenCalled();
    expect(api.putE2eList).not.toHaveBeenCalled();
    expect(api.clearE2eKeys).not.toHaveBeenCalled();

    // Every later operation stops at the flag: not one more look at grappa.
    vi.mocked(api.getE2eList).mockClear();
    await chats.drainE2e(net.slug);
    await expect(chats.sendEncrypted(net.slug, "Bob", "hi")).rejects.toBeInstanceOf(
      IdentityElsewhereError,
    );
    expect(api.getE2eList).not.toHaveBeenCalled();
    expect(api.sendE2e).not.toHaveBeenCalled();
    // Nothing was stored for the slot: a look now finds no record.
    const { accounts } = await browserE2e();
    expect(await accounts.withAccount(slot(), async (session) => session.created)).toBe(true);
  });

  it("a record that holds no identity (a new one failed after grappa's was deleted) reads elsewhere, and sends nothing", async () => {
    await chats.drainE2e(net.slug);
    const { accounts } = await browserE2e();
    await accounts.withAccount(slot(), async (session) => {
      session.master = null;
      session.own = null;
    });
    vi.mocked(api.listE2eDeviceInbox).mockClear();

    await chats.drainE2e(net.slug);

    expect(chats.identityElsewhere(net.slug)).toBe(true);
    expect(api.listE2eDeviceInbox).not.toHaveBeenCalled();
    expect(api.sendE2e).not.toHaveBeenCalled();
  });

  it("a drop push on a network held elsewhere is no failure: the account's other devices send them", async () => {
    const warn = vi.spyOn(console, "warn");
    chats.identitySynced(net.slug, "elsewhere");

    await expect(
      chats.encryptedSendDropped(net.slug, "c29tZW9uZS1lbHNl", "late"),
    ).resolves.toBeUndefined();

    expect(warn).not.toHaveBeenCalled();
  });

  it("takes what the page's identity sync found, both ways", () => {
    chats.identitySynced(net.slug, "elsewhere");
    expect(chats.identityElsewhere(net.slug)).toBe(true);

    chats.identitySynced(net.slug, "ready");
    expect(chats.identityElsewhere(net.slug)).toBe(false);
  });

  it("pairedHere clears the elsewhere flag and tells the other tabs", async () => {
    chats.identitySynced(net.slug, "elsewhere");
    const other = new BroadcastChannel("grappa-e2e-chats");
    const told: unknown[] = [];
    other.addEventListener("message", (event) => told.push(event.data));
    try {
      chats.pairedHere(net.slug, slot());

      expect(chats.identityElsewhere(net.slug)).toBe(false);
      await vi.waitFor(() => expect(told).toEqual([{ slug: net.slug, slot: slot(), chats: [] }]));
    } finally {
      other.close();
    }
  });

  it("a new identity started here on the user's word replaces the one grappa held, and the network runs again", async () => {
    await madeElsewhere();
    const old = await grappa.api.getE2eList(net.nick, net.slug);
    await chats.drainE2e(net.slug);
    await chats.loadEncryptedChat(net.slug, "Bob");
    expect(chats.identityElsewhere(net.slug)).toBe(true);

    await chats.replaceEncryptedIdentity(net.slug);

    expect(chats.identityElsewhere(net.slug)).toBe(false);
    expect(api.clearE2eKeys).toHaveBeenCalledTimes(1);
    const now = await grappa.api.getE2eList(net.nick, net.slug);
    expect(now?.master).toBe((await own()).master);
    expect(now?.master).not.toBe(old?.master);
    // The window shown reads the new identity.
    expect(chats.ownKey(net.slug)).toBe((await own()).master);
    const b = await bob();
    await b.client.send(b.ctx, net.nick, "welcome back");
    await b.client.drain(b.ctx);
    await chats.drainE2e(net.slug);
    expect(chats.encryptedRows(net.slug, "Bob")?.map((r) => r.kind === "in" && r.body)).toEqual([
      "welcome back",
    ]);
  });

  // The flag is worked out again on evidence, never on a clock: grappa can
  // change under a page that has it set, or clear, by another tab or device.
  describe("worked out again", () => {
    /** Another browser of alice's starts a new identity over the one grappa holds: this device is gone from grappa. */
    async function replacedElsewhere() {
      const other = accountStore(olm(), memoryVault(), memoryLock());
      await replaceIdentity(other, net.nick, "another-browser", net.slug);
      vi.mocked(api.putE2eList).mockClear();
      vi.mocked(api.registerE2eDevice).mockClear();
      vi.mocked(api.clearE2eKeys).mockClear();
      return grappa.api.getE2eList(net.nick, net.slug);
    }

    /** Another tab of this browser starts a new identity over the one held elsewhere, in the store both tabs share. */
    async function replacedInAnotherTab() {
      const { accounts } = await browserE2e();
      await replaceIdentity(accounts, net.nick, slot(), net.slug);
      vi.mocked(api.clearE2eKeys).mockClear();
      return grappa.api.getE2eList(net.nick, net.slug);
    }

    it("clears when another tab of this browser says it changed the network: the new identity it started is this tab's too", async () => {
      await madeElsewhere();
      await chats.drainE2e(net.slug);
      expect(chats.identityElsewhere(net.slug)).toBe(true);
      const made = await replacedInAnotherTab();
      const other = new BroadcastChannel("grappa-e2e-chats");

      try {
        other.postMessage({ slug: net.slug, slot: slot(), chats: [] });
        await vi.waitFor(() => expect(chats.identityElsewhere(net.slug)).toBe(false));
      } finally {
        other.close();
      }

      expect(made?.master).toBe((await own()).master);
      expect(await grappa.api.getE2eList(net.nick, net.slug)).toEqual(made);
      expect(api.clearE2eKeys).not.toHaveBeenCalled();
    });

    it("a new identity confirmed on a flag gone stale deletes nothing: another tab of this browser holds the identity grappa lists", async () => {
      await madeElsewhere();
      await chats.drainE2e(net.slug);
      expect(chats.identityElsewhere(net.slug)).toBe(true);
      // This tab never hears of it.
      const made = await replacedInAnotherTab();

      await chats.replaceEncryptedIdentity(net.slug);

      expect(api.clearE2eKeys).not.toHaveBeenCalled();
      expect(chats.identityElsewhere(net.slug)).toBe(false);
      expect(await grappa.api.getE2eList(net.nick, net.slug)).toEqual(made);
      expect(made?.master).toBe((await own()).master);
    });

    it("sets on the first 404 from this device's doors: grappa holds the device no more, and nothing is written", async () => {
      await chats.drainE2e(net.slug);
      expect(chats.identityElsewhere(net.slug)).toBe(false);
      const made = await replacedElsewhere();

      await chats.drainE2e(net.slug);

      expect(chats.identityElsewhere(net.slug)).toBe(true);
      expect(await grappa.api.getE2eList(net.nick, net.slug)).toEqual(made);
      expect(api.registerE2eDevice).not.toHaveBeenCalled();
      expect(api.putE2eList).not.toHaveBeenCalled();
      expect(api.clearE2eKeys).not.toHaveBeenCalled();
    });

    it("sets on the first send grappa refuses as from a device it does not know", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await chats.drainE2e(net.slug);
      await replacedElsewhere();
      vi.mocked(api.listE2eDeviceInbox).mockClear();

      await chats.sendEncrypted(net.slug, "Bob", "anyone?");

      // The KEYREQ the message waits behind, refused: no inbox was read.
      await expect(vi.mocked(api.sendE2e).mock.results[0]?.value).rejects.toMatchObject({
        status: 422,
        code: "unknown_device",
      });
      expect(api.listE2eDeviceInbox).not.toHaveBeenCalled();
      expect(chats.identityElsewhere(net.slug)).toBe(true);
    });
  });
});

describe("trustOf", () => {
  const peer = (verified: boolean) => ({ master: "k".repeat(43), verified, devices: 1 });
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
