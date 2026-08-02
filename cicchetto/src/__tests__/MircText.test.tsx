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

// #455 — textual emphasis markers (*bold*, _underline_, /italic/) rendered
// client-side, markers kept visible, as a display-only layer over the
// linkified run text. The layer is GATED per surface (opt-in via the
// `emphasis` prop, off by default): user-authored surfaces pass it,
// server/service surfaces do not. Composition with linkify (URLs
// untouched) and wire mIRC formatting is the crux; copy fidelity is a
// guarantee, asserted.
describe("MircText textual emphasis markers (#455)", () => {
  describe("emphasis enabled (user-authored surfaces opt in)", () => {
    it("renders *word* as a .scrollback-mirc-bold span with the asterisks kept", () => {
      const { container } = render(() => <MircBody body="a *bold* b" emphasis />);
      const span = container.querySelector(".scrollback-mirc-bold");
      expect(span).not.toBeNull();
      expect(span?.textContent).toBe("*bold*");
    });

    it("renders _word_ as a .scrollback-mirc-underline span with the underscores kept", () => {
      const { container } = render(() => <MircBody body="a _und_ b" emphasis />);
      const span = container.querySelector(".scrollback-mirc-underline");
      expect(span).not.toBeNull();
      expect(span?.textContent).toBe("_und_");
    });

    it("renders /word/ as a .scrollback-mirc-italic span with the slashes kept", () => {
      const { container } = render(() => <MircBody body="a /it/ b" emphasis />);
      const span = container.querySelector(".scrollback-mirc-italic");
      expect(span).not.toBeNull();
      expect(span?.textContent).toBe("/it/");
    });

    it("does NOT emphasize _ or / inside a URL — the anchor text stays intact", () => {
      const body = "see https://ex.com/a/b_c/d here";
      const { container } = render(() => <MircBody body={body} emphasis />);
      const link = container.querySelector(".scrollback-link") as HTMLAnchorElement;
      expect(link.textContent).toBe("https://ex.com/a/b_c/d");
      expect(container.querySelector(".scrollback-mirc-italic")).toBeNull();
      expect(container.querySelector(".scrollback-mirc-underline")).toBeNull();
    });

    it("leaves a filesystem path /usr/bin/ literal (no italic span)", () => {
      const { container } = render(() => <MircBody body="run /usr/bin/ now" emphasis />);
      expect(container.querySelector(".scrollback-mirc-italic")).toBeNull();
    });

    it("preserves copy-paste fidelity — rendered text equals the source verbatim", () => {
      const body = "a *bold* _under_ /it/ https://ex.com/a_b/c end";
      const { container } = render(() => <MircBody body={body} emphasis />);
      // Markers stay visible and nothing is inserted, so the DOM text
      // content (what window.getSelection() returns) is the source string.
      expect(container.textContent).toBe(body);
    });

    it("composes with wire mIRC bold — control byte stripped, marker kept visible", () => {
      // \x02 = wire bold toggle around the whole "hi *x* there"; the marker
      // pass also finds *x*. The rendered text drops the control byte and
      // keeps the asterisks.
      const { container } = render(() => <MircBody body={"\x02hi *x* there\x02"} emphasis />);
      expect(container.textContent).toBe("hi *x* there");
      expect(container.querySelector(".scrollback-mirc-bold")).not.toBeNull();
    });
  });

  describe("emphasis disabled by default (the per-surface gate)", () => {
    // The whole value of vjt's ruling is in the OFF surfaces: a MircBody
    // WITHOUT the emphasis prop — which is exactly what every server/
    // service consumer (WhoisCard, DirectoryPane, ServerReplyModal,
    // ServiceModal, LinksModal, WhoModal, WhowasCard, RegistrationWizard)
    // renders — must leave the markers as literal text, unstyled.
    it("leaves *word* _word_ /word/ literal when emphasis is not passed", () => {
      const { container } = render(() => <MircBody body="a *bold* _und_ /it/ b" />);
      expect(container.querySelector(".scrollback-mirc-bold")).toBeNull();
      expect(container.querySelector(".scrollback-mirc-underline")).toBeNull();
      expect(container.querySelector(".scrollback-mirc-italic")).toBeNull();
    });

    it("keeps the marker text verbatim on an ungated surface (copy fidelity)", () => {
      const body = "released /usr/local/etc and *ping* to _snake_case_ nick";
      const { container } = render(() => <MircBody body={body} />);
      expect(container.textContent).toBe(body);
    });

    it("still renders WIRE mIRC bold on an ungated surface (only the marker layer is gated)", () => {
      // A server that sends real \x02 bytes must still render bold in an
      // off-surface (e.g. a whois card) — the gate only suppresses the
      // textual-marker layer, never the wire-formatting layer.
      const { container } = render(() => <MircBody body={"\x02real\x02 *notmarked*"} />);
      const bold = container.querySelector(".scrollback-mirc-bold");
      expect(bold?.textContent).toBe("real");
      // ...but the *notmarked* asterisks are NOT styled (no second bold span).
      expect(container.querySelectorAll(".scrollback-mirc-bold")).toHaveLength(1);
    });
  });
});

// #648 — a `#channel` linkify segment renders as a click-to-join affordance,
// but ONLY on surfaces that pass `onChannelClick` (scrollback). Everywhere
// else it degrades to plain text — exactly how a url segment renders on a
// non-tappable surface. The crux is the emphasis exclusion: a channel token
// MUST be exempt from the textual-emphasis pass the same way a url is, or
// `#foo_bar_baz` gets its underscores eaten.
describe("MircText channel affordance (#648)", () => {
  it("renders a #channel as a .channel-clickable button; clicking calls onChannelClick with the RAW channel", () => {
    const spy = vi.fn();
    const { container } = render(() => (
      <MircBody body="join #Sniffo now" emphasis onChannelClick={spy} />
    ));
    const btn = container.querySelector(".channel-clickable") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    // display-cased, raw (keys fold downstream; the affordance shows what
    // the sender typed).
    expect(btn.textContent).toBe("#Sniffo");
    btn.click();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("#Sniffo");
  });

  it("excludes a channel from the emphasis pass — #foo_bar_baz keeps its underscores (THE TRAP)", () => {
    const { container } = render(() => (
      <MircBody body="#foo_bar_baz" emphasis onChannelClick={vi.fn()} />
    ));
    // The emphasis pass would have italic/underline-wrapped `_bar_`; a
    // channel segment must never reach it.
    expect(container.querySelector(".scrollback-mirc-underline")).toBeNull();
    expect(container.querySelector(".scrollback-mirc-italic")).toBeNull();
    const btn = container.querySelector(".channel-clickable") as HTMLButtonElement;
    expect(btn?.textContent).toBe("#foo_bar_baz");
    expect(container.textContent).toBe("#foo_bar_baz");
  });

  it("renders a channel as PLAIN TEXT (no button) on a surface WITHOUT onChannelClick", () => {
    const { container } = render(() => <MircBody body="join #chan" emphasis />);
    expect(container.querySelector(".channel-clickable")).toBeNull();
    expect(container.textContent).toBe("join #chan");
  });
});
