import { beforeEach, describe, expect, test, vi } from "vitest";

// mobilePanel — mobile chrome-panel mutex helpers. Every launcher closes
// the three sibling surfaces (members / settings / archive) before
// opening its own. Tests assert the mutex outcome, not call order.

const setArchiveModalNetwork = vi.fn();
vi.mock("../archive", () => ({
  setArchiveModalNetwork: (v: unknown) => setArchiveModalNetwork(v),
}));

import { openHomePanel } from "../mobilePanel";

function setters() {
  return {
    membersOpen: () => true,
    setMembersOpen: vi.fn(),
    setSettingsOpen: vi.fn(),
  };
}

describe("openHomePanel (#291)", () => {
  beforeEach(() => {
    setArchiveModalNetwork.mockReset();
  });

  test("closes members, settings and archive then navigates home", () => {
    const s = setters();
    const navigate = vi.fn();
    openHomePanel(s, navigate);
    expect(s.setMembersOpen).toHaveBeenCalledWith(false);
    expect(s.setSettingsOpen).toHaveBeenCalledWith(false);
    expect(setArchiveModalNetwork).toHaveBeenCalledWith(null);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
