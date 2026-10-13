import { type Component, Show } from "solid-js";
import { createOverlayEscape } from "./lib/overlayScrollLock";
import { dismissWhowasCard, whowasCardBySlug } from "./lib/whowasCard";
import { MircBody } from "./MircText";
import NickText from "./NickText";

// P-0c — WHOWAS card. Renders the historical-user reply inline at the
// top of the active window's scrollback pane (mirror of WhoisCard).
// Per spec #2:
//   * Ephemeral — bundle lives in `whowasCardBySlug` until replaced by
//     the next /whowas on the same network OR explicitly dismissed.
//   * Inline-in-active-window — operator typed /whowas from the window
//     they're looking at; the reply renders there.
//   * NOT a modal, NOT routed to $server — irssi-like inline feel.
//
// The 406 ERR_WASNOSUCHNICK case is folded into the same component:
// `not_found: true` → renders a "no history" banner instead of the
// historical fields.
//
// MVP scope: only the most-recent historical entry is rendered (the
// server-side bundle accumulates all 314 RPL_WHOWASUSER entries but
// projects only the last into typed fields). Multi-entry rendering
// is out of scope per the plan §Domain 3 design.

export type Props = {
  networkSlug: string;
};

const WhowasCard: Component<Props> = (props) => {
  const bundle = () => whowasCardBySlug()[props.networkSlug];
  // #1199 — Escape dismisses through the shared ordered ESC stack (the same
  // door every modal uses), invoking the SAME verb the × does, so a modal
  // opened over the card still closes first. No COVERING refcount: the card
  // sits IN the scrollback flow, not over it, so the pane behind must not
  // freeze. #1772 — the iOS touch lock is not part of what that gives up.
  createOverlayEscape(
    () => bundle() !== undefined,
    () => dismissWhowasCard(props.networkSlug),
  );

  return (
    <Show when={bundle()}>
      {(b) => (
        <div class="whowas-card selectable-text" data-testid="whowas-card">
          <div class="whowas-card-header">
            <span class="whowas-card-title">/whowas</span>
            <NickText nick={b().target} extraClass="whowas-card-target" />
            <button
              type="button"
              class="whowas-card-close"
              aria-label="Dismiss WHOWAS"
              onClick={() => dismissWhowasCard(props.networkSlug)}
            >
              ×
            </button>
          </div>
          <Show
            when={!b().not_found}
            fallback={
              <p class="whowas-card-empty muted">
                no history for <NickText nick={b().target} />
              </p>
            }
          >
            <dl class="whowas-card-fields">
              <Show when={b().user !== null && b().host !== null}>
                <dt>userhost</dt>
                <dd>
                  {b().user}@{b().host}
                </dd>
              </Show>
              <Show when={b().realname}>
                <dt>realname</dt>
                <dd>
                  <MircBody body={b().realname ?? ""} />
                </dd>
              </Show>
              <Show when={b().server}>
                <dt>last seen on</dt>
                <dd>{b().server}</dd>
              </Show>
              <Show when={b().logoff_time}>
                <dt>logged off</dt>
                <dd class="whowas-card-logoff">{b().logoff_time}</dd>
              </Show>
            </dl>
          </Show>
        </div>
      )}
    </Show>
  );
};

export default WhowasCard;
