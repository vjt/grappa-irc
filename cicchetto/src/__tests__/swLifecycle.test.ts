import { describe, expect, it, vi } from "vitest";
import { isSkipWaitingMessage, navigateStaleClients } from "../lib/swLifecycle";

// #1063 — the update-lifecycle half of the service worker, extracted so
// vitest can drive it (the SW module itself can't be imported under jsdom:
// it declares the `ServiceWorkerGlobalScope` `self` and pulls in Workbox).
// Same reason `swNavigate.ts` and `pushPayload.ts` exist.

function client(visibilityState: "hidden" | "visible", url: string) {
  return {
    url,
    visibilityState,
    navigate: vi.fn<(u: string) => Promise<unknown>>().mockResolvedValue(null),
  };
}

describe("navigateStaleClients (#1063)", () => {
  it("navigates a client nobody is looking at onto its own url", async () => {
    const hidden = client("hidden", "https://example.test/chat");

    await navigateStaleClients([hidden]);

    // Its OWN url, not "/" — a reload, not a reset to the root. The client
    // is mid-route and must come back where it was.
    expect(hidden.navigate).toHaveBeenCalledWith("https://example.test/chat");
  });

  it("leaves a visible client alone", async () => {
    const visible = client("visible", "https://example.test/chat");

    await navigateStaleClients([visible]);

    // The gate. A hard reset of the window the operator is looking at is a
    // worse defect than the stale bundle it would fix.
    expect(visible.navigate).not.toHaveBeenCalled();
  });

  it("keeps going when one client's navigate rejects", async () => {
    const failing = client("hidden", "https://example.test/a");
    failing.navigate.mockRejectedValue(new Error("client is unloading"));
    const second = client("hidden", "https://example.test/b");

    await navigateStaleClients([failing, second]);

    // A client can go away between matchAll and navigate. One casualty must
    // not strand every other window on the old bundle.
    expect(second.navigate).toHaveBeenCalledWith("https://example.test/b");
  });
});

describe("isSkipWaitingMessage (#1063)", () => {
  it("accepts the message performRefresh actually posts", () => {
    // Pinned against the literal in `bundleHash.ts` performRefresh. The
    // whole defect was a post with no listener; a typo on either side puts
    // it straight back.
    expect(isSkipWaitingMessage({ type: "SKIP_WAITING" })).toBe(true);
  });

  it("rejects any other message", () => {
    // The SW also receives `{type:"navigate"}` from its own notificationclick
    // path — skipWaiting must not fire on it.
    expect(isSkipWaitingMessage({ type: "navigate", url: "/" })).toBe(false);
  });

  it("rejects non-object payloads without throwing", () => {
    // A message port is an open boundary: anything at all can arrive.
    expect(isSkipWaitingMessage(null)).toBe(false);
    expect(isSkipWaitingMessage("SKIP_WAITING")).toBe(false);
  });
});
