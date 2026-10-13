import { type Component, For, Show } from "solid-js";
import type { WhoisBundle } from "./lib/api";
import { formatDateTime } from "./lib/dateFormat";
import { formatDuration } from "./lib/duration";
import { createOverlayEscape } from "./lib/overlayScrollLock";
import { whoisBundleHasFields } from "./lib/whoisBundle";
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
// `feedback_no_localized_strings_server_side`, the P-0a human strings are
// built here from server-emitted typed booleans / strings.
//
// #367 exception — `oper_text` (313 RPL_WHOISOPERATOR trailing) IS echoed
// from the upstream wire trailing, deliberately: it is ircd pass-through
// data (the operator-level distinction the server itself sends), not a
// grappa-generated localized string, so the no-localized-strings policy
// does not gate it. Same class as `server_info` / channel names.
//
// #606 — PROP-DRIVEN presentation. WhoisCard renders whatever `bundle` it
// is handed and knows nothing about WHERE that bundle lives:
//   * the scrollback overlay (`ScrollbackPane`) passes the single-slot
//     `whoisCardBySlug` bundle for the active window's network AND an
//     `onDismiss` — the × button that clears the user-issued /whois card;
//   * the query rail context (`RailContext`, #606) passes its per-nick
//     `railWhoisFor` bundle and OMITS `onDismiss` — the rail card is a
//     persistent per-window-kind surface (like `ServerInfoCard`), so it has
//     no × affordance.
// Short-circuits to nothing when `bundle` is undefined, so both mount sites
// can render it unconditionally.

export type Props = {
  bundle: WhoisBundle | undefined;
  /** When supplied, renders the × dismiss button wired to this handler
      (the ephemeral scrollback card). Omit for the persistent rail card. */
  onDismiss?: () => void;
};

// issue 2270 — through the ONE date renderer, so the signon instant does not
// take its notation from the browser's UI language.
const formatSignon = (epochSeconds: number | null): string | null => {
  if (epochSeconds === null) return null;
  return formatDateTime(epochSeconds * 1000);
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
  // #221 — "registered" fires for bahamut (307 → is_registered) AND solanum
  // (330 → account present). "SSL" fires for bahamut (275 → using_ssl) AND
  // solanum (671 → secure). The two ircds signal the same fact via different
  // numerics; the badge must read BOTH sources or a Libera user's modal
  // looks anonymous + insecure (the reopened-#221 regression).
  if (b.is_registered || b.account !== null)
    tags.push({ label: "registered", cssMod: "registered" });
  if (b.using_ssl || b.secure) tags.push({ label: "SSL", cssMod: "ssl" });
  if (b.is_java) tags.push({ label: "java", cssMod: "java" });
  return tags;
};

