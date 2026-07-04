import { beforeEach, describe, expect, it } from "vitest";
import { __setConnectivityForTests, isOffline } from "../lib/connectivity";

// #119 — device connectivity signal. Tracks navigator.onLine +
// online/offline window events. Drives the stacked error region's
// connectivity source (the honest signal that replaced the deleted WS
// 1006 "origin misconfigured" heuristic).

describe("connectivity", () => {
  beforeEach(() => {
    __setConnectivityForTests(true);
  });

  it("reports online (not offline) by default", () => {
    expect(isOffline()).toBe(false);
  });

  it("flips to offline when the window 'offline' event fires", () => {
    window.dispatchEvent(new Event("offline"));
    expect(isOffline()).toBe(true);
  });

  it("flips back to online when the window 'online' event fires", () => {
    window.dispatchEvent(new Event("offline"));
    expect(isOffline()).toBe(true);
    window.dispatchEvent(new Event("online"));
    expect(isOffline()).toBe(false);
  });
});
