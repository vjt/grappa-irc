// issue 2430 — the key bundle sync: what cic sends grappa, in what order,
// and what it keeps when an upload fails. REST is mocked at the api module
// (the boundary); the account store is the real one over in-memory twins of
// IndexedDB and Web Locks, and the keys are real vodozemac keys.
import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Lock, Sealed, Vault } from "../lib/e2e/accountStore";
import { olm } from "./helpers/olm";

vi.mock("../lib/api", () => ({
  clearE2eKeys: vi.fn(),
  getE2eKeys: vi.fn(),
  uploadE2eKeys: vi.fn(),
}));

const [bearer, setBearer] = createSignal<string | null>(null);
const [me, setMe] = createSignal<{ kind: string; id: string } | null>(null);
const [list, setList] = createSignal<{ id: number; slug: string }[] | undefined>(undefined);
vi.mock("../lib/auth", () => ({ token: () => bearer() }));
vi.mock("../lib/networks", () => ({ user: () => me(), networks: () => list() }));
vi.mock("../lib/e2e/olm", () => ({ loadOlm: async () => olm() }));

function memoryVault(): Vault {
  const records = new Map<string, Sealed>();
  let key: Promise<CryptoKey> | undefined;
  return {
    load: async (slot) => records.get(slot),
    store: async (slot, sealed) => {
      records.set(slot, sealed);
    },
    wrappingKey: () => {
      key ??= crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      return key;
    },
  };
}

const memoryLock: Lock = <T>(_name: string, fn: () => Promise<T>) => fn();

// The browser store is IndexedDB + Web Locks, which jsdom has neither of.
vi.mock("../lib/e2e/accountStore", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/e2e/accountStore")>();
  const vault = memoryVault();
  return { ...real, indexedDbVault: () => vault, webLock: memoryLock };
});

const api = await import("../lib/api");
const { accountStore } = await import("../lib/e2e/accountStore");
const { accountSlot, mountKeyBundleSync, syncKeyBundle } = await import("../lib/e2e/bundleSync");

type Upload = { one_time_keys: string[]; fallback: string | null };

const keyOf = (payload: string): string =>
  (JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as { otk: { key: string } }).otk.key;

const uploads = (): Upload[] => vi.mocked(api.uploadE2eKeys).mock.calls.map((call) => call[2]);

const SLOT = "user:0b5e:1";

