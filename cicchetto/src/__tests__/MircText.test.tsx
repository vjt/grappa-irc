import { render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { MircBody } from "../MircText";

// #220 — per-surface link-vs-surface event routing.
//
// A linkified anchor (MircBody renders URLs as real <a target=_blank>)
// that lives INSIDE a tappable surface double-fires: the anchor click
// bubbles to the surface's onClick, so a single tap both browses the
// link AND performs the surface action. `linkPolicy` decides who wins.
//
// Solid delegates `click` to a single document listener and walks the
// composed path calling each element's handler, stopping when
// `e.cancelBubble` is set. So `e.stopPropagation()` inside a delegated
// anchor handler DOES stop the walk before it reaches the wrapping
// surface handler — observable in jsdom via a bubbling dispatch. These
// tests dispatch a real bubbling+cancelable MouseEvent on the anchor
// (same pattern as the media-link suite in ScrollbackPane.test.tsx).

const CROSS_HOST_BODY = "see https://example.com/x for more";

// Dispatch a bubbling, cancelable primary click on the anchor and return
// the event (so callers can inspect defaultPrevented).
function clickAnchor(link: Element): MouseEvent {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  link.dispatchEvent(ev);
  return ev;
}

describe("MircText linkPolicy (#220)", () => {
  describe('default "navigate" (behavior-preserving)', () => {
    it("renders a cross-host URL as a plain target=_blank anchor and does NOT prevent navigation", () => {
      const { container } = render(() => <MircBody body={CROSS_HOST_BODY} />);
      const link = container.querySelector(".scrollback-link") as HTMLAnchorElement;
      expect(link).not.toBeNull();
      expect(link.href).toBe("https://example.com/x");
      expect(link.target).toBe("_blank");
      const ev = clickAnchor(link);
      // Plain navigation — the anchor does its default thing.
      expect(ev.defaultPrevented).toBe(false);
    });

    it("does NOT stop propagation — the click reaches the wrapping surface", () => {
      const surfaceSpy = vi.fn();
      const { container } = render(() => (
        // Faithful to production: the real surfaces (DirectoryPane row,
        // TopicBar strip) are <button>s that wrap MircBody.
        <button type="button" onClick={surfaceSpy}>
          <MircBody body={CROSS_HOST_BODY} />
        </button>
      ));
      const link = container.querySelector(".scrollback-link") as HTMLAnchorElement;
      clickAnchor(link);
      expect(surfaceSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('"link-wins" (/list rows — link browses, surface suppressed)', () => {
    it("stops propagation so the wrapping surface handler does NOT fire", () => {
      const surfaceSpy = vi.fn();
      const { container } = render(() => (
        <button type="button" onClick={surfaceSpy}>
          <MircBody body={CROSS_HOST_BODY} linkPolicy="link-wins" />
        </button>
      ));
      const link = container.querySelector(".scrollback-link") as HTMLAnchorElement;
      clickAnchor(link);
      expect(surfaceSpy).not.toHaveBeenCalled();
    });

    it("still lets the link navigate (does NOT preventDefault) — the link just browses", () => {
      const { container } = render(() => (
        <MircBody body={CROSS_HOST_BODY} linkPolicy="link-wins" />
      ));
      const link = container.querySelector(".scrollback-link") as HTMLAnchorElement;
      const ev = clickAnchor(link);
      expect(ev.defaultPrevented).toBe(false);
    });
  });

  describe('"surface-wins" (topic bar — surface always wins, no direct navigation)', () => {
    it("prevents the link's default navigation", () => {
      const { container } = render(() => (
        <MircBody body={CROSS_HOST_BODY} linkPolicy="surface-wins" />
      ));
      const link = container.querySelector(".scrollback-link") as HTMLAnchorElement;
      const ev = clickAnchor(link);
      expect(ev.defaultPrevented).toBe(true);
    });

    it("does NOT stop propagation — the click still reaches the wrapping surface", () => {
      const surfaceSpy = vi.fn();
      const { container } = render(() => (
        <button type="button" onClick={surfaceSpy}>
          <MircBody body={CROSS_HOST_BODY} linkPolicy="surface-wins" />
        </button>
      ));
      const link = container.querySelector(".scrollback-link") as HTMLAnchorElement;
      clickAnchor(link);
      expect(surfaceSpy).toHaveBeenCalledTimes(1);
    });
  });
});
