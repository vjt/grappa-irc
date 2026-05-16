import type { Component } from "solid-js";

// M-cluster M-9b — shared inline-confirm button.
//
// Extracted from M-8 AdminVisitorsTab. Second use case in M-9b's
// Sessions tab (Disconnect + Terminate per row) justifies the lift
// per CLAUDE.md "Implement once, reuse everywhere".
//
// "Dumb" component — parent owns the `armed` signal (singleton key
// across rows + per-row across action buttons) and re-routes the
// mutex by toggling each child's `armed` prop. The child only
// renders one of two labels + fires onArm or onConfirm depending
// on the current `armed` value.
//
// Sticky (no timeout, no global click reset, no cancel button) per
// M-8 design Q2. The parent disarms by setting `armed=false`
// externally (refresh button, sibling action arming, etc.).
//
// Per `feedback_css_block_button_wraps_inline_prefix`: textContent
// IS the load-bearing UX signal. No `::before` sigils or wrapping
// spans — the visible label is the inner text directly.

export type Props = {
  idleLabel: string;
  confirmLabel: string;
  armed: boolean;
  onArm: () => void;
  onConfirm: () => void | Promise<void>;
  testId: string;
  extraClass?: string;
};

const InlineConfirmButton: Component<Props> = (props) => {
  return (
    <button
      type="button"
      class={`inline-confirm-btn ${props.extraClass ?? ""}`.trim()}
      classList={{ confirming: props.armed }}
      data-testid={props.testId}
      onClick={() => {
        if (props.armed) {
          void props.onConfirm();
        } else {
          props.onArm();
        }
      }}
    >
      {props.armed ? props.confirmLabel : props.idleLabel}
    </button>
  );
};

export default InlineConfirmButton;
