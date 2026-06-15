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

  // Authoritative caret for the compose textarea. Under inputmode=none the
  // controlled textarea (value={draft()}) re-renders on every setDraft and
  // iOS resets / mis-reports the selection — so reading ta.selectionStart
  // between fast keystrokes dropped characters (the insert landed on a stale
  // or phantom-selected range and replaced text). The host OWNS the caret
  // instead (the custom keyboard is the sole input driver here); the DOM is
  // re-synced only when the caret moves OUT of band — the user taps/selects
  // in the textarea, or an external draft change (history / channel switch)
  // settles. jsdom can't reproduce the iOS selection reset, so this is
  // verified by the editText burst tests + on-device dogfood.
  let caretStart = 0;
  let caretEnd = 0;

  // Set the host caret + push it to the DOM (visual) once Solid's
  // controlled re-render has flushed.
  const setCaret = (start: number, end: number, ta: HTMLTextAreaElement) => {
    caretStart = start;
    caretEnd = end;
    queueMicrotask(() => ta.setSelectionRange(start, end));
  };

  // Re-read the live caret AFTER the browser settles — for out-of-band
  // moves (user tap, history recall, channel switch) where nothing is
  // racing the DOM caret so it's trustworthy again.
  const resyncCaret = (ta: HTMLTextAreaElement) => {
    queueMicrotask(() => {
      caretStart = ta.selectionStart;
      caretEnd = ta.selectionEnd;
    });
  };

  onMount(() => {
    const onFocusIn = (e: FocusEvent) => {
      if (isComposeTextarea(e.target)) setWantKeyboard(true);
      else if (isOtherTextEntry(e.target)) setWantKeyboard(false);
    };
    // A tap / drag-select directly on the compose textarea is the only way
    // the user moves the caret out of band — the keyboard keys preventDefault
    // and never move it — so re-sync the host caret to wherever they put it.
    // `select` covers drag-selection (so typing then replaces the selection);
    // our own setSelectionRange is always collapsed and never fires `select`,
    // so there's no feedback loop. Use e.target directly (no querySelector on
    // every click — key taps are clicks too, and that ran on the hot path).
    const onUserReposition = (e: Event) => {
      const t = e.target;
      if (t instanceof HTMLTextAreaElement && isComposeTextarea(t)) resyncCaret(t);
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("click", onUserReposition);
    document.addEventListener("keyup", onUserReposition);
    document.addEventListener("select", onUserReposition, true);
    onCleanup(() => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("click", onUserReposition);
      document.removeEventListener("keyup", onUserReposition);
      document.removeEventListener("select", onUserReposition, true);
    });
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
  // one so the caret returns and the keyboard stays docked. Also re-sync the
  // host caret to the new channel's draft (its own text + caret position).
  createEffect(() => {
    selectedChannel(); // track switches
    if (!visible()) return;
    queueMicrotask(() => {
      const ta = activeTextarea();
      if (!ta) return;
      ta.focus();
      caretStart = ta.selectionStart;
      caretEnd = ta.selectionEnd;
    });
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

  // Apply an editing intent against the DRAFT STORE (synchronous, the source
  // of truth) using the HOST-OWNED caret (not the racy DOM caret). Update
  // the host caret + push it to the DOM.
  const applyEdit = (intent: EditIntent, key: ChannelKey, ta: HTMLTextAreaElement) => {
    const current = getDraft(key);
    const { text, caret } = editText(intent, current, caretStart, caretEnd);
    if (text !== current) setDraft(key, text);
    setCaret(caret, caret, ta);
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
        // Recall replaces the whole draft; let the caret settle to where the
        // re-render lands (end of the recalled text) and re-sync.
        if (intent.dir === "prev") recallPrev(key);
        else recallNext(key);
        resyncCaret(ta);
        break;
      case "accessory":
        if (intent.id === "slash" || intent.id === "hash") {
          applyEdit({ kind: "insertText", text: intent.id === "slash" ? "/" : "#" }, key, ta);
        } else if (intent.id === "tab") {
          // Reuse the Shell.tsx cycleNickComplete approach: draft store for
          // text, HOST caret for position. tabComplete returns the new
          // cursor; thread it back into the host caret.
          const current = getDraft(key);
          const result = tabComplete(key, current, caretStart, true);
          if (!result) return;
          setDraft(key, result.newInput);
          setCaret(result.newCursor, result.newCursor, ta);
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