beforeEach(() => {
  vi.mocked(api.clearE2eKeys).mockResolvedValue(undefined);
  vi.mocked(api.uploadE2eKeys).mockResolvedValue({ one_time_keys: 50, fallback: true });
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("syncKeyBundle", () => {
  it("a new account drops grappa's old bundle first, then uploads a full one", async () => {
    const store = accountStore(olm(), memoryVault(), memoryLock);

    await syncKeyBundle(store, "tok", SLOT, "azzurra");

    expect(api.clearE2eKeys).toHaveBeenCalledWith("tok", "azzurra");
    expect(api.getE2eKeys).not.toHaveBeenCalled();
    const [upload] = uploads();
    expect(upload?.one_time_keys).toHaveLength(50);
    expect(upload?.fallback).not.toBeNull();
    // The old account's keys must be gone before the new ones arrive.
    const cleared = vi.mocked(api.clearE2eKeys).mock.invocationCallOrder[0] ?? Infinity;
    const uploaded = vi.mocked(api.uploadE2eKeys).mock.invocationCallOrder[0] ?? -Infinity;
    expect(cleared).toBeLessThan(uploaded);
  });

  it("a known account asks grappa what is left and sends only that, never clearing", async () => {
    const store = accountStore(olm(), memoryVault(), memoryLock);
    await syncKeyBundle(store, "tok", SLOT, "azzurra");
    vi.mocked(api.clearE2eKeys).mockClear();
    vi.mocked(api.getE2eKeys).mockResolvedValue({ one_time_keys: 47, fallback: true });

    await syncKeyBundle(store, "tok", SLOT, "azzurra");

    expect(api.clearE2eKeys).not.toHaveBeenCalled();
    const sent = uploads()[1];
    expect(sent?.one_time_keys).toHaveLength(3);
    expect(sent?.fallback).toBeNull();
    // Keys already sent were marked published: these three are new.
    const before = new Set(uploads()[0]?.one_time_keys.map(keyOf));
    expect(sent?.one_time_keys.map(keyOf).some((key) => before.has(key))).toBe(false);
  });

  it("sends nothing when grappa's bundle is full", async () => {
    const store = accountStore(olm(), memoryVault(), memoryLock);
    await syncKeyBundle(store, "tok", SLOT, "azzurra");
    vi.mocked(api.getE2eKeys).mockResolvedValue({ one_time_keys: 50, fallback: true });

    await syncKeyBundle(store, "tok", SLOT, "azzurra");

    expect(api.uploadE2eKeys).toHaveBeenCalledTimes(1);
  });

  it("keeps the keys of a failed upload, and sends the same ones next time", async () => {
    const store = accountStore(olm(), memoryVault(), memoryLock);
    vi.mocked(api.uploadE2eKeys).mockRejectedValueOnce(new Error("503"));

    await expect(syncKeyBundle(store, "tok", SLOT, "azzurra")).rejects.toThrow("503");
    // The account with those keys was stored before they left: the retry is
    // the same account, not a new one that would clear grappa again.
    vi.mocked(api.clearE2eKeys).mockClear();
    vi.mocked(api.getE2eKeys).mockResolvedValue({ one_time_keys: 0, fallback: false });
    await syncKeyBundle(store, "tok", SLOT, "azzurra");

    expect(api.clearE2eKeys).not.toHaveBeenCalled();
    const [failed, retried] = uploads();
    expect(retried?.one_time_keys.map(keyOf)).toEqual(failed?.one_time_keys.map(keyOf));
    expect(retried?.fallback && keyOf(retried.fallback)).toBe(
      failed?.fallback && keyOf(failed.fallback),
    );
  });

  it("a failed clear stores no account, so the next sync starts over and clears again", async () => {
    const store = accountStore(olm(), memoryVault(), memoryLock);
    vi.mocked(api.clearE2eKeys).mockRejectedValueOnce(new Error("offline"));

    await expect(syncKeyBundle(store, "tok", SLOT, "azzurra")).rejects.toThrow("offline");
    await syncKeyBundle(store, "tok", SLOT, "azzurra");

    expect(api.clearE2eKeys).toHaveBeenCalledTimes(2);
    expect(api.uploadE2eKeys).toHaveBeenCalledTimes(1);
  });
});

describe("mountKeyBundleSync", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  // The signals are module state: each case starts from no network list, and
  // uses its own subject, since the page-wide record of synced slots stays.
  beforeEach(() => {
    setList(undefined);
  });

  it("syncs each network once per page, and a network that appears later", async () => {
    vi.mocked(api.getE2eKeys).mockResolvedValue({ one_time_keys: 50, fallback: true });
    setBearer("tok");
    setMe({ kind: "user", id: "a1" });
    const dispose = createRoot((d) => {
      mountKeyBundleSync();
      return d;
    });
    setList([
      { id: 1, slug: "azzurra" },
      { id: 2, slug: "libera" },
    ]);
    await settle();
    expect(
      vi
        .mocked(api.uploadE2eKeys)
        .mock.calls.map((call) => call[1])
        .sort(),
    ).toEqual(["azzurra", "libera"]);

    // A refetch of the same list syncs nothing again: no second look at
    // either bundle (a sync of a known account starts with a GET).
    setList([
      { id: 1, slug: "azzurra" },
      { id: 2, slug: "libera" },
    ]);
    await settle();
    expect(api.getE2eKeys).not.toHaveBeenCalled();
    expect(api.clearE2eKeys).toHaveBeenCalledTimes(2);
    expect(api.uploadE2eKeys).toHaveBeenCalledTimes(2);

    setList([
      { id: 1, slug: "azzurra" },
      { id: 2, slug: "libera" },
      { id: 3, slug: "oftc" },
    ]);
    await settle();
    expect(vi.mocked(api.uploadE2eKeys).mock.calls.map((call) => call[1])).toContain("oftc");
    expect(api.uploadE2eKeys).toHaveBeenCalledTimes(3);
    dispose();
  });

  it("retries a network whose sync failed when the list next changes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setBearer("tok");
    setMe({ kind: "user", id: "b2" });
    vi.mocked(api.clearE2eKeys).mockRejectedValueOnce(new Error("offline"));
    const dispose = createRoot((d) => {
      mountKeyBundleSync();
      return d;
    });
    setList([{ id: 1, slug: "azzurra" }]);
    await settle();
    expect(api.uploadE2eKeys).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("azzurra"), expect.anything());

    setList([{ id: 1, slug: "azzurra" }]);
    await settle();
    expect(api.uploadE2eKeys).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("does nothing while logged out", async () => {
    setBearer(null);
    setMe(null);
    const dispose = createRoot((d) => {
      mountKeyBundleSync();
      return d;
    });
    setList([{ id: 1, slug: "azzurra" }]);
    await settle();
    expect(api.clearE2eKeys).not.toHaveBeenCalled();
    expect(api.getE2eKeys).not.toHaveBeenCalled();
    dispose();
  });
});

describe("accountSlot", () => {
  it("keys an account on the subject and the network, so neither shares one", () => {
    const slots = new Set([
      accountSlot({ kind: "user", id: "a1" }, 1),
      accountSlot({ kind: "user", id: "a1" }, 2),
      accountSlot({ kind: "visitor", id: "a1" }, 1),
      accountSlot({ kind: "user", id: "b2" }, 1),
    ]);
    expect(slots.size).toBe(4);
  });
});
