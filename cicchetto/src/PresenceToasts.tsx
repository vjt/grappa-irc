import { type Component, For } from "solid-js";
import { dismissToast, presenceToasts } from "./lib/notifyWatch";
import NickText from "./NickText";

// #247 — non-intrusive toasts for GENUINE /notify presence transitions
// (`presence_changed` with `initial: false`; the post-arm baseline
// never toasts — see notifyWatch.ts), plus error-styled toasts for
// upstream watch-list rejections (`presence_error` — review 2026-07-19
// R2: without a visible surface the rejection only existed in the
// cic_diag ring buffer). Self-expiring, click-to-dismiss, stacked in a
// corner overlay; the durable signal stays the Watched panel dot.
// `role="status"` (polite) — presence chatter must not interrupt
// screen readers mid-flow the way error banners do.
//
// Plain branching (no <Show>/<Switch>) is safe here: toast rows are
// immutable — the store only appends and removes, never mutates — so
// the <For> child renders once per row identity.

const PresenceToasts: Component = () => {
  return (
    <div class="presence-toasts" aria-live="polite">
      <For each={presenceToasts()}>
        {(toast) =>
          toast.kind === "error" ? (
            <button
              type="button"
              class="presence-toast presence-toast-error"
              onClick={() => dismissToast(toast.id)}
            >
              <span class="presence-toast-dot">!</span>
              <span class="presence-toast-text">
                Watch list full — not watching:{" "}
                {toast.detail !== "" ? toast.detail : "(see server window)"}
              </span>
            </button>
          ) : (
            <button
              type="button"
              class={`presence-toast presence-toast-${toast.presence}`}
              onClick={() => dismissToast(toast.id)}
            >
              <span class="presence-toast-dot">{toast.presence === "online" ? "●" : "○"}</span>
              <NickText nick={toast.nick} extraClass="presence-toast-nick" />
              <span class="presence-toast-text">
                {toast.presence === "online" ? "is online" : "went offline"}
              </span>
            </button>
          )
        }
      </For>
    </div>
  );
};

export default PresenceToasts;
