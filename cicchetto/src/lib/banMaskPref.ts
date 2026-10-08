import { createSignal } from "solid-js";
import type { BanMaskForm } from "./banMask";
import { getBanMaskForm, putBanMaskForm } from "./userSettings";

// issue 2347 — the subject's default ban type, mirrored from the server the
// way `uploadOrchestrator` mirrors the upload confirm: loaded once at app
// start so the very first `/kb` honours it, written through on a change so
// the next one does too. `/kb` and the Kickban menu entry read it at the
// moment they send; the explicit Ban nick / Ban host rows never do.
//
// Default "host" matches the server's own default AND what `/kb` sent before
// the setting existed, so a failed or not-yet-finished load — or a pre-38
// server that 404s the route — behaves exactly like a subject who never
// chose.
const [banMaskForm, setBanMaskFormSignal] = createSignal<BanMaskForm>("host");

export function banMaskFormValue(): BanMaskForm {
  return banMaskForm();
}

/** Load the server-persisted ban type into the cache. Errors are swallowed:
 *  the cache stays at "host", the server default too. */
export async function loadBanMaskForm(token: string): Promise<void> {
  try {
    setBanMaskFormSignal(await getBanMaskForm(token));
  } catch {
    /* swallowed — stays at the server's own default ("host") */
  }
}

/** Persist a new ban type and mirror the server's answer into the cache.
 *  Throws ApiError on 4xx/5xx; the cache keeps its old value then. */
export async function saveBanMaskForm(token: string, form: BanMaskForm): Promise<void> {
  setBanMaskFormSignal(await putBanMaskForm(token, form));
}

/** Test seam — mirrors `resetUploadConfirmEnabledForTests`. */
export function resetBanMaskFormForTests(): void {
  setBanMaskFormSignal("host");
}
