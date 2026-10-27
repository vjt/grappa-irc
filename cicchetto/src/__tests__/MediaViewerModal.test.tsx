import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { closeMediaViewer, mediaViewerState, openMediaViewer } from "../lib/mediaViewer";
import {
  __resetForTest,
  overlayCount,
  overlayEscapeDepth,
  runTopmostOverlayEscape,
} from "../lib/overlayScrollLock";
import { TEXT_VIEW_MAX_BYTES } from "../lib/textResource";
import MediaViewerModal from "../MediaViewerModal";
import { resetPlatformStubs, stubIosStandalone } from "./helpers/platformStubs";
import { fireTouchAt } from "./helpers/touchEvents";

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
const TEXT_URL = "https://grappa.example/uploads/abcdefghijklmnopqrstuvwxyz.txt";

// Response-shaped stub, same reason as textResource.test.ts: the component
// depends on `res.body.getReader()`, and the platform's own Response is not
// what is under test here. Module-scoped because the #1764 pane suite and the
// #1839 copy suite need the same fetch, and two copies of it could drift into
// two different notions of what the viewer is looking at.
const stubBody = (text: string): void => {
  const chunk = new TextEncoder().encode(text);
  vi.stubGlobal("fetch", () =>
    Promise.resolve({
      ok: true,
      status: 206,
      body: {
        getReader: () => {
          let sent = false;
          return {
            read: () => {
              if (sent) return Promise.resolve({ done: true });
              sent = true;
              return Promise.resolve({ done: false, value: chunk });
            },
            cancel: () => Promise.resolve(),
          };
        },
      },
    }),
  );
};

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

  // #232 — Escape closes via the shared overlay stack (focus-independent),
  // replacing the old private document keydown listener. runTopmostOverlayEscape
  // is the exact verb the single global keybindings listener invokes.
  it("Escape closes the viewer via the shared overlay stack (focus may sit anywhere)", async () => {
    render(() => <MediaViewerModal />);
    openMediaViewer(IMAGE_URL, "image");
    await waitFor(() => expect(overlayEscapeDepth()).toBe(1));
    expect(runTopmostOverlayEscape()).toBe(true);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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

// issue 1889 — a deleted or expired upload 404s, and the viewer used to render
// that exactly like a broken image: "failed to load — try open in browser",
// where "open in browser" lands on the same route and serves
// `{"error":"not_found"}` as JSON. Two operators went hunting a client bug.
//
// The probe's own decision table lives in mediaAvailability.test.ts against a
// bare function. What is pinned HERE is the wiring only this component can get
// wrong: that the failure transition asks at all, that a 404 changes what the
// reader is told, and — the constraint that matters most — that nothing short
// of a read 404 ever does.
describe("MediaViewerModal — gone vs broken (issue 1889)", () => {
  // The probe is same-origin gated, so the href has to BE same-origin for the
  // component to reach the fetch at all. Built from the live origin rather
  // than spelled out: jsdom's URL is config, not a fact this suite owns.
  const OWN_UPLOAD_URL = `${window.location.origin}/uploads/abcdefghijklmnopqrstuvwxyz.png`;

  const stubProbe = (respond: () => Promise<unknown>): Mock => {
    const fetchMock = vi.fn(respond);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a 404 on the failed upload says it is GONE, not that the load failed", async () => {
    stubProbe(() => Promise.resolve({ status: 404 }));
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(OWN_UPLOAD_URL, "image");
    container.querySelector("img")?.dispatchEvent(new Event("error"));

    await waitFor(() => {
      expect(screen.getByText(/gone/i)).not.toBeNull();
    });
    // The generic line is REPLACED, not joined: it is the sentence that sent
    // two operators after a client bug, and "open in browser" is bad advice
    // for a route that answers JSON.
    expect(screen.queryByText(/failed to load/i)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  // 🔴 The hard constraint, from three directions. Saying "gone" when the
  // upload is fine is worse than the generic message this change replaces.
  it("a 200 keeps the generic text — the element failed for some other reason", async () => {
    const fetchMock = stubProbe(() => Promise.resolve({ status: 200 }));
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(OWN_UPLOAD_URL, "image");
    container.querySelector("img")?.dispatchEvent(new Event("error"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(screen.getByText(/failed to load/i)).not.toBeNull();
    expect(screen.queryByText(/gone/i)).toBeNull();
  });

  it("a probe that never answers keeps the generic text — a dead network is not a deleted upload", async () => {
    const fetchMock = stubProbe(() => Promise.reject(new TypeError("Failed to fetch")));
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(OWN_UPLOAD_URL, "image");
    container.querySelector("img")?.dispatchEvent(new Event("error"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(screen.getByText(/failed to load/i)).not.toBeNull();
    expect(screen.queryByText(/gone/i)).toBeNull();
  });

  it("a cross-host failure is never probed at all — connect-src would refuse it", async () => {
    // Not merely "answers unknown": the request must not be ISSUED, because a
    // blocked fetch is a securitypolicyviolation and the e2e _cspGuard fixture
    // fails any spec whose journey raises one.
    const fetchMock = stubProbe(() => Promise.resolve({ status: 404 }));
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer("https://elsewhere.example/pic.png", "image");
    container.querySelector("img")?.dispatchEvent(new Event("error"));

    await waitFor(() => {
      expect(screen.getByText(/failed to load/i)).not.toBeNull();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a media element that LOADS is never probed — the refinement belongs to the failure", async () => {
    const fetchMock = stubProbe(() => Promise.resolve({ status: 404 }));
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(OWN_UPLOAD_URL, "image");
    container.querySelector("img")?.dispatchEvent(new Event("load"));

    await waitFor(() => {
      expect(screen.queryByRole("status")).toBeNull();
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/gone/i)).toBeNull();
  });

  // The header anchor is the SAME advice in another form: it lands on the same
  // route and shows the reader `{"error":"not_found"}`. A line saying the file
  // is gone beside a live control that opens it contradicts itself.
  it("takes 'open in browser' away once the upload is known gone", async () => {
    stubProbe(() => Promise.resolve({ status: 404 }));
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(OWN_UPLOAD_URL, "image");
    expect(screen.getByRole("link", { name: /open in browser/i })).not.toBeNull();

    container.querySelector("img")?.dispatchEvent(new Event("error"));

    await waitFor(() => {
      expect(screen.queryByRole("link", { name: /open in browser/i })).toBeNull();
    });
  });

  it("KEEPS 'open in browser' on a generic failure — there the advice is still live", async () => {
    // The suppression is scoped to `gone` on purpose. On an ordinary failed
    // load "maybe it is your browser, try it over there" is still a real
    // hypothesis, and the escape hatch still earns its place.
    const fetchMock = stubProbe(() => Promise.reject(new TypeError("Failed to fetch")));
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(OWN_UPLOAD_URL, "image");
    container.querySelector("img")?.dispatchEvent(new Event("error"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(screen.getByText(/failed to load/i)).not.toBeNull();
    expect(screen.getByRole("link", { name: /open in browser/i })).not.toBeNull();
  });
});

// #1438 — swipe up or down to dismiss. The binder's decision table (which
// drags commit, which spring back, what it refuses to claim) is pinned in
// mediaViewerGesture.test.ts against a bare element; what is asserted HERE is
// the wiring only this component can get wrong: the listener sits on the modal
// BODY so a video is as dismissible as an image, the paint re-states the CSS
// centering the inline transform overwrites, the backdrop thins with the pull,
// and a zoomed image keeps its pan.
//
// What these do NOT prove: the follow itself. A synthetic touch in jsdom moves
// no compositor, so this pins the transform STRING the component writes, not
// that anything tracked a finger. That half is on-device (see the module).
describe("MediaViewerModal — swipe to dismiss (#1438)", () => {
  const SLOW_MS = 2_000; // well under the flick threshold, so distance decides
  const X = 160;
  const Y0 = 300;

  const dialogIn = (container: HTMLElement): HTMLElement => {
    const el = container.querySelector<HTMLElement>(".media-viewer-modal");
    if (el === null) throw new Error("no media viewer dialog rendered");
    return el;
  };

  const backdropIn = (container: HTMLElement): HTMLElement => {
    const el = container.querySelector<HTMLElement>(".media-viewer-backdrop");
    if (el === null) throw new Error("no media viewer backdrop rendered");
    return el;
  };

  // Touch DOWN and drag to `dy`, finger still on the glass — the mid-drag paint
  // is only observable before the release puts everything back.
  const dragTo = (target: HTMLElement, dy: number): void => {
    fireTouchAt(target, "touchstart", 0, { clientX: X, clientY: Y0 });
    fireTouchAt(target, "touchmove", SLOW_MS / 2, { clientX: X, clientY: Y0 + dy });
  };

  const dragAndLift = (target: HTMLElement, dy: number): void => {
    dragTo(target, dy);
    fireTouchAt(target, "touchend", SLOW_MS, { clientX: X, clientY: Y0 + dy });
  };

  it("a long downward drag on the image closes the viewer through the shared close verb", () => {
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(IMAGE_URL, "image");
    dragAndLift(dialogIn(container), 400);
    expect(mediaViewerState()).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a long upward drag on a VIDEO closes it too — the listener is on the modal, not the image", () => {
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(VIDEO_URL, "video");
    dragAndLift(dialogIn(container), -400);
    expect(mediaViewerState()).toBeNull();
  });

  it("translates the modal by the drag distance while the finger is down", () => {
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(IMAGE_URL, "image");
    const dialog = dialogIn(container);
    dragTo(dialog, 50);
    expect(dialog.style.transform).toContain("translateY(50px)");
  });

  it("keeps the CSS centering in the dragged transform (an inline transform replaces the rule)", () => {
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(IMAGE_URL, "image");
    const dialog = dialogIn(container);
    dragTo(dialog, 50);
    expect(dialog.style.transform).toContain("translate(-50%, -50%)");
  });

  it("thins the backdrop as the pull grows", () => {
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(IMAGE_URL, "image");
    const dialog = dialogIn(container);
    const backdrop = backdropIn(container);
    dragTo(dialog, 50);
    const near = Number(backdrop.style.opacity);
    fireTouchAt(dialog, "touchmove", SLOW_MS, { clientX: X, clientY: Y0 + 300 });
    const far = Number(backdrop.style.opacity);
    expect(near).toBeLessThan(1);
    expect(far).toBeLessThan(near);
    expect(far).toBeGreaterThanOrEqual(0);
  });

  it("a short slow drag springs the modal and the backdrop back to rest", () => {
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(IMAGE_URL, "image");
    const dialog = dialogIn(container);
    const backdrop = backdropIn(container);
    dragAndLift(dialog, 50);
    expect(mediaViewerState()).not.toBeNull();
    expect(dialog.style.transform).toBe("");
    expect(backdrop.style.opacity).toBe("");
  });

  it("a zoomed image keeps the drag — the dismiss stands down until it is back at fit", () => {
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(IMAGE_URL, "image");
    const img = container.querySelector<HTMLElement>("img");
    if (img === null) throw new Error("no image rendered");
    // Double-tap zoom (#213), the same two touchstarts the viewer reads: it is
    // the published scale, not a test seam, that stands the dismiss down.
    // Since #1805 the drag it stands down FOR is the browser's own scroll
    // rather than a synthesized pan, but the gate and its reason are unchanged.
    fireTouchAt(img, "touchstart", 1_000, { clientX: X, clientY: Y0 });
    fireTouchAt(img, "touchend", 1_020, { clientX: X, clientY: Y0 });
    fireTouchAt(img, "touchstart", 1_100, { clientX: X, clientY: Y0 });
    dragAndLift(dialogIn(container), 400);
    expect(mediaViewerState()).not.toBeNull();
  });
});

// #1805 — the pan is the browser's scroller now, not a synthesized transform.
// The pure arithmetic (rescaleScroll, applyPinch, toggleZoom) is pinned in
// pinchZoom.test.ts; what is asserted HERE is what only this component can get
// wrong, and each item is one that a plausible-looking implementation gets
// wrong silently:
//
//   - a single-finger touchmove must NOT be claimed. A blanket preventDefault
//     is exactly what shipped before, and it leaves every other symptom intact
//     while the scroll simply never happens (measured on the #1805 bench:
//     claiming while zoomed pins scrollTop at 0 with the scroller otherwise
//     correct in every respect).
//   - the sizer must be ZERO at fit. Non-zero there is a browser pan at fit,
//     which is the swipe-to-dismiss taken away.
//   - the zoom must be anchored to the touched point. Anchoring to the corner
//     also "works": it zooms, it scrolls, and it is wrong.
//
// jsdom has no layout, so the fit box the component MIRRORS and the scroll
// offsets it WRITES are injected below. That is a seam on the DOM, not on the
// component — nothing in production code knows these tests exist.
describe("MediaViewerModal — native pan for the zoomed image (#1805)", () => {
  const FIT = { width: 300, height: 200 };

  const openZoomable = (container: HTMLElement) => {
    openMediaViewer(IMAGE_URL, "image");
    const scroller = container.querySelector<HTMLElement>(".media-viewer-zoom-scroller");
    const sizer = container.querySelector<HTMLElement>(".media-viewer-zoom-sizer");
    const img = container.querySelector<HTMLImageElement>("img.media-viewer-media--zoomable");
    if (scroller === null || sizer === null || img === null) {
      throw new Error("no zoomable image rendered");
    }
    Object.defineProperty(img, "clientWidth", { value: FIT.width, configurable: true });
    Object.defineProperty(img, "clientHeight", { value: FIT.height, configurable: true });
    scroller.getBoundingClientRect = (): DOMRect =>
      ({
        left: 0,
        top: 0,
        right: FIT.width,
        bottom: FIT.height,
        width: FIT.width,
        height: FIT.height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    let scrollLeft = 0;
    let scrollTop = 0;
    Object.defineProperty(scroller, "scrollLeft", {
      configurable: true,
      get: () => scrollLeft,
      set: (v: number) => {
        scrollLeft = v;
      },
    });
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    });
    // The load handler is where the fit is first measured — no ResizeObserver
    // in jsdom, which the component tolerates on purpose.
    fireEvent.load(img);
    return { scroller, sizer, img };
  };

  const doubleTapAt = (el: HTMLElement, clientX: number, clientY: number): void => {
    fireTouchAt(el, "touchstart", 1_000, { clientX, clientY });
    fireTouchAt(el, "touchend", 1_020, { clientX, clientY });
    fireTouchAt(el, "touchstart", 1_100, { clientX, clientY });
  };

  it("leaves a single-finger touchmove unclaimed, so the browser can scroll with it", () => {
    const { container } = render(() => <MediaViewerModal />);
    const { img } = openZoomable(container);
    doubleTapAt(img, 150, 100);
    fireTouchAt(img, "touchstart", 2_000, { clientX: 150, clientY: 100 });
    const move = fireTouchAt(img, "touchmove", 2_050, { clientX: 150, clientY: 40 });
    expect(move.defaultPrevented).toBe(false);
  });

  it("still claims a TWO-finger touchmove — the native pinch it replaces does not exist", () => {
    const { container } = render(() => <MediaViewerModal />);
    const { img } = openZoomable(container);
    fireTouchAt(
      img,
      "touchstart",
      2_000,
      { clientX: 100, clientY: 100 },
      { clientX: 200, clientY: 100 },
    );
    const move = fireTouchAt(
      img,
      "touchmove",
      2_050,
      { clientX: 0, clientY: 100 },
      { clientX: 300, clientY: 100 },
    );
    expect(move.defaultPrevented).toBe(true);
    expect(img.style.transform).toBe("scale(3)");
  });

  it("carries NO scrollable area at fit, so the dismiss keeps the single-finger drag", () => {
    const { container } = render(() => <MediaViewerModal />);
    const { sizer } = openZoomable(container);
    expect(sizer.style.width).toBe("0px");
    expect(sizer.style.height).toBe("0px");
  });

  it("grows the scrollable area to fit x scale once zoomed — a transform alone would grow nothing", () => {
    const { container } = render(() => <MediaViewerModal />);
    const { sizer, img } = openZoomable(container);
    doubleTapAt(img, 150, 100);
    expect(img.style.transform).toBe("scale(2)");
    expect(sizer.style.width).toBe(`${FIT.width * 2}px`);
    expect(sizer.style.height).toBe(`${FIT.height * 2}px`);
  });

  it("anchors a double-tap zoom to the tapped point, not to the corner", () => {
    const { container } = render(() => <MediaViewerModal />);
    const { scroller, img } = openZoomable(container);
    // Tap dead centre of a 300x200 box: at 2x the point that was at (150,100)
    // paints at (300,200), so holding it under the finger costs exactly one
    // half-box of scroll on each axis.
    doubleTapAt(img, 150, 100);
    expect(scroller.scrollLeft).toBe(150);
    expect(scroller.scrollTop).toBe(100);
  });

  it("holds the top-left corner when THAT is what was tapped", () => {
    const { container } = render(() => <MediaViewerModal />);
    const { scroller, img } = openZoomable(container);
    doubleTapAt(img, 0, 0);
    expect(scroller.scrollLeft).toBe(0);
    expect(scroller.scrollTop).toBe(0);
  });

  it("unwinds the scroll when the second double-tap returns the image to fit", () => {
    const { container } = render(() => <MediaViewerModal />);
    const { scroller, sizer, img } = openZoomable(container);
    doubleTapAt(img, 150, 100);
    doubleTapAt(img, 150, 100);
    expect(img.style.transform).toBe("scale(1)");
    expect(sizer.style.width).toBe("0px");
    expect(scroller.scrollLeft).toBe(0);
    expect(scroller.scrollTop).toBe(0);
  });

  it("marks the modal as the image variant, so the stylesheet can re-open the touch stream", () => {
    const { container } = render(() => <MediaViewerModal />);
    openZoomable(container);
    const dialog = container.querySelector<HTMLElement>(".media-viewer-modal");
    if (dialog === null) throw new Error("no media viewer dialog rendered");
    expect(dialog.classList.contains("media-viewer-modal--zoomable")).toBe(true);
  });

  it("does NOT mark a video as the image variant — a <video> has no scroller under it", () => {
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(VIDEO_URL, "video");
    const dialog = container.querySelector<HTMLElement>(".media-viewer-modal");
    if (dialog === null) throw new Error("no media viewer dialog rendered");
    expect(dialog.classList.contains("media-viewer-modal--zoomable")).toBe(false);
    expect(container.querySelector(".media-viewer-zoom-scroller")).toBeNull();
  });
});

// #1764 — .txt / .md open as SOURCE in the same modal: monospace, line
// numbers, no rendering of any kind (vjt, #sbiffo 2026-08-24: "nono nessun
// rendering di gesu, assolutamente solo il sorgente txt e md"). The fetch/cap
// arithmetic is pinned in textResource.test.ts against the raw verb; what is
// asserted HERE is what only this component can get wrong — that the bytes
// reach the pane, that the gutter numbers the lines the pane shows, that the
// truncation is VISIBLE, and that a scrolled pane does not lose its scroll to
// the dismiss gesture.
describe("MediaViewerModal — text source viewer (#1764)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const textPane = (container: HTMLElement): HTMLElement => {
    const el = container.querySelector<HTMLElement>(".media-viewer-text");
    if (el === null) throw new Error("no text pane rendered");
    return el;
  };

  it("renders the fetched source verbatim in a <pre>", async () => {
    stubBody("alpha\nbeta\ngamma\n");
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(TEXT_URL, "text");
    await waitFor(() => {
      expect(container.querySelector(".media-viewer-text-source")?.textContent).toBe(
        "alpha\nbeta\ngamma",
      );
    });
    // The whole point of the ruling: nothing was interpreted on the way in.
    expect(container.querySelector(".media-viewer-text-source")?.tagName).toBe("PRE");
  });

  it("numbers every line, and exactly the lines the pane shows", async () => {
    stubBody("one\ntwo\nthree\nfour\n");
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(TEXT_URL, "text");
    await waitFor(() => {
      expect(container.querySelector(".media-viewer-text-gutter")?.textContent).toBe("1\n2\n3\n4");
    });
  });

  it("markdown source is shown as SOURCE — no heading, no emphasis, no anchor", async () => {
    stubBody("# Title\n\n**bold** and [a link](https://example.com)\n");
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer("https://grappa.example/uploads/abcdefghijklmnopqrstuvwxyz.md", "text");
    await waitFor(() => {
      expect(container.querySelector(".media-viewer-text-source")?.textContent).toContain(
        "**bold**",
      );
    });
    const pane = textPane(container);
    // The three shapes a renderer would have produced. cic has no sanitisation
    // surface anywhere today and this change must not be the reason it grows
    // one — so the assertion is about generated HTML, not about looks.
    expect(pane.querySelector("h1")).toBeNull();
    expect(pane.querySelector("strong")).toBeNull();
    expect(pane.querySelector("a")).toBeNull();
  });

  it("says so, in the pane, when the source was cut at the cap", async () => {
    stubBody("x".repeat(TEXT_VIEW_MAX_BYTES + 1));
    render(() => <MediaViewerModal />);
    openMediaViewer(TEXT_URL, "text");
    await waitFor(() => {
      expect(screen.getByText(/first .* of this file/i)).not.toBeNull();
    });
  });

  it("says nothing about truncation when the whole file arrived", async () => {
    stubBody("short\n");
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(TEXT_URL, "text");
    await waitFor(() => {
      expect(container.querySelector(".media-viewer-text-source")).not.toBeNull();
    });
    expect(container.querySelector(".media-viewer-text-truncated")).toBeNull();
  });

  it("a failed fetch shows the shared failure text, not a forever-spinner", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: false, status: 404, body: null }));
    render(() => <MediaViewerModal />);
    openMediaViewer(TEXT_URL, "text");
    await waitFor(() => {
      expect(screen.getByText(/failed to load/i)).not.toBeNull();
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a downward drag on a SCROLLED pane does not dismiss — the pane owns its own axis", async () => {
    stubBody("a\nb\nc\n");
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(TEXT_URL, "text");
    await waitFor(() => {
      expect(container.querySelector(".media-viewer-text")).not.toBeNull();
    });
    const dialog = container.querySelector<HTMLElement>(".media-viewer-modal");
    if (dialog === null) throw new Error("no media viewer dialog rendered");
    // jsdom has no layout, so scrollTop is a plain writable property here —
    // which is exactly the state the gate reads on a real phone.
    textPane(container).scrollTop = 120;
    fireTouchAt(dialog, "touchstart", 0, { clientX: 160, clientY: 300 });
    fireTouchAt(dialog, "touchmove", 1_000, { clientX: 160, clientY: 700 });
    fireTouchAt(dialog, "touchend", 2_000, { clientX: 160, clientY: 700 });
    expect(mediaViewerState()).not.toBeNull();
  });

  it("an UPWARD drag never dismisses a text pane — that gesture is 'read on'", async () => {
    stubBody("a\nb\nc\n");
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(TEXT_URL, "text");
    await waitFor(() => {
      expect(container.querySelector(".media-viewer-text")).not.toBeNull();
    });
    const dialog = container.querySelector<HTMLElement>(".media-viewer-modal");
    if (dialog === null) throw new Error("no media viewer dialog rendered");
    fireTouchAt(dialog, "touchstart", 0, { clientX: 160, clientY: 300 });
    fireTouchAt(dialog, "touchmove", 1_000, { clientX: 160, clientY: -100 });
    fireTouchAt(dialog, "touchend", 2_000, { clientX: 160, clientY: -100 });
    expect(mediaViewerState()).not.toBeNull();
  });

  it("a long downward drag from the TOP of the pane still dismisses", async () => {
    stubBody("a\nb\nc\n");
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(TEXT_URL, "text");
    await waitFor(() => {
      expect(container.querySelector(".media-viewer-text")).not.toBeNull();
    });
    const dialog = container.querySelector<HTMLElement>(".media-viewer-modal");
    if (dialog === null) throw new Error("no media viewer dialog rendered");
    fireTouchAt(dialog, "touchstart", 0, { clientX: 160, clientY: 300 });
    fireTouchAt(dialog, "touchmove", 1_000, { clientX: 160, clientY: 700 });
    fireTouchAt(dialog, "touchend", 2_000, { clientX: 160, clientY: 700 });
    expect(mediaViewerState()).toBeNull();
  });

  it("carries the text modifier class, which is what re-opens touch panning for the pane", async () => {
    stubBody("a\n");
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(TEXT_URL, "text");
    await waitFor(() => {
      expect(container.querySelector(".media-viewer-text")).not.toBeNull();
    });
    expect(container.querySelector(".media-viewer-modal--text")).not.toBeNull();
  });

  it("an image open carries NO text modifier — `touch-action: none` must survive there", () => {
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(IMAGE_URL, "image");
    expect(container.querySelector(".media-viewer-modal--text")).toBeNull();
  });
});

// issue 1839 — a copy control on the text arm's header. Selecting a long source
// pane by hand is a fight on a phone (the pane owns the drag as a scroll), so
// the button is the whole affordance; what is asserted here is the three ways
// it can be shipped wrong and look right:
//
//   - copying the DOM instead of the resource. The pane is a gutter <pre> and a
//     source <pre> side by side, so `textContent` off the pane carries the line
//     NUMBERS. The fixtures below are deliberately digit-free, which makes a
//     gutter leak provable rather than eyeballed.
//   - copying a TRUNCATED view without saying so. `TEXT_VIEW_MAX_BYTES` caps
//     the fetch, and a silent prefix of a config file is the failure worth
//     designing against.
//   - swallowing a clipboard failure. `navigator.clipboard` is
//     `[SecureContext]`-only and undefined on the plain-http LAN deploys this
//     project supports, which is not a hypothetical arm.
describe("MediaViewerModal — copy the source (issue 1839)", () => {
  const restoreClipboard: Array<() => void> = [];

  const withClipboard = (value: unknown): void => {
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value, configurable: true });
    restoreClipboard.push(() => {
      if (original === undefined) Reflect.deleteProperty(navigator, "clipboard");
      else Object.defineProperty(navigator, "clipboard", original);
    });
  };

  const stubClipboard = (): Mock<(t: string) => Promise<void>> => {
    const writeText = vi.fn<(t: string) => Promise<void>>(() => Promise.resolve());
    withClipboard({ writeText });
    return writeText;
  };

  afterEach(() => {
    for (const restore of restoreClipboard.splice(0)) restore();
    vi.unstubAllGlobals();
  });

  const openTextAndCopy = async (container: HTMLElement, href: string): Promise<void> => {
    openMediaViewer(href, "text");
    await waitFor(() => {
      expect(container.querySelector(".media-viewer-text-source")).not.toBeNull();
    });
    await fireEvent.click(screen.getByRole("button", { name: /^copy$/i }));
  };

  it("puts the SOURCE on the clipboard — the gutter's line numbers stay out of it", async () => {
    stubBody("alpha\nbeta\ngamma\n");
    const writeText = stubClipboard();
    const { container } = render(() => <MediaViewerModal />);
    await openTextAndCopy(container, TEXT_URL);

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const payload = writeText.mock.calls[0]?.[0] ?? "";
    expect(payload).toBe("alpha\nbeta\ngamma");
    // The gutter really is rendered, and really does carry digits — without
    // this the negative below would pass against an empty pane.
    expect(container.querySelector(".media-viewer-text-gutter")?.textContent).toBe("1\n2\n3");
    // The fixture has no digits of its own, so ANY digit in the payload is a
    // number that came off the gutter. This is the assertion a `textContent`
    // scrape of the pane fails.
    expect(payload).not.toMatch(/[0-9]/);
  });

  it("says the clipboard holds only a slice when the fetch was cut at the cap", async () => {
    stubBody("x".repeat(TEXT_VIEW_MAX_BYTES + 1));
    const writeText = stubClipboard();
    const { container } = render(() => <MediaViewerModal />);
    await openTextAndCopy(container, TEXT_URL);

    // The slice is still delivered — refusing to copy would be worse than
    // copying and saying so.
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(new RegExp(`first ${TEXT_VIEW_MAX_BYTES / 1024} KiB`));
  });

  it("does NOT claim a slice when the whole file arrived", async () => {
    stubBody("alpha\nbeta\n");
    stubClipboard();
    const { container } = render(() => <MediaViewerModal />);
    await openTextAndCopy(container, TEXT_URL);

    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/copied/i);
    expect(status.textContent).not.toMatch(/first/i);
  });

  it("names a missing clipboard API instead of failing inert", async () => {
    stubBody("alpha\nbeta\n");
    withClipboard(undefined);
    const { container } = render(() => <MediaViewerModal />);
    await openTextAndCopy(container, TEXT_URL);

    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/secure \(HTTPS\)/);
    // The source stays on screen: the way out the message names is real.
    expect(container.querySelector(".media-viewer-text-source")?.textContent).toBe("alpha\nbeta");
  });

  it("names a rejected write too (denied permission)", async () => {
    stubBody("alpha\nbeta\n");
    withClipboard({ writeText: () => Promise.reject(new Error("NotAllowedError")) });
    const { container } = render(() => <MediaViewerModal />);
    await openTextAndCopy(container, TEXT_URL);

    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/NotAllowedError/);
  });

  it("offers no copy control on the image arm — the header is shared chrome", () => {
    render(() => <MediaViewerModal />);
    openMediaViewer(IMAGE_URL, "image");
    expect(screen.queryByRole("button", { name: /^copy$/i })).toBeNull();
  });

  it("offers no copy control when the text fetch failed — there is nothing to take", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: false, status: 404, body: null }));
    render(() => <MediaViewerModal />);
    openMediaViewer(TEXT_URL, "text");
    await waitFor(() => {
      expect(screen.getByText(/failed to load/i)).not.toBeNull();
    });
    expect(screen.queryByRole("button", { name: /^copy$/i })).toBeNull();
  });
});

