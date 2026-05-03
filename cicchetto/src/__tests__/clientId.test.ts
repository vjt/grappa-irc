import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { __resetClientIdMemoryFallback, getOrCreateClientId } from "../lib/clientId";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("getOrCreateClientId", () => {
  beforeEach(() => {
    localStorage.clear();
    __resetClientIdMemoryFallback();
  });

  test("generates UUID v4 on first call", () => {
    const id = getOrCreateClientId();
    expect(id).toMatch(UUID_V4);
  });

  test("returns same value on subsequent calls", () => {
    const id1 = getOrCreateClientId();
    const id2 = getOrCreateClientId();
    expect(id1).toBe(id2);
  });

  test("regenerates if localStorage cleared", () => {
    const id1 = getOrCreateClientId();
    localStorage.clear();
    const id2 = getOrCreateClientId();
    expect(id1).not.toBe(id2);
  });

  // Bouncer runs on plain HTTP until Phase 5 hardening adds TLS;
  // `crypto.randomUUID` is gated to secure contexts and throws
  // "crypto.randomUUID is not a function" over HTTP. The fallback
  // builds a v4 UUID from `crypto.getRandomValues` (available on
  // insecure origins).
  describe("when crypto.randomUUID is unavailable (insecure HTTP)", () => {
    let original: typeof crypto.randomUUID | undefined;

    beforeEach(() => {
      original = crypto.randomUUID;
      Object.defineProperty(crypto, "randomUUID", {
        value: undefined,
        configurable: true,
        writable: true,
      });
    });

    afterEach(() => {
      if (original) {
        Object.defineProperty(crypto, "randomUUID", {
          value: original,
          configurable: true,
          writable: true,
        });
      }
    });

    test("falls back to manual UUID v4 when randomUUID is missing", () => {
      const id = getOrCreateClientId();
      expect(id).toMatch(UUID_V4);
    });

    test("fallback produces distinct UUIDs across regenerations", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 16; i++) {
        localStorage.clear();
        ids.add(getOrCreateClientId());
      }
      expect(ids.size).toBe(16);
    });
  });

  test("uses crypto.randomUUID when present", () => {
    const spy = vi.spyOn(crypto, "randomUUID");
    getOrCreateClientId();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  // L-cic-1 — Safari Private Browsing hard-quotas localStorage at zero
  // bytes; some embedded WebViews scrub it on session end. Throwing
  // QuotaExceededError used to bubble out and break login entirely
  // (T31 admission control reads `X-Client-Id` from this UUID — no UUID,
  // no admission). Fall back to an in-memory cache so the current tab
  // session keeps a stable identity even when persistence fails.
  describe("when localStorage.setItem throws", () => {
    test("falls back to in-memory cache on QuotaExceededError", () => {
      const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      });
      const id1 = getOrCreateClientId();
      expect(id1).toMatch(UUID_V4);
      // Subsequent calls return the same in-memory UUID — no re-roll
      // even though localStorage still rejects writes.
      const id2 = getOrCreateClientId();
      expect(id2).toBe(id1);
      setItemSpy.mockRestore();
    });

    test("falls back when localStorage.getItem itself throws", () => {
      const getItemSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new DOMException("storage disabled", "SecurityError");
      });
      const id1 = getOrCreateClientId();
      expect(id1).toMatch(UUID_V4);
      const id2 = getOrCreateClientId();
      expect(id2).toBe(id1);
      getItemSpy.mockRestore();
    });
  });

  // L-cic-2 — version key gates the storage-key shape. If a future
  // hardening pass changes the persisted format, bumping
  // `CURRENT_VERSION` invalidates stale entries and forces a clean
  // re-roll instead of half-parsing an old shape.
  describe("version-key drift", () => {
    test("wipes the stored UUID when the version key is missing", () => {
      // Stash a UUID directly under the storage key without the
      // companion version key — this mimics a stored-by-old-version
      // value that predates the v1 gate.
      localStorage.setItem("grappa-client-id", "11111111-1111-4111-8111-111111111111");
      const fresh = getOrCreateClientId();
      expect(fresh).toMatch(UUID_V4);
      expect(fresh).not.toBe("11111111-1111-4111-8111-111111111111");
    });

    test("wipes the stored UUID when the version key mismatches", () => {
      localStorage.setItem("grappa-client-id", "11111111-1111-4111-8111-111111111111");
      localStorage.setItem("grappa-client-id-version", "v0-old");
      const fresh = getOrCreateClientId();
      expect(fresh).toMatch(UUID_V4);
      expect(fresh).not.toBe("11111111-1111-4111-8111-111111111111");
    });

    test("rejects a stored value that fails the UUID-v4 regex", () => {
      // Tampered-by-devtools or scrubbed-by-extension: the version key
      // is correct but the body is junk. Don't ship the junk — re-roll.
      localStorage.setItem("grappa-client-id", "not-a-uuid");
      localStorage.setItem("grappa-client-id-version", "v1");
      const fresh = getOrCreateClientId();
      expect(fresh).toMatch(UUID_V4);
      expect(fresh).not.toBe("not-a-uuid");
    });
  });

  // L-cic-3 — separator-consistency rename `grappa.client_id` →
  // `grappa-client-id` aligns with `grappa-token` + `grappa-subject`.
  // Existing users have the dotted key in their localStorage; without
  // a migration read, every active session would re-roll on first
  // load and briefly inflate the per-IP session-cap denominator.
  describe("legacy storage key migration", () => {
    test("preserves a UUID-shaped legacy value on first read", () => {
      const legacy = "22222222-2222-4222-8222-222222222222";
      localStorage.setItem("grappa.client_id", legacy);
      const id = getOrCreateClientId();
      expect(id).toBe(legacy);
      // Migration moved it under the new key + set the version key.
      expect(localStorage.getItem("grappa-client-id")).toBe(legacy);
      expect(localStorage.getItem("grappa-client-id-version")).toBe("v1");
      // Legacy key cleaned up.
      expect(localStorage.getItem("grappa.client_id")).toBeNull();
    });

    test("ignores a legacy value that fails UUID-v4 regex", () => {
      localStorage.setItem("grappa.client_id", "garbage");
      const id = getOrCreateClientId();
      expect(id).toMatch(UUID_V4);
      expect(id).not.toBe("garbage");
    });
  });
});
