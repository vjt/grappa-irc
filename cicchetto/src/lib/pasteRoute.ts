import { channelKey } from "./channelKey";
import { getDraft, isDraining, setDraft } from "./compose";
import { requestConfirm } from "./confirmDialog";
import { dropUpload } from "./dropUpload";
import { pastedMessageCount, shouldGuardPaste } from "./pasteFlood";
import { categoryOf } from "./uploadCategory";

// Shared clipboard-paste routing — the file/text branching lifted out of
// ComposeBox.onPaste so the textarea's own paste AND the boot-time global
// paste listener (#352, lib/globalPaste.ts) run ONE code path instead of two
// copies that drift. Every paste — focused on the textarea or intercepted at
// the document while focus sits elsewhere — resolves to the same three
// outcomes: file → upload, big text → flood-confirm, small text → insert.
//
// The dependencies are all module-level (compose store, dropUpload,
// confirmDialog, pasteFlood), so this is a pure function of (event, textarea,
// target) — nothing ComposeBox-instance-bound. The textarea is passed in
// explicitly (NOT read off `e.currentTarget`) precisely so the global path can
// hand in the mounted compose textarea for a paste event that fired on
// `document`.

// #80 — insert a confirmed paste at the caret, replacing any selection,
// exactly as a native paste would. The confirm dialog only GATES the paste, so
// on confirm we perform the insertion the browser skipped (we preventDefault'd
// it); the global path (#352) ALSO uses this for a below-threshold paste,
// because a paste that fired while the textarea was unfocused never triggers a
// native insert. Then place the caret after the inserted text and refocus:
// both the modal's affirmative button and a document-level paste leave focus
// off the textarea, and the operator wants to keep typing / hit Enter.
// queueMicrotask mirrors the recall-caret precedent — run AFTER the controlled
// value re-render commits to the DOM.
export function insertPastedText(
  ta: HTMLTextAreaElement,
  networkSlug: string,
  channelName: string,
  text: string,
): void {
  const key = channelKey(networkSlug, channelName);
  const before = getDraft(key);
  const start = ta.selectionStart ?? before.length;
  const end = ta.selectionEnd ?? before.length;
  const next = before.slice(0, start) + text + before.slice(end);
  setDraft(key, next);
  const caret = start + text.length;
  queueMicrotask(() => {
    ta.focus();
    ta.setSelectionRange(caret, caret);
  });
}

// Route a clipboard `paste` event to the upload path or the text path for the
// (networkSlug, channelName) window whose compose textarea is `ta`.
//
// `nativeInsertAvailable` splits the two callers:
//   * true  — the textarea's own onPaste (focus is ON it): a below-threshold
//             plain-text paste is LEFT to the browser's native insert, so
//             1–3-line pastes stay frictionless.
//   * false — the #352 global listener (paste fired with focus elsewhere): the
//             browser performs NO native insert into the unfocused textarea, so
//             below-threshold text is inserted explicitly here. Empty/unreadable
//             text (iOS clipboard denial) is a no-op — the caller has already
//             focused the compose bar for the graceful degrade.
export function routeClipboardPaste(
  e: ClipboardEvent,
  ta: HTMLTextAreaElement,
  networkSlug: string,
  channelName: string,
  nativeInsertAvailable: boolean,
): void {
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
    dropUpload(files, networkSlug, channelName);
    return;
  }
  // #737 — a paced drain owns this window's draft, so the text path has
  // nowhere to put a paste: the store refuses the write. Drop it HERE rather
  // than letting the flood modal ask "Paste 30 lines?" and then discard the
  // answer. preventDefault covers the global-listener path, whose target
  // textarea may not be the focused element and so is not protected by its own
  // readOnly. The file branch above is untouched — an upload never touches the
  // draft.
  if (isDraining(channelKey(networkSlug, channelName))) {
    e.preventDefault();
    return;
  }
  // #80/#816 — plain-text multi-line paste guard. A pasted block is sent as
  // one PRIVMSG per line on submit (compose.ts → messageLines.ts), so any
  // paste that becomes more than one message is a burst the operator did not
  // compose by hand. Intercept the native paste and confirm BEFORE the text
  // lands; a one-message paste falls through to the native textarea insert
  // and stays frictionless. Reuses the store-driven confirm dialog
  // (lib/confirmDialog) — Cancel is the safe default (drop the paste), the
  // affirmative button pastes.
  const text = data.getData("text");
  if (shouldGuardPaste(text)) {
    e.preventDefault();
    // #816 — quote MESSAGES, not lines. The operator is authorising a number
    // of wire frames, and that is the number the send path will produce; a
    // line count would over-state it for any block containing a blank line.
    // Always ≥ 2 here (that is what tripped the guard), so the plural is
    // unconditional and needs no branch.
    const messages = pastedMessageCount(text);
    requestConfirm({
      title: `Paste as ${messages} messages?`,
      // Target-neutral copy: `channelName` is a nick on a query (DM) window,
      // so "flood the channel" would misdescribe a DM. "it" carries both.
      body: `This paste will be sent to ${channelName} as ${messages} separate messages. Sending can flood it with a burst.`,
      confirmLabel: "Paste",
      onConfirm: () => insertPastedText(ta, networkSlug, channelName, text),
    });
    return;
  }
  // Below the flood threshold.
  if (nativeInsertAvailable) return; // focused textarea → the browser inserts it
  if (text === "") return; // global path with no readable text → focus-only (iOS)
  e.preventDefault();
  insertPastedText(ta, networkSlug, channelName, text);
}
