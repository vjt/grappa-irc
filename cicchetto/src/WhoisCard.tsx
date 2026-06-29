import { type Component, For, Show } from "solid-js";
import type { WhoisBundle } from "./lib/api";
import { dismissWhoisCard, whoisCardBySlug } from "./lib/whoisCard";
import { MircBody } from "./MircText";
import NickText from "./NickText";

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
// P-0a — Cluster `numeric-delegation-p0` 2026-05-13. 11 additional
// WHOIS-leg flags rendered as inline tags + structured rows. Per
// `feedback_no_localized_strings_server_side`, ALL human strings are
// built here from server-emitted typed booleans / strings — never
// echoed from upstream wire trailing.
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

// P-0a — collect inline tag chips derived from typed booleans. The label
// strings are owned here (locale-extensible), NOT by the server.
type TagChip = { label: string; cssMod: string };

const collectTags = (b: WhoisBundle): TagChip[] => {
  const tags: TagChip[] = [];
  if (b.is_operator) tags.push({ label: "oper", cssMod: "oper" });
  if (b.is_admin) tags.push({ label: "server admin", cssMod: "admin" });
  if (b.is_services_admin) tags.push({ label: "services admin", cssMod: "sadmin" });
  if (b.is_agent) tags.push({ label: "services agent", cssMod: "agent" });
  if (b.is_helper) tags.push({ label: "helper", cssMod: "helper" });
  if (b.is_chanop) tags.push({ label: "chanop", cssMod: "chanop" });
  if (b.is_registered) tags.push({ label: "registered", cssMod: "registered" });
  if (b.using_ssl) tags.push({ label: "SSL", cssMod: "ssl" });
  if (b.is_java) tags.push({ label: "java", cssMod: "java" });
  return tags;
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
      b.channels !== null ||
      // P-0a — extended flags also count as "has data"
      b.using_ssl ||
      b.is_registered ||
      b.is_admin ||
      b.is_services_admin ||
      b.is_helper ||
      b.is_chanop ||
      b.is_agent ||
      b.is_java ||
      b.umodes !== null ||
      b.away_message !== null ||
      b.actually_host !== null
    );
  };

  return (
    <Show when={bundle()}>
      {(b) => (
        <div class="whois-card" data-testid="whois-card">
          <div class="whois-card-header">
            <NickText nick={b().target} extraClass="whois-card-target" />
            <For each={collectTags(b())}>
              {(tag) => (
                <span class={`whois-card-tag whois-card-tag-${tag.cssMod}`}>{tag.label}</span>
              )}
            </For>
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
                <dd>
                  <MircBody body={b().realname ?? ""} />
                </dd>
              </Show>
              <Show when={b().away_message}>
                <dt>away</dt>
                <dd class="whois-card-away">
                  <MircBody body={b().away_message ?? ""} />
                </dd>
              </Show>
              <Show when={b().actually_host}>
                <dt>connecting from</dt>
                <dd>
                  <MircBody body={b().actually_host ?? ""} />
                  <Show when={b().actually_ip}>
                    {" ["}
                    <MircBody body={b().actually_ip ?? ""} />
                    {"]"}
                  </Show>
                </dd>
              </Show>
              <Show when={b().umodes}>
                <dt>modes</dt>
                <dd class="whois-card-umodes">
                  <MircBody body={b().umodes ?? ""} />
                </dd>
              </Show>
              <Show when={b().server}>
                <dt>server</dt>
                <dd>
                  {b().server}
                  <Show when={b().server_info}>
                    {" ("}
                    <MircBody body={b().server_info ?? ""} />
                    {")"}
                  </Show>
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
