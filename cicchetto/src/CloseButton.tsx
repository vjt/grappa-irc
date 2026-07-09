import type { Component } from "solid-js";

// Shared destructive close × for BottomBar (mobile) + Sidebar (desktop).
//
// #195 — the #172 hold-to-close gesture was REMOVED: on touch it read as a
// broken × (a tap did nothing; a >10px finger drift cancelled the 500ms
// hold), so users perceived "the X stopped working". Closing is now a plain
// instant click on every surface; the DELIBERATE-ness that the hold gate was
// meant to provide moved to an explicit confirm modal at the destructive call
// sites (windowClose.confirmLeaveChannel / confirmDisconnectNetwork). This
// component is a thin styled button again — the `onConfirm` prop is the click
// handler (a raw close for non-destructive windows, a confirm-opener for
// channel/network).
export interface CloseButtonProps {
  onConfirm: () => void;
  ariaLabel: string;
  // Surface-specific base class: "bottom-bar-close" | "sidebar-close".
  class: string;
}

const CloseButton: Component<CloseButtonProps> = (props) => {
  return (
    <button
      type="button"
      class={props.class}
      aria-label={props.ariaLabel}
      onClick={() => props.onConfirm()}
    >
      ×
    </button>
  );
};

export default CloseButton;
