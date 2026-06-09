import { type Component, createEffect, createSignal, onCleanup, Show } from "solid-js";
import { popOverlay, pushOverlay } from "./lib/overlayScrollLock";
import { acknowledgePrivacy, dismissUpload, privacyModalState } from "./lib/uploadOrchestrator";

// First-upload privacy modal — images cluster I-2 (2026-05-15).
//
// Mounted at Shell root so it overlays the entire UI when open.
// Driven entirely by `privacyModalState()` from the orchestrator;
// component is stateless w.r.t. open/closed — it just renders.
//
// Per A6 + feedback_no_localized_strings_server_side: copy is cic-
// owned, parameterized on `host.displayName` + `host.retentionStatement`
// so swapping providers tomorrow doesn't require copy edits.

const PrivacyModal: Component = () => {
  const [remember, setRemember] = createSignal(false);

  // UX-6 bucket A — refcounted overlay scroll-lock.
  // `privacyModalState().open` is the open signal; edge-triggered
  // push/pop via wasOpen closure. v4: scroll-lock targets the
  // .image-upload-modal element (rendered inside `<Show keyed>`),
  // looked up via queueMicrotask after Solid commits the render.
  let wasOpen = false;
  let lockedEl: HTMLElement | null = null;
  createEffect(() => {
    const open = privacyModalState().open;
    if (open && !wasOpen) {
      wasOpen = true;
      queueMicrotask(() => {
        lockedEl = document.querySelector<HTMLElement>(".image-upload-modal");
        pushOverlay(lockedEl);
      });
    } else if (!open && wasOpen) {
      wasOpen = false;
      popOverlay(lockedEl);
      lockedEl = null;
    }
  });
  onCleanup(() => {
    if (wasOpen) {
      wasOpen = false;
      popOverlay(lockedEl);
      lockedEl = null;
    }
  });

  const onContinue = () => {
    acknowledgePrivacy(remember());
    setRemember(false);
  };

  const onCancel = () => {
    const state = privacyModalState();
    if (state.open) dismissUpload(state.key);
    setRemember(false);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") onCancel();
  };

  // Narrow the discriminated union for <Show>'s typed-children form.
  // Returning the open state (or null) lets Show's keyed accessor pass
  // a non-null narrowed value to the render fn.
  const openState = (): { displayName: string; retentionStatement: string } | null => {
    const s = privacyModalState();
    return s.open
      ? { displayName: s.host.displayName, retentionStatement: s.host.retentionStatement }
      : null;
  };

  return (
    <Show when={openState()} keyed>
      {(host) => (
        // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close-on-outside; Esc handled by dialog onKeyDown
        // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is non-interactive scrim, click is convenience-only
        <div class="image-upload-modal-backdrop" onClick={onCancel}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="image-upload-modal-title"
            class="image-upload-modal"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={onKeyDown}
            tabIndex={-1}
          >
            <h2 id="image-upload-modal-title">Upload to {host.displayName}</h2>
            <p>
              Files you upload here go to <strong>{host.displayName}</strong> —{" "}
              {host.retentionStatement} Don't upload anything you wouldn't want a stranger to see.
            </p>
            <label class="image-upload-modal-remember">
              <input
                type="checkbox"
                checked={remember()}
                onChange={(e) => setRemember(e.currentTarget.checked)}
              />
              Don't show this again
            </label>
            <div class="image-upload-modal-buttons">
              <button type="button" onClick={onCancel}>
                Cancel
              </button>
              <button type="button" class="primary" onClick={onContinue}>
                Continue
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};

export default PrivacyModal;
