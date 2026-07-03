import { type Component } from "solid-js";
import { createHoldToClose } from "./lib/holdToClose";

// #172 — shared destructive close × for BottomBar (mobile) + Sidebar (desktop).
//
// A touch/pen press must be HELD past the threshold to confirm, so a mobile
// fat-finger tap can't spuriously close a window; a mouse click (and keyboard
// Enter/Space) stays instant — pixel-precise input is already deliberate, so
// desktop is never punished. The `.close-holding` class is applied while a
// touch hold is in progress (a "keep holding" cue).
//
// The actual close verb (windowClose.*) is injected via `onConfirm`: this
// component owns ONLY the interaction gate, keeping the state-push layer pure
// (CLAUDE.md "reuse the verbs, not the nouns"). One component, both surfaces —
// so a new close site inherits the gate for free.
export interface CloseButtonProps {
  onConfirm: () => void;
  ariaLabel: string;
  // Surface-specific base class: "bottom-bar-close" | "sidebar-close".
  class: string;
}

const CloseButton: Component<CloseButtonProps> = (props) => {
  const g = createHoldToClose(() => props.onConfirm());
  return (
    <button
      type="button"
      class={props.class}
      classList={{ "close-holding": g.holding() }}
      aria-label={props.ariaLabel}
      onPointerDown={g.onPointerDown}
      onPointerMove={g.onPointerMove}
      onPointerUp={g.onPointerUp}
      onPointerCancel={g.onPointerCancel}
      onPointerLeave={g.onPointerLeave}
      onClick={g.onClick}
    >
      ×
    </button>
  );
};

export default CloseButton;
