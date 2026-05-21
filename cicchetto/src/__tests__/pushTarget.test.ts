import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPushTarget, installPushTargetListener } from "../lib/pushTarget";
import { setSelectedChannel } from "../lib/selection";

// UX-6-J: SW posts {type: "navigate", url} to focused client; cic
// listens and routes selection via setSelectedChannel. Pure-unit
// coverage of (a) the listener wires + filters non-navigate messages,
// (b) applyPushTarget routes valid URLs and ignores malformed ones,
// (c) applyPushTarget defers setSelectedChannel until the target
// network is in the live store.
//
// setSelectedChannel is mocked so we can assert the call shape without
// dragging in identityScopedStore + scrollback + cursor side-effects.

vi.mock("../lib/selection", () => ({
  setSelectedChannel: vi.fn(),
}));

vi.mock("../lib/networks", () => ({
  networks: vi.fn(() => [{ id: 1, slug: "libera", kind: "user", connection_state: "connected" }]),
  channelsBySlug: vi.fn(() => ({
    libera: [{ id: 10, name: "#sniffo" }],
  })),
  networkBySlug: vi.fn((slug: string) =>
    slug === "libera" ? { id: 1, slug: "libera", kind: "user" } : undefined,
  ),
}));

describe("applyPushTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes a channel deep-link to setSelectedChannel with kind=channel", () => {
    applyPushTarget("/?network=libera&channel=%23sniffo");
    expect(setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "libera",
      channelName: "#sniffo",
      kind: "channel",
    });
  });

  it("routes a query deep-link to setSelectedChannel with kind=query", () => {
    applyPushTarget("/?network=libera&channel=nextime");
    expect(setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "libera",
      channelName: "nextime",
      kind: "query",
    });
  });

  it("ignores malformed URLs (no selection change) and warns", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    applyPushTarget("/");
    applyPushTarget("not-a-url");
    applyPushTarget("/?network=libera"); // missing channel
    expect(setSelectedChannel).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(3);
    warnSpy.mockRestore();
  });

  it("absolute URLs work too (the SW posts client.url-style strings)", () => {
    applyPushTarget("https://cic.example.org/?network=libera&channel=%23sniffo");
    expect(setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "libera",
      channelName: "#sniffo",
      kind: "channel",
    });
  });

  it("routes even when network is not in live store (caller validates)", () => {
    // The selection store's UX-4 bucket D effect handles unknown-slug
    // gracefully; applyPushTarget routes the intent and lets the store
    // own the rendering decision. This keeps the helper pure.
    applyPushTarget("/?network=unknown&channel=%23anywhere");
    expect(setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "unknown",
      channelName: "#anywhere",
      kind: "channel",
    });
  });
});

describe("installPushTargetListener", () => {
  let messageHandler: ((ev: MessageEvent) => void) | null = null;
  let originalSW: typeof navigator.serviceWorker | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    messageHandler = null;
    originalSW = navigator.serviceWorker;

    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        addEventListener: vi.fn((type: string, handler: (ev: MessageEvent) => void) => {
          if (type === "message") {
            messageHandler = handler;
          }
        }),
        removeEventListener: vi.fn(),
      },
    });
  });

  afterEach(() => {
    if (originalSW === undefined) {
      // biome-ignore lint/performance/noDelete: cleanup test stub
      delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    } else {
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: originalSW,
      });
    }
  });

  it("registers a 'message' listener on navigator.serviceWorker", () => {
    installPushTargetListener();
    expect(navigator.serviceWorker.addEventListener).toHaveBeenCalledWith(
      "message",
      expect.any(Function),
    );
  });

  it("routes a {type:'navigate', url} message to applyPushTarget", () => {
    installPushTargetListener();
    expect(messageHandler).not.toBeNull();
    messageHandler?.(
      new MessageEvent("message", {
        data: { type: "navigate", url: "/?network=libera&channel=%23sniffo" },
      }),
    );
    expect(setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "libera",
      channelName: "#sniffo",
      kind: "channel",
    });
  });

  it("ignores messages with unknown type", () => {
    installPushTargetListener();
    messageHandler?.(
      new MessageEvent("message", {
        data: { type: "something-else", url: "/?network=libera&channel=%23sniffo" },
      }),
    );
    expect(setSelectedChannel).not.toHaveBeenCalled();
  });

  it("ignores messages with no data field", () => {
    installPushTargetListener();
    messageHandler?.(new MessageEvent("message", { data: null }));
    expect(setSelectedChannel).not.toHaveBeenCalled();
  });

  it("ignores messages with non-object data", () => {
    installPushTargetListener();
    messageHandler?.(new MessageEvent("message", { data: "not an object" }));
    messageHandler?.(new MessageEvent("message", { data: 42 }));
    expect(setSelectedChannel).not.toHaveBeenCalled();
  });

  it("ignores messages where url is not a string", () => {
    installPushTargetListener();
    messageHandler?.(new MessageEvent("message", { data: { type: "navigate", url: 42 } }));
    expect(setSelectedChannel).not.toHaveBeenCalled();
  });

  it("is a no-op when navigator.serviceWorker is undefined", () => {
    // biome-ignore lint/performance/noDelete: simulate non-SW env
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    expect(() => installPushTargetListener()).not.toThrow();
  });
});
