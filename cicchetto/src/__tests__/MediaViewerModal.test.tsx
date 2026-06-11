import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("same-task open→close does not strand the overlay refcount (deferred-push leak)", async () => {
    // Review fix (2026-06-11): the deferred pushOverlay microtask must
    // re-check the open flag — close runs popOverlay (clamped at 0)
    // BEFORE the queued push fires, and an unconditional push would
    // strand the count at 1 forever (popOverlay clamps, so no later
    // overlay cycle drains it → permanent iOS scroll-lock).
    render(() => <MediaViewerModal />);
    openMediaViewer(IMAGE_URL, "image");
    closeMediaViewer();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(overlayCount()).toBe(0);
  });
});

// Dogfood bug (2026-06-11): on iOS standalone the plain target=_blank
// anchor NAVIGATED THE PWA — same-origin URLs are in-PWA-scope, and
// in-scope navigation ignores target. That is the exact root cause the
// modal itself was built around; the escape hatch needs the
// x-safari-https:// scheme handoff instead (real Safari, iOS 17+).
describe("MediaViewerModal — 'open in browser' iOS-standalone escape", () => {
  const IPHONE_UA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

  afterEach(() => {
    // Stub fully removed (not set to undefined) — restores the jsdom
    // baseline where the property is absent.
    delete (navigator as Navigator & { standalone?: boolean }).standalone;
    vi.restoreAllMocks();
  });

  function stubIosStandalone(standalone: boolean): void {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE_UA);
    Object.defineProperty(navigator, "standalone", {
      value: standalone,
      configurable: true,
    });
  }

  it("iOS standalone: anchor href is rewritten to the x-safari-https scheme", () => {
    stubIosStandalone(true);
    render(() => <MediaViewerModal />);
    openMediaViewer(IMAGE_URL, "image");
    const anchor = screen.getByRole("link", { name: /open in browser/i }) as HTMLAnchorElement;
    expect(anchor.getAttribute("href")).toBe(
      "x-safari-https://grappa.example/uploads/abcdefghijklmnopqrstuvwxyz",
    );
  });

  it("iOS browser tab (not standalone): href untouched — target=_blank already works there", () => {
    stubIosStandalone(false);
    render(() => <MediaViewerModal />);
    openMediaViewer(IMAGE_URL, "image");
    const anchor = screen.getByRole("link", { name: /open in browser/i }) as HTMLAnchorElement;
    expect(anchor.getAttribute("href")).toBe(IMAGE_URL);
  });
});

// Dogfood bug (2026-06-11): the modal body rendered a bare media
// element — blank dialog until bytes arrived. Spinner until the
// element reports readiness (img: load; video/audio: loadedmetadata),
// explicit failure text on error so a 404 can't spin forever.
describe("MediaViewerModal — loading state", () => {
  it("image: spinner visible on open, gone after the img load event", () => {
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(IMAGE_URL, "image");
    expect(screen.getByRole("status", { name: /loading/i })).not.toBeNull();
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    img?.dispatchEvent(new Event("load"));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("video: spinner until loadedmetadata", () => {
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(VIDEO_URL, "video");
    expect(screen.getByRole("status", { name: /loading/i })).not.toBeNull();
    container.querySelector("video")?.dispatchEvent(new Event("loadedmetadata"));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("audio: spinner until loadedmetadata", () => {
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(IMAGE_URL, "audio");
    expect(screen.getByRole("status", { name: /loading/i })).not.toBeNull();
    container.querySelector("audio")?.dispatchEvent(new Event("loadedmetadata"));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("media error replaces the spinner with failure text (no forever-spinner on 404)", () => {
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(IMAGE_URL, "image");
    container.querySelector("img")?.dispatchEvent(new Event("error"));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText(/failed to load/i)).not.toBeNull();
  });

  it("loading state resets per open — a reopened viewer spins again", () => {
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(IMAGE_URL, "image");
    container.querySelector("img")?.dispatchEvent(new Event("load"));
    expect(screen.queryByRole("status")).toBeNull();
    closeMediaViewer();
    openMediaViewer(VIDEO_URL, "video");
    expect(screen.getByRole("status", { name: /loading/i })).not.toBeNull();
  });
});
