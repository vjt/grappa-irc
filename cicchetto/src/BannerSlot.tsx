import { type Component, Show } from "solid-js";
import type { BannerEntry, BannerSeverity } from "./lib/errorBanners";

// #119 — one slot in the unified stacked error region. Pure presentational:
// takes a single typed `BannerEntry` and renders it. The owner (ErrorBanners)
// maps the derived+sanitized active entries onto these; keeping the slot a
// pure component of its input makes the message / severity-role / actionHint
// rendering testable by injection, independent of which source produced it.

// Severity → ARIA live-region politeness: errors interrupt (assertive), the
// informational bundle-refresh prompt announces politely.
const severityRole = (severity: BannerSeverity): "alert" | "status" =>
  severity === "info" ? "status" : "alert";

const BannerSlot: Component<{ entry: BannerEntry }> = (props) => {
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
    </div>
  );
};

export default BannerSlot;
