import { render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DiagFloat, { DIAG_FLAG_KEY } from "../DiagFloat";
import { SETTLE_REREAD_DELAYS_MS } from "../lib/viewportHeight";

// #1791 — the resume seam on the instrument.
//
// DiagFloat (UX-6 D6) is the ONE instrument built for the iOS PWA
// layout-viewport shift, and until this change it listened only to what a
// FOREGROUND app emits: `resize`, `scroll`, `focusin`/`focusout`, touch. An
// app-switch RETURN reliably emits none of those — that absence is the entire
// premise of #649's three resume triggers on the var writer — so the panel has
// never produced a single line for the event class #1791 is reported on.
//
// What these tests prove: the WIRING. Given a resume event, a line lands, and
// it carries the two readings that discriminate the rival explanations of the
// report (`--vh`, the var, and `wy`, the window scroll offset).
//
// What they do NOT prove, deliberately (#654's rule — "a green spec that
// cannot observe the behaviour is worse than no spec"): anything about iOS.
// jsdom has no visual viewport, no soft keyboard and no WKWebView
// UIScrollView. Whether a real iOS resume shifts the content, and by how much,
// is vjt's device leg — which is what the panel now exists to capture.

const geometryLines = (): string[] =>
  Array.from(screen.getByTestId("diag-float-geometry").children).map((el) => el.textContent ?? "");

const setVisibility = (state: DocumentVisibilityState): void => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
};

describe("DiagFloat — resume triggers (#1791)", () => {
  beforeEach(() => {
    localStorage.setItem(DIAG_FLAG_KEY, "1");
    setVisibility("visible");
  });

  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.style.removeProperty("--vh");
    setVisibility("visible");
  });

  it("logs a line when visibilitychange returns the document to visible", () => {
    render(() => <DiagFloat />);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(geometryLines().some((line) => line.includes("resume:visible"))).toBe(true);
  });

  it("logs a line on pageshow (the bfcache / installed-PWA restore)", () => {
    render(() => <DiagFloat />);
    window.dispatchEvent(new Event("pageshow"));
    expect(geometryLines().some((line) => line.includes("resume:pageshow"))).toBe(true);
  });

  it("logs a line on window focus (another app dismissed over the top)", () => {
    render(() => <DiagFloat />);
    window.dispatchEvent(new Event("focus"));
    expect(geometryLines().some((line) => line.includes("resume:focus"))).toBe(true);
  });

  // The hide edge is kept — unlike the var WRITER, which gates on
  // `visibilityState === "visible"` because it must not write a hidden
  // geometry. An instrument that drops the hide edge loses the bracket that
  // says what the last foreground geometry was and how long the app was away.
  it("logs the hide edge too, as the bracket for the resume that follows", () => {
    render(() => <DiagFloat />);
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(geometryLines().some((line) => line.includes("resume:hidden"))).toBe(true);
  });

  it("re-samples on the writer's settle schedule, with no further event", () => {
    vi.useFakeTimers();
    render(() => <DiagFloat />);
    window.dispatchEvent(new Event("pageshow"));

    // Nothing but the immediate line yet.
    expect(geometryLines().filter((line) => line.includes("resume:pageshow+"))).toHaveLength(0);

    // Import the schedule rather than restating it: the instrument must sample
    // at the instants the single var writer settles at, or the two disagree
    // about when "settled" is and a reader correlating them gets a false story.
    vi.advanceTimersByTime(Math.max(...SETTLE_REREAD_DELAYS_MS));
    const settled = geometryLines().filter((line) => line.includes("resume:pageshow+"));
    expect(settled).toHaveLength(SETTLE_REREAD_DELAYS_MS.length);
    for (const ms of SETTLE_REREAD_DELAYS_MS) {
      expect(settled.some((line) => line.includes(`resume:pageshow+${ms}ms`))).toBe(true);
    }
  });

  it("schedules no settle re-reads on the hide edge (nothing settles while hidden)", () => {
    vi.useFakeTimers();
    render(() => <DiagFloat />);
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(Math.max(...SETTLE_REREAD_DELAYS_MS));
    expect(geometryLines().filter((line) => line.includes("resume:hidden+"))).toHaveLength(0);
  });

  // The report this issue carries cannot tell "vars stuck at the full viewport"
  // from "vars correct, content scrolled" — both paint the identical picture.
  // `--vh` and `wy` on the SAME line are what separates them, and `--vh` was
  // captured but rendered only in the live headline, which by screenshot time
  // has already moved on.
  it("carries the var and the scroll offset on the logged line", () => {
    document.documentElement.style.setProperty("--vh", "4.81px");
    render(() => <DiagFloat />);
    window.dispatchEvent(new Event("pageshow"));
    const line = geometryLines().find((l) => l.includes("resume:pageshow"));
    expect(line).toContain("--vh=4.81px");
    expect(line).toContain("wy=");
  });
});

