import { type Component, createSignal, Show } from "solid-js";
import { createOverlayLock } from "./lib/overlayScrollLock";
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

  const onContinue = () => {
    acknowledgePrivacy(remember());
    setRemember(false);
  };

  const onCancel = () => {
    const state = privacyModalState();
    if (state.open) dismissUpload(state.key);
    setRemember(false);
  };

  // UX-6 bucket A — refcounted overlay scroll-lock.
  // `privacyModalState().open` is the open signal. Shared
  // createOverlayLock wiring — extracted 2026-06-11 when
  // MediaViewerModal would have been the third verbatim copy; see
  // overlayScrollLock.ts for the edge-trigger + deferred-push
  // semantics, including the same-task-close leak fix. #232 — the shared
  // Esc-to-close routes through the same lock (topmost-first, focus-independent).
  createOverlayLock(() => privacyModalState().open, ".image-upload-modal", onCancel);

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
        // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close-on-outside; Esc via the shared overlay stack (keybindings → runTopmostOverlayEscape)
        // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is non-interactive scrim, click is convenience-only
        <div class="image-upload-modal-backdrop" onClick={onCancel}>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: inner dialog onClick only stops backdrop-click propagation; Esc closes via the shared overlay stack */}
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="image-upload-modal-title"
            class="image-upload-modal"
            onClick={(e) => e.stopPropagation()}
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
