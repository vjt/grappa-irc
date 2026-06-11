import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeMediaViewer, mediaViewerState, openMediaViewer } from "../lib/mediaViewer";
import { __resetForTest, overlayCount } from "../lib/overlayScrollLock";
import MediaViewerModal from "../MediaViewerModal";
import { resetPlatformStubs, stubIosStandalone } from "./helpers/platformStubs";

// `maybeEscapePwaClick` is mocked at the module boundary: its escaping
// branch calls window.location.assign, which jsdom makes unforgeable
// AND unimplemented (can be neither spied nor run cleanly). The
// decision logic is pinned in platform.test.ts; here we pin the WIRING
// — the anchor delegates plain clicks to the shared handler. Everything
// else from lib/platform stays real.
const mockMaybeEscapePwaClick = vi.fn((e: MouseEvent, _href: string): boolean => {
  e.preventDefault();
  return true;
});
vi.mock("../lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/platform")>();
  return {
    ...actual,
    maybeEscapePwaClick: (e: MouseEvent, href: string) => mockMaybeEscapePwaClick(e, href),
  };
});

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
// Review fix: the handoff is a CLICK intercept (shared
// maybeEscapePwaClick) — the href attribute must stay the plain URL so
// long-press → Copy Link yields a live https:// URL, not a dead
// x-safari-https:// one (same contract as ScrollbackPane's media
// intercept).
describe("MediaViewerModal — 'open in browser' iOS-standalone escape", () => {
  afterEach(() => {
    mockMaybeEscapePwaClick.mockClear();
    resetPlatformStubs();
  });

  it("href stays the plain URL even on iOS standalone (copy-link must yield a live URL)", () => {
    stubIosStandalone(true);
    render(() => <MediaViewerModal />);
    openMediaViewer(IMAGE_URL, "image");
    const anchor = screen.getByRole("link", { name: /open in browser/i }) as HTMLAnchorElement;
    expect(anchor.getAttribute("href")).toBe(IMAGE_URL);
    expect(anchor.getAttribute("target")).toBe("_blank");
  });

  it("plain click delegates to the shared escape handler with the media href", () => {
    render(() => <MediaViewerModal />);
    openMediaViewer(IMAGE_URL, "image");
    const anchor = screen.getByRole("link", { name: /open in browser/i });
    fireEvent.click(anchor);
    expect(mockMaybeEscapePwaClick).toHaveBeenCalledTimes(1);
    expect(mockMaybeEscapePwaClick.mock.calls[0]?.[1]).toBe(IMAGE_URL);
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

  it("video: suspend clears the spinner (iOS Low Power Mode defers preload — no metadata without a gesture)", () => {
    // Review fix: under iOS data-saving, preload=metadata is downgraded
    // and neither loadedmetadata nor error fires before a play gesture
    // — `suspend` is the event WebKit fires when it defers loading, and
    // without it as a terminator the spinner spins forever over the
    // video's own centered play control.
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(VIDEO_URL, "video");
    container.querySelector("video")?.dispatchEvent(new Event("suspend"));
    expect(screen.queryByRole("status")).toBeNull();
    expect(container.querySelector("video")).not.toBeNull();
  });

  it("mid-playback error does NOT unmount a ready video (transitions only leave 'loading')", () => {
    // Review fix: a transient MEDIA_ERR_NETWORK on an already-playing
    // element must not rip the player out of the DOM — the failure
    // state is for loads that never succeeded.
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(VIDEO_URL, "video");
    const video = container.querySelector("video");
    video?.dispatchEvent(new Event("loadedmetadata"));
    expect(screen.queryByRole("status")).toBeNull();
    video?.dispatchEvent(new Event("error"));
    expect(screen.queryByText(/failed to load/i)).toBeNull();
    expect(container.querySelector("video")).not.toBeNull();
  });

  it("suspend after a load failure does not resurrect the dead element", () => {
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(VIDEO_URL, "video");
    const video = container.querySelector("video");
    video?.dispatchEvent(new Event("error"));
    expect(screen.getByText(/failed to load/i)).not.toBeNull();
    video?.dispatchEvent(new Event("suspend"));
    expect(screen.getByText(/failed to load/i)).not.toBeNull();
    expect(container.querySelector("video")).toBeNull();
  });
});
