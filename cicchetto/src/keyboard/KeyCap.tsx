import { type Component, createSignal } from "solid-js";
import {
  computeStripGeometry,
  KeyGesture,
  LONG_PRESS_MS,
  MOVE_SLOP_PX,
  type Rect,
  type StripGeometry,
  Y_BAND_PAD_PX,
} from "./gesture";
import { variantsFor } from "./variations";

// Strip cell sizing (CSS-coupled; keep in sync with VariationStrip.tsx).
const CELL_WIDTH = 44;
const STRIP_HEIGHT = 50;
const STRIP_GAP = 8;

export interface KeyCapProps {
  label: string;
  insertText: string;
  fn?: boolean; // function key styling
  // Commit a string (base or chosen variant).
  onCommit: (text: string) => void;
  // Ask the parent to render the strip; returns nothing — KeyCap drives
  // highlight via the gesture and reports the final variant on commit.
  onOpenVariants: (args: {
    variants: string[];
    geom: StripGeometry;
    highlight: () => number | null;
  }) => void;
  // Tear the strip down. Called when the gesture cancels mid-drag (finger
  // dropped below the key) and unconditionally on release, so the strip
  // never lingers on screen after the press ends (dogfood round 2).
  onCloseVariants: () => void;
}

const KeyCap: Component<KeyCapProps> = (props) => {
  const [active, setActive] = createSignal(false);
  const [highlight, setHighlight] = createSignal<number | null>(null);

  let gesture: KeyGesture | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let variants: string[] = [];

  // Cache the key's viewport rect. getBoundingClientRect forces a SYNCHRONOUS
  // reflow, and the previous keystroke's setDraft dirties layout — so calling
  // it on every pointerdown jammed the main thread enough that iOS dropped
  // fast taps entirely (the missed key gave no press-flash at all: the
  // pointerdown never arrived). The keyboard is position:fixed and its keys
  // don't move during a typing session, so compute the rect once and reuse it.
  // (dogfood round 3 — the real root cause; the editing-layer fixes were all
  // the wrong layer.)
  let cachedRect: Rect | null = null;
  const rectOf = (el: HTMLElement): Rect => {
    if (!cachedRect) {
      const r = el.getBoundingClientRect();
      cachedRect = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    }
    return cachedRect;
  };

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault(); // never steal focus from the textarea
    clearTimer(); // start each press clean — drop any timer a prior gesture left if its pointerup never reached us (capture-less edge)
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const rect = rectOf(e.currentTarget as HTMLElement);
    gesture = new KeyGesture({
      keyRect: rect,
      moveSlopPx: MOVE_SLOP_PX,
      yBandPadPx: Y_BAND_PAD_PX,
    });
    gesture.down(e.clientX, e.clientY);
    setActive(true);

    variants = variantsFor(props.insertText);
    if (variants.length > 0) {
      timer = setTimeout(() => {
        if (!gesture) return;
        const geom = computeStripGeometry({
          keyRect: rect,
          variantCount: variants.length,
          cellWidth: CELL_WIDTH,
          stripHeight: STRIP_HEIGHT,
          gap: STRIP_GAP,
          viewportWidth: window.innerWidth,
        });
        gesture.openVariations(geom);
        setHighlight(geom.defaultIndex);
        props.onOpenVariants({ variants, geom, highlight });
      }, LONG_PRESS_MS);
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!gesture) return;
    gesture.move(e.clientX, e.clientY);
    const p = gesture.phase();
    if (p.kind === "longpress") {
      setHighlight(p.highlight);
      // highlight === null while in long-press means the gesture cancelled
      // (finger dropped below the key) — close the strip immediately, like
      // iOS, instead of leaving it on screen until release.
      if (p.highlight === null) props.onCloseVariants();
    }
  };

  const finish = () => {
    clearTimer();
    setActive(false);
    if (!gesture) return;
    const intent = gesture.up();
    gesture = null;
    if (intent.kind === "commit-base") props.onCommit(props.insertText);
    else if (intent.kind === "commit-variant")
      props.onCommit(variants[intent.index] ?? props.insertText);
    // cancel → no commit
    setHighlight(null);
    // Always tear the strip down on release — a cancelled gesture never
    // calls onCommit, so without this the strip stayed open forever after
    // dragging below the key and releasing (dogfood round 2).
    props.onCloseVariants();
  };

  // No per-tap magnify balloon: it spawned a Portal DOM node on every press,
  // adding main-thread work to the hot path that helped iOS drop fast taps.
  // The press-flash (.kbd-key--active) is the lightweight feedback; a cheap
  // shared magnify can come back later (it's deferred polish either way).
  return (
    <div
      class={`kbd-key${props.fn ? " kbd-key--fn" : ""}${active() ? " kbd-key--active" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
    >
      {props.label}
    </div>
  );
};

export default KeyCap;
