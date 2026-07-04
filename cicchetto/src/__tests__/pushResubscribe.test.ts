import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #181 — the SW-update / app-resume wiring that renews a dropped push
// subscription. We mock ONLY `ensurePushSubscription` (the boundary the
// module delegates to) and drive real DOM/serviceWorker events.

const ensureMock = vi.fn().mockResolvedValue("present");
vi.mock("../lib/push", () => ({
  ensurePushSubscription: (...args: unknown[]) => ensureMock(...args),
}));

import { installPushResubscribe } from "../lib/pushResubscribe";

function fakeServiceWorker(): EventTarget & { controller: object | null } {
  const et = new EventTarget() as EventTarget & { controller: object | null };
  et.controller = {};
  return et;
}

let dispose: (() => void) | undefined;

beforeEach(() => {
  ensureMock.mockClear();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
});

describe("installPushResubscribe (#181)", () => {
  it("renews on boot when a token exists", async () => {
    vi.stubGlobal("navigator", { serviceWorker: fakeServiceWorker() });
    dispose = installPushResubscribe(() => "tok");
    await vi.waitFor(() => expect(ensureMock).toHaveBeenCalledWith("tok"));
  });

  it("renews on service-worker controllerchange (bundle refresh)", async () => {
    const sw = fakeServiceWorker();
    vi.stubGlobal("navigator", { serviceWorker: sw });
    dispose = installPushResubscribe(() => "tok");
    await vi.waitFor(() => expect(ensureMock).toHaveBeenCalled()); // boot
    ensureMock.mockClear();

    sw.dispatchEvent(new Event("controllerchange"));
    await vi.waitFor(() => expect(ensureMock).toHaveBeenCalledWith("tok"));
  });

  it("renews on visibilitychange when the document is visible (app resume)", async () => {
    vi.stubGlobal("navigator", { serviceWorker: fakeServiceWorker() });
    dispose = installPushResubscribe(() => "tok");
    await vi.waitFor(() => expect(ensureMock).toHaveBeenCalled());
    ensureMock.mockClear();

    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(ensureMock).toHaveBeenCalledWith("tok"));
  });

  it("does not renew when there is no token (not logged in)", async () => {
    const sw = fakeServiceWorker();
    vi.stubGlobal("navigator", { serviceWorker: sw });
    dispose = installPushResubscribe(() => null);
    sw.dispatchEvent(new Event("controllerchange"));
    await Promise.resolve();
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it("dispose() removes the listeners", async () => {
    const sw = fakeServiceWorker();
    vi.stubGlobal("navigator", { serviceWorker: sw });
    const d = installPushResubscribe(() => "tok");
    await vi.waitFor(() => expect(ensureMock).toHaveBeenCalled());
    ensureMock.mockClear();

    d();
    sw.dispatchEvent(new Event("controllerchange"));
    await Promise.resolve();
    expect(ensureMock).not.toHaveBeenCalled();
  });
});
