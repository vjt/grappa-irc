import { channelKey } from "./channelKey";
import { getDraft, isDraining, setDraft } from "./compose";
import { placeCaretInView } from "./composeCaret";
import { requestConfirm } from "./confirmDialog";
import { dropUpload } from "./dropUpload";
import { classifyPaste, PASTE_HARD_MESSAGE_LIMIT, pastedMessageCount } from "./pasteFlood";
import { categoryOf } from "./uploadCategory";

// Shared clipboard-paste routing — the file/text branching lifted out of
// ComposeBox.onPaste so the textarea's own paste AND the boot-time global
// paste listener (#352, lib/globalPaste.ts) run ONE code path instead of two
// copies that drift. Every paste — focused on the textarea or intercepted at
// the document while focus sits elsewhere — resolves to the same three
// outcomes: file → upload, big text → flood-confirm, small text → insert.
//
// #1250 added a THIRD door for the same reason the second one exists: an
// IME-mediated paste (GBoard's clipboard chip) fires no `paste` event at all,
// so the guard did not exist on that path and the message cap was bypassable
// by choosing a different gesture. All three doors converge on
// `routeGuardedText` — a new entry point must reuse it rather than grow a
// fourth copy of the decision.
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
//
// #1113 — and REVEAL that caret. The draft may already wrap past the rows=1
// textarea, in which case the paste point can land outside the visible box in
// either direction, so the scroll has to follow the caret. `focus()` stays
// first: it is what restores the selection this then overwrites.
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
    placeCaretInView(ta, caret);
  });
}

// #816 — the second door. A pasted block becomes a `text/plain` File and
// rides the EXISTING upload path: the orchestrator posts the resulting URL as
// a 📄-prefixed PRIVMSG, one frame instead of N, and the recipient clicks
// through. No new category, no new server surface — `text/plain` is already
// an accepted `document` MIME (uploadCategory.ts, a 1:1 mirror of the
// server's @mime_categories), so this reuses the upload VERB rather than
// inventing a paste service. Same shape as the 📸 image path CLAUDE.md names
// as the model for "media is a link, and IRC stays text".
//
// vjt's ruling (2026-08-06) made it a CHOICE, not a punishment: it is offered
// on EVERY guarded paste (as the confirm dialog's alternative door), not only
// once the operator has already been refused by the hard cap. Above the cap
// it is the affirmative, because the paste door is gone — same verb, same
// label, so the two arms read as one action and not two.
export const PASTE_UPLOAD_FILENAME = "paste.txt";
export const PASTE_UPLOAD_LABEL = "Upload as .txt";

// #1256 — declare the encoding. `text` is a JS string and the File
// constructor encodes USVString parts as UTF-8 by specification, so this
// is a fact about the bytes, not a guess: these bytes are OURS. Without
// the label the server stores a bare `text/plain` and serves it
// unlabelled, and a Western-locale browser paints every accented
// character as mojibake. The server splits the parameter off the type
// before matching its allowlist (Grappa.Uploads.ContentType) and
// re-emits the charset on GET.
export function uploadPastedText(text: string, networkSlug: string, channelName: string): void {
  const file = new File([text], PASTE_UPLOAD_FILENAME, {
    type: "text/plain; charset=utf-8",
  });
  dropUpload([file], networkSlug, channelName);
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
  routeGuardedText(e, data.getData("text"), ta, networkSlug, channelName, nativeInsertAvailable);
}

// #1250 — the THIRD door: an IME-mediated paste. GBoard's clipboard chip (and
// any other input-method insertion) commits text through the input method and
// fires NO `paste` event at all — only `beforeinput` with an `insertFromPaste`
// inputType. The flood guard was therefore not "weak" on that path, it was
// absent: an operator could bypass PASTE_HARD_MESSAGE_LIMIT entirely by
// choosing the chip over the long-press Paste menu.
//
// Text source order mirrors what the engines actually populate: `dataTransfer`
// when the insertion carries one, `data` for the plain-string commit. Anything
// else is not a paste we can size, so it is left alone.
export function routePastedInput(
  e: InputEvent,
  ta: HTMLTextAreaElement,
  networkSlug: string,
  channelName: string,
): void {
  if (!PASTE_INPUT_TYPES.has(e.inputType)) return;
  const text = e.dataTransfer?.getData("text") ?? e.data ?? "";
  // nativeInsertAvailable = true: this IS the browser's own insertion about to
  // happen into the focused textarea, so the below-threshold arm lets it.
  routeGuardedText(e, text, ta, networkSlug, channelName, true);
}

// `insertFromPasteAsQuotation` is the same gesture with quoting applied by the
// UA; it becomes the same burst of PRIVMSGs, so it is sized by the same rule.
const PASTE_INPUT_TYPES = new Set(["insertFromPaste", "insertFromPasteAsQuotation"]);

