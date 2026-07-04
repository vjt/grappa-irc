import { render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ErrorBanners from "../ErrorBanners";
import { shouldShowRefreshBanner } from "../lib/bundleHash";
import { __setConnectivityForTests } from "../lib/connectivity";
import {
  __resetSocketHealthForTests,
  ERROR_THRESHOLD,
  recordSocketError,
  recordSocketOpen,
} from "../lib/socketHealth";

// The bundle-refresh source needs a real vite build's script tag (absent in
// jsdom), so mock ONLY that DOM-derived boundary; socketHealth + connectivity
// stay real (vitest hoists this vi.mock above the imports). Live bundle
// behavior is covered by the bundle-refresh e2e specs.
vi.mock("../lib/bundleHash", () => ({
  shouldShowRefreshBanner: vi.fn(() => false),
  performRefresh: vi.fn(),
}));

const mockShouldShowRefresh = vi.mocked(shouldShowRefreshBanner);

// #119 — unified stacked error-banner owner. Renders every active source as a
// distinct `.error-banner[data-source=...]` slot inside ONE fixed flex-column
// container, so N banners stack without overlap (the pre-#119 bug was two
// independent `position: fixed; top: 0` elements colliding).

function tripWs(): void {
  for (let i = 0; i < ERROR_THRESHOLD; i++) recordSocketError();
}

describe("ErrorBanners", () => {
  beforeEach(() => {
    __resetSocketHealthForTests();
    __setConnectivityForTests(true);
    mockShouldShowRefresh.mockReturnValue(false);
  });

  afterEach(() => {
    __resetSocketHealthForTests();
    __setConnectivityForTests(true);
    mockShouldShowRefresh.mockReturnValue(false);
  });

  it("renders nothing when every source is healthy", () => {
    const { container } = render(() => <ErrorBanners />);
    expect(container.querySelector(".error-banners")).toBeNull();
  });

  it("renders one stacked slot per active source (distinct DOM nodes, no overlap)", () => {
    tripWs();
    __setConnectivityForTests(false);
    mockShouldShowRefresh.mockReturnValue(true);
    const { container } = render(() => <ErrorBanners />);

    const region = container.querySelector(".error-banners");
    expect(region).not.toBeNull();
    const slots = container.querySelectorAll(".error-banner");
    expect(slots).toHaveLength(3);
    // Every slot is a direct child of the ONE stacking container — that is
    // what makes them stack instead of overlap.
    for (const slot of slots) expect(slot.parentElement).toBe(region);

    expect(container.querySelector('.error-banner[data-source="ws"]')).not.toBeNull();
    expect(container.querySelector('.error-banner[data-source="connectivity"]')).not.toBeNull();
    expect(container.querySelector('.error-banner[data-source="bundle-refresh"]')).not.toBeNull();
  });

  it("removes a source's slot automatically when it recovers (auto-clear)", () => {
    tripWs();
    const { container } = render(() => <ErrorBanners />);
    expect(container.querySelector('.error-banner[data-source="ws"]')).not.toBeNull();

    recordSocketOpen();
    expect(container.querySelector('.error-banner[data-source="ws"]')).toBeNull();
    // Whole region collapses once the last source clears.
    expect(container.querySelector(".error-banners")).toBeNull();
  });
});
