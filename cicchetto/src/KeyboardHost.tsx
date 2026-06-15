import { type Component, createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { KeyboardIntent } from "./keyboard";
import { Keyboard } from "./keyboard";
import { type ChannelKey, channelKey } from "./lib/channelKey";
import { getDraft, recallNext, recallPrev, setDraft, tabComplete } from "./lib/compose";
import { ircKeyboardEnabled } from "./lib/keyboardPref";
import { selectedChannel } from "./lib/selection";
import { isMobile } from "./lib/theme";

// The editing intents that mutate text/caret (a subset of KeyboardIntent;
// the control intents — submit/history/accessory/dismiss — are routed
// separately by the host).
export type EditIntent =
  | { kind: "insertText"; text: string }
  | { kind: "deleteBackward" }
  | { kind: "moveCaret"; dir: "left" | "right" };

// Pure editing math: given the current text + selection, return the next
// text and the caret after applying an editing intent. No DOM. The host
// feeds it the DRAFT-STORE text (the source of truth), NOT the live
// textarea's value — under a fast keystroke burst the controlled textarea
// is mid-re-render and reading ta.value drops characters (dogfood round 2).
export function editText(
  intent: EditIntent,
  text: string,
  selStart: number,
  selEnd: number,
): { text: string; caret: number } {
  switch (intent.kind) {
    case "insertText": {
      const next = text.slice(0, selStart) + intent.text + text.slice(selEnd);
      return { text: next, caret: selStart + intent.text.length };
    }
    case "deleteBackward": {
      if (selStart !== selEnd) {
        return { text: text.slice(0, selStart) + text.slice(selEnd), caret: selStart };
      }
      if (selStart > 0) {
        return { text: text.slice(0, selStart - 1) + text.slice(selStart), caret: selStart - 1 };
      }
      return { text, caret: selStart };
    }
    case "moveCaret": {
      // A live selection (reachable via native iOS text-selection even under
      // inputmode=none) collapses to its near edge; a collapsed caret steps
      // one char.
      const caret =
        selStart !== selEnd
          ? intent.dir === "left"
            ? selStart
            : selEnd
          : intent.dir === "left"
            ? Math.max(0, selStart - 1)
            : Math.min(text.length, selEnd + 1);
      return { text, caret };
    }
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

  // Apply an editing intent through the DRAFT STORE, not the live textarea.
  // Reading ta.value mid-render dropped chars under fast typing; the store
  // is synchronous + authoritative. The caret is then restored on the next
  // microtask, AFTER Solid's controlled-value re-render has flushed (which
  // otherwise yanks the caret to the end). Same shape as tab-complete.
  const applyEdit = (intent: EditIntent, key: ChannelKey, ta: HTMLTextAreaElement) => {
    const current = getDraft(key);
    const { text, caret } = editText(intent, current, ta.selectionStart, ta.selectionEnd);
    if (text !== current) setDraft(key, text);
    queueMicrotask(() => ta.setSelectionRange(caret, caret));
  };

  const onIntent = (intent: KeyboardIntent) => {
    const sel = selectedChannel();
    const ta = activeTextarea();
    if (!sel || !ta) return;
    const key = channelKey(sel.networkSlug, sel.channelName);

    switch (intent.kind) {
      case "insertText":
      case "deleteBackward":
      case "moveCaret":
        applyEdit(intent, key, ta);
        break;
      case "submit":
        // Mirror Enter: dispatch the form's submit so ComposeBox.doSubmit runs.
        ta.closest("form")?.requestSubmit();
        break;
      case "history":
        if (intent.dir === "prev") recallPrev(key);
        else recallNext(key);
        break;
      case "accessory":
        if (intent.id === "slash" || intent.id === "hash") {
          applyEdit({ kind: "insertText", text: intent.id === "slash" ? "/" : "#" }, key, ta);
        } else if (intent.id === "tab") {
          // Reuse the Shell.tsx cycleNickComplete approach: read from the
          // draft store (not ta.value) so fast typing doesn't miss chars;
          // schedule the caret write on the next microtask so the Solid
          // signal write has flushed first.
          const current = getDraft(key);
          const result = tabComplete(key, current, ta.selectionStart, true);
          if (!result) return;
          setDraft(key, result.newInput);
          queueMicrotask(() => ta.setSelectionRange(result.newCursor, result.newCursor));
        }
        break;
      case "dismiss":
        // Drop the open-intent AND blur so the next focus re-opens it
        // (vjt: tap the compose box to bring it back).
        setWantKeyboard(false);
        ta.blur();
        break;
    }
  };

  return (
    <Show when={mountable()}>
      <Keyboard visible={visible()} leftAccessories={LEFT_ACCESSORIES} onIntent={onIntent} />
    </Show>
  );
};

export default KeyboardHost;
