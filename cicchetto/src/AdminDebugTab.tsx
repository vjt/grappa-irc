import { type Component, createSignal, For, onCleanup, onMount } from "solid-js";
import { isDiagEnabled, setDiagEnabled } from "./DiagFloat";

// UX-6 D12 (2026-05-21) — Admin → Debug tab. Hosts the iOS PWA
// keyboard / viewport diagnostics. Previously lived inside
// SettingsDrawer (as a fieldset) where the visibility was bound to
// the drawer's open state — closing the drawer to test the keyboard
// path hid the very diag we needed to read. Lifted into a dedicated
// admin tab so the diag readouts are reachable from a stable
// surface without competing with focus-state of the surface under
// investigation.
//
// Two affordances:
// 1. "floating diag overlay" toggle — flips localStorage.cic_diag
//    which DiagFloat polls every 1s. Floating overlay is the
//    primary read surface during keyboard slide-in (renders via
//    Portal to body, escapes any shell transform, stays at top-right
//    of layout viewport).
// 2. Inline live readouts + event log — supplementary, useful when
//    the admin is not on a touch device but wants to inspect
//    visualViewport behavior on resize.
//
// Read-only DOM probes, zero side effects on production paths.
// Read-write of localStorage.cic_diag is the only state change.
//
// Per-class parity matrix (`feedback_e2e_user_class_parity_matrix`):
// admin-gated, EXEMPT. e2e coverage at m7-admin-gate proves
// non-admin can't reach AdminPane at all; this tab inherits.

