import { type Component, createSignal, onCleanup, Show } from "solid-js";
import { isDiagEnabled } from "./DiagFloat";
import { channelKey } from "./lib/channelKey";
import { getDraft, recallNext, recallPrev, setDraft, submit, tabComplete } from "./lib/compose";
import { composePlaceholder } from "./lib/composePlaceholder";
import { requestConfirm } from "./lib/confirmDialog";
import { diagPush } from "./lib/diagLog";
import { networkBySlug } from "./lib/networks";
import { pastedLineCount, shouldGuardPaste } from "./lib/pasteFlood";
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
  // On-device gesture diagnostics (#123): captured once per touch at
  // touchstart so the flag is read a single time, not per move. When on,
  // touchstart / claim / touchend push a line into diagLog for DiagFloat to
  // render — the evidence webkit playwright can't produce.
  let diagOn = false;

  const scrollBoundary = (el: HTMLTextAreaElement): ScrollBoundary => {
    const maxScroll = el.scrollHeight - el.clientHeight;
    return { atTop: el.scrollTop <= 0, atBottom: el.scrollTop >= maxScroll - 1 };
  };

  // #173 — after a history recall the controlled `value` swaps to the recalled
  // line, but the pure compose store (recallPrev/recallNext) only mutates the
  // draft — it never touches the caret or the native scroll. On a recalled line
  // that OVERFLOWS the rows=1 textarea the browser leaves scrollTop at 0 with
  // the end-caret below the fold — you recall a long line and can't see where
  // you're typing (the dogfood symptom; a down-gesture reaches it most reliably
  // because by the #123 mapping it fires only while atTop === scrollTop 0).
  // Place the caret deterministically at the END (irssi recall semantics) and
  // scroll the textarea so that caret is in view. queueMicrotask mirrors the
  // tab-complete precedent: run AFTER the value re-render commits to the DOM.
  // ONE helper, both recall entry points (swipe touchend + keydown ArrowUp/
  // ArrowDown) — the defect and the fix are identical for both, so this is the
  // general "after any recall the caret is visible" rule, not a gesture patch.
  const scrollRecallCaretIntoView = (): void => {
    const el = textareaEl;
    if (el === undefined) return;
    queueMicrotask(() => {
      const end = el.value.length;
      el.setSelectionRange(end, end);
      el.scrollTop = el.scrollHeight;
    });
  };

  // #178 + #203 — gesture recall gating, split by direction.
  //
  // #178 gated BOTH gesture-recall directions on a non-empty draft: an
  // empty/short (rows=1) draft sits at BOTH scroll edges, so by the #123
  // boundary mapping (`claimAxis`) ANY vertical flick over it claims the
  // gesture, and a fast up-flick then handed off to `recallPrev` —
  // pulling an old sent line into a draft the user never intended to
  // edit.
  //
  // #203 corrected that for swipe-UP: the gate was too broad and broke
  // swipe≡ArrowUp parity. The compose textarea is rows=1 — an EMPTY one
  // has nothing to scroll (the scrollback pane is a SEPARATE touch
  // surface), so the #178 "empty up-flick is a scroll/look gesture"
  // premise doesn't hold there; the only coherent intent of an up-flick
  // over an empty compose is recall — exactly what the physical ArrowUp
  // key does (`onKeyDown`, which #178 always left recalling on empty).
  // So swipe-UP → `recallPrev` now fires UNCONDITIONALLY (see the
  // `case "recall-prev"` below), restoring the stock-mobile-keyboard
  // affordance's parity with the arrow key AND killing the dead-gesture
  // defect where an empty up-flick suppressed native scroll (onTouchMove
  // preventDefault) yet did nothing.
  //
  // `gestureRecallAllowed` is KEPT on swipe-DOWN (`recallNext`): a
  // down-flick's job is "walk back down toward the live draft you
  // stashed on the way up", meaningful only once there IS an in-progress
  // draft — and `recallNext` is a no-op on a null cursor anyway, so
  // gating it costs nothing while preserving #178's scope. `.trim()` so
  // a stray space/newline doesn't count as "content".
  const gestureRecallAllowed = (): boolean => getDraft(key()).trim() !== "";

  // Swipe gestures on the textarea give a stock mobile keyboard (no Tab, no
  // arrows) the same affordances as keys: swipe RIGHT = Tab (nick complete),
  // swipe UP = ArrowUp (older history), swipe DOWN = ArrowDown (newer
  // history). A swipe — not double-tap — because double-tap collides with the
  // OS word-select. TOUCH (not pointer) events: only touchmove.preventDefault
  // reliably suppresses iOS's native scroll + drag-to-select.
  //
  // #123 nested-scroll boundary handoff (2026-07-03) — the textarea is an
  // INNER scroll surface; the swipe is the OUTER gesture. The inner scroll owns
  // the vertical drag WHILE it still has room in that direction; the instant it
  // hits its edge (finger-up → bottom, finger-down → top), it CEDES the rest of
  // this same touch to the gesture. That is why the boundary is read LIVE on
  // every touchmove, not snapshotted at touchstart: a frozen snapshot only ever
  // handed off from an already-at-edge start, so a mid-scrolled draft ate the
  // drag and the gesture only fired on a SECOND touch (the "double-swipe" bug;
  // it appeared to work solely at scrollTop === 0). `claimAxis` owns the
  // direction→edge mapping; the flick test is deferred to touchend over the
  // WHOLE gesture (`gestureAction`), where displacement + elapsed are reliable.
  //
  // These are bound via a ref + addEventListener (see bindSwipe), NOT JSX
  // onTouch* — Solid delegates touch events to a single PASSIVE listener on
  // `document`, where preventDefault silently no-ops. We need an element-level,
  // explicitly non-passive touchmove listener to preventDefault at the handoff.
  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches.length === 1 ? e.touches[0] : undefined;
    swipeStart = t ? { x: t.clientX, y: t.clientY } : null;
    swipeStartTime = performance.now();
    claimedAxis = null;
    diagOn = isDiagEnabled();
    if (diagOn && textareaEl && t) {
      const el = textareaEl;
      diagPush(
        `TS y=${Math.round(t.clientY)} st=${el.scrollTop} sh=${el.scrollHeight} ch=${el.clientHeight}`,
      );
    }
  };

  const onTouchMove = (e: TouchEvent) => {
    if (swipeStart === null || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (t === undefined) return;
    if (claimedAxis === null) {
      // Read the scroll boundary LIVE every move: the textarea may have
      // native-scrolled to its edge DURING this touch, and the gesture must
      // hand off the instant it does. A vertical drag WITH room returns null →
      // we stay hands-off so pan-y scrolls the draft.
      const boundary = textareaEl ? scrollBoundary(textareaEl) : { atTop: true, atBottom: true };
      claimedAxis = claimAxis(swipeStart, { x: t.clientX, y: t.clientY }, boundary);
      if (claimedAxis === null) return;
      if (diagOn) {
        const st = textareaEl ? textareaEl.scrollTop : -1;
        diagPush(
          `CLAIM ${claimedAxis} up=${t.clientY - swipeStart.y < 0} atTop=${boundary.atTop} atBot=${boundary.atBottom} st=${st}`,
        );
      }
    }
    // Suppress native scroll + drag-to-select once we own the gesture.
    e.preventDefault();
  };

  const onTouchEnd = (e: TouchEvent) => {
    const start = swipeStart;
    const claimed = claimedAxis;
    swipeStart = null;
    const t = e.changedTouches[0];
    if (start === null || t === undefined) return;
    const end = { x: t.clientX, y: t.clientY };
    // Full-gesture velocity + direction → action (null: never claimed / slow
    // release / no mapped direction). The boundary gate already ran at claim.
    const action =
      claimed === null ? null : gestureAction(start, end, performance.now() - swipeStartTime);
    if (diagOn) {
      const st = textareaEl ? textareaEl.scrollTop : -1;
      diagPush(
        `END claimed=${claimed ?? "no"} act=${action ?? "none"} dy=${Math.round(end.y - start.y)} st=${st}`,
      );
    }
    switch (action) {
      case "recall-prev":
        // #203 — swipe-UP recalls unconditionally (parity with ArrowUp;
        // see gestureRecallAllowed's doc). No empty-draft gate here.
        recallPrev(key());
        scrollRecallCaretIntoView();
        break;
      case "recall-next":
        // #178 — swipe-DOWN recall stays gated on a non-empty draft.
        if (gestureRecallAllowed()) {
          recallNext(key());
          scrollRecallCaretIntoView();
        }
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

  // #80 — insert a confirmed multi-line paste at the caret, replacing any
  // selection, exactly as a native paste would — the confirm dialog only
  // GATED it, so on Paste we perform the insertion the browser skipped
  // (we preventDefault'd it). Then place the caret after the inserted text
  // and refocus the textarea: the modal's affirmative button stole focus,
  // and the operator wants to keep typing / hit Enter to send. queueMicrotask
  // mirrors the recall-caret precedent — run AFTER the controlled value
  // re-render commits to the DOM.
  const insertPastedText = (ta: HTMLTextAreaElement, text: string): void => {
    const before = getDraft(key());
    const start = ta.selectionStart ?? before.length;
    const end = ta.selectionEnd ?? before.length;
    const next = before.slice(0, start) + text + before.slice(end);
    setDraft(key(), next);
    const caret = start + text.length;
    queueMicrotask(() => {
      ta.focus();
      ta.setSelectionRange(caret, caret);
    });
  };

  const onPaste = (e: ClipboardEvent) => {
    const data = e.clipboardData;
    if (!data) return;
    const files: File[] = [];
    // `?? []`: a clipboardData without an `items` list is degenerate but must
    // not throw the whole handler — the plain-text branch below still runs off
    // getData (restores the pre-#80 `if (!items) …` safety).
    for (const item of data.items ?? []) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file !== null && categoryOf(file.type) !== null) files.push(file);
    }
    // File paste (image/media upload) — disjoint from the text-line guard.
    // The upload path owns preventDefault + its own e2e/vitest coverage.
    if (files.length > 0) {
      e.preventDefault();
      handleFiles(files);
      return;
    }
    // #80 — plain-text multi-line paste flood guard. A pasted block is sent
    // as one PRIVMSG per line on submit (compose.ts → messageLines.ts), so a
    // large block can flood the channel. Above the line threshold, intercept
    // the native paste and confirm BEFORE the text lands; below it, fall
    // through to native textarea paste so 1–3-line pastes stay frictionless.
    // Reuses the store-driven confirm dialog (lib/confirmDialog) — Cancel is
    // the safe default (drop the paste), the affirmative button pastes.
    const text = data.getData("text");
    if (!shouldGuardPaste(text)) return;
    e.preventDefault();
    const ta = e.currentTarget as HTMLTextAreaElement;
    const lines = pastedLineCount(text);
    requestConfirm({
      title: `Paste ${lines} lines?`,
      // Target-neutral copy: `channelName` is a nick on a query (DM) window,
      // so "flood the channel" would misdescribe a DM. "a burst of messages"
      // is honest without over-claiming one-message-per-line (blank lines are
      // dropped at send — splitMessageLines), and reads right for both a
      // channel and a DM.
      body: `You're about to paste ${lines} lines into ${props.channelName}. Sending can flood it with a burst of messages.`,
      confirmLabel: "Paste",
      onConfirm: () => insertPastedText(ta, text),
    });
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
        scrollRecallCaretIntoView();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      const ta = e.currentTarget as HTMLTextAreaElement;
      const after = ta.value.slice(ta.selectionEnd);
      if (!after.includes("\n")) {
        e.preventDefault();
        recallNext(key());
        scrollRecallCaretIntoView();
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
          // #241 — expose the in-flight state to assistive tech: the spinner
          // itself is decorative (aria-hidden), so aria-busy is the a11y twin
          // of the visual swap. Screen readers announce the busy state instead
          // of only the disabled state.
          aria-busy={sending()}
          disabled={sending() || getDraft(key()).trim() === ""}
          // #59: keep the textarea focused when sending via the button.
          // Tapping a <button> moves focus off the textarea, which collapses
          // the native on-screen keyboard (Android especially). preventDefault
          // on pointerdown stops the focus steal — the click still fires +
          // submits. Same trick as the image-picker button.
          onPointerDown={(e) => e.preventDefault()}
        >
          {/* #241 — in-flight feedback. While a send is in flight
              (`sending()` true — POST-scoped: cleared on the send's 201
              ack, the server persisting+broadcasting atomically) the
              paper-plane arrow is swapped for a CSS spinner; it reverts
              to the arrow on resolution. Non-optimistic: the spinner
              reflects the REAL in-flight window, it does NOT fake a sent
              row (cic never originates state). The spinner is a decorative
              (`aria-hidden`) ring like the arrow it replaces — the
              button's `aria-label` carries the a11y name in both states. */}
          <Show
            when={sending()}
            fallback={
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
            }
          >
            <span
              class="compose-send-spinner"
              data-testid="compose-send-spinner"
              aria-hidden="true"
            />
          </Show>
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
