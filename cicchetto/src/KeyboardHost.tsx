import { type Component, createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
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

// True when `el` is the live compose textarea (not some other text field).
function isComposeTextarea(el: EventTarget | null): el is HTMLTextAreaElement {
  return el instanceof HTMLTextAreaElement && el.closest(".compose-box") !== null;
}

function isOtherTextEntry(el: EventTarget | null): boolean {
  return (
    (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !isComposeTextarea(el)
  );
}

const KeyboardHost: Component = () => {
  // Focus-driven visibility (vjt dogfood 2026-06-14): the keyboard shows
  // when the compose textarea is focused and hides when X dismisses it
  // (X blurs the textarea). `wantKeyboard` is the open-intent — set on
  // compose focus, cleared on dismiss or when a DIFFERENT text field takes
  // focus (that field gets its own native keyboard). keepKeyboard.ts pins
  // compose focus across taps on non-input chrome, so during normal use the
  // keyboard stays docked; only X (or focusing elsewhere) closes it. This
  // replaces the always-docked model where X had no visible effect.
  const [wantKeyboard, setWantKeyboard] = createSignal(false);

  onMount(() => {
    const onFocusIn = (e: FocusEvent) => {
      if (isComposeTextarea(e.target)) setWantKeyboard(true);
      else if (isOtherTextEntry(e.target)) setWantKeyboard(false);
    };
    document.addEventListener("focusin", onFocusIn);
    onCleanup(() => document.removeEventListener("focusin", onFocusIn));
  });

  // Gate: opt-in ON + mobile viewport + coarse pointer (touch). Desktop
  // (fine pointer / wide viewport) never mounts. The Keyboard stays mounted
  // whenever mountable so its slide animation can run both ways; `visible`
  // drives the actual show/hide.
  const mountable = () =>
    ircKeyboardEnabled() &&
    isMobile() &&
    typeof window !== "undefined" &&
    window.matchMedia?.("(pointer: coarse)").matches === true;

  const visible = () => mountable() && wantKeyboard();

  // Stay open across channel switch (vjt: iOS-like). The compose textarea
  // can be re-created on switch; if the keyboard is open, re-focus the live
  // one so the caret returns and the keyboard stays docked.
  createEffect(() => {
    selectedChannel(); // track switches
    if (!visible()) return;
    queueMicrotask(() => activeTextarea()?.focus());
  });

  // Reservation: lift the bottom chrome (composer + BottomBar) above the
  // keyboard by its MEASURED rendered height — no magic KB_HEIGHT_PX
  // constant to drift against the device. 0 when hidden so the closed
  // layout reclaims the space. (Owner moved here from Shell so the var
  // tracks actual visibility, not just the opt-in flag.)
  createEffect(() => {
    const v = visible();
    queueMicrotask(() => {
      const root = document.querySelector<HTMLElement>(".kbd-root");
      const h = v && root ? root.offsetHeight : 0;
      document.documentElement.style.setProperty("--irc-kb-height", `${h}px`);
    });
  });

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
      // Close the keyboard: drop the open-intent AND blur so the next focus
      // re-opens it (vjt: tap the compose box to bring it back).
      onDismiss: () => {
        setWantKeyboard(false);
        ta.blur();
      },
    };

    applyIntent(intent, ta, cb);
  };

  return (
    <Show when={mountable()}>
      <Keyboard visible={visible()} leftAccessories={LEFT_ACCESSORIES} onIntent={onIntent} />
    </Show>
  );
};

export default KeyboardHost;
