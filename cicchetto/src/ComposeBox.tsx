import { type Component, createSignal, Show } from "solid-js";
import { channelKey } from "./lib/channelKey";
import { getDraft, recallNext, recallPrev, setDraft, submit } from "./lib/compose";
import { networkBySlug } from "./lib/networks";
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

  // ---- Image upload trigger surfaces -------------------------------

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
    if (!file.type.startsWith("image/")) return;
    handleFile(file);
  };

  const onPaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file?.type.startsWith("image/")) {
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
        {/* Image category only until Task 7 widens the picker to
            video + document alongside the orchestrator pipeline (Task 5). */}
        <input
          ref={pickerInput}
          type="file"
          accept={activeHost().acceptedMimeTypes.image.join(",")}
          data-image-picker
          hidden
          onChange={onPickerChange}
        />
        <button
          type="button"
          class="compose-box-image-picker"
          aria-label="upload image"
          onClick={onPickerClick}
          title="upload image"
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
          value={getDraft(key())}
          onInput={onInput}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={`message ${props.channelName}`}
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
          disabled={sending() || getDraft(key()).trim() === ""}
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
              <div class="compose-box-upload-progress" role="progressbar">
                <span class="compose-box-upload-filename">{st().filename}</span>
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
