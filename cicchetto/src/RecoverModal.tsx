import { type Component, For, Match, Show, Switch } from "solid-js";
import type { RecoverStatus, RecoverStep } from "./lib/api";
import { createOverlayLock } from "./lib/overlayScrollLock";
import { dismissRecover, recoverState } from "./lib/recoverProgress";

// #581 — "recover my identity" progress modal. Server-driven: opens off the
// first `recover_progress` user-topic event (recoverProgress.ts store), lists
// each recovery step with a running / ok / failed indicator, and shows the
// terminal success or failure state. cic NEVER originates recovery state — it
// mirrors the server's step + result events; there is no client-side progress
// guess, no optimistic success.
//
// NO retry button: a failure is TERMINAL (the reason is shown and the flow
// stops — the user re-issues /recover to try again). Success shows a clear
// success line; the user dismisses (× / backdrop / Esc). Mirrors the proven
// RegistrationWizardModal / ServiceModal shell (backdrop scrim + role=dialog +
// createOverlayLock).
//
// data-testid="recover-modal" + per-step data-step / data-status attributes so
// an e2e can assert the visible outcome (each step's state + the final result).
//
// Mounted once per Shell branch (mobile + desktop); only one branch is live,
// so a single instance exists.

// Per-step human copy. cic owns the localized strings
// (`feedback_no_localized_strings_server_side`); the server ships the closed
// `step` atom only.
const STEP_LABEL: Record<RecoverStep, string> = {
  identify: "Identifying to services",
  // review-#4: on the recover (re-identify) path the server emits `register`
  // as the FINAL "+r confirmed" step (recover_progress_steps/:succeeded), NOT
  // a fresh registration — so "Identity confirmed", not "Registering your nick".
  register: "Identity confirmed",
  nick: "Reclaiming your nick",
  recover: "Recovering your nick",
  release: "Releasing the held nick",
};

// Status indicator glyph. Running = a spinner-ish ellipsis; ok/failed are the
// terminal per-step marks. Also exposed as data-status for e2e assertion.
const STATUS_GLYPH: Record<RecoverStatus, string> = {
  running: "…",
  ok: "✓",
  failed: "✗",
};

// Map the known terminal failure reason tokens to friendly copy; anything else
// (a future server reason token, additive-only) falls back to generic copy —
// the friendlyChannelError posture (known → copy, unknown → fallback), never a
// dropped/blank failure.
//
// #623 — `identify_unconfirmed` (leg b: nick reclaimed, sameNick IDENTIFY sent,
// but +r never confirmed) has NO bespoke case yet and intentionally hits the
// generic fallback ("Recovery couldn't be completed. Try again.") — apt, since a
// retry often succeeds. Bespoke copy is a product decision, not shipped here.
function reasonCopy(reason: string | null): string {
  switch (reason) {
    case "wrong_password":
      return "The password didn't match — recovery was refused.";
    case "nick_unavailable":
      return "Your nick isn't available to recover right now.";
    case "services_declined":
      return "The network's services declined the recovery.";
    default:
      return "Recovery couldn't be completed. Try again.";
  }
}

const RecoverModal: Component = () => {
  const state = () => recoverState();
  const close = (): void => dismissRecover();

  // Refcounted overlay scroll-lock + shared Esc-to-close (topmost-first), same
  // wiring as ServiceModal / RegistrationWizardModal. onEscape MUST equal the
  // ×/backdrop close verb. A new pane-covering modal MUST push the overlay
  // refcount or the iOS scroll-freeze mis-counts.
  createOverlayLock(() => state() !== null, ".recover-modal-body", close);

  return (
    <Show when={state()}>
      {(st) => (
        // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close-on-outside; Esc via the shared overlay stack (keybindings → runTopmostOverlayEscape)
        // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is non-interactive scrim
        <div class="recover-modal-backdrop" onClick={close}>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: inner dialog onClick only stops backdrop-click propagation; Esc closes via the shared overlay stack */}
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="recover-modal-title"
            class="recover-modal"
            data-testid="recover-modal"
            data-network={st().networkSlug}
            data-outcome={st().outcome ?? "running"}
            onClick={(e) => e.stopPropagation()}
            tabIndex={-1}
          >
            <header class="recover-modal-header">
              <h2 id="recover-modal-title">
                <span class="recover-modal-sigil" aria-hidden="true">
                  🔑
                </span>
                Recover your identity
              </h2>
              <button type="button" class="recover-modal-close" aria-label="close" onClick={close}>
                ×
              </button>
            </header>

            <div class="recover-modal-body">
              <p class="recover-modal-copy muted">
                Recovering your registered identity on <b>{st().networkSlug}</b>.
              </p>

              <ul class="recover-modal-steps">
                <For each={st().steps}>
                  {(s) => (
                    <li
                      class="recover-modal-step"
                      classList={{
                        "is-running": s.status === "running",
                        "is-ok": s.status === "ok",
                        "is-failed": s.status === "failed",
                      }}
                      data-testid="recover-modal-step"
                      data-step={s.step}
                      data-status={s.status}
                    >
                      <span class="recover-modal-step-glyph" aria-hidden="true">
                        {STATUS_GLYPH[s.status]}
                      </span>
                      <span class="recover-modal-step-label">{STEP_LABEL[s.step]}</span>
                    </li>
                  )}
                </For>
              </ul>

              <Switch>
                <Match when={st().outcome === "succeeded"}>
                  <p
                    class="recover-modal-success"
                    data-testid="recover-modal-success"
                    role="status"
                  >
                    🎉 Your identity is recovered on {st().networkSlug}!
                  </p>
                </Match>
                <Match when={st().outcome === "failed"}>
                  <p class="recover-modal-failure" data-testid="recover-modal-failure" role="alert">
                    {reasonCopy(st().reason)}
                  </p>
                </Match>
              </Switch>
            </div>

            <footer class="recover-modal-footer">
              <button
                type="button"
                class="recover-modal-dismiss"
                data-testid="recover-modal-dismiss"
                onClick={close}
              >
                {st().outcome === null ? "Close" : "Done"}
              </button>
            </footer>
          </div>
        </div>
      )}
    </Show>
  );
};

export default RecoverModal;
