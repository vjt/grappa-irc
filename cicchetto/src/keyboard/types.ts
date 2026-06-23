// The standalone keyboard's boundary contract. Nothing here imports cic.
// The host decides how to apply each intent to whatever text surface it
// owns; the keyboard never touches the DOM text field directly.

export type KeyboardIntent =
  | { kind: "insertText"; text: string } // a char, variant, or emoji
  | { kind: "deleteBackward" } // backspace
  | { kind: "submit" } // return
  | { kind: "moveCaret"; dir: "left" | "right" }
  | { kind: "history"; dir: "prev" | "next" } // up / down
  | { kind: "accessory"; id: string } // host-defined (e.g. "tab")
  | { kind: "dismiss" }; // close button

// A host-injected accessory button. The keyboard renders `label`; on tap
// it echoes `{ kind: "accessory", id }` and the host interprets `id`.
export interface AccessoryButton {
  id: string;
  label: string;
}

export interface KeyboardProps {
  onIntent: (intent: KeyboardIntent) => void;
  leftAccessories: AccessoryButton[];
  visible: boolean;
}

// Active keyboard layer. Emoji is a sibling "layer" the picker occupies.
export type KeyboardLayer = "letters" | "numbers" | "symbols" | "emoji";
