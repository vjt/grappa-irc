import { type Component, For } from "solid-js";
import type { AccessoryButton, KeyboardIntent } from "./types";

export interface AcceleratorBarProps {
  leftAccessories: AccessoryButton[];
  onIntent: (intent: KeyboardIntent) => void;
}

// pointerdown preventDefault: never steal textarea focus (same rule as
// KeyCap). Click still fires for the action.
const noFocusSteal = (e: PointerEvent) => e.preventDefault();

const AcceleratorBar: Component<AcceleratorBarProps> = (props) => {
  const btn = (label: string, aria: string, intent: KeyboardIntent) => (
    <button
      type="button"
      class="kbd-acc-btn"
      aria-label={aria}
      onPointerDown={noFocusSteal}
      onClick={() => props.onIntent(intent)}
    >
      {label}
    </button>
  );

  return (
    <div class="kbd-acc-pill">
      <For each={props.leftAccessories}>
        {(a) => btn(a.label, a.label, { kind: "accessory", id: a.id })}
      </For>
      <span class="kbd-acc-sep" />
      {/* Visual order ◀ ▲ ▼ ▶ (left, up, down, right) — vjt's preference
          (2026-06-14 dogfood). Intents are unchanged: ◀▶ move the caret,
          ▲▼ walk input history. */}
      {btn("◀", "move caret left", { kind: "moveCaret", dir: "left" })}
      {btn("▲", "history previous", { kind: "history", dir: "prev" })}
      {btn("▼", "history next", { kind: "history", dir: "next" })}
      {btn("▶", "move caret right", { kind: "moveCaret", dir: "right" })}
      <span class="kbd-acc-spacer" />
      {btn("✕", "close keyboard", { kind: "dismiss" })}
    </div>
  );
};

export default AcceleratorBar;
