import { type Component, createSignal, onCleanup, Show } from "solid-js";
import { channelKey } from "./lib/channelKey";
import { getDraft, recallNext, recallPrev, setDraft, submit, tabComplete } from "./lib/compose";
import { ircKeyboardEnabled } from "./lib/keyboardPref";
import { networkBySlug } from "./lib/networks";
import { type DragAxis, dragAxis, type Point, swipeDirection } from "./lib/swipe";
import { categoryOf } from "./lib/uploadCategory";
import { activeHost } from "./lib/uploadHost";
import {
  cancelUpload,
  dismissUpload,
  retryUpload,
  triggerUpload,
  uploadState,
} from "./lib/uploadOrchestrator";
import { windowStateByChannel } from "./lib/windowState";

// Sticky-bottom compose surface. Reads + writes compose.ts state;
// dispatches submit on Enter; arrow keys walk per-channel history.
//
// Tab-complete is wired by keybindings.ts (Phase 5) which fires
// cycleNickComplete on Tab in the textarea — keybindings.ts dispatches
// to a handler that Shell.tsx wires to compose.tabComplete. That two-
// hop indirection avoids ComposeBox having to know about the global
// keybinding install; selecting a different focused element won't fire
// the wrong tab handler.
//
// CP15 B5: greyed-state visual when window state is failed/kicked/parked.
// The form root gets `.compose-box-greyed`; an inline "(not joined)"
// label sits beneath the textarea. Compose stays functional — operator
// can still type `/join` / `/part`. Query windows (no state entry) and
// state == "joined" / "pending" render the normal form; pending is the
// post-click optimistic visual feedback while the JOIN echo is in flight.
//
// CP19 T32 parked-window — per-network derivation overlay: when the
// network's credential `connection_state ∈ {parked, failed}` the
// compose box is greyed regardless of the per-window state. Mirrors the
// Sidebar derivation rule so a parked network's selected channel can't
// silently look ready-to-send. Operator can still type `/connect` to
// unpark.
//
// Images cluster I-2 (2026-05-15): three trigger surfaces for image
// upload — file picker (camera-icon button; iOS Safari's native picker
// already exposes "Take Photo" so a separate camera-capture button
// would be redundant), drag-drop (whole-form), clipboard paste
// (textarea). All converge on `triggerUpload()` from
// uploadOrchestrator; the orchestrator handles privacy modal
// gating, MIME pre-check, TTL dropdown wiring, progress state,
// auto-send. ComposeBox is the trigger surface only — no upload
// logic lives here.
//
// Uploads cluster Task 7 (2026-06-09): the trigger surfaces widened
// from image-only to every categorized MIME — `categoryOf()` is the
// drop/paste filter, the picker's accept attr spans all the active
// host's categories. The host accept-list + per-category cap checks
// stay in the orchestrator (one gate, one error surface); the
// category filter here only stops obviously-uninteresting payloads
// (text selections, random binaries) from opening the upload UI.

export type Props = {
  networkSlug: string;
  channelName: string;
};

const NOT_JOINED_STATES = new Set(["failed", "kicked", "parked"]);
const NETWORK_GREYED_STATES = new Set(["parked", "failed"]);

