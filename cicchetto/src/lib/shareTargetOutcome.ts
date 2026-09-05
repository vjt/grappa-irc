import { createSignal } from "solid-js";

// #1103 — what to tell the operator when a shared file goes nowhere.
//
// Its own module, next to `swRegistration.ts` in shape and for the same
// reason: `errorBanners.ts` derives its entries from signals owned elsewhere,
// so the signal has to live somewhere that does not drag the upload graph
// into the banner registry. The registry imports the two readers below and
// nothing else.
//
// This is a REPORT, not state: it is written once by the boot reader when a
// share cannot be delivered, and the operator's × ends it. Nothing derives
// from it and nothing else writes it.

/**
 * Why a share could not be delivered.
 *
 * `no-destination` — the last window the operator was in is gone (or there
 * never was one), so there is no IRC target to send to.
 * `nothing-uploadable` — the share carried no file the upload path accepts.
 * That covers an empty share too: from the operator's side "nothing came
 * through" is the same sentence either way.
 * `confirm-displaced` — #1883: the share opened a confirm at boot and another
 * confirm replaced it before the operator answered, so the files were dropped
 * with no input. Only reachable with the upload confirm opted IN; without this
 * the share vanished with no banner at all.
 */
export type ShareTargetBlock = "no-destination" | "nothing-uploadable" | "confirm-displaced";

const [blocked, setBlocked] = createSignal<ShareTargetBlock | null>(null);

export const shareTargetBlock = blocked;

export function recordShareTargetBlock(reason: ShareTargetBlock): void {
  setBlocked(reason);
}

export function clearShareTargetBlock(): void {
  setBlocked(null);
}

export function shouldShowShareTargetBanner(): boolean {
  return blocked() !== null;
}

export function shareTargetBannerMessage(): string {
  switch (blocked()) {
    case "no-destination":
      return "Shared file had nowhere to go — open a channel or a query, then share again.";
    case "nothing-uploadable":
      return "Nothing in that share could be uploaded.";
    case "confirm-displaced":
      return "Shared file was dropped when another dialog took over — share it again.";
    default:
      // Unreachable while the banner is gated on `shouldShowShareTargetBanner`.
      // Empty rather than a placeholder: a banner with filler text in it is
      // worse than one that renders nothing.
      return "";
  }
}
