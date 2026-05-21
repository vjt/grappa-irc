import { type Component, createSignal, For, onCleanup, onMount, Show } from "solid-js";

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
// `cic_diag === "1"` (toggled from SettingsDrawer); not rendered by
// default. Read-only — no side effects on the layout under
// investigation.

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
  vvH: number;
  vvOT: number;
  winH: number;
  winY: number;
  dseT: number;
  sbT: number;
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

  const snap = (ev: string): void => {
    const vv = window.visualViewport;
    const h = vv?.height ?? 0;
    const ot = vv?.offsetTop ?? 0;
    const wh = window.innerHeight;
    const wy = window.scrollY;
    const dse = document.scrollingElement?.scrollTop ?? -1;
    const sb =
      (window as unknown as { __cic_scrollback?: HTMLDivElement }).__cic_scrollback?.scrollTop ??
      -1;
    const cv = document.documentElement.style.getPropertyValue("--vv-offset-top") || "(unset)";
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
          vvH: h,
          vvOT: ot,
          winH: wh,
          winY: wy,
          dseT: dse,
          sbT: sb,
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
    const onFocusIn = () => snap("focusin");
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
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onWinScroll);
    window.visualViewport?.addEventListener("resize", onVvResize);
    window.visualViewport?.addEventListener("scroll", onVvScroll);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    onCleanup(() => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onWinScroll);
      window.visualViewport?.removeEventListener("resize", onVvResize);
      window.visualViewport?.removeEventListener("scroll", onVvScroll);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchend", onTouchEnd);
    });
  });

  return (
    <Show when={enabled()}>
      <div class="diag-float" data-testid="diag-float">
        <div class="diag-float-headline">
          vvOT=<strong>{vvOT()}</strong> vvH={vvH()} winH={winH()}
        </div>
        <div class="diag-float-line">
          css={cssOT()} ev={lastEv()} #{tick()}
        </div>
        <div class="diag-float-log">
          <For each={log()}>
            {(s) => (
              <div>
                {s.t}ms {s.ev} vvOT={s.vvOT} vvH={s.vvH} wy={s.winY} dseT={s.dseT} sbT={s.sbT}
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
};

export default DiagFloat;
