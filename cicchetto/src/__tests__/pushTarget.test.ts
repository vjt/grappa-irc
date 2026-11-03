import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptedChat } from "../lib/encryptedChats";
import { openEncryptedWindow } from "../lib/encryptedWindow";
import { applyPushTarget, installPushTargetListener, pushTargetSelection } from "../lib/pushTarget";
import { openQueryWindowState } from "../lib/queryWindows";
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
  applySeedEnvelope: vi.fn(),
}));

vi.mock("../lib/networks", () => ({
  // #1861 — casemappingForSlug (lib/casemapping.ts) resolves the fold
  // through this map, so the mock has to carry it.
  networkIdBySlug: () => undefined,
  networks: vi.fn(() => [{ id: 1, slug: "libera", kind: "user", connection_state: "connected" }]),
  channelsBySlug: vi.fn(() => ({
    libera: [{ id: 10, name: "#sniffo" }],
  })),
  networkBySlug: vi.fn((slug: string) =>
    slug === "libera" ? { id: 1, slug: "libera", kind: "user" } : undefined,
  ),
}));

// #146 — the query branch now reuses the open-then-select verb. Mock the
// query-window surface so we can assert the open push fires without
// dragging in the phoenix socket. `canonicalQueryNick` echoes the nick
// (no open window to resolve casing against in unit context).
vi.mock("../lib/queryWindows", () => ({
  openQueryWindowState: vi.fn(),
  canonicalQueryNick: vi.fn((_networkId: number, nick: string) => nick),
}));

// issue 2515 — the encrypted query is cic's own window: the device's chat
// index knows whether it exists and how it spells the peer (here: `alice`,
// a chat first opened under that spelling), and `openEncryptedWindow` is
// the open-then-focus verb every other door uses (`/equery`, the nick menu).
// Two readers of that index: the page's copy (`encryptedChat`, what the
// sidebar shows) and the store itself (`encryptedChatNick`), which a cold tap
// reads before the page's copy is in.
vi.mock("../lib/encryptedChats", () => ({
  encryptedChat: vi.fn((slug: string, nick: string) =>
    slug === "libera" && nick.toLowerCase() === "alice"
      ? { nick: "alice", open: true, unread: 1 }
      : undefined,
  ),
  encryptedChatNick: vi.fn(async (slug: string, nick: string) =>
    slug === "libera" && nick.toLowerCase() === "alice" ? "alice" : nick,
  ),
}));

vi.mock("../lib/encryptedWindow", () => ({
  openEncryptedWindow: vi.fn(() => Promise.resolve()),
}));

describe("applyPushTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes a channel deep-link to setSelectedChannel with kind=channel (no query open)", () => {
    applyPushTarget("/?network=libera&channel=%23sniffo");
    expect(setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "libera",
      channelName: "#sniffo",
      kind: "channel",
    });
    // A channel highlight implies the operator is already joined — no
    // query-window open step.
    expect(openQueryWindowState).not.toHaveBeenCalled();
  });

  it("opens AND selects the query window for a DM deep-link (#146)", () => {
    applyPushTarget("/?network=libera&channel=nextime");
    // #146 root-cause fix: the DM window is OPENED (server upserts the
    // query_windows row) before selection, mirroring every other DM-open
    // site — not just selected (which would point at a non-existent
    // window with no sidebar row).
    expect(openQueryWindowState).toHaveBeenCalledWith(1, "nextime", expect.any(String));
    expect(setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "libera",
      channelName: "nextime",
      kind: "query",
    });
  });

  it("DM deep-link to an unbound network falls back to a plain select (no open)", () => {
    applyPushTarget("/?network=unknown&channel=someone");
    // Network not resolvable → can't open a query window; best-effort
    // select keeps the helper total without crashing on a stale link.
    expect(openQueryWindowState).not.toHaveBeenCalled();
    expect(setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "unknown",
      channelName: "someone",
      kind: "query",
    });
  });

  it("opens the encrypted query for an encrypted-message deep-link (issue 2515)", async () => {
    applyPushTarget("/?network=libera&channel=Bob&e2e=1");
    // The encrypted window, never the plaintext query with the same nick:
    // no query window is opened and nothing selects one.
    await vi.waitFor(() => expect(openEncryptedWindow).toHaveBeenCalledWith("libera", "Bob"));
    expect(openQueryWindowState).not.toHaveBeenCalled();
    expect(setSelectedChannel).not.toHaveBeenCalled();
  });

  it("opens the chat under the name the device's chat index stores, even before the page's copy has it", async () => {
    // A cold tap: the page's copy of the index is still empty.
    const pageCopy = vi.mocked(encryptedChat).getMockImplementation();
    vi.mocked(encryptedChat).mockImplementation(() => undefined);
    try {
      applyPushTarget("/?network=libera&channel=Alice&e2e=1");
      await vi.waitFor(() => expect(openEncryptedWindow).toHaveBeenCalledWith("libera", "alice"));
    } finally {
      if (pageCopy !== undefined) vi.mocked(encryptedChat).mockImplementation(pageCopy);
    }
  });

  it("says when the encrypted chat could not be opened, never swallows it", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(openEncryptedWindow).mockRejectedValueOnce(new Error("no network libera to use"));
    applyPushTarget("/?network=libera&channel=Bob&e2e=1");
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(1));
    warnSpy.mockRestore();
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

describe("pushTargetSelection", () => {
  // issue 2515 — the window an encrypted-message notification names is the
  // encrypted query `$e2e:<nick>`, spelled as the chat index spells the peer
  // (the sidebar row's name), so a notification is dismissed by the window
  // it opens (`notificationDismiss.ts` walks this mapping backwards).
  it("maps an encrypted target to the encrypted window, in the chat index's spelling", () => {
    expect(
      pushTargetSelection({ networkSlug: "libera", channelName: "Alice", kind: "encrypted" }),
    ).toEqual({ networkSlug: "libera", channelName: "$e2e:alice", kind: "encrypted" });
  });

  it("keeps the payload's spelling for a peer the chat index does not know yet", () => {
    expect(
      pushTargetSelection({ networkSlug: "libera", channelName: "Bob", kind: "encrypted" }),
    ).toEqual({ networkSlug: "libera", channelName: "$e2e:Bob", kind: "encrypted" });
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
