import { type Component, Show } from "solid-js";
import { activeWindowCount, hasActiveWindows, jumpToNextActiveWindow } from "./lib/activeWindows";

// GH #235 — the on-screen "jump to next active window" affordance
// (irssi Alt+A). ONE component, two placements (Shell mounts it in the
// desktop sidebar bottom-left and as a mobile bottom-bar-right overlay);
// the `variant` only selects the CSS-positioning class. Auto-hides via
// `<Show>` when zero windows have unread activity.
//
// onClick routes through the SAME `jumpToNextActiveWindow` verb that the
// Alt+A keybinding + Ctrl+N call — no divergent second code path. The
// count badge derives from the same ordered list (`activeWindowCount`),
// so it can never disagree with the auto-hide condition.

export type Props = {
  variant: "desktop" | "mobile";
};

const NextActiveButton: Component<Props> = (props) => {
  return (
    <Show when={hasActiveWindows()}>
      <button
        type="button"
        class={`next-active-btn next-active-btn-${props.variant}`}
        data-testid="next-active-btn"
        aria-label="jump to next active window"
        title="jump to next active window (Alt+A)"
        onClick={() => jumpToNextActiveWindow()}
      >
        <span class="next-active-glyph" aria-hidden="true">
          »
        </span>
        <span class="next-active-count">{activeWindowCount()}</span>
      </button>
    </Show>
  );
};

export default NextActiveButton;
