import { type Component, createEffect, Show } from "solid-js";
import { acceptConfirm, confirmRequest, dismissConfirm } from "./lib/confirmDialog";
import { createOverlayLock } from "./lib/overlayScrollLock";

// #195 — explicit confirm modal for destructive window actions (leave
// channel, disconnect network). Store-driven singleton (lib/confirmDialog);
// mounted once per Shell layout branch (mobile + desktop). Replaces the
// removed #172 hold-to-close gesture.
//
// Cancel is the SAFE default: it takes initial focus (so a stray Enter
// dismisses, never leaves), and backdrop-click + Esc both dismiss without
// firing. Only the explicit affirmative button runs the carried action.
// Structure mirrors DeleteAccountModal (backdrop-nested dialog + overlay
// scroll-lock), the closest existing confirm-shaped modal.

const ConfirmModal: Component = () => {
  let cancelBtn: HTMLButtonElement | undefined;

  // Overlay scroll-lock + #232 shared Esc-to-close. dismissConfirm is the
  // same SAFE close verb Cancel / backdrop use — Esc never fires the carried
  // action (topmost-first, focus-independent).
  createOverlayLock(() => confirmRequest() !== null, ".confirm-modal", dismissConfirm);

  // Autofocus Cancel on open — the non-destructive default per #195 (a stray
  // Enter dismisses, never confirms). Edge-triggered so a re-render with the
  // same open value doesn't re-steal focus.
  let wasOpen = false;
  createEffect(() => {
    const open = confirmRequest() !== null;
    if (open && !wasOpen) {
      wasOpen = true;
      queueMicrotask(() => cancelBtn?.focus());
    } else if (!open && wasOpen) {
      wasOpen = false;
    }
  });

  return (
    <Show when={confirmRequest()}>
      {(req) => (
        // Modal nested INSIDE the backdrop (flex-centered child): a click on
        // the modal lands on the modal, a click on the scrim dismisses.
        // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close-on-outside; Esc via the shared overlay stack (keybindings → runTopmostOverlayEscape)
        // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is a non-interactive scrim
        <div
          class="confirm-modal-backdrop"
          onClick={dismissConfirm}
          data-testid="confirm-modal-backdrop"
        >
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: inner dialog onClick only stops backdrop-click propagation; Esc closes via the shared overlay stack */}
          <div
            class="confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-label={req().title}
            data-testid="confirm-modal"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 class="confirm-modal-title">{req().title}</h2>
            <p class="confirm-modal-body" data-testid="confirm-modal-body">
              {req().body}
            </p>
            <div class="confirm-modal-actions">
              <button
                ref={cancelBtn}
                type="button"
                class="confirm-modal-cancel"
                data-testid="confirm-modal-cancel"
                onClick={dismissConfirm}
              >
                Cancel
              </button>
              <button
                type="button"
                class="confirm-modal-confirm"
                data-testid="confirm-modal-confirm"
                onClick={acceptConfirm}
              >
                {req().confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};

export default ConfirmModal;
