import { type Component, For } from "solid-js";
import { dismissToast, presenceToasts } from "./lib/notifyWatch";
import NickText from "./NickText";

// #247 — non-intrusive toasts for GENUINE /notify presence transitions
// (`presence_changed` with `initial: false`; the post-arm baseline
// never toasts — see notifyWatch.ts). Self-expiring, click-to-dismiss,
// stacked in a corner overlay; the durable signal stays the Watched
// panel dot. `role="status"` (polite) — presence chatter must not
// interrupt screen readers mid-flow the way error banners do.

const PresenceToasts: Component = () => {
  return (
    <div class="presence-toasts" aria-live="polite">
      <For each={presenceToasts()}>
        {(toast) => (
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
        )}
      </For>
    </div>
  );
};

export default PresenceToasts;
