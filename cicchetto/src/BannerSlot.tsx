import { type Component, Show } from "solid-js";
import type { BannerEntry, BannerSeverity } from "./lib/errorBanners";

// #119 — one slot in the unified stacked error region. Pure presentational:
// takes a single typed `BannerEntry` and renders it. The owner (ErrorBanners)
// maps the derived+sanitized active entries onto these; keeping the slot a
// pure component of its input makes the message / severity-role / actionHint
// rendering testable by injection, independent of which source produced it.
//
// #207 — the slot also renders a × dismiss affordance when the owner passes an
// `onDismiss` handler (production always does). The slot stays pure: it doesn't
// know WHICH source it is or what dismissing means — it just invokes the
// callback. The owner (ErrorBanners) owns the client-local dismiss state.

// Severity → ARIA live-region politeness: errors interrupt (assertive), the
// informational bundle-refresh prompt announces politely.
const severityRole = (severity: BannerSeverity): "alert" | "status" =>
  severity === "info" ? "status" : "alert";

const BannerSlot: Component<{ entry: BannerEntry; onDismiss?: () => void }> = (props) => {
  return (
    <div
      class={`error-banner error-banner-${props.entry.severity}`}
      data-source={props.entry.source}
      data-severity={props.entry.severity}
      role={severityRole(props.entry.severity)}
    >
      <span class="error-banner-message">{props.entry.message}</span>
      <Show when={props.entry.actionHint}>
        {(action) => (
          <button type="button" class="error-banner-action" onClick={() => action().onAction()}>
            {action().label}
          </button>
        )}
      </Show>
      <Show when={props.onDismiss}>
        {(onDismiss) => (
          <button
            type="button"
            class="error-banner-dismiss"
            aria-label="Dismiss notification"
            onClick={() => onDismiss()()}
          >
            {"×"}
          </button>
        )}
      </Show>
    </div>
  );
};

export default BannerSlot;
