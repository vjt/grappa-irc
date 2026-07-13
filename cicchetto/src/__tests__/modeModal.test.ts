import { describe, expect, it } from "vitest";

// #216 — /mode modal open/close store. Holds the (networkSlug, channel)
// the modal is currently open for, or null when closed.

import { closeModeModal, modeModalState, openModeModal } from "../lib/modeModal";

describe("modeModal store", () => {
  it("starts closed (null)", () => {
    closeModeModal();
    expect(modeModalState()).toBeNull();
  });

  it("openModeModal sets the (networkSlug, channel) target", () => {
    openModeModal("bahamut", "#bofh");
    expect(modeModalState()).toEqual({ networkSlug: "bahamut", channel: "#bofh" });
  });

  it("openModeModal replaces a prior target (re-open for a different channel)", () => {
    openModeModal("bahamut", "#bofh");
    openModeModal("libera", "#elixir");
    expect(modeModalState()).toEqual({ networkSlug: "libera", channel: "#elixir" });
  });

  it("closeModeModal resets to null", () => {
    openModeModal("bahamut", "#bofh");
    closeModeModal();
    expect(modeModalState()).toBeNull();
  });
});
