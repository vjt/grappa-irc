import { type Component, createEffect, createSignal, For, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { computeMenuPosition } from "./lib/menuPosition";

// The context-menu SHELL: portal, backdrop, Escape, and the measured
// flip/clamp placement. Extracted from `UserContextMenu` when #1067 needed a
// second menu (the long-press message menu) with the same chrome and a
// completely different item list — the shared thing is the frame, not the
// actions, so the caller supplies the items.
//
// Positioning (#487): measured flip/clamp so the menu always opens fully inside
// the viewport. After render we measure the menu box (getBoundingClientRect)
// and feed it + the viewport to the pure `computeMenuPosition` seam
// (lib/menuPosition.ts): the menu FLIPS above/left of the press when it would
// overflow the far edge (pointer stays on the menu edge, like a native context
// menu), CLAMPS when a flip would underflow, and pins to the edge — with the
// CSS `max-height` + `overflow-y:auto` fallback — when it is taller than the
// viewport (short mobile viewport, keyboard up). The arithmetic is unit-tested
// without a real viewport (menuPosition.test.ts); the visible placement is
// proven in the Playwright e2e (issue487-context-menu-viewport-clamp.spec.ts)
// since jsdom gives no real viewport dimensions. Opacity-gated until measured
// so the pre-measure frame never flashes off-screen.
//
// #949 — "inside the viewport" was the LAYOUT viewport, whose origin under
// `viewport-fit=cover` is the physical top of the display. #913 fixed the same
// arithmetic for the rail menu and named this door as carrying the residue.
// The bounds now come from `.context-menu-safe-area`: a fixed, unpainted box
// laid out at `inset: env(safe-area-inset-*)`, measured with
// `getBoundingClientRect()`. That indirection is the point. #913 established
// that JS must NOT read the inset back out of a custom property —
// `getComputedStyle().getPropertyValue()` on an unregistered one can hand back
// the token stream rather than a length, and the NaN that follows is swallowed
// by any `|| 0` into a fix that looks applied and does nothing. A rect is a
// resolved length by construction: the engine still owns `env()`, and JS reads
// geometry, which is the one thing it can always trust. The box also yields
// all four insets from one measurement, which is what the X axis (landscape
// notch) and the bottom edge (home indicator) need.

export type ContextMenuItem = {
  label: string;
  enabled: boolean;
  action: () => void;
};

export type Props = {
  items: ContextMenuItem[];
  position: { x: number; y: number };
  onClose: () => void;
};

const ContextMenu: Component<Props> = (props) => {
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") props.onClose();
  };

  createEffect(() => {
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => document.removeEventListener("keydown", onKeyDown));
  });

  const handleItemClick = (item: ContextMenuItem): void => {
    if (!item.enabled) return;
    item.action();
    props.onClose();
  };

  let menuRef: HTMLDivElement | undefined;
  let safeAreaRef: HTMLDivElement | undefined;
  const [placement, setPlacement] = createSignal({
    top: props.position.y,
    left: props.position.x,
  });
  const [placed, setPlaced] = createSignal(false);

  createEffect(() => {
    // Track the press position so a re-open at new coords re-runs this: the
    // caller may keep this component mounted across two opens (`<Show>` on a
    // signal), so `onMount` alone would strand the menu at the first coords.
    const clickX = props.position.x;
    const clickY = props.position.y;
    if (!menuRef || !safeAreaRef) return;
    const rect = menuRef.getBoundingClientRect();
    const safe = safeAreaRef.getBoundingClientRect();
    setPlacement(
      computeMenuPosition({
        clickX,
        clickY,
        menuWidth: rect.width,
        menuHeight: rect.height,
        // Visual viewport (NOT window.innerWidth/Height) so the clamp shrinks
        // with the on-screen keyboard — matching the CSS `max-height:
        // var(--viewport-height)` fallback and the app-wide viewportHeight.ts
        // primitive (both derive from window.visualViewport).
        // window.innerHeight stays full-screen while the keyboard is up, which
        // would let the menu render under the keyboard (the #487 symptom, on
        // mobile). Playwright equalizes innerHeight and visualViewport, so the
        // keyboard-up divergence is a device-dogfood item, not an e2e one.
        viewportWidth: window.visualViewport?.width ?? window.innerWidth,
        viewportHeight: window.visualViewport?.height ?? window.innerHeight,
        // #949 — the safe box, in layout-viewport coordinates. Where there is
        // no inset (every desktop browser, every engine in the e2e suite) this
        // is exactly {0, w, h, 0} and the placement is bit-identical to #487's.
        safeArea: { top: safe.top, right: safe.right, bottom: safe.bottom, left: safe.left },
      }),
    );
    setPlaced(true);
  });

  return (
    // Portal to <body> so the fixed-position menu + backdrop are never trapped
    // inside a scrollback-pane stacking context. #75's background wallpaper
    // makes `.scrollback-pane` an `isolation: isolate` stacking context when a
    // bg theme is active; a fixed descendant of it would be confined to the
    // pane's paint region (menu behind the ComposeBox, backdrop not covering
    // out-of-pane chrome). Rendering at the document root keeps the z-300/301
    // layers above everything, themed or not.
    <Portal>
      {/* #949 — the safe-area ruler. Unpainted and untouchable; it exists only
          so `getBoundingClientRect()` can hand the placement math the four
          insets as resolved lengths. */}
      <div ref={safeAreaRef} class="context-menu-safe-area" aria-hidden="true" />
      {/* Backdrop: click-outside closes the menu. Rendered as button for a11y. */}
      <button
        type="button"
        class="context-menu-backdrop"
        aria-label="Close menu"
        onClick={props.onClose}
      />
      <div
        ref={menuRef}
        class="context-menu"
        style={{
          position: "fixed",
          top: `${placement().top}px`,
          left: `${placement().left}px`,
          opacity: placed() ? "1" : "0",
        }}
        role="menu"
      >
        <For each={props.items}>
          {(item) => (
            <button
              type="button"
              class="context-menu-item"
              classList={{ "context-menu-item-disabled": !item.enabled }}
              disabled={!item.enabled}
              onClick={() => handleItemClick(item)}
            >
              {item.label}
            </button>
          )}
        </For>
      </div>
    </Portal>
  );
};

export default ContextMenu;
