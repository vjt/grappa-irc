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
      ].slice(0, 60),
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
    // UX-6 D11 — per-frame probe armed on focusin so we can see if
    // iOS animates the visual viewport shift (gradual) or jumps
    // (instant). 600ms window = covers iOS's ~250ms keyboard slide-
    // in animation + buffer. Each frame snaps once into the log so
    // we get a frame-by-frame trace of wy / vvOT / vvH during the
    // shift.
    let frameProbeUntil = 0;
    const frameProbe = (): void => {
      if (performance.now() >= frameProbeUntil) return;
      snap("rAF");
      requestAnimationFrame(frameProbe);
    };
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase() ?? "?";
      const cls = t?.className ? `.${String(t.className).slice(0, 20)}` : "";
      snap("focusin", `${tag}${cls}`);
      frameProbeUntil = performance.now() + 600;
      requestAnimationFrame(frameProbe);
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
        <div class="diag-float-log">
          <For each={log()}>
            {(s) => (
              <div>
                {s.t}ms {s.ev}
                {s.tgt ? `[${s.tgt}]` : ""} vvH={s.vvH} vvOT={s.vvOT} wy={s.winY} dseT={s.dseT}
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
