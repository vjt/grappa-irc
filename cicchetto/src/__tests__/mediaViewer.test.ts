import { afterEach, describe, expect, it } from "vitest";
import { closeMediaViewer, openMediaViewer } from "../lib/mediaViewer";

// Media-viewer store (#1124). `openMediaViewer` is the single open door —
// `MircText`'s media-link click handler is its only caller — so the
// keyboard-dismissing blur is pinned on the VERB here, not at a call site.
// Sibling shape: audioPlayer.test.ts.
//
// What jsdom cannot prove: there is no soft keyboard and no visualViewport
// resize here, so this asserts the CAUSE (focus leaves the text field) and
// not the EFFECT (the viewport grows back, the image gets the full height).
// The effect is device-verify only.

const IMAGE_URL = "https://grappa.example/uploads/abcdefghijklmnopqrstuvwxyz";

afterEach(() => {
  closeMediaViewer();
  document.body.replaceChildren();
});

describe("mediaViewer store", () => {
  it("openMediaViewer blurs the focused compose field, so iOS dismisses the keyboard", () => {
    const compose = document.createElement("textarea");
    document.body.append(compose);
    compose.focus();
    expect(document.activeElement).toBe(compose);

    openMediaViewer(IMAGE_URL, "image");

    expect(document.activeElement).not.toBe(compose);
  });
});