const AdminDebugTab: Component = () => {
  const [diagWinH, setDiagWinH] = createSignal(0);
  const [diagWinW, setDiagWinW] = createSignal(0);
  const [diagVvH, setDiagVvH] = createSignal(0);
  const [diagVvW, setDiagVvW] = createSignal(0);
  const [diagVvScale, setDiagVvScale] = createSignal(1);
  const [diagVvOffsetTop, setDiagVvOffsetTop] = createSignal(0);
  const [diagCssVar, setDiagCssVar] = createSignal("");
  const [diagVhVar, setDiagVhVar] = createSignal("");
  const [diagIsIos, setDiagIsIos] = createSignal(false);
  const [diagEventTick, setDiagEventTick] = createSignal(0);
  const [diagLastEvent, setDiagLastEvent] = createSignal<string>("(none)");
  const [diagFocusedTag, setDiagFocusedTag] = createSignal<string>("(none)");
  const [diagElems, setDiagElems] = createSignal<string>("(none)");
  const [diagLog, setDiagLog] = createSignal<string[]>([]);
  const [diagFloatOn, setDiagFloatOn] = createSignal(isDiagEnabled());

  const snapshotDiag = (eventName: string): void => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    const winH = typeof window !== "undefined" ? window.innerHeight : 0;
    const winW = typeof window !== "undefined" ? window.innerWidth : 0;
    const vvH = vv?.height ?? 0;
    const vvW = vv?.width ?? 0;
    setDiagWinH(winH);
    setDiagWinW(winW);
    setDiagVvH(vvH);
    setDiagVvW(vvW);
    setDiagVvScale(vv?.scale ?? 1);
    setDiagVvOffsetTop(vv?.offsetTop ?? 0);
    setDiagCssVar(
      typeof document !== "undefined"
        ? document.documentElement.style.getPropertyValue("--viewport-height") || "(unset)"
        : "(no document)",
    );
    setDiagVhVar(
      typeof document !== "undefined"
        ? document.documentElement.style.getPropertyValue("--vh") || "(unset)"
        : "(no document)",
    );
    setDiagIsIos(
      typeof document !== "undefined" && document.documentElement.classList.contains("is-ios"),
    );
    setDiagEventTick((n) => n + 1);
    setDiagLastEvent(eventName);
    setDiagFocusedTag(
      typeof document !== "undefined" && document.activeElement
        ? `${document.activeElement.tagName}${
            (document.activeElement as HTMLElement).id
              ? `#${(document.activeElement as HTMLElement).id}`
              : ""
          }`
        : "(none)",
    );
    const probe = (sel: string): string => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return `${sel}=∅`;
      const cs = getComputedStyle(el);
      const ch = el.clientHeight;
      const sh = el.scrollHeight;
      const tag = sel.replace(/[.#]/g, "").replace(/-/g, "").slice(0, 4);
      const shStr = sh !== ch ? `/${sh}` : "";
      return `${tag}=${ch}${shStr}[${cs.minHeight}]`;
    };
    const elemSummary = [
      probe(".shell-mobile"),
      probe(".shell-mobile .shell-main"),
      probe(".scrollback-pane"),
      probe(".scrollback"),
      probe(".compose-box"),
      probe(".bottom-bar"),
    ].join(" ");
    setDiagElems(elemSummary);
    const delta = winH - vvH;
    const line = `${eventName} vv=${Math.round(vvH)} win=${Math.round(winH)} Δ=${Math.round(delta)} ${elemSummary}`;
    setDiagLog((prev) => [line, ...prev].slice(0, 20));
  };

  onMount(() => {
    snapshotDiag("mount");
    const onResize = () => snapshotDiag("resize");
    const onVvResize = () => snapshotDiag("vv.resize");
    const onVvScroll = () => snapshotDiag("vv.scroll");
    const onFocusIn = () => snapshotDiag("focusin");
    const onFocusOut = () => snapshotDiag("focusout");
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onVvResize);
    window.visualViewport?.addEventListener("scroll", onVvScroll);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    onCleanup(() => {
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onVvResize);
      window.visualViewport?.removeEventListener("scroll", onVvScroll);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    });
  });

  return (
    <div class="admin-debug-tab" data-testid="admin-debug-tab">
      <fieldset class="settings-fieldset settings-diag">
        <legend>floating diag overlay</legend>
        <label class="settings-row">
          <span>show floating diag overlay (top-right, live during keyboard)</span>
          <input
            type="checkbox"
            checked={diagFloatOn()}
            onChange={(e) => {
              const v = e.currentTarget.checked;
              setDiagEnabled(v);
              setDiagFloatOn(v);
            }}
            data-testid="diag-float-toggle"
          />
        </label>
      </fieldset>
      <fieldset class="settings-fieldset settings-diag">
        <legend>viewport diagnostics</legend>
        <div class="settings-diag-grid">
          <span>vv.height</span>
          <code data-testid="diag-vv-h">{Math.round(diagVvH())}</code>
          <span>vv.width</span>
          <code data-testid="diag-vv-w">{Math.round(diagVvW())}</code>
          <span>window.innerHeight</span>
          <code data-testid="diag-win-h">{Math.round(diagWinH())}</code>
          <span>window.innerWidth</span>
          <code data-testid="diag-win-w">{Math.round(diagWinW())}</code>
          <span>Δ (winH − vvH)</span>
          <code data-testid="diag-delta">{Math.round(diagWinH() - diagVvH())}</code>
          <span>vv.scale</span>
          <code>{diagVvScale().toFixed(2)}</code>
          <span>vv.offsetTop</span>
          <code>{Math.round(diagVvOffsetTop())}</code>
          <span>--viewport-height</span>
          <code data-testid="diag-css-var">{diagCssVar()}</code>
          <span>--vh</span>
          <code data-testid="diag-vh-var">{diagVhVar()}</code>
          <span>html.is-ios</span>
          <code data-testid="diag-is-ios">{diagIsIos() ? "true" : "false"}</code>
          <span>active element</span>
          <code data-testid="diag-focus">{diagFocusedTag()}</code>
          <span>event tick</span>
          <code data-testid="diag-event-tick">{diagEventTick()}</code>
          <span>last event</span>
          <code data-testid="diag-last-event">{diagLastEvent()}</code>
        </div>
        <details open>
          <summary>element chain heights (clientH/scrollH [minH])</summary>
          <p class="settings-diag-elems">
            <code data-testid="diag-elems">{diagElems()}</code>
          </p>
        </details>
        <details>
          <summary>recent events (newest first)</summary>
          <ol class="settings-diag-log">
            <For each={diagLog()}>
              {(line) => (
                <li>
                  <code>{line}</code>
                </li>
              )}
            </For>
          </ol>
        </details>
      </fieldset>
    </div>
  );
};

export default AdminDebugTab;
