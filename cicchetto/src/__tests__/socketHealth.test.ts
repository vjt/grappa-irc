import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetSocketHealthForTests,
  ERROR_THRESHOLD,
  recordSocketClose,
  recordSocketError,
  recordSocketOpen,
  shouldShowBanner,
  socketHealth,
} from "../lib/socketHealth";

describe("socketHealth", () => {
  beforeEach(() => {
    __resetSocketHealthForTests();
  });

  it("starts in connecting state with zero errors", () => {
    const h = socketHealth();
    expect(h.state).toBe("connecting");
    expect(h.errorCount).toBe(0);
    expect(h.lastCloseCode).toBeNull();
    expect(shouldShowBanner()).toBe(false);
  });

  it("increments errorCount on each recordSocketError", () => {
    recordSocketError();
    recordSocketError();
    expect(socketHealth().state).toBe("error");
    expect(socketHealth().errorCount).toBe(2);
  });

  it("does not show banner below threshold", () => {
    for (let i = 0; i < ERROR_THRESHOLD - 1; i++) recordSocketError();
    expect(shouldShowBanner()).toBe(false);
  });

  it("shows banner at threshold", () => {
    for (let i = 0; i < ERROR_THRESHOLD; i++) recordSocketError();
    expect(shouldShowBanner()).toBe(true);
    expect(socketHealth().errorCount).toBe(ERROR_THRESHOLD);
  });

  it("resets errorCount + state on recordSocketOpen — banner auto-dismisses", () => {
    for (let i = 0; i < ERROR_THRESHOLD + 2; i++) recordSocketError();
    expect(shouldShowBanner()).toBe(true);
    recordSocketOpen();
    expect(socketHealth().state).toBe("open");
    expect(socketHealth().errorCount).toBe(0);
    expect(shouldShowBanner()).toBe(false);
  });

  it("recordSocketClose preserves errorCount and captures CloseEvent code/reason", () => {
    recordSocketError();
    recordSocketError();
    const closeEvent = { code: 1006, reason: "" } as CloseEvent;
    recordSocketClose(closeEvent);
    expect(socketHealth().state).toBe("connecting");
    // errorCount unchanged — the banner stays up across close→reconnect.
    expect(socketHealth().errorCount).toBe(2);
    expect(socketHealth().lastCloseCode).toBe(1006);
  });

  it("captures the reason string when the browser exposes one", () => {
    recordSocketError();
    recordSocketClose({ code: 1011, reason: "internal error" } as CloseEvent);
    expect(socketHealth().lastCloseCode).toBe(1011);
    expect(socketHealth().lastCloseReason).toBe("internal error");
  });
});
