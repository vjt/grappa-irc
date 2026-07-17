import { type Component, Show } from "solid-js";
import {
  activeWindowCount,
  hasActiveWindows,
  jumpToNextActiveWindow,
  nextActiveKind,
} from "./lib/activeWindows";

// GH #235 — the on-screen "jump to next active window" affordance
// (irssi Alt+A). ONE component, placements selected by `variant`: the
// desktop sidebar bottom-left, and — on mobile — either ScrollbackPane's
// float stack (scrollback windows, #280) or a viewport-fixed overlay
// (non-scrollback windows). Auto-hides via `<Show>` when zero windows
// have unread activity.
//
// onClick routes through the SAME `jumpToNextActiveWindow` verb that the
// Alt+A keybinding + Ctrl+N call — no divergent second code path. The
// count badge derives from the same ordered list (`activeWindowCount`),
// so it can never disagree with the auto-hide condition.
//
// #280 — badge COLOR reflects the next target's tier via `nextActiveKind`:
// RED (priority) for a mention/DM, BLUE (normal) for an ordinary channel.
// Same single source as the count/auto-hide, so it can never diverge.

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
        <span
          class="next-active-count"
          classList={{
            "next-active-count-priority": nextActiveKind() === "priority",
            "next-active-count-normal": nextActiveKind() === "normal",
          }}
        >
          {activeWindowCount()}
        </span>
      </button>
    </Show>
  );
};

export default NextActiveButton;
