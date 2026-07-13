import { describe, expect, it } from "vitest";

// #229 — /umode modal open/close store. Holds the networkSlug the modal is
// currently open for, or null when closed. Sibling of modeModal (#216) but
// carries only a network slug (umodes are per-session, no channel).

import { closeUmodeModal, openUmodeModal, umodeModalState } from "../lib/umodeModal";

describe("umodeModal store", () => {
  it("starts closed (null)", () => {
    closeUmodeModal();
    expect(umodeModalState()).toBeNull();
  });

  it("openUmodeModal sets the networkSlug target", () => {
    openUmodeModal("bahamut");
    expect(umodeModalState()).toEqual({ networkSlug: "bahamut" });
  });

  it("openUmodeModal replaces a prior target (re-open for a different network)", () => {
    openUmodeModal("bahamut");
    openUmodeModal("libera");
    expect(umodeModalState()).toEqual({ networkSlug: "libera" });
  });

  it("closeUmodeModal resets to null", () => {
    openUmodeModal("bahamut");
    closeUmodeModal();
    expect(umodeModalState()).toBeNull();
  });
});
