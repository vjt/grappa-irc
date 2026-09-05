import { createSignal } from "solid-js";

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
// thumbnail is indistinguishable from the right one by name alone. The store
// stays domain-agnostic the same way `alternative` does — it carries a
// pre-formatted row (label, detail, an optional blob to render) and a removal
// closure, and knows nothing about uploads, MIME categories or byte
// formatting. The MODAL owns the object-URL lifecycle for the blob, because
// the row's own mount/unmount is the only thing that knows when the URL stops
// being needed.

// The third door. `null` on a request means a plain two-button yes/no dialog.
export type ConfirmAlternative = {
  // Label of the alternative button (e.g. "Upload as .txt").
  label: string;
  // Fired ONLY when the operator picks this door — never on confirm/dismiss.
  onSelect: () => void;
};

// One row of the attachment list. Everything domain-shaped (the filename, the
// byte spelling, whether this thing can be shown as a picture) is decided by
// the CALLER and arrives here already resolved.
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
  // Non-null → render it as a thumbnail. A Blob rather than a URL string so
  // the modal can own `createObjectURL`/`revokeObjectURL` around the row's
  // lifetime; a caller-minted URL would have to be revoked from a dismiss path
  // this store deliberately does not expose.
  thumbnail: Blob | null;
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