// The ONE text decision, shared by all three doors (textarea `paste`, the #352
// document listener, and the #1250 IME `beforeinput`). Takes the event as a
// bare `Event` because all it needs from it is `preventDefault` — which is
// also what keeps a fourth door from having to be a ClipboardEvent.
//
// #1250, one gesture / at most one dialog — by CONSTRUCTION, with no
// cross-event bookkeeping. A native paste is reported twice, but the second
// report is the FIRST one's default action: the UA fires `paste`, and only if
// that is not cancelled does it perform the insertion, which is what fires
// `beforeinput[insertFromPaste]`. So both guarded arms below, which
// `preventDefault` the `paste`, structurally suppress the `beforeinput` that
// would have asked again. The pass-through arm does let both fire, and is
// idempotent by design: with `nativeInsertAvailable` it only ever decides "let
// the browser do it", so classifying twice costs one extra pure call and
// changes nothing.
//
// The rejected alternative was a module-level "this gesture is claimed" flag
// released on a macrotask. It would have covered a hypothetical engine that
// fires both reports for a CANCELLED paste — but it also makes two pastes in
// one task indistinguishable from one, which is a state no browser can produce
// and every existing paste test does. Three test files had to learn to yield
// between cases before this comment was written; a guard that quietly disarms
// itself for the next author is worse than the ordering assumption it removes.
// The ordering is verified on both shipped engines by
// `paste-ime-flood-guard.spec.ts` rather than assumed here.
function routeGuardedText(
  e: Event,
  text: string,
  ta: HTMLTextAreaElement,
  networkSlug: string,
  channelName: string,
  nativeInsertAvailable: boolean,
): void {
  // #737 — a paced drain owns this window's draft, so the text path has
  // nowhere to put a paste: the store refuses the write. Drop it HERE rather
  // than letting the flood modal ask "Paste 30 lines?" and then discard the
  // answer. preventDefault covers the global-listener path, whose target
  // textarea may not be the focused element and so is not protected by its own
  // readOnly. The file branch is untouched — an upload never touches the
  // draft.
  if (isDraining(channelKey(networkSlug, channelName))) {
    e.preventDefault();
    return;
  }
  // #80/#816 — plain-text multi-line paste guard. A pasted block is sent as
  // one PRIVMSG per line on submit (compose.ts → messageLines.ts), so any
  // paste that becomes more than one message is a burst the operator did not
  // compose by hand. `classifyPaste` owns the three-way decision; this switch
  // owns what each one looks like. Both dialogs reuse the store-driven
  // confirm (lib/confirmDialog) — Cancel is the safe default in both.
  // Always the real count in both guarded arms, and ≥ 2 by construction, so
  // the plural is unconditional and needs no branch.
  const messages = pastedMessageCount(text);
  switch (classifyPaste(text)) {
    case "confirm":
      e.preventDefault();
      requestConfirm({
        // #816 — quote MESSAGES, not lines. The operator is authorising wire
        // frames, and that is what the send path will produce; a line count
        // would over-state it for any block containing a blank line.
        title: `Paste as ${messages} messages?`,
        // Target-neutral copy: `channelName` is a nick on a query (DM)
        // window, so "flood the channel" would misdescribe a DM. "it" carries
        // both.
        body: `This paste will be sent to ${channelName} as ${messages} separate messages. Sending can flood it with a burst — or send it as one text file instead.`,
        confirmLabel: "Paste",
        onConfirm: () => insertPastedText(ta, networkSlug, channelName, text),
        // The third door, offered BEFORE any refusal: an operator who reads
        // "4 separate messages" and thinks better of it can post one link
        // instead, without having to hit the cap first to be told it exists.
        alternative: {
          label: PASTE_UPLOAD_LABEL,
          onSelect: () => uploadPastedText(text, networkSlug, channelName),
        },
      });
      return;
    case "over-limit":
      e.preventDefault();
      requestConfirm({
        title: `Too many messages to send`,
        // Both numbers: what they pasted and where the ceiling is. "Too many"
        // without the limit leaves the operator guessing what would fit.
        body: `This paste would be ${messages} separate messages to ${channelName} — more than the ${PASTE_HARD_MESSAGE_LIMIT} a burst may be. Upload it as a text file instead and post the link.`,
        confirmLabel: PASTE_UPLOAD_LABEL,
        onConfirm: () => uploadPastedText(text, networkSlug, channelName),
        // No third door here: the paste door is what the cap closed, so
        // uploading IS the affirmative and there is nothing else to offer.
        alternative: null,
      });
      return;
    case "insert":
      if (nativeInsertAvailable) return; // focused textarea → the browser inserts it
      if (text === "") return; // global path with no readable text → focus-only (iOS)
      e.preventDefault();
      insertPastedText(ta, networkSlug, channelName, text);
      return;
  }
}
