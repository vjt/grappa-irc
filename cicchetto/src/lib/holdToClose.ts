import { type Accessor, createSignal } from "solid-js";
import { MOVE_SLOP_PX } from "../keyboard/gesture";

// #172 — hold-to-confirm gate for destructive window-close × buttons.
//
// The problem: a bare tap on the BottomBar close × closed a window
// instantly, so a mobile fat-finger spuriously lost windows the user never
// meant to close. The fix makes closing DELIBERATE without touching what a
// close DOES: a touch/pen press must be HELD past a threshold to confirm.
//
// Placement (CLAUDE.md "reuse the verbs, not the nouns"): the gate lives at
// the button-INTERACTION layer, NOT in lib/windowClose.ts — those close verbs
// are a synchronous state-push layer with no pointer/event/timer context, and
// stuffing a setTimeout into them would be a boundary violation (and
// untestable). windowClose.* stays the on-confirm ACTION, unchanged; this
// module is the pure gesture core + a thin Solid handler factory that both
// BottomBar and Sidebar attach to via <CloseButton>.

// A destructive confirm wants a LONGER hold than the 300ms keyboard-variations
// popup (keyboard/gesture LONG_PRESS_MS) — an accidental fat-finger tap on a
// tiny × must not slip past. 500ms is a device-calibration default; it's a
// FEEL knob vjt tunes on-device post-ship. Named, no magic number at the call
// sites (mirrors LONG_PRESS_MS). Slop reuses keyboard/gesture MOVE_SLOP_PX —
// a finger that drifts past ~10px is scrolling, not confirming.
export const HOLD_TO_CLOSE_MS = 500;

export type HoldPhase = "idle" | "holding" | "cancelled" | "confirmed";

// Pure per-press state machine. Framework-free, no DOM, no timer (the factory
// owns the setTimeout and feeds samples in) — mirrors keyboard/gesture.ts
// KeyGesture so it's unit-testable with plain method calls.
//
// Touch/pen presses are GATED: they must be held past the timer without
// drifting more than moveSlopPx. A mouse press is pixel-precise and already
// deliberate — it bypasses the hold and confirms on the native click (the
// factory's onClick), so desktop is never punished.
export class HoldToCloseGesture {
  private readonly slopSq: number;
  private phase: HoldPhase = "idle";
  private startX = 0;
  private startY = 0;

  constructor(cfg: { moveSlopPx: number }) {
    this.slopSq = cfg.moveSlopPx * cfg.moveSlopPx;
  }

  phaseOf(): HoldPhase {
    return this.phase;
  }

  // Is a touch/pen hold currently in progress? Drives the "keep holding"
  // visual cue; always false for mouse (which never holds).
  holding(): boolean {
    return this.phase === "holding";
  }

  // pointerdown. Returns whether the caller should arm a hold timer +
  // suppress the trailing synthetic click (both true only for touch/pen).
  down(pointerType: string, x: number, y: number): { gated: boolean } {
    this.startX = x;
    this.startY = y;
    const gated = pointerType !== "" && pointerType !== "mouse";
    this.phase = gated ? "holding" : "idle";
    return { gated };
  }

  // pointermove. A drift past slop cancels the hold — the finger is scrolling,
  // not confirming a close.
  move(x: number, y: number): void {
    if (this.phase !== "holding") return;
    const dx = x - this.startX;
    const dy = y - this.startY;
    if (dx * dx + dy * dy > this.slopSq) this.phase = "cancelled";
  }

  // The hold timer elapsed with the press still valid. The factory clears the
  // timer on up/move/cancel, but the phase guard is the source of truth so a
  // late timer can never confirm. Returns true → fire the close.
  timerElapsed(): boolean {
    if (this.phase !== "holding") return false;
    this.phase = "confirmed";
    return true;
  }

  // pointerup / pointercancel / pointerleave — an early release or a stolen
  // gesture. Never confirms here (confirm is the timer's job for touch, the
  // click's for mouse); just cancels an in-flight hold.
  release(): void {
    if (this.phase === "holding") this.phase = "cancelled";
  }
}

export interface HoldToClose {
  onPointerDown: (e: PointerEvent) => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerUp: (e: PointerEvent) => void;
  onPointerCancel: (e: PointerEvent) => void;
  onPointerLeave: (e: PointerEvent) => void;
  onClick: (e: MouseEvent) => void;
  holding: Accessor<boolean>;
}

// Wire a destructive close button to the hold-to-confirm gesture. Bind the
// pointer/click handlers to the button and drive a "hold in progress" cue off
// `holding`. `onConfirm` runs the actual close verb (windowClose.*) — this
// factory adds ONLY the interaction gate.
export function createHoldToClose(onConfirm: () => void): HoldToClose {
  let gesture: HoldToCloseGesture | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // A touch/pen tap or hold fires a trailing synthetic `click`; swallow it so
  // it can't confirm behind the gesture's back. A mouse/keyboard click is not
  // preceded by a gated pointerdown, so it flows through to onConfirm. The
  // flag is reset on every pointerdown (a mouse press clears any stale value).
  let swallowClick = false;
  const [holding, setHolding] = createSignal(false);

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const end = () => {
    clearTimer();
    if (gesture) gesture.release();
    gesture = null;
    setHolding(false);
  };

  const onPointerDown = (e: PointerEvent) => {
    clearTimer();
    gesture = new HoldToCloseGesture({ moveSlopPx: MOVE_SLOP_PX });
    const { gated } = gesture.down(e.pointerType, e.clientX, e.clientY);
    swallowClick = gated;
    if (!gated) {
      // mouse → the native click confirms; nothing to track or hold.
      gesture = null;
      return;
    }
    try {
      // Keep receiving move/up even if the finger slides off the tiny ×.
      // Best-effort: a synthetic e2e pointer id isn't a live pointer.
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // ignore — capture is an optimisation, not a correctness requirement
    }
    setHolding(true);
    timer = setTimeout(() => {
      timer = null;
      if (gesture?.timerElapsed()) {
        setHolding(false);
        onConfirm();
      }
    }, HOLD_TO_CLOSE_MS);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!gesture) return;
    gesture.move(e.clientX, e.clientY);
    if (!gesture.holding()) {
      clearTimer();
      setHolding(false);
    }
  };

  const onClick = (e: MouseEvent) => {
    if (swallowClick) {
      // the trailing synthetic click after a touch tap/hold — the gesture
      // already decided; never double-fire the close.
      swallowClick = false;
      e.preventDefault();
      return;
    }
    // a genuine mouse click or a keyboard Enter/Space activation — instant.
    onConfirm();
  };

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: end,
    onPointerCancel: end,
    onPointerLeave: end,
    onClick,
    holding,
  };
}
