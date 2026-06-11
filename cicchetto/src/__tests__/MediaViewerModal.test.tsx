import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeMediaViewer, mediaViewerState, openMediaViewer } from "../lib/mediaViewer";
import { __resetForTest, overlayCount } from "../lib/overlayScrollLock";
import MediaViewerModal from "../MediaViewerModal";

// Media-viewer modal — media-link cluster (2026-06-11). Real store, no
// mocks: `lib/mediaViewer.ts` is a two-verb signal; mocking it would
// test the mock (CLAUDE.md "mock at boundaries, real dependencies
// inside").

const IMAGE_URL = "https://grappa.example/uploads/abcdefghijklmnopqrstuvwxyz";
const VIDEO_URL = "https://grappa.example/uploads/zyxwvutsrqponmlkjihgfedcba";

beforeEach(() => {
  closeMediaViewer();
  __resetForTest();
});

afterEach(() => {
  closeMediaViewer();
  __resetForTest();
});

describe("MediaViewerModal", () => {
  it("renders nothing while the viewer state is closed", () => {
    render(() => <MediaViewerModal />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("openMediaViewer with image kind renders a dialog with an <img> for the URL", () => {
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(IMAGE_URL, "image");
    expect(screen.getByRole("dialog")).not.toBeNull();
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe(IMAGE_URL);
  });

  it("video kind renders a <video> with controls and playsinline", () => {
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(VIDEO_URL, "video");
    const video = container.querySelector("video");
    expect(video?.getAttribute("src")).toBe(VIDEO_URL);
    expect(video?.hasAttribute("controls")).toBe(true);
    expect(video?.hasAttribute("playsinline")).toBe(true);
  });

  it("audio kind renders an <audio> with controls", () => {
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(IMAGE_URL, "audio");
    const audio = container.querySelector("audio");
    expect(audio?.getAttribute("src")).toBe(IMAGE_URL);
    expect(audio?.hasAttribute("controls")).toBe(true);
  });

  it("close button closes the viewer", () => {
    render(() => <MediaViewerModal />);
    openMediaViewer(IMAGE_URL, "image");
    fireEvent.click(screen.getByRole("button", { name: "Close media viewer" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mediaViewerState()).toBeNull();
  });

  it("backdrop click closes the viewer", () => {
    render(() => <MediaViewerModal />);
    openMediaViewer(IMAGE_URL, "image");
    fireEvent.click(screen.getByRole("button", { name: /close media viewer backdrop/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Escape closes the viewer (document-level listener — focus may sit anywhere)", () => {
    render(() => <MediaViewerModal />);
    openMediaViewer(IMAGE_URL, "image");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("'open in browser' is a real anchor to the URL with target=_blank rel=noopener", () => {
    render(() => <MediaViewerModal />);
    openMediaViewer(IMAGE_URL, "image");
    const anchor = screen.getByRole("link", { name: /open in browser/i }) as HTMLAnchorElement;
    expect(anchor.getAttribute("href")).toBe(IMAGE_URL);
    expect(anchor.getAttribute("target")).toBe("_blank");
    expect(anchor.getAttribute("rel")).toContain("noopener");
  });

  it("pushes the overlay scroll-lock while open and pops it on close", async () => {
    render(() => <MediaViewerModal />);
    openMediaViewer(IMAGE_URL, "image");
    // pushOverlay is deferred a microtask (Solid commit first — same
    // shape as ArchiveModal/PrivacyModal).
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(overlayCount()).toBe(1);
    closeMediaViewer();
    expect(overlayCount()).toBe(0);
  });
});
