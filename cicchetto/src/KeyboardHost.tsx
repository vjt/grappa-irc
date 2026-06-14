import { type Component, Show } from "solid-js";
import type { KeyboardIntent } from "./keyboard";
import { Keyboard } from "./keyboard";
import { channelKey } from "./lib/channelKey";
import { getDraft, recallNext, recallPrev, setDraft, tabComplete } from "./lib/compose";
import { ircKeyboardEnabled } from "./lib/keyboardPref";
import { selectedChannel } from "./lib/selection";
import { isMobile } from "./lib/theme";

// Callback set the pure applyIntent uses — kept injectable so the editing
// math is unit-testable without the live compose store.
export interface HostCallbacks {
  onDraft: (value: string) => void;
  onSubmit: () => void;
  onHistory: (dir: "prev" | "next") => void;
  onAccessory: (id: string) => void;
  onDismiss: () => void;
}

// Pure editing application: mutate the textarea value + caret, then push
// the new draft / route control intents.
export function applyIntent(
  intent: KeyboardIntent,
  ta: HTMLTextAreaElement,
  cb: HostCallbacks,
): void {
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  switch (intent.kind) {
    case "insertText": {
      const next = ta.value.slice(0, start) + intent.text + ta.value.slice(end);
      ta.value = next;
      const caret = start + intent.text.length;
      ta.setSelectionRange(caret, caret);
      cb.onDraft(next);
      break;
    }
    case "deleteBackward": {
      if (start !== end) {
        const next = ta.value.slice(0, start) + ta.value.slice(end);
        ta.value = next;
        ta.setSelectionRange(start, start);
        cb.onDraft(next);
      } else if (start > 0) {
        const next = ta.value.slice(0, start - 1) + ta.value.slice(start);
        ta.value = next;
        ta.setSelectionRange(start - 1, start - 1);
        cb.onDraft(next);
      }
      break;
    }
    case "moveCaret": {
      // With a live selection (reachable via native iOS text-selection even
      // under inputmode=none), an arrow collapses to the near edge rather
      // than stepping past it; only a collapsed caret moves by one char.
      let pos: number;
      if (start !== end) {
        pos = intent.dir === "left" ? start : end;
      } else {
        pos = intent.dir === "left" ? Math.max(0, start - 1) : Math.min(ta.value.length, end + 1);
      }
      ta.setSelectionRange(pos, pos);
      break;
    }
    case "submit":
      cb.onSubmit();
      break;
    case "history":
      cb.onHistory(intent.dir);
      break;
    case "accessory":
      cb.onAccessory(intent.id);
      break;
    case "dismiss":
      cb.onDismiss();
      break;
  }
}

// Resolve the live compose textarea — same selector Shell uses.
function activeTextarea(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>(".compose-box textarea");
}

const LEFT_ACCESSORIES = [
  { id: "tab", label: "Tab" },
  { id: "slash", label: "/" },
  { id: "hash", label: "#" },
];

const KeyboardHost: Component = () => {
  const onIntent = (intent: KeyboardIntent) => {
    const sel = selectedChannel();
    const ta = activeTextarea();
    if (!sel || !ta) return;
    const key = channelKey(sel.networkSlug, sel.channelName);

    const cb: HostCallbacks = {
      onDraft: (value) => setDraft(key, value),
      onSubmit: () => {
        // Mirror Enter: dispatch the form's submit so ComposeBox.doSubmit runs.
        ta.closest("form")?.requestSubmit();
      },
      onHistory: (dir) => (dir === "prev" ? recallPrev(key) : recallNext(key)),
      onAccessory: (id) => {
        if (id === "slash" || id === "hash") {
          applyIntent({ kind: "insertText", text: id === "slash" ? "/" : "#" }, ta, cb);
          return;
        }
        if (id === "tab") {
          // Reuse the Shell.tsx cycleNickComplete approach:
          // read from the draft store (not ta.value) so fast typing
          // doesn't miss chars; schedule caret write on next microtask
          // so the Solid signal write has flushed first.
          const current = getDraft(key);
          const result = tabComplete(key, current, ta.selectionStart, true);
          if (!result) return;
          setDraft(key, result.newInput);
          queueMicrotask(() => {
            ta.setSelectionRange(result.newCursor, result.newCursor);
          });
        }
      },
      onDismiss: () => ta.blur(),
    };

    applyIntent(intent, ta, cb);
  };

  // Gate: opt-in ON + mobile viewport + coarse pointer (touch).
  // Desktop (fine pointer / wide viewport) never mounts.
  const show = () =>
    ircKeyboardEnabled() &&
    isMobile() &&
    typeof window !== "undefined" &&
    window.matchMedia?.("(pointer: coarse)").matches === true;

  return (
    <Show when={show()}>
      <Keyboard visible={true} leftAccessories={LEFT_ACCESSORIES} onIntent={onIntent} />
    </Show>
  );
};

export default KeyboardHost;
