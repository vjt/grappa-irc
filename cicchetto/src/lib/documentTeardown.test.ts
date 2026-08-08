import { beforeEach, describe, expect, it, vi } from "vitest";

// #954 — the epoch is module state armed at import, so every test re-imports
// after a reset to get a document that has observed nothing yet. That is also
// the only way to exercise the arming itself: the listeners are registered as
// a side effect of the import, exactly as they are in the app.
beforeEach(() => {
  vi.resetModules();
});

describe("#954 — document teardown epoch", () => {
  it("starts at an epoch nothing has moved", async () => {
    const { documentTeardownEpoch, documentTornDownSince } = await import("./documentTeardown");
    expect(documentTornDownSince(documentTeardownEpoch())).toBe(false);
  });

  it("moves on pagehide — the modern teardown event", async () => {
    const { documentTeardownEpoch, documentTornDownSince } = await import("./documentTeardown");
    const before = documentTeardownEpoch();
    window.dispatchEvent(new Event("pagehide"));
    expect(documentTornDownSince(before)).toBe(true);
  });

  it("moves on beforeunload — the legacy fallback for WebViews without pagehide", async () => {
    const { documentTeardownEpoch, documentTornDownSince } = await import("./documentTeardown");
    const before = documentTeardownEpoch();
    window.dispatchEvent(new Event("beforeunload"));
    expect(documentTornDownSince(before)).toBe(true);
  });

  it("does NOT move on visibilitychange — a backgrounded tab keeps its fetches", async () => {
    // The scope pin. Widening the trigger to visibility would make every
    // ordinary send failure in a hidden tab look like a teardown, and #954's
    // drop would then eat text the server never received.
    const { documentTeardownEpoch, documentTornDownSince } = await import("./documentTeardown");
    const before = documentTeardownEpoch();
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("blur"));
    expect(documentTornDownSince(before)).toBe(false);
  });

  it("keeps moving after a restore — it is a counter, not a latch", async () => {
    // A `pagehide` is not necessarily the end: bfcache entry and the iOS PWA
    // freeze both fire it on documents that come back. A boolean would stay
    // true for the rest of such a document's life and start condemning
    // ordinary failures; a counter re-answers the question per flight.
    const { documentTeardownEpoch, documentTornDownSince } = await import("./documentTeardown");

    window.dispatchEvent(new Event("pagehide"));
    // The document came back. A flight sampled NOW spans no teardown…
    const afterRestore = documentTeardownEpoch();
    expect(documentTornDownSince(afterRestore)).toBe(false);

    // …until the next one lands.
    window.dispatchEvent(new Event("pagehide"));
    expect(documentTornDownSince(afterRestore)).toBe(true);
  });
});