// issue 2468 — a picture someone posted could not be forwarded from a phone:
// the viewer had no way to take the FILE out, only the "open in browser" detour.
// vjt's ruling adds two verbs beside that anchor, Download and Share, and the
// native long-press menu on the image (a stylesheet rule — pinned at source in
// touchSelectionPolicy.test.ts, because jsdom applies no stylesheet).
describe("MediaViewerModal — download + share (issue 2468)", () => {
  // Both verbs are same-origin gated, so the href has to BE same-origin to
  // reach them. Built from the live origin, the issue 1889 suite's reasoning.
  const OWN_IMAGE_URL = `${window.location.origin}/uploads/abcdefghijklmnopqrstuvwxyz.png`;
  const OWN_VIDEO_URL = `${window.location.origin}/uploads/zyxwvutsrqponmlkjihgfedcba.mp4`;
  const FOREIGN_IMAGE_URL = "https://elsewhere.example/uploads/pic.png";
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const restoreNavigator: Array<() => void> = [];

  const defineOnNavigator = (key: "share" | "canShare", value: unknown): void => {
    const original = Object.getOwnPropertyDescriptor(navigator, key);
    Object.defineProperty(navigator, key, { value, configurable: true });
    restoreNavigator.push(() => {
      if (original === undefined) Reflect.deleteProperty(navigator, key);
      else Object.defineProperty(navigator, key, original);
    });
  };

  const stubShare = (
    respond: () => Promise<void> = () => Promise.resolve(),
    canShareFiles = true,
  ): Mock<(data: ShareData) => Promise<void>> => {
    const share = vi.fn<(data: ShareData) => Promise<void>>(respond);
    defineOnNavigator("share", share);
    defineOnNavigator("canShare", (data: ShareData) => data.files === undefined || canShareFiles);
    return share;
  };

  // The served bytes, as the upload route answers them.
  const stubServedImage = (): Mock => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        blob: () => Promise.resolve(new Blob([PNG_BYTES], { type: "image/png" })),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  const actionStatus = (container: HTMLElement): Element | null =>
    container.querySelector(".media-viewer-action-status");

  afterEach(() => {
    for (const restore of restoreNavigator.splice(0)) restore();
    vi.unstubAllGlobals();
  });

  it("offers a download anchor for an own upload, beside 'open in browser'", () => {
    render(() => <MediaViewerModal />);
    openMediaViewer(OWN_IMAGE_URL, "image");

    const download = screen.getByRole("link", { name: /^download$/i });
    expect(download.getAttribute("href")).toBe(OWN_IMAGE_URL);
    // Empty on purpose (the AudioMiniPlayer precedent): the save takes the
    // server's own filename, and cic has nothing better on the wire.
    expect(download.getAttribute("download")).toBe("");
    // A download is not a navigation. With `target=_blank` some engines open
    // an empty tab for it, and on iOS standalone a tab is the PWA itself.
    expect(download.hasAttribute("target")).toBe(false);
    expect(screen.getByRole("link", { name: /open in browser/i })).not.toBeNull();
  });

  it("offers it on a video too — the header is shared chrome", () => {
    render(() => <MediaViewerModal />);
    openMediaViewer(OWN_VIDEO_URL, "video");
    expect(screen.getByRole("link", { name: /^download$/i }).getAttribute("href")).toBe(
      OWN_VIDEO_URL,
    );
  });

  it("offers NO download on a cross-host link — `download` is ignored there and would navigate out", () => {
    render(() => <MediaViewerModal />);
    openMediaViewer(FOREIGN_IMAGE_URL, "image");
    expect(screen.queryByRole("link", { name: /^download$/i })).toBeNull();
    // The control is the anchor beside it: the header did render.
    expect(screen.getByRole("link", { name: /open in browser/i })).not.toBeNull();
  });

  it("offers share only where the Web Share API exists", () => {
    render(() => <MediaViewerModal />);
    openMediaViewer(OWN_IMAGE_URL, "image");
    expect(screen.queryByRole("button", { name: /^share$/i })).toBeNull();
    closeMediaViewer();

    stubShare();
    openMediaViewer(OWN_IMAGE_URL, "image");
    expect(screen.getByRole("button", { name: /^share$/i })).not.toBeNull();
  });

  it("shares the FILE of an own upload where the platform accepts files", async () => {
    const fetchMock = stubServedImage();
    const share = stubShare();
    render(() => <MediaViewerModal />);
    openMediaViewer(OWN_IMAGE_URL, "image");

    await fireEvent.click(screen.getByRole("button", { name: /^share$/i }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(OWN_IMAGE_URL);
    const data = share.mock.calls[0]?.[0];
    expect(data?.url).toBeUndefined();
    const file = data?.files?.[0];
    expect(data?.files).toHaveLength(1);
    // Named after the link's last segment so the receiving app sees a `.png`,
    // typed from what the server served, and the bytes are the served bytes.
    expect(file?.name).toBe("abcdefghijklmnopqrstuvwxyz.png");
    expect(file?.type).toBe("image/png");
    expect(file?.size).toBe(PNG_BYTES.byteLength);
  });

  it("falls back to the link where the platform refuses the file", async () => {
    stubServedImage();
    const share = stubShare(() => Promise.resolve(), false);
    render(() => <MediaViewerModal />);
    openMediaViewer(OWN_IMAGE_URL, "image");

    await fireEvent.click(screen.getByRole("button", { name: /^share$/i }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(share.mock.calls[0]?.[0]).toEqual({ url: OWN_IMAGE_URL });
  });

  it("falls back to the link when the bytes cannot be fetched", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: false, status: 404 }));
    const share = stubShare();
    render(() => <MediaViewerModal />);
    openMediaViewer(OWN_IMAGE_URL, "image");

    await fireEvent.click(screen.getByRole("button", { name: /^share$/i }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(share.mock.calls[0]?.[0]).toEqual({ url: OWN_IMAGE_URL });
  });

  it("shares a cross-host link by URL without fetching it — connect-src would refuse the request", async () => {
    // Not merely "falls back": the request must not be ISSUED, because a
    // blocked fetch is a securitypolicyviolation (the issue 1889 probe rule).
    const fetchMock = stubServedImage();
    const share = stubShare();
    render(() => <MediaViewerModal />);
    openMediaViewer(FOREIGN_IMAGE_URL, "image");

    await fireEvent.click(screen.getByRole("button", { name: /^share$/i }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(share.mock.calls[0]?.[0]).toEqual({ url: FOREIGN_IMAGE_URL });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says nothing when the reader dismisses the share sheet", async () => {
    stubServedImage();
    const share = stubShare(() => Promise.reject(new DOMException("cancelled", "AbortError")));
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(OWN_IMAGE_URL, "image");

    await fireEvent.click(screen.getByRole("button", { name: /^share$/i }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    // Flush the rejection before asserting the absence of what it would write.
    await Promise.resolve();
    expect(actionStatus(container)).toBeNull();
  });

  it("names a refused share instead of failing inert", async () => {
    stubServedImage();
    stubShare(() => Promise.reject(new DOMException("share refused", "NotAllowedError")));
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(OWN_IMAGE_URL, "image");

    await fireEvent.click(screen.getByRole("button", { name: /^share$/i }));

    await waitFor(() => expect(actionStatus(container)?.textContent).toMatch(/share refused/));
  });

  it("takes download and share away once the upload is known gone", async () => {
    // Same reasoning as 'open in browser' above: both would hand the reader
    // the route's `{"error":"not_found"}` instead of a file.
    vi.stubGlobal("fetch", () => Promise.resolve({ status: 404 }));
    stubShare();
    const { container } = render(() => <MediaViewerModal />);
    openMediaViewer(OWN_IMAGE_URL, "image");
    expect(screen.getByRole("link", { name: /^download$/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /^share$/i })).not.toBeNull();

    container.querySelector("img")?.dispatchEvent(new Event("error"));

    await waitFor(() => {
      expect(screen.queryByText(/gone/i)).not.toBeNull();
    });
    expect(screen.queryByRole("link", { name: /^download$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^share$/i })).toBeNull();
  });
});
