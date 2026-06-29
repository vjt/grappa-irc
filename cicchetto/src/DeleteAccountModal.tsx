import { useNavigate } from "@solidjs/router";
import { type Component, createEffect, createSignal, onCleanup, Show } from "solid-js";
import { deleteAccount } from "./lib/lifecycle";
import { popOverlay, pushOverlay } from "./lib/overlayScrollLock";

// #157 — irreversibility gate for self-service account deletion. The
// destructive button stays DISABLED until the operator types their exact
// account name / nick (`confirmationText`): "the user cannot do this by
// accident" — a deliberate, character-perfect echo of the identity being
// destroyed (no trim / casefold). On confirm, `deleteAccount()` wipes the
// account server-side + clears the local bearer, then we navigate to
// /login. A failed wipe surfaces inline and does NOT clear the token (the
// account still exists). DISTINCT from the two-tap quit button — an
// irreversible nuke needs a stronger gate than quit's arm/confirm.

export type Props = {
  open: boolean;
  onClose: () => void;
  // The exact string the operator must type to arm deletion — their
  // account name (user) or nick (visitor), from `displayNick(me)`.
  confirmationText: string;
};

const DeleteAccountModal: Component<Props> = (props) => {
  const navigate = useNavigate();
  const [typed, setTyped] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  // Reset the typed gate + error on every close so a reopen starts
  // disarmed (the modal stays in the tree; a stale match would otherwise
  // survive close → reopen).
  let wasOpen = false;
  createEffect(() => {
    if (props.open && !wasOpen) {
      wasOpen = true;
    } else if (!props.open && wasOpen) {
      wasOpen = false;
      setTyped("");
      setError(null);
      setBusy(false);
    }
  });

  // Overlay scroll-lock — same edge-triggered shape as ShareSessionModal.
  let modalEl: HTMLDivElement | undefined;
  let scrollLocked = false;
  createEffect(() => {
    if (props.open && !scrollLocked) {
      scrollLocked = true;
      pushOverlay(modalEl ?? null);
    } else if (!props.open && scrollLocked) {
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

  // Armed only on an EXACT match. An empty confirmationText never arms
  // (guards the loading null-me case where the drawer shouldn't have
  // offered the affordance anyway).
  const armed = (): boolean => props.confirmationText !== "" && typed() === props.confirmationText;

  const onConfirm = async () => {
    if (!armed() || busy()) return;
    setBusy(true);
    setError(null);
    try {
      await deleteAccount();
      navigate("/login", { replace: true });
    } catch (err) {
      const code = err instanceof Error ? err.message : "delete_failed";
      setError(code);
      setBusy(false);
    }
  };

  return (
    <Show when={props.open}>
      {/* Modal nested INSIDE the backdrop (flex-centered child), so a click
          on the modal lands on the modal — not the fixed backdrop painting
          above it. Backdrop click closes; modal click stops propagation;
          Esc closes. Mirrors ArchiveModal's structure (the sibling layout
          intercepts the confirm button via the backdrop's pointer events). */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close-on-outside; Esc handled by dialog onKeyDown */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop is a non-interactive scrim */}
      <div
        class="delete-account-backdrop"
        onClick={props.onClose}
        data-testid="delete-account-backdrop"
      >
        <div
          ref={modalEl}
          class="delete-account-modal"
          role="dialog"
          aria-modal="true"
          aria-label="delete account"
          data-testid="delete-account-modal"
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Escape") props.onClose();
          }}
        >
          <header class="delete-account-header">
            <h2>delete account</h2>
            <button
              type="button"
              class="delete-account-close"
              aria-label="close delete account"
              data-testid="delete-account-close"
              onClick={props.onClose}
            >
              ×
            </button>
          </header>

          <p class="delete-account-warning" role="alert">
            this permanently deletes your account and ALL associated data — scrollback, settings,
            sessions. it cannot be undone.
          </p>

          <label class="delete-account-confirm-label">
            type <strong>{props.confirmationText}</strong> to confirm:
            <input
              type="text"
              class="delete-account-confirm-input"
              data-testid="delete-account-confirm-input"
              autocomplete="off"
              value={typed()}
              onInput={(e) => setTyped((e.currentTarget as HTMLInputElement).value)}
            />
          </label>

          <Show when={error() !== null}>
            <p class="delete-account-error" role="alert" data-testid="delete-account-error">
              {error()}
            </p>
          </Show>

          <button
            type="button"
            class="delete-account-confirm"
            data-testid="delete-account-confirm"
            disabled={!armed() || busy()}
            onClick={() => {
              void onConfirm();
            }}
          >
            delete my account forever
          </button>
        </div>
      </div>
    </Show>
  );
};

export default DeleteAccountModal;
