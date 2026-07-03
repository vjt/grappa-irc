import { type Component, createSignal, onCleanup, Show } from "solid-js";
import { channelKey } from "./lib/channelKey";
import { getDraft, recallNext, recallPrev, setDraft, submit, tabComplete } from "./lib/compose";
import { composePlaceholder } from "./lib/composePlaceholder";
import { ircKeyboardEnabled } from "./lib/keyboardPref";
import { networkBySlug } from "./lib/networks";
import {
  claimAxis,
  type DragAxis,
  gestureAction,
  type Point,
  type ScrollBoundary,
} from "./lib/swipe";
import { categoryOf } from "./lib/uploadCategory";
import { activeHost } from "./lib/uploadHost";
import {
  cancelUpload,
  dismissUpload,
  retryUpload,
  triggerUploads,
  uploadBatch,
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
// Images cluster I-2 (2026-05-15): three trigger surfaces for upload
// — file picker (paperclip-icon button; iOS Safari's native picker
// still exposes "Take Photo" / "Choose File" so a separate
// camera-capture button would be redundant), drag-drop (whole-form),
// clipboard paste
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
  let textareaEl: HTMLTextAreaElement | undefined;
  let swipeStart: Point | null = null;
  // Wall-clock at touchstart (ms). Feeds the touchend velocity gate so a slow
  // release is told apart from a fast flick. Browser time is legitimate here —
  // the Date.now / performance.now ban is a workflow-script rule, not cic
  // runtime. Reset every touchstart; read once, at touchend.
  let swipeStartTime = 0;
  let claimedAxis: DragAxis | null = null;
  // The textarea's native-scroll boundary sampled at touchstart. Decides
  // whether a vertical drag is a history flick (at the edge) or native scroll
  // (has room). A non-overflowing draft is at both edges → any flick claims.
  let startBoundary: ScrollBoundary = { atTop: true, atBottom: true };

  const scrollBoundary = (el: HTMLTextAreaElement): ScrollBoundary => {
    const maxScroll = el.scrollHeight - el.clientHeight;
    return { atTop: el.scrollTop <= 0, atBottom: el.scrollTop >= maxScroll - 1 };
  };

  // Swipe gestures on the textarea give a stock mobile keyboard (no Tab, no
  // arrows) the same affordances as keys: swipe RIGHT = Tab (nick complete),
  // swipe UP = ArrowUp (older history), swipe DOWN = ArrowDown (newer
  // history). A swipe — not double-tap — because double-tap collides with the
  // OS word-select. TOUCH (not pointer) events: only touchmove.preventDefault
  // reliably suppresses iOS's native scroll + drag-to-select.
  //
  // #123 rework (2026-07-03) — BOUNDARY claim, not velocity claim. The prior
  // velocity-gate (659aa06) sampled speed at the first 8px-slop crossing — the
  // acceleration ramp, where a real flick still reads slow — and abandoned
  // irrevocably. Dogfood double-failure: genuine flicks died (abandoned early)
  // AND iOS-coalesced scroll-drags got hijacked (a coalesced first move reads
  // fast → claimed → preventDefault kills the scroll). Fix: the mid-drag CLAIM
  // keys off the textarea's scroll BOUNDARY, not speed (`claimAxis`). A
  // vertical drag with scroll room in its direction is NEVER claimed → native
  // `touch-action: pan-y` scrolls the draft. A vertical drag PAST an edge (or
  // any drag on a non-overflowing draft, which is at both edges) claims the
  // history gesture; horizontal always claims (→ tab-complete). The flick test
  // moves to touchend over the WHOLE gesture (`gestureAction`), where
  // displacement + elapsed are both large and reliable.
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
    swipeStartTime = performance.now();
    claimedAxis = null;
    // Sample the scroll edges NOW — intent is fixed when the finger lands.
    startBoundary = textareaEl ? scrollBoundary(textareaEl) : { atTop: true, atBottom: true };
  };

  const onTouchMove = (e: TouchEvent) => {
    if (swipeStart === null || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (t === undefined) return;
    if (claimedAxis === null) {
      // Claim only a drag native scroll can't consume; a vertical drag with
      // room returns null and we stay hands-off so pan-y scrolls the draft.
      claimedAxis = claimAxis(swipeStart, { x: t.clientX, y: t.clientY }, startBoundary);
      if (claimedAxis === null) return;
    }
    // Suppress native scroll + drag-to-select once we own the gesture.
    e.preventDefault();
  };

  const onTouchEnd = (e: TouchEvent) => {
    const start = swipeStart;
    swipeStart = null;
    if (start === null || claimedAxis === null) return;
    const t = e.changedTouches[0];
    if (t === undefined) return;
    const end = { x: t.clientX, y: t.clientY };
    // Full-gesture velocity + direction → action (or null: slow release / no
    // mapped direction). The boundary gate already ran at claim time.
    switch (gestureAction(start, end, performance.now() - swipeStartTime)) {
      case "recall-prev":
        recallPrev(key());
        break;
      case "recall-next":
        recallNext(key());
        break;
      case "tab-complete": {
        const ta = e.currentTarget as HTMLTextAreaElement;
        const result = tabComplete(key(), getDraft(key()), ta.selectionEnd, true);
        if (!result) return;
        queueMicrotask(() => {
          ta.setSelectionRange(result.newCursor, result.newCursor);
        });
        break;
      }
    }
  };

  // Bind the swipe listeners on the textarea element itself, bypassing
  // Solid's passive document-level event delegation (touchmove MUST be
  // non-passive for preventDefault to take). onCleanup removes them when the
  // ComposeBox is disposed (e.g. channel switch re-creates the textarea).
  const bindSwipe = (el: HTMLTextAreaElement): void => {
    textareaEl = el;
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    onCleanup(() => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      textareaEl = undefined;
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

  // Drop/paste: filter to uploadable categories before handing the batch
  // to the orchestrator (a mixed drop of files + plain text uploads only
  // the files). #118 uploads ALL of them, sequentially.
  const handleFiles = (files: File[]): void => {
    const uploadable = files.filter((f) => categoryOf(f.type) !== null);
    if (uploadable.length === 0) return;
    triggerUploads(key(), props.networkSlug, props.channelName, uploadable);
  };

  const onPickerChange = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    // Picker path does NOT pre-filter by category: normalizeUploadFile in
    // the orchestrator relabels iOS .m4r ringtones (octet-stream → audio)
    // that categoryOf would otherwise drop.
    const files = input.files ? Array.from(input.files) : [];
    if (files.length > 0) {
      triggerUploads(key(), props.networkSlug, props.channelName, files);
    }
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
    const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
    handleFiles(files);
  };

  const onPaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of items) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file !== null && categoryOf(file.type) !== null) files.push(file);
    }
    if (files.length === 0) return;
    e.preventDefault();
    handleFiles(files);
  };

  // #118 — "(i/N)" counter, shown only while a multi-file batch is in
  // flight. A single upload (total 1) renders no counter.
  const batchLabel = (): string | null => {
    const b = uploadBatch(key());
    return b !== null && b.total > 1 ? `(${b.index}/${b.total})` : null;
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
          multiple
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
          {/* Paperclip icon (Feather) — inline SVG, theme-agnostic. A
           * generic "attach" affordance: the picker accepts every
           * category (image/video/document/audio), and iOS Safari's
           * native picker still exposes "Take Photo" / "Choose File"
           * on this single button — no separate capture input needed. */}
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
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <textarea
          ref={bindSwipe}
          value={getDraft(key())}
          onInput={onInput}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={composePlaceholder(props.networkSlug, props.channelName)}
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
                <Show when={batchLabel()}>
                  {(label) => <span class="compose-box-upload-batch">{label()}</span>}
                </Show>
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
              <Show when={batchLabel()}>
                {(label) => <span class="compose-box-upload-batch">{label()}</span>}
              </Show>
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