const ComposeBox: Component<Props> = (props) => {
  const key = () => channelKey(props.networkSlug, props.channelName);
  const [error, setError] = createSignal<string | null>(null);
  const [sending, setSending] = createSignal(false);
  let pickerInput: HTMLInputElement | undefined;
  let swipeStart: Point | null = null;
  let claimedAxis: DragAxis | null = null;

  // Swipe gestures on the textarea give a stock mobile keyboard (no Tab, no
  // arrows) the same affordances as keys: swipe RIGHT = Tab (nick complete),
  // swipe UP = ArrowUp (older history), swipe DOWN = ArrowDown (newer
  // history). A swipe — not double-tap — because double-tap collides with the
  // OS word-select. TOUCH (not pointer) events: only touchmove.preventDefault
  // reliably suppresses iOS's native scroll + drag-to-select, so once the
  // drag commits to an axis (dragAxis) we claim it and preventDefault the
  // rest. On touchend swipeDirection classifies the dominant axis and we
  // dispatch the matching key action.
  //
  // These are bound via a ref + addEventListener (see bindSwipe), NOT JSX
  // onTouch* — Solid delegates touch events to a single PASSIVE listener on
  // `document`, where preventDefault silently no-ops. We need an
  // element-level, explicitly non-passive touchmove listener.
  const onTouchStart = (e: TouchEvent) => {
    // Stock-keyboard path only: with the IRC keyboard on, KeyboardHost owns
    // the caret (textarea is inputmode=none) and has its own Tab key.
    if (ircKeyboardEnabled()) return;
    const t = e.touches.length === 1 ? e.touches[0] : undefined;
    swipeStart = t ? { x: t.clientX, y: t.clientY } : null;
    claimedAxis = null;
  };

  const onTouchMove = (e: TouchEvent) => {
    if (swipeStart === null || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (t === undefined) return;
    if (claimedAxis === null) {
      claimedAxis = dragAxis(swipeStart, { x: t.clientX, y: t.clientY });
    }
    // Suppress native scroll + drag-to-select once we own the gesture.
    if (claimedAxis !== null) e.preventDefault();
  };

  const onTouchEnd = (e: TouchEvent) => {
    const start = swipeStart;
    swipeStart = null;
    if (start === null || claimedAxis === null) return;
    const t = e.changedTouches[0];
    if (t === undefined) return;
    const dir = swipeDirection(start, { x: t.clientX, y: t.clientY });
    if (dir === "up") {
      recallPrev(key());
    } else if (dir === "down") {
      recallNext(key());
    } else if (dir === "right") {
      const ta = e.currentTarget as HTMLTextAreaElement;
      const result = tabComplete(key(), getDraft(key()), ta.selectionEnd, true);
      if (!result) return;
      queueMicrotask(() => {
        ta.setSelectionRange(result.newCursor, result.newCursor);
      });
    }
    // "left" / null → no mapped action.
  };

  // Bind the swipe listeners on the textarea element itself, bypassing
  // Solid's passive document-level event delegation (touchmove MUST be
  // non-passive for preventDefault to take). onCleanup removes them when the
  // ComposeBox is disposed (e.g. channel switch re-creates the textarea).
  const bindSwipe = (el: HTMLTextAreaElement): void => {
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    onCleanup(() => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    });
  };

  const greyed = (): boolean => {
    // Bucket F H4: only UserNetwork carries connection_state. Narrow on
    // network.kind before reading the field; visitor networks are
    // never greyed at the network level (visitors have no credential
    // row to park / fail).
    const net = networkBySlug(props.networkSlug);
    if (net?.kind === "user" && NETWORK_GREYED_STATES.has(net.connection_state)) return true;
    const s = windowStateByChannel()[key()];
    return s !== undefined && NOT_JOINED_STATES.has(s);
  };

  const onInput = (e: Event) => {
    const value = (e.currentTarget as HTMLTextAreaElement).value;
    setDraft(key(), value);
    setError(null);
  };

  // ---- Upload trigger surfaces (all categories) --------------------

  const handleFile = (file: File): void => {
    triggerUpload(key(), props.networkSlug, props.channelName, file);
  };

  const onPickerChange = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) handleFile(file);
    // Reset so picking the same file twice still fires `change`.
    input.value = "";
  };

  const onPickerClick = () => {
    pickerInput?.click();
  };

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (categoryOf(file.type) === null) return;
    handleFile(file);
  };

  const onPaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file !== null && categoryOf(file.type) !== null) {
        e.preventDefault();
        handleFile(file);
        return;
      }
    }
  };

  const onCancelUpload = () => {
    cancelUpload(key());
  };

  const onRetryUpload = () => {
    retryUpload(key());
  };

  const onDismissUpload = () => {
    dismissUpload(key());
  };

  // ---- Submit ------------------------------------------------------

  const doSubmit = async (): Promise<void> => {
    if (sending()) return;
    setSending(true);
    setError(null);
    try {
      const result = await submit(key(), props.networkSlug, props.channelName);
      if ("error" in result && result.error !== "empty") {
        setError(result.error);
      }
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void doSubmit();
      return;
    }
    if (e.key === "ArrowUp") {
      const ta = e.currentTarget as HTMLTextAreaElement;
      // Only walk history if cursor is on first line; otherwise let
      // native cursor movement handle it.
      const before = ta.value.slice(0, ta.selectionStart);
      if (!before.includes("\n")) {
        e.preventDefault();
        recallPrev(key());
      }
      return;
    }
    if (e.key === "ArrowDown") {
      const ta = e.currentTarget as HTMLTextAreaElement;
      const after = ta.value.slice(ta.selectionEnd);
      if (!after.includes("\n")) {
        e.preventDefault();
        recallNext(key());
      }
      return;
    }
  };

  return (
    <>
      <form
        class={`compose-box${greyed() ? " compose-box-greyed" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          void doSubmit();
        }}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <input
          ref={pickerInput}
          type="file"
          accept={Object.values(activeHost().acceptedMimeTypes).flat().join(",")}
          data-file-picker
          hidden
          onChange={onPickerChange}
        />
        <button
          type="button"
          class="compose-box-image-picker"
          aria-label="upload file"
          onClick={onPickerClick}
          title="upload file"
        >
          {/* Camera icon — inline SVG, theme-agnostic. iOS Safari's
           * native picker on this single button already exposes
           * "Take Photo" / "Photo Library" — no separate
           * capture=environment input needed. */}
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
        </button>
        <textarea
          ref={bindSwipe}
          value={getDraft(key())}
          onInput={onInput}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={`message ${props.channelName}`}
          rows={1}
          aria-label="compose message"
          // IRC keyboard: suppress the native on-screen keyboard while the
          // opt-in is on. DECLARATIVE + reactive so every render of this
          // textarea — including re-creation on channel switch — carries the
          // attr; an imperative Shell effect missed freshly-rendered textareas
          // and the native keyboard slipped through (dogfood bug, 2026-06-14).
          inputmode={ircKeyboardEnabled() ? "none" : undefined}
        />
        {/* UX-6 bucket F (2026-05-21) — arrow glyph + aria-label
            preserve a11y + byRole queries. SVG (not Unicode ➤) so the
            glyph survives Linux/Windows font-stack fallback — `.compose-box
            button` inherits `--font-mono` whose Consolas/Liberation/DejaVu
            members lack Dingbats-block codepoints. Matches the camera-
            icon SVG precedent on the sibling picker button. */}
        <button
          type="submit"
          aria-label="send message"
          disabled={sending() || getDraft(key()).trim() === ""}
          // #59: keep the textarea focused when sending via the button.
          // Tapping a <button> moves focus off the textarea, which collapses
          // the on-screen keyboard (native on Android; also drops the
          // IRC-keyboard focus model). preventDefault on pointerdown stops
          // the focus steal — the click still fires + submits. Same trick as
          // the keyboard keys + the image-picker button.
          onPointerDown={(e) => e.preventDefault()}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
            data-testid="compose-send-glyph"
          >
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </form>
      <Show when={uploadState(key())}>
        {(st) => (
          <Show
            when={st().error}
            fallback={
              // role="status" (polite live region), NOT role="progressbar":
              // the native <progress> below self-announces, and ARIA
              // progressbar has Children Presentational=true — it would
              // flatten the filename / phase label / cancel button out of
              // the a11y tree. status also announces the "processing
              // video…" phase transition (Task 8 a11y review, 2026-06-09).
              <div class="compose-box-upload-progress" role="status">
                <span class="compose-box-upload-filename">{st().filename}</span>
                <Show when={st().phase === "transcoding"}>
                  <span class="compose-box-upload-phase">processing video…</span>
                </Show>
                <progress value={st().loaded} max={st().total} />
                <button type="button" onClick={onCancelUpload}>
                  cancel
                </button>
              </div>
            }
          >
            <div class="compose-box-upload-error" role="alert">
              <span class="compose-box-upload-filename">{st().filename}</span>
              <span class="compose-box-upload-error-msg">{st().error}</span>
              <button type="button" onClick={onRetryUpload}>
                retry
              </button>
              <button type="button" onClick={onDismissUpload}>
                dismiss
              </button>
            </div>
          </Show>
        )}
      </Show>
      <Show when={greyed()}>
        <p class="compose-box-not-joined muted">(not joined)</p>
      </Show>
      <Show when={error()}>
        {(msg) => (
          <p class="compose-box-error" role="alert">
            {msg()}
          </p>
        )}
      </Show>
    </>
  );
};

export default ComposeBox;
