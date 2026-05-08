import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Test boundary: vi.mock api so re-importing auth doesn't pull network.
vi.mock("../lib/api", () => ({
  listNetworks: vi.fn(),
  listChannels: vi.fn(),
  listMessages: vi.fn(),
  sendMessage: vi.fn(),
  me: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  setOn401Handler: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("identityScopedStore — cleanup registration", () => {
  it("fires registered resets on token rotation (tokA → tokB)", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const auth = await import("../lib/auth");
    const { identityScopedStore } = await import("../lib/identityScopedStore");

    const store = identityScopedStore((onIdentityChange) => {
      const [signal, setSignal] = createSignal<Record<string, number>>({ a: 1 });
      onIdentityChange(() => setSignal({}));
      return { signal, setSignal };
    });

    expect(store.signal()).toEqual({ a: 1 });
    auth.setToken("tokB");
    await vi.waitFor(() => {
      expect(store.signal()).toEqual({});
    });
  });

  it("fires registered resets on logout (token → null)", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const auth = await import("../lib/auth");
    const { identityScopedStore } = await import("../lib/identityScopedStore");

    const store = identityScopedStore((onIdentityChange) => {
      const [signal, setSignal] = createSignal<string>("hello");
      onIdentityChange(() => setSignal(""));
      return { signal, setSignal };
    });

    expect(store.signal()).toBe("hello");
    auth.setToken(null);
    await vi.waitFor(() => {
      expect(store.signal()).toBe("");
    });
  });

  it("does NOT fire resets on cold-start login (null → tokA)", async () => {
    // No localStorage seed → token() === null at module init.
    const auth = await import("../lib/auth");
    const { identityScopedStore } = await import("../lib/identityScopedStore");

    let resetFires = 0;
    const store = identityScopedStore((onIdentityChange) => {
      const [signal, setSignal] = createSignal<string>("seed");
      onIdentityChange(() => {
        resetFires += 1;
        setSignal("");
      });
      return { signal };
    });

    // Initial run: prev === undefined → guard mask. No reset.
    expect(resetFires).toBe(0);
    expect(store.signal()).toBe("seed");

    auth.setToken("tokA");
    // Cold-start: prev === null → guard mask. No reset.
    await new Promise((r) => setTimeout(r, 10));
    expect(resetFires).toBe(0);
    expect(store.signal()).toBe("seed");
  });

  it("does NOT fire resets when token re-set to identical value", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const auth = await import("../lib/auth");
    const { identityScopedStore } = await import("../lib/identityScopedStore");

    let resetFires = 0;
    identityScopedStore((onIdentityChange) => {
      onIdentityChange(() => {
        resetFires += 1;
      });
      return {};
    });

    // Force same-value re-emit. Solid's createSignal default-equals
    // dedupes referentially-equal sets; re-setting "tokA" is a no-op
    // and the on(token) effect doesn't re-run. Belt-and-braces: the
    // factory's `t !== prev` guard would mask it anyway.
    auth.setToken("tokA");
    await new Promise((r) => setTimeout(r, 10));
    expect(resetFires).toBe(0);
  });

  it("fires multiple registered resets in registration order", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const auth = await import("../lib/auth");
    const { identityScopedStore } = await import("../lib/identityScopedStore");

    const fireOrder: string[] = [];
    identityScopedStore((onIdentityChange) => {
      onIdentityChange(() => fireOrder.push("first"));
      onIdentityChange(() => fireOrder.push("second"));
      onIdentityChange(() => fireOrder.push("third"));
      return {};
    });

    auth.setToken("tokB");
    await vi.waitFor(() => {
      expect(fireOrder).toEqual(["first", "second", "third"]);
    });
  });

  it("supports stores with no registered resets (no-cleanup case)", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const auth = await import("../lib/auth");
    const { identityScopedStore } = await import("../lib/identityScopedStore");

    // Caller may legitimately pass build that registers nothing —
    // shouldn't crash on rotation.
    const store = identityScopedStore((_onIdentityChange) => ({ value: 42 }));
    expect(store.value).toBe(42);

    auth.setToken("tokB");
    await new Promise((r) => setTimeout(r, 10));
    expect(store.value).toBe(42);
  });
});
