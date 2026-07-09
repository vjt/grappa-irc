import { type Component, createEffect, onCleanup, Show } from "solid-js";
import { acceptConfirm, confirmRequest, dismissConfirm } from "./lib/confirmDialog";
import { popOverlay, pushOverlay } from "./lib/overlayScrollLock";

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
  let modalEl: HTMLDivElement | undefined;
  let cancelBtn: HTMLButtonElement | undefined;

  // Overlay scroll-lock + autofocus Cancel, edge-triggered on open/close
  // (same shape as DeleteAccountModal). Focusing Cancel makes it the default
  // action for keyboard/Enter — a non-destructive default per #195.
  let scrollLocked = false;
  createEffect(() => {
    const open = confirmRequest() !== null;
    if (open && !scrollLocked) {
      scrollLocked = true;
      pushOverlay(modalEl ?? null);
      queueMicrotask(() => cancelBtn?.focus());
    } else if (!open && scrollLocked) {
      scrollLocked = false;
      popOverlay(modalEl ?? null);
    }
  });
  onCleanup(() => {
    if (scrollLocked) {
      scrollLocked = false;
      popOverlay(modalEl ?? null);
    }
  });

  return (
    <Show when={confirmRequest()}>
      {(req) => (
        // Modal nested INSIDE the backdrop (flex-centered child): a click on
        // the modal lands on the modal, a click on the scrim dismisses.
        // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close-on-outside; Esc handled by the dialog onKeyDown
        // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is a non-interactive scrim
        <div
          class="confirm-modal-backdrop"
          onClick={dismissConfirm}
          data-testid="confirm-modal-backdrop"
        >
          <div
            ref={modalEl}
            class="confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-label={req().title}
            data-testid="confirm-modal"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") dismissConfirm();
            }}
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