const WhoisCard: Component<Props> = (props) => {
  const bundle = () => props.bundle;
  // #1199 — Escape closes the card through the shared ordered ESC stack, the
  // same door every modal uses, so a modal opened over the card still closes
  // first. Gated on `onDismiss`: it is the dismissability of the mount site,
  // and the rail card (which omits it) must NOT be closable — a persistent
  // per-window surface Escape can close is one the operator cannot bring back.
  // No COVERING refcount: the card sits IN the scrollback flow, not over it, so
  // the pane behind must keep scrolling and must not freeze its snapshot.
  // #1772 — the iOS touch lock is NOT part of what that gives up (it was, and a
  // drag with the card open panned the whole app shell). The gate below decides
  // both: the rail card, which cannot be dismissed, takes neither.
  createOverlayEscape(
    () => bundle() !== undefined && props.onDismiss !== undefined,
    () => props.onDismiss?.(),
  );
  const hasFields = (): boolean => {
    const b = bundle();
    return b !== undefined && whoisBundleHasFields(b);
  };

  return (
    <Show when={bundle()}>
      {(b) => (
        <div class="whois-card selectable-text" data-testid="whois-card">
          <div class="whois-card-header">
            {/* M3b — the authenticated `/networks/:id/peer_avatar/:slug`
                path from `Grappa.Avatars`, NEVER the peer's raw declared
                URL (see docs/DESIGN_NOTES.md #1280: fetched/sanitized
                server-side, served same-origin, WHOIS-card-only — not
                the member list, not scrollback). Absent when never
                queried / still fetching / the peer never answered. */}
            <Show when={b().avatar_url}>
              {(url) => <img class="whois-card-avatar" src={url()} alt="" />}
            </Show>
            <NickText nick={b().target} extraClass="whois-card-target" />
            <For each={collectTags(b())}>
              {(tag) => (
                <span class={`whois-card-tag whois-card-tag-${tag.cssMod}`}>{tag.label}</span>
              )}
            </For>
            <Show when={props.onDismiss}>
              <button
                type="button"
                class="whois-card-close"
                aria-label="Dismiss WHOIS"
                onClick={() => props.onDismiss?.()}
              >
                ×
              </button>
            </Show>
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
              {/* #367 — 313 RPL_WHOISOPERATOR role text. The header "oper"
                  badge flags operator status at a glance; this row shows the
                  exact ircd role (IRC Operator vs Server / Services
                  Administrator) so a viewer can tell them apart. Absent for
                  a bare 313 (oper_text null) — the badge alone remains, the
                  pre-#367 fallback. Unlike the P-0a flags this string is
                  upstream-ircd pass-through, so it routes through MircBody
                  like every other free-text whois field (#142). */}
              <Show when={b().oper_text}>
                <dt>oper</dt>
                <dd class="whois-card-oper-text">
                  <MircBody body={b().oper_text ?? ""} />
                </dd>
              </Show>
              {/* #221 — solanum account name (330 RPL_WHOISLOGGEDIN). The
                  "registered" badge above signals identity is confirmed; this
                  row shows WHICH services account. Predicate is `!== null` to
                  match collectTags's badge gate — a badge with no matching
                  row (or vice-versa) would be an inconsistency. */}
              <Show when={b().account !== null}>
                <dt>account</dt>
                <dd class="whois-card-account">
                  <MircBody body={b().account ?? ""} />
                </dd>
              </Show>
              {/* #221 — TLS protocol string (671 RPL_WHOISSECURE bracketed
                  payload). The "SSL" badge signals TLS; this row shows the
                  version + cipher when the server exposed it. */}
              <Show when={b().secure_cipher}>
                <dt>secure</dt>
                <dd class="whois-card-secure-cipher">
                  <MircBody body={b().secure_cipher ?? ""} />
                </dd>
              </Show>
              {/* #221 — client cert fingerprint (276 RPL_WHOISCERTFP). */}
              <Show when={b().certfp}>
                <dt>cert</dt>
                <dd class="whois-card-certfp">
                  <MircBody body={b().certfp ?? ""} />
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
                  {formatDuration(b().idle_seconds)}
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
              {/* #673 — every WHOIS-leg numeric with no typed field, which
                  #221's generic catch collects and nothing rendered until
                  now: 340 RPL_SHUNNED (bahamut, oper-only), 320
                  RPL_WHOISSPECIAL (solanum), and whatever either ircd adds
                  next. Rendered LAST so the typed rows keep their shape.

                  Order is the wire's: the server accumulator prepends LIFO
                  for O(1) fold and `Grappa.Session.Wire.reverse_extra_lines/1`
                  reverses on emit, so this list arrives in arrival order —
                  render as-is, never reverse here.

                  The text is the ircd's trailing param, i.e. upstream
                  English, NOT a grappa-authored string — the i18n pass must
                  NOT translate it (same class as `oper_text` / `server_info`
                  above). It routes through MircBody because a services-set
                  line can carry mIRC colour (#142). The numeric is oper
                  diagnostics, so it rides in `title` rather than the body. */}
              <Show when={(b().extra_lines?.length ?? 0) > 0}>
                <dt>info</dt>
                <dd>
                  <For each={b().extra_lines ?? []}>
                    {(line) => (
                      <div class="whois-card-extra-line" title={`numeric ${line.numeric}`}>
                        <MircBody body={line.text} />
                      </div>
                    )}
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
