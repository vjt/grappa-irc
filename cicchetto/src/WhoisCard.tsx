import { type Component, For, Show } from "solid-js";
import { dismissWhoisCard, whoisCardBySlug } from "./lib/whoisCard";

// C2 — WHOIS card. Renders the aggregated WHOIS bundle inline at the top
// of the active window's scrollback pane. Per spec #2:
//   * Ephemeral — bundle lives in `whoisCardBySlug` until replaced by the
//     next /whois on the same network OR explicitly dismissed.
//   * Inline-in-active-window — the user typed /whois from the window
//     they're looking at; the reply renders there. Cross-network: only
//     the bundle for the active window's network shows (one card max).
//   * NOT a modal, NOT routed to $server — irssi-like inline feel
//     (matches the rest of the client).
//
// Empty bundle (only `target` populated, no upstream numerics): renders
// a "no such nick" banner. Operator users: 313 RPL_WHOISOPERATOR adds
// an [oper] tag. Idle / signon: rendered as relative human text.
//
// Close affordance: × button on the right calls `dismissWhoisCard` for
// this network. Mounted by `ScrollbackPane.tsx` only when a bundle
// exists for the selected window's network slug.

export type Props = {
  networkSlug: string;
};

const formatIdle = (seconds: number | null): string | null => {
  if (seconds === null) return null;
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
};

const formatSignon = (epochSeconds: number | null): string | null => {
  if (epochSeconds === null) return null;
  return new Date(epochSeconds * 1000).toLocaleString();
};

const WhoisCard: Component<Props> = (props) => {
  const bundle = () => whoisCardBySlug()[props.networkSlug];
  const hasFields = (): boolean => {
    const b = bundle();
    if (!b) return false;
    return (
      b.user !== null ||
      b.host !== null ||
      b.realname !== null ||
      b.server !== null ||
      b.is_operator ||
      b.idle_seconds !== null ||
      b.channels !== null
    );
  };

  return (
    <Show when={bundle()}>
      {(b) => (
        <div class="whois-card" data-testid="whois-card">
          <div class="whois-card-header">
            <span class="whois-card-target">{b().target}</span>
            <Show when={b().is_operator}>
              <span class="whois-card-tag whois-card-tag-oper">oper</span>
            </Show>
            <button
              type="button"
              class="whois-card-close"
              aria-label="Dismiss WHOIS"
              onClick={() => dismissWhoisCard(props.networkSlug)}
            >
              ×
            </button>
          </div>
          <Show
            when={hasFields()}
            fallback={
              <p class="whois-card-empty muted">
                no WHOIS information returned (target unknown or privacy-stripped)
              </p>
            }
          >
            <dl class="whois-card-fields">
              <Show when={b().user !== null && b().host !== null}>
                <dt>userhost</dt>
                <dd>
                  {b().user}@{b().host}
                </dd>
              </Show>
              <Show when={b().realname}>
                <dt>realname</dt>
                <dd>{b().realname}</dd>
              </Show>
              <Show when={b().server}>
                <dt>server</dt>
                <dd>
                  {b().server}
                  <Show when={b().server_info}> ({b().server_info})</Show>
                </dd>
              </Show>
              <Show when={b().idle_seconds !== null}>
                <dt>idle</dt>
                <dd>
                  {formatIdle(b().idle_seconds)}
                  <Show when={b().signon !== null}> · signon {formatSignon(b().signon)}</Show>
                </dd>
              </Show>
              <Show when={(b().channels?.length ?? 0) > 0}>
                <dt>channels</dt>
                <dd>
                  <For each={b().channels ?? []}>
                    {(chan) => <span class="whois-card-channel">{chan}</span>}
                  </For>
                </dd>
              </Show>
            </dl>
          </Show>
        </div>
      )}
    </Show>
  );
};

export default WhoisCard;
