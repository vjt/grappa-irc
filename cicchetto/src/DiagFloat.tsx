import { type Component, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { diagLog } from "./lib/diagLog";
import { SETTLE_REREAD_DELAYS_MS } from "./lib/viewportHeight";

// UX-6 bucket D6 (2026-05-21) — floating diag overlay for on-device
// debugging of iOS PWA layout-viewport shift. The pre-existing diag
// panel inside SettingsDrawer (~line 140) is invisible during the
// keyboard-open path that we're trying to diagnose: focusing the
// compose textarea closes the settings drawer (it's an overlay
// surface in the mutex group). vjt cannot read the numbers while the
// bug is happening.
//
// This component renders position:fixed top-right so it stays visible
// over BottomBar + compose + keyboard. Flag-gated via localStorage
// `cic_diag === "1"`; not rendered by default. Read-only — no side effects
// on the layout under investigation.
//
// 🔴 The toggle is `AdminDebugTab.tsx` (`setDiagEnabled`, its only caller
// outside this module and the tests) and NOT SettingsDrawer, whose own
// comment records the move. Corrected here because the stale attribution
// hid the constraint that matters: that tab is ADMIN-GATED, so every number
// this panel prints is reachable only by an admin. On an installed iOS PWA
// there is no console either, so "just set the localStorage key" needs a Mac
// and Web Inspector. Issue 1791 is blocked on exactly that — the instrument
// is available to whoever does NOT reproduce the defect — which is why the
// foreground check that separates its two candidates was written to have a
// half that needs no instrument at all: look at whether the iOS
// form-accessory bar covers the bottom tab row. Anything that can only be
// answered from this panel inherits the gate, `winH - vvH` included.

export const DIAG_FLAG_KEY = "cic_diag";

export function isDiagEnabled(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(DIAG_FLAG_KEY) === "1";
}

export function setDiagEnabled(on: boolean): void {
  if (typeof localStorage === "undefined") return;
  if (on) localStorage.setItem(DIAG_FLAG_KEY, "1");
  else localStorage.removeItem(DIAG_FLAG_KEY);
}

interface Snapshot {
  ev: string;
  tgt: string;
  vvH: number;
  vvOT: number;
  winH: number;
  winY: number;
  dseT: number;
  sbT: number;
  htmlSH: number;
  htmlCH: number;
  bodySH: number;
  bodyCH: number;
  rootSH: number;
  rootCH: number;
  posHtml: string;
  posBody: string;
  cssOT: string;
  t: number;
}

const DiagFloat: Component = () => {
  const [enabled, setEnabled] = createSignal(isDiagEnabled());
  const [vvH, setVvH] = createSignal(0);
  const [vvOT, setVvOT] = createSignal(0);
  const [winH, setWinH] = createSignal(0);
  const [cssOT, setCssOT] = createSignal("");
  const [lastEv, setLastEv] = createSignal("(none)");
  const [tick, setTick] = createSignal(0);
  const [log, setLog] = createSignal<Snapshot[]>([]);
  const t0 = performance.now();

  const snap = (ev: string, tgt = ""): void => {
    const vv = window.visualViewport;
    const h = vv?.height ?? 0;
    const ot = vv?.offsetTop ?? 0;
    const wh = window.innerHeight;
    const wy = window.scrollY;
    const dse = document.scrollingElement?.scrollTop ?? -1;
    const cv = document.documentElement.style.getPropertyValue("--vh") || "(unset)";
    const html = document.documentElement;
    const body = document.body;
    const root = document.getElementById("root");
    const htmlCS = getComputedStyle(html);
    const bodyCS = getComputedStyle(body);
    setVvH(h);
    setVvOT(ot);
    setWinH(wh);
    setCssOT(cv);
    setLastEv(ev);
    setTick((n) => n + 1);
    setLog((prev) =>
      [
        {
          ev,
          tgt,
          vvH: h,
          vvOT: ot,
          winH: wh,
          winY: wy,
          dseT: dse,
          sbT: -1,
          htmlSH: html.scrollHeight,
          htmlCH: html.clientHeight,
          bodySH: body.scrollHeight,
          bodyCH: body.clientHeight,
          rootSH: root?.scrollHeight ?? -1,
          rootCH: root?.clientHeight ?? -1,
          posHtml: htmlCS.position,
          posBody: bodyCS.position,
          cssOT: cv,
          t: Math.round(performance.now() - t0),
        },
        ...prev,
      ].slice(0, 30),
    );
  };

  onMount(() => {
    // Re-read flag from localStorage on mount (set in settings panel
    // between mounts) AND poll every second so vjt can toggle without
    // a refresh. Cheap — single boolean compare per second.
    const flagPoll = setInterval(() => {
      const e = isDiagEnabled();
      if (e !== enabled()) setEnabled(e);
    }, 1000);
    onCleanup(() => clearInterval(flagPoll));

    snap("mount");
    const onResize = () => snap("win.resize");
    const onVvResize = () => snap("vv.resize");
    const onVvScroll = () => snap("vv.scroll");
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase() ?? "?";
      const cls = t?.className ? `.${String(t.className).slice(0, 20)}` : "";
      snap("focusin", `${tag}${cls}`);
    };
    const onFocusOut = () => snap("focusout");
    // UX-6 D8 (2026-05-21) — instrument window.scroll for the 1-3s
    // scroll-lock investigation. vjt reports a freeze on drag-to-
    // bottom; D7 hypothesised installScrollPin was the cause but
    // the freeze persists with the pin removed (D7) AND restored
    // (D8), so the cause is elsewhere. Logging here captures every
    // window.scroll firing with timestamp so we can correlate the
    // 1-3s window with what's actually scrolling.
    const onWinScroll = () => snap(`win.scroll@y${window.scrollY}`);
    // Touch events bracket the scroll-lock — start (drag begin),
    // move (drag ongoing — heavy, but we need the cadence to see
    // if scroll-lock is "touchmoves stop firing" or "touchmoves
    // fire but scroll doesn't follow"), end (drag release →
    // momentum begins). Tagged separately so we can tell them
    // apart in the log.
    const onTouchStart = () => snap("touch.start");
    const onTouchEnd = () => snap("touch.end");
    // #1791 (2026-08-26) — the resume seam. Everything above watches what a
    // FOREGROUND app emits. An app-switch RETURN reliably emits none of it:
    // that absence is the whole premise of #649's three resume triggers on the
    // var writer, and it left the one instrument aimed at this surface unable
    // to produce a single line for the event class #1791 is reported on. An
    // absent line then reads as "nothing happened" when it means "nothing was
    // watching" — the same trap `lib/resumeProbe.ts` declares about itself.
    //
    // Same three events, same reason, same source as the writer's: an installed
    // PWA coming back from an app-switch reports `visibilitychange`, a bfcache
    // restore reports `pageshow`, and a same-visibility focus return reports
    // only `focus`. This is a READER of those events; the writer stays the sole
    // writer of the vars.
    const settleTimers: ReturnType<typeof setTimeout>[] = [];
    // The corrective geometry arrives with NO event to announce it (#285
    // reopen, #649) — so an event-driven-only instrument is blind by
    // construction on exactly the settle it needs to see. Re-sample on the
    // writer's own schedule, which is why that constant is imported rather
    // than restated: the panel and the vars must agree on when "settled" is.
    const resume = (tag: string): void => {
      snap(tag);
      for (const ms of SETTLE_REREAD_DELAYS_MS) {
        settleTimers.push(setTimeout(() => snap(`${tag}+${ms}ms`), ms));
      }
    };
    const onVisibility = () => {
      // Both edges, unlike the writer — which GATES on visible because it must
      // not write a hidden geometry. Dropping the hide edge would lose the
      // bracket that records the last foreground geometry (the keyboard-open
      // value #649 says gets frozen) and how long the app was away. Nothing
      // settles while hidden, so the hide edge takes no re-read schedule.
      if (document.visibilityState !== "visible") {
        snap("resume:hidden");
        return;
      }
      resume("resume:visible");
    };
    const onPageShow = () => resume("resume:pageshow");
    const onWinFocus = () => resume("resume:focus");
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onWinScroll);
    window.visualViewport?.addEventListener("resize", onVvResize);
    window.visualViewport?.addEventListener("scroll", onVvScroll);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("focus", onWinFocus);
    onCleanup(() => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onWinScroll);
      window.visualViewport?.removeEventListener("resize", onVvResize);
      window.visualViewport?.removeEventListener("scroll", onVvScroll);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", onWinFocus);
      // A settle re-read outliving the unmount would `snap()` into a disposed
      // signal — the resume schedule runs up to 900ms past its trigger, which
      // is long enough for a real unmount to land inside it.
      for (const id of settleTimers) clearTimeout(id);
    });
  });

  return (
    <Show when={enabled()}>
      <div class="diag-float" data-testid="diag-float">
        <div class="diag-float-headline">
          vvH=<strong>{vvH()}</strong> winH={winH()} vvOT={vvOT()}
        </div>
        <div class="diag-float-line">
          is-ios=
          <strong>
            {typeof document !== "undefined" &&
            document.documentElement.classList.contains("is-ios")
              ? "YES"
              : "NO"}
          </strong>{" "}
          ua={typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 60) : "?"}
        </div>
        <div class="diag-float-line">
          --vh={cssOT()} ev={lastEv()} #{tick()}
        </div>
        {/* #123 compose-swipe telemetry — pushed by ComposeBox's touch
            handlers via lib/diagLog. Newest first: touchstart geometry, the
            claim decision (direction / boundary / scrollTop), the touchend
            action. The on-device evidence webkit playwright can't produce. */}
        <div class="diag-float-line">compose-swipe:</div>
        <div class="diag-float-log" data-testid="diag-float-swipe">
          <For each={diagLog()}>{(line) => <div>{line}</div>}</For>
        </div>
        {/* #1791 — `--vh` per LINE, not only in the live headline above. The
            report cannot tell "vars stuck at the full viewport" from "vars
            correct, content scrolled": both paint the identical picture, and
            the var beside `wy` on one line is what separates them. It was
            captured all along and rendered only live, which by the time a
            screenshot is taken has already moved on. The sibling
            `--viewport-height` is deliberately NOT added: one writer sets both
            in one call, so a second reading would be a duplicate, not a
            check. */}
        <div class="diag-float-log" data-testid="diag-float-geometry">
          <For each={log()}>
            {(s) => (
              <div>
                {s.t}ms {s.ev}
                {s.tgt ? `[${s.tgt}]` : ""} vvH={s.vvH} vvOT={s.vvOT} wy={s.winY} dseT={s.dseT}
                {" --vh="}
                {s.cssOT}
                {" | "}html=
                <strong>{s.posHtml}</strong>
                {s.htmlSH}/{s.htmlCH} body={s.posBody}
                {s.bodySH}/{s.bodyCH} root={s.rootSH}/{s.rootCH}
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
};

export default DiagFloat;
