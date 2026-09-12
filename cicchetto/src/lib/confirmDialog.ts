import { createSignal } from "solid-js";
import type { MediaKind } from "./mediaLink";

// #195 — generic confirm-dialog primitive. Replaces the #172 hold-to-close
// gesture (removed) for destructive window actions: leaving a channel and
// disconnecting a network. An explicit modal makes the action DELIBERATE and
// gives immediate visual feedback — the silent 500ms hold-gate gave none, so
// on touch it read as a broken × (a tap did nothing, a drift past 10px
// cancelled the hold; see the #195 Android field reports).
//
// Domain-agnostic on purpose: the confirm ACTION is a closure carried on the
// request, so the store knows nothing about windowClose verbs. Callers build
// a request with `requestConfirm` (see windowClose.ts's `confirmLeaveChannel`
// / `confirmDisconnectNetwork`), the singleton <ConfirmModal> renders it, and
// `acceptConfirm` / `dismissConfirm` resolve it. One request at a time — a
// modal is a focus trap, you cannot stack two — so a new request replaces any
// pending one (last-write-wins, same shape as the other cic modal stores).
//
// Cancel is the safe default: NO destructive default button. Backdrop click,
// Esc, and the Cancel button all dismiss WITHOUT firing the action.
//
// #816 added an OPTIONAL third door: an alternative way to get what the
// operator wanted, offered ALONGSIDE Cancel and the affirmative instead of
// replacing either. The paste guard is its first caller — "send this block as
// a .txt upload" is not a yes and not a no, it is a different route to the
// same intent — and the store stays domain-agnostic by carrying a second
// closure rather than learning about uploads.
//
// 1883 added an OPTIONAL attachment list, for the same reason and on the same
// terms: a question about FILES cannot be asked in a sentence. "Send this?" is
// answerable only if the operator can see WHICH file, and a mis-tapped gallery
// thumbnail is indistinguishable from the right one by name alone. #1964
// widened that row from an image-only thumbnail to a preview of whatever the
// file actually is, and gave the request a `defaultButton` — see both fields
// below for why each was necessary. The store stays domain-agnostic the same
// way `alternative` does — it carries a pre-formatted row (label, detail, an
// optional blob and the kind to render it as) and a removal closure, and knows
// nothing about uploads, MIME types or byte formatting. It does now name
// `MediaKind`, a type-only import: that is the RENDERING vocabulary the media
// viewer already speaks, not a domain fact about uploads, and the alternative
// was a second four-member union meaning the same four things. The MODAL owns the object-URL lifecycle for the blob, because
// the row's own mount/unmount is the only thing that knows when the URL stops
// being needed.

// The third door. `null` on a request means a plain two-button yes/no dialog.
export type ConfirmAlternative = {
  // Label of the alternative button (e.g. "Upload as .txt").
  label: string;
  // Fired ONLY when the operator picks this door — never on confirm/dismiss.
  onSelect: () => void;
};

// #1964 — what to render for a row, and as what.
//
// The KIND is the media viewer's own `MediaKind` and not a union private to
// this store: a staged local file poses the same question a clicked scrollback
// link does — what element can show this — so the confirm row answers it with
// the same four words and reuses the same element shapes (an `<img>`, a muted
// `<video>`, an `<audio controls>`, a `<pre>` of lines). The caller decides the
// kind (`attachmentPreview.previewKindOf`); the modal owns the object URL.
export type ConfirmPreview = {
  kind: MediaKind;
  // A Blob rather than a URL string so the modal can own
  // `createObjectURL`/`revokeObjectURL` around the row's lifetime; a
  // caller-minted URL would have to be revoked from a dismiss path this store
  // deliberately does not expose.
  blob: Blob;
};

// One row of the attachment list. Everything domain-shaped (the filename, the
// byte spelling, what this thing can be shown as) is decided by the CALLER and
// arrives here already resolved.
export type ConfirmAttachment = {
  // Stable identity for the row and its remove button. Filenames are NOT
  // unique — a gallery multi-select routinely yields two `IMG_0001.png`.
  id: string;
  // Primary line — the filename.
  label: string;
  // Secondary line — e.g. a formatted size. The caller formats it; carrying a
  // raw number here would put a spelling decision in a store that has no
  // business making one.
  detail: string;
  // Non-null → render it, per its kind. `null` means nothing renderable (a
  // PDF, a spreadsheet) and the row keeps its neutral placeholder — #1964
  // widened this from an image-only thumbnail, it did not invent a renderer
  // for every type.
  preview: ConfirmPreview | null;
};

// #2094 — one option of the request's optional single-choice control.
export type ConfirmChoiceOption = {
  // What `value()` compares against and `onSelect` receives. A string because
  // that is what a `<select>` deals in; a caller whose domain value is a
  // number spells it and reads it back at its own boundary, the same way the
  // attachment rows arrive pre-formatted.
  value: string;
  // What the operator reads (e.g. "24 hours").
  label: string;
};

