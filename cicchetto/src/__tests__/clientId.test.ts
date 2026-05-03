import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getOrCreateClientId } from "../lib/clientId";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("getOrCreateClientId", () => {
  beforeEach(() => localStorage.clear());

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
});
