import { afterEach, describe, expect, it } from "vitest";
import { viewerFrameTop } from "../lib/mediaViewerFrame";

// issue 2500 — where the media viewer's frame starts. jsdom lays nothing out,
// so every box here is a stubbed rect: these tests pin which edge is read in
// which window, and the e2e (issue2500-viewer-clears-top-bar.spec.ts) is what
// observes a real engine placing the viewer under it.

const rect = (top: number, bottom: number): DOMRect =>
  ({
    top,
    bottom,
    y: top,
    x: 0,
    left: 0,
    right: 0,
    width: 0,
    height: bottom - top,
    toJSON: () => ({}),
  }) as DOMRect;

// A `.shell-main` whose top sits at `paneTop` — the shell's safe-area padding
// already applied, as on an installed iOS PWA — optionally carrying a top bar
// whose bottom edge sits at `barBottom`.
const mountPane = (paneTop: number, barBottom?: number): void => {
  const pane = document.createElement("section");
  pane.className = "shell-main";
  pane.getBoundingClientRect = () => rect(paneTop, paneTop + 600);
  if (barBottom !== undefined) {
    const bar = document.createElement("div");
    bar.className = "topic-bar";
    bar.getBoundingClientRect = () => rect(barBottom - 63, barBottom);
    pane.append(bar);
  }
  document.body.append(pane);
};

afterEach(() => {
  document.body.replaceChildren();
});

describe("viewerFrameTop (issue 2500)", () => {
  it("starts the frame at the bottom edge of the pane's top bar", () => {
    mountPane(59, 122);
    expect(viewerFrameTop()).toBe(122);
  });

  it("starts it at the pane's own top in a window with no bar, which still clears the inset", () => {
    mountPane(59);
    expect(viewerFrameTop()).toBe(59);
  });

  it("never starts above the pane, even when the bar has scrolled out of it", () => {
    // The admin pane scrolls with its bar inside it, so the bar's bottom edge
    // can sit above the pane's top. The frame must not follow it up there.
    mountPane(59, 20);
    expect(viewerFrameTop()).toBe(59);
  });

  it("is 0 with no shell mounted at all", () => {
    expect(viewerFrameTop()).toBe(0);
  });
});