// #2094 — an OPTIONAL single choice, asked alongside the question rather than
// after it. Same terms as `alternative` and `attachments`: the store carries a
// pre-formatted control and knows nothing about what is being chosen.
//
// Why the confirm and not a settings pane: a dialog that already shows WHICH
// files are going out is the one place the operator knows what this batch is
// worth, and a preference set once in a drawer cannot be told that. The
// upload TTL is its first caller (vjt's ruling on #2094, option 1); the store
// does not know that, and a second caller asking a different one-of-N
// question needs nothing here.
//
// Deliberately ONE choice and not a list of them: a confirm dialog asks one
// question, and a second control on it would be a form wearing a modal's
// chrome. A caller that needs two is a caller that needs a form.
export type ConfirmChoice = {
  // VISIBLE label, and the accessible name with it — the modal wraps the
  // control in a `<label>` so there is exactly one. Unlike the SettingsDrawer
  // ladder, which sits under a `<legend>` naming the group (#1227 removed the
  // second name there), a dropdown alone in a dialog says only "24 hours" and
  // nothing about what happens then.
  label: string;
  options: ReadonlyArray<ConfirmChoiceOption>;
  // Reactive, like `attachments.items`: the modal re-renders the selection
  // without the request being replaced (which would re-run the open
  // transition and steal focus back to the default button).
  value: () => string;
  // The caller owns the selection. The store does not hold it, so a request
  // that is displaced takes its half-made choice with it.
  onSelect: (value: string) => void;
};

export type ConfirmAttachments = {
  // Reactive on purpose: a removal must re-render the list WITHOUT replacing
  // the request (which would re-run the modal's open transition and steal
  // focus back to Cancel).
  items: () => ConfirmAttachment[];
  // Remove one row. What an empty set means is the caller's decision, not the
  // store's — the picker guard closes the dialog, a future caller might not.
  onRemove: (id: string) => void;
};

export type ConfirmRequest = {
  // #1883 — fired when THIS request is replaced by a later `requestConfirm`,
  // i.e. the question disappeared without the operator answering it. Optional
  // because almost every caller is driven by a gesture that is still on screen
  // and can simply be repeated; the OS share target cannot, because it arrives
  // at boot with nothing on screen to retry.
  onDisplaced?: () => void;
  // Short dialog heading (e.g. "Leave channel").
  title: string;
  // Full question, with the channel/network name interpolated by the caller
  // (e.g. "Do you want to leave #italia?").
  body: string;
  // Label of the affirmative button (e.g. "Yes").
  confirmLabel: string;
  // Fired ONLY on affirmative confirm — never on cancel/dismiss.
  onConfirm: () => void;
  // Explicit `null` rather than an optional field: every call site declares
  // whether its dialog has a third door, so a reader never has to check the
  // type to find out that a two-button modal was intended.
  alternative: ConfirmAlternative | null;
  // Same explicit-`null` contract as `alternative`, and for the same reason:
  // a text-only dialog says so in its own call site.
  attachments: ConfirmAttachments | null;
  // #2094 — same explicit-`null` contract again: a dialog that asks nothing
  // beyond yes/no says so where it is written, not by opening the modal.
  choice: ConfirmChoice | null;
  // #1964 — which button takes focus on open, i.e. what a bare Enter answers.
  // Explicit on every call site, like the two fields above: which key sends
  // and which key discards must be readable at the call site, not by opening
  // the modal.
  //
  // #195 made Cancel the universal default ("a stray Enter dismisses, never
  // leaves"), and that still holds for every dialog here whose affirmative
  // leaves a channel, drops a network, floods a room or deletes a theme. The
  // upload confirm is the one that reads the other way (Gabriele's ruling,
  // 2026-09-08): the operator has already picked, dropped or pasted the file,
  // the dialog is OPT-IN and was switched on to LOOK at what is going out, and
  // Enter — the key you press after reading — threw the staged files away.
  // Cancel is not the safe answer there; it is the one that loses the work.
  defaultButton: "cancel" | "confirm";
};

const [confirmRequest, setConfirmRequest] = createSignal<ConfirmRequest | null>(null);

export { confirmRequest };

// #1883 — replacing a pending request now TELLS it, instead of dropping it in
// silence. Last-write-wins is still the rule (a modal is a focus trap), but a
// caller whose question vanished with no operator input has no other way to
// learn that its files went nowhere. Only the displaced request is notified;
// the operator's own Cancel is a deliberate answer and goes down the ordinary
// dismiss path.
export function requestConfirm(req: ConfirmRequest): void {
  const displaced = confirmRequest();
  setConfirmRequest(req);
  displaced?.onDisplaced?.();
}

// Cancel / backdrop / Esc — dismiss without firing the carried action.
export function dismissConfirm(): void {
  setConfirmRequest(null);
}

// Affirmative confirm — fire the carried action, then clear. Clearing FIRST
// means the action may itself open another confirm without a stale request
// lingering behind it.
export function acceptConfirm(): void {
  const req = confirmRequest();
  if (req === null) return;
  setConfirmRequest(null);
  req.onConfirm();
}

// #816 — the alternative door. Same clear-then-fire order as acceptConfirm,
// and exclusive with it: picking this one never runs onConfirm. A request
// with no alternative resolves to NOTHING — the dialog stays open, because
// nothing was chosen.
export function chooseAlternative(): void {
  const alt = confirmRequest()?.alternative;
  if (alt === undefined || alt === null) return;
  setConfirmRequest(null);
  alt.onSelect();
}
