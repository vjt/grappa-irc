import { type Component, Show } from "solid-js";
import { type BannerEntry, type BannerSeverity, entryId } from "./lib/errorBanners";

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
      // #902 — the per-ENTRY identity, not the source. For the five
      // single-instance sources it equals `data-source`; for `invite` it
      // names the (network, channel), which makes each stacked invite
      // individually addressable.
      //
      // This is also the suite's replacement observation of
      // `windowStateByChannel`. `issue30-channel-tab-completion` used the
      // greyed `:invited` pseudo-row for that — the only DOM projection of
      // that map — and #902 deletes the row. The invite banners are derived
      // straight off the same map (`windowState.invitedWindows`), so this
      // attribute restores the barrier and names the channel besides. A
      // sidebar row for a JOINED channel comes from `channelsBySlug` on a
      // different topic with no ordering guarantee, so it cannot serve.
      data-banner-id={entryId(props.entry)}
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
