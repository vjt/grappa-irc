import { type Component, createSignal, Show } from "solid-js";
import { Portal } from "solid-js/web";
import {
  computeStripGeometry,
  KeyGesture,
  LONG_PRESS_MS,
  MOVE_SLOP_PX,
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
}

const KeyCap: Component<KeyCapProps> = (props) => {
  const [active, setActive] = createSignal(false);
  const [magnify, setMagnify] = createSignal<{ x: number; y: number } | null>(null);
  const [highlight, setHighlight] = createSignal<number | null>(null);

  let gesture: KeyGesture | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let variants: string[] = [];

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault(); // never steal focus from the textarea
    clearTimer(); // start each press clean — drop any timer a prior gesture left if its pointerup never reached us (capture-less edge)
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    gesture = new KeyGesture({
      keyRect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      moveSlopPx: MOVE_SLOP_PX,
      yBandPadPx: Y_BAND_PAD_PX,
    });
    gesture.down(e.clientX, e.clientY);
    setActive(true);
    setMagnify({ x: (rect.left + rect.right) / 2, y: rect.top });

    variants = variantsFor(props.insertText);
    if (variants.length > 0) {
      timer = setTimeout(() => {
        if (!gesture) return;
        const geom = computeStripGeometry({
          keyRect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
          variantCount: variants.length,
          cellWidth: CELL_WIDTH,
          stripHeight: STRIP_HEIGHT,
          gap: STRIP_GAP,
          viewportWidth: window.innerWidth,
        });
        gesture.openVariations(geom);
        setMagnify(null);
        setHighlight(geom.defaultIndex);
        props.onOpenVariants({ variants, geom, highlight });
      }, LONG_PRESS_MS);
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!gesture) return;
    gesture.move(e.clientX, e.clientY);
    const p = gesture.phase();
    if (p.kind === "longpress") setHighlight(p.highlight);
  };

  const finish = () => {
    clearTimer();
    setActive(false);
    setMagnify(null);
    if (!gesture) return;
    const intent = gesture.up();
    gesture = null;
    if (intent.kind === "commit-base") props.onCommit(props.insertText);
    else if (intent.kind === "commit-variant")
      props.onCommit(variants[intent.index] ?? props.insertText);
    // cancel → no commit
    setHighlight(null);
  };

  return (
    <>
      <div
        class={`kbd-key${props.fn ? " kbd-key--fn" : ""}${active() ? " kbd-key--active" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
      >
        {props.label}
      </div>
      {/* Portal to <body>: .kbd-root carries `transform` (the slide
          animation), which makes it the containing block for any
          position:fixed descendant — so an in-tree magnify would anchor to
          .kbd-root, not the viewport, and render off-screen. The balloon is
          positioned with viewport coords (getBoundingClientRect), so it must
          escape the transformed ancestor. (dogfood bug, 2026-06-14) */}
      <Portal>
        <Show when={magnify()}>
          {(m) => (
            <div
              class="kbd-magnify"
              style={{
                left: `${m().x - 22}px`,
                top: `${m().y - 52}px`,
                width: "44px",
                height: "48px",
              }}
            >
              {props.label}
            </div>
          )}
        </Show>
      </Portal>
    </>
  );
};

export default KeyCap;
