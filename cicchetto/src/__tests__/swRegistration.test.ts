import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetSwRegistrationForTests,
  recordSwRegError,
  recordSwRegistered,
  shouldShowSwRegBanner,
  swRegistration,
} from "../lib/swRegistration";

// #120 — service-worker registration health signal. Module-singleton mirroring
// the socketHealth.ts / connectivity.ts shape. Captures the SW-registration
// OUTCOME, and critically the ERROR DETAIL (name + message) — that captured
// detail is the #181 push-notification diagnostic lever, read back through the
// signal accessor / the window.__cic_swRegistration hook, not just a human
// string in a banner. So these tests assert detail is captured, not a boolean.

describe("swRegistration", () => {
  beforeEach(() => {
    __resetSwRegistrationForTests();
  });

  it("starts in unknown state with no error and no banner", () => {
    const h = swRegistration();
    expect(h.state).toBe("unknown");
    expect(h.error).toBeNull();
    expect(shouldShowSwRegBanner()).toBe(false);
  });

  it("captures the error name + message on recordSwRegError and shows the banner", () => {
    recordSwRegError({
      name: "SecurityError",
      message: "Failed to register a ServiceWorker: origin not allowed",
    });
    const h = swRegistration();
    expect(h.state).toBe("error");
    expect(h.error?.name).toBe("SecurityError");
    expect(h.error?.message).toBe("Failed to register a ServiceWorker: origin not allowed");
    expect(shouldShowSwRegBanner()).toBe(true);
  });

  it("normalizes a real Error instance into name + message (the #181 lever detail)", () => {
    recordSwRegError(new TypeError("registration script threw"));
    const h = swRegistration();
    expect(h.error?.name).toBe("TypeError");
    expect(h.error?.message).toBe("registration script threw");
  });

  it("normalizes a non-Error thrown value without losing the detail", () => {
    recordSwRegError("bare string failure");
    const h = swRegistration();
    expect(h.state).toBe("error");
    expect(h.error?.name).toBe("Error");
    expect(h.error?.message).toBe("bare string failure");
    expect(shouldShowSwRegBanner()).toBe(true);
  });

  it("clears the banner when a later successful registration is recorded", () => {
    recordSwRegError({ name: "AbortError", message: "install aborted" });
    expect(shouldShowSwRegBanner()).toBe(true);
    recordSwRegistered(undefined);
    expect(swRegistration().state).toBe("registered");
    expect(swRegistration().error).toBeNull();
    expect(shouldShowSwRegBanner()).toBe(false);
  });

  it("stays tripped until reset — the error surface is sticky (no auto-clear event)", () => {
    recordSwRegError({ name: "SecurityError", message: "denied" });
    expect(shouldShowSwRegBanner()).toBe(true);
    // No window event or timer clears it; only an explicit reset (or a later
    // successful registration) does.
    __resetSwRegistrationForTests();
    expect(shouldShowSwRegBanner()).toBe(false);
    expect(swRegistration().state).toBe("unknown");
  });
});
