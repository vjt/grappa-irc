import { type Component, For, type JSX, onMount } from "solid-js";
import { bootBundleHashAccessor, bootBundleVersionAccessor } from "./lib/bundleHash";
import {
  announceAppliedBundleRefresh,
  bundleRefreshToasts,
  dismissBundleRefreshToast,
} from "./lib/bundleRefreshNotice";
import { dismissInviteToast, inviteToasts } from "./lib/inviteLink";
import { dismissPresenceToast, presenceToasts } from "./lib/notifyWatch";
import NickText from "./NickText";

// The client's ONE toast surface (#775, extracted from #247's PresenceToasts).
//
// Self-expiring, click-to-dismiss, stacked in a corner overlay. Deliberately
// quiet: the durable signal always lives elsewhere — the Watched panel dot for
// presence, the version in Settings for a bundle — and this is the glance.
//
// EVERY PRODUCER RENDERS INTO THIS ONE CONTAINER ELEMENT. Each owns its queue
// and its payload type (see lib/toasts.ts on why the queues stay separate: the
// presence one is wiped on an account switch and the update notice must not
// be), but a second `position: fixed` stack would land on top of this one, so a
// new producer is one more <For> here — never a variant bolted onto somebody
// else's union, and never a second overlay.
//
// `aria-live="polite"` on the container: toasts must not interrupt a screen
// reader mid-flow the way an error banner does. That is ALSO why the #775
// notice is consumed at MOUNT rather than at boot in `main.tsx`: a live region
// inserted with its content already inside it announces nothing — only
// mutations observed after the region is in the tree are spoken — so an
// announcement made before this component exists would be the one toast in the
// app a screen reader could never hear, and it is the one whose whole job is to
// explain an unexplained reset. Mount is also simply when the notice becomes
// observable at all, and it makes the wiring testable by rendering this
// component rather than by grepping the composition root.
//
// Plain branching (no <Show>/<Switch>) is safe: rows are immutable — a queue
// only appends and removes — so each <For> child renders once per row identity.

// The tone IS a stylesheet contract: each value needs a `.toast-<tone>` rule in
// themes/default.css, so a union makes adding one a compile error until the CSS
// exists (jsdom draws no layout, so no test would catch a missing rule). The
// icon stays a plain glyph — it needs no rule and no new tone to change.
type ToastTone = "online" | "offline" | "error" | "update";

const ToastRow: Component<{
  tone: ToastTone;
  icon: string;
  onDismiss: () => void;
  children: JSX.Element;
}> = (props) => (
  <button type="button" class={`toast toast-${props.tone}`} onClick={props.onDismiss}>
    <span class="toast-icon">{props.icon}</span>
    {props.children}
  </button>
);

const Toasts: Component = () => {
  onMount(() => {
    announceAppliedBundleRefresh(Date.now(), bootBundleHashAccessor(), bootBundleVersionAccessor());
  });

  return (
    <div class="toast-stack" aria-live="polite">
      {/* #247 — genuine /notify presence transitions (`presence_changed` with
          `initial: false`; the post-arm baseline never toasts), plus
          error-styled toasts for upstream watch-list rejections
          (`presence_error` — review 2026-07-19 R2: without a visible surface
          the rejection only existed in the cic_diag ring buffer). */}
      <For each={presenceToasts()}>
        {(toast) =>
          toast.kind === "error" ? (
            <ToastRow tone="error" icon="!" onDismiss={() => dismissPresenceToast(toast.id)}>
              <span class="toast-text">
                Watch list full — not watching:{" "}
                {toast.detail !== "" ? toast.detail : "(see server window)"}
              </span>
            </ToastRow>
          ) : (
            <ToastRow
              tone={toast.presence}
              icon={toast.presence === "online" ? "●" : "○"}
              onDismiss={() => dismissPresenceToast(toast.id)}
            >
              <NickText nick={toast.nick} extraClass="toast-nick" />
              <span class="toast-text">
                {toast.presence === "online" ? "is online" : "went offline"}
              </span>
            </ToastRow>
          )
        }
      </For>
      {/* #775 — an auto-refresh (#674) that actually landed, announced by the
          document that booted out of it. */}
      <For each={bundleRefreshToasts()}>
        {(toast) => (
          <ToastRow tone="update" icon="↻" onDismiss={() => dismissBundleRefreshToast(toast.id)}>
            <span class="toast-text">{toast.text}</span>
          </ToastRow>
        )}
      </For>
      {/* #793 — an invite link for a network this account has not bound.
          Whether that case should offer to add the network is an open product
          decision; until it is taken, the recipient at least learns why the
          link they clicked did nothing. */}
      <For each={inviteToasts()}>
        {(toast) => (
          <ToastRow tone="error" icon="!" onDismiss={() => dismissInviteToast(toast.id)}>
            <span class="toast-text">
              Invite for {toast.networkSlug} — you are not connected to that network.
            </span>
          </ToastRow>
        )}
      </For>
    </div>
  );
};

export default Toasts;