// #2389 — the scrollback pane on every line.
//
// The report: on an iOS PWA, after a return from background, the scrollback
// does not follow the finger until a resize. The rival explanations are told
// apart only by the PANE at the stuck instant — is the #285 gate latched
// (`scrollback-locked`, `touch-action: none`)? is the pane hidden by the #130
// activation flip? does the finger reach it at all (`touchmove` counted) and
// does it scroll (`scroll` counted)? The panel recorded none of that.
//
// Same limit as above: these prove the WIRING (the fields land on the line,
// the counters count the pane and only the pane, and reset per line). Nothing
// here says anything about iOS; the device reading does.
describe("DiagFloat — scrollback pane fields (#2389)", () => {
  let pane: HTMLDivElement | null = null;

  const mountPane = (): HTMLDivElement => {
    const el = document.createElement("div");
    el.setAttribute("data-testid", "scrollback");
    el.className = "scrollback";
    el.appendChild(document.createElement("div"));
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 900 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 600 });
    el.scrollTop = 40;
    document.body.appendChild(el);
    pane = el;
    return el;
  };

  const lineFor = (ev: string): string | undefined =>
    geometryLines().find((l) => l.includes(` ${ev} `) || l.includes(` ${ev}[`));

  beforeEach(() => {
    localStorage.setItem(DIAG_FLAG_KEY, "1");
    setVisibility("visible");
  });

  afterEach(() => {
    pane?.remove();
    pane = null;
  });

  it("carries the gate class, visibility, overflow-x and the three scroll numbers", () => {
    const el = mountPane();
    el.classList.add("scrollback-locked");
    el.style.visibility = "hidden";
    el.style.overflowX = "hidden";
    render(() => <DiagFloat />);
    window.dispatchEvent(new Event("pageshow"));

    const line = lineFor("resume:pageshow");
    expect(line).toContain("sb=locked");
    expect(line).toContain("vis=hidden");
    expect(line).toContain("ox=hidden");
    expect(line).toContain("st=40/900/600");
    expect(line).toContain("ta=");
  });

  it("reads an unlocked pane as open", () => {
    mountPane();
    render(() => <DiagFloat />);
    window.dispatchEvent(new Event("pageshow"));
    expect(lineFor("resume:pageshow")).toContain("sb=open");
  });

  it("says the pane is absent rather than printing zeros", () => {
    render(() => <DiagFloat />);
    window.dispatchEvent(new Event("pageshow"));
    const line = lineFor("resume:pageshow");
    expect(line).toContain("sb=absent");
    expect(line).not.toContain("st=");
  });

  it("counts touchmove and scroll on the pane only, and resets them per line", () => {
    const el = mountPane();
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    render(() => <DiagFloat />);

    const row = el.firstElementChild as HTMLElement;
    for (let i = 0; i < 3; i++) row.dispatchEvent(new Event("touchmove", { bubbles: true }));
    outside.dispatchEvent(new Event("touchmove", { bubbles: true }));
    // `scroll` does not bubble: the instrument must catch it in capture.
    el.dispatchEvent(new Event("scroll"));
    el.dispatchEvent(new Event("scroll"));
    outside.dispatchEvent(new Event("scroll"));

    window.dispatchEvent(new Event("pageshow"));
    const first = lineFor("resume:pageshow");
    expect(first).toContain("tm=3");
    expect(first).toContain("sc=2");

    window.dispatchEvent(new Event("focus"));
    const second = lineFor("resume:focus");
    expect(second).toContain("tm=0");
    expect(second).toContain("sc=0");

    outside.remove();
  });
});
