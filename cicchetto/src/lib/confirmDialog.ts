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

// The third door. `null` on a request means a plain two-button yes/no dialog.
export type ConfirmAlternative = {
  // Label of the alternative button (e.g. "Upload as .txt").
  label: string;
  // Fired ONLY when the operator picks this door — never on confirm/dismiss.
  onSelect: () => void;
};

export type ConfirmRequest = {
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
};

const [confirmRequest, setConfirmRequest] = createSignal<ConfirmRequest | null>(null);

export { confirmRequest };

export function requestConfirm(req: ConfirmRequest): void {
  setConfirmRequest(req);
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
