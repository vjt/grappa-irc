import { type Component, For, Show } from "solid-js";
import type { WhoUser } from "./lib/api";
import { channelKey } from "./lib/channelKey";
import { memberSigil } from "./lib/memberSigil";
import { membersByChannel } from "./lib/members";
import { networks } from "./lib/networks";
import { nickEquals } from "./lib/nickEquals";
import { createOverlayLock } from "./lib/overlayScrollLock";
import { canonicalQueryNick, openQueryWindowState } from "./lib/queryWindows";
import { selectedChannel, setSelectedChannel } from "./lib/selection";
import { dismissWhoModal, whoModalBySlug } from "./lib/whoModal";
import { MircBody } from "./MircText";
import NickText, { type PrefixGlyph } from "./NickText";

// #169 — /who modal. Centered, scrollable, dismissable overlay rendering the
// parsed per-user rows from a `who_reply` event (Session.Server's buffered
// 352/315 drain). Mirrors NamesModal (same overlay/scroll-lock/dismiss/nick-
// click scaffolding); the body differs — a flat per-user TABLE (nick, flags,
// user@host, server, hops, realname) instead of the sigil-grouped names
// roster. Mounted once per Shell branch (mobile + desktop); only one branch
// is live, so a single instance exists.
//
// Reads the roster for the CURRENTLY-ACTIVE network
// (`selectedChannel()?.networkSlug`) from the per-slug `whoModalBySlug`
// store. Rows arrive in server WHO order (event_router preserves wire order);
// cic renders them as-is. Ephemeral — dismissing just drops the store entry.
// Clicking a nick closes the modal + opens a query (the MembersPane verb
// pair). Dismiss via ×, Esc, or backdrop.

// #272 — the 352 flags `%` is OVERLOADED on azzurra bahamut. Its m_who.c
// status grammar is positional:
//
//   [ H | G ] · [ * | % ] · [ S ] · [ @ | % | + ]
//     away       oper|+i     ssl     chanop|halfop|voice
//
// The position-2 `%` is the umode +i (invisible) marker the ircd emits ONLY
// in the operator WHO view; the position-4 `%` is the halfop channel-
// membership prefix. A plain +i member (`H%`) is byte-identical to a real
// non-invisible halfop (`H%`) — undecidable from the flags string alone. The
// pre-#272 code derived the membership sigil with `modes.includes("%")`, so
// an operator's `/who #chan` mislabeled every +i member as a halfop.
//
// The NAMES roster (`membersByChannel`) is the authoritative, ircd-agnostic
// source of channel membership: it carries `@`/`%`/`+` as discrete prefixes
// with no overloading. We cross-check it first (option 1 in #272) and only
// parse the flags field positionally when no roster snapshot exists (`WHO`
// on a non-joined channel, `WHO <nick|mask>`).
type Membership = "@" | "%" | "+";

type WhoFlagChip = { label: string; cssMod: string };

type WhoFlags = {
  away: "here" | "gone";
  oper: boolean;
  invisible: boolean;
  secure: boolean;
  membership: Membership | null;
  unknown: string[];
};

const isMembership = (ch: string): ch is Membership => ch === "@" || ch === "%" || ch === "+";

// Positional parse of the raw 352 flags token per the bahamut grammar above.
// Consumes each grammar slot in order so the position-2 invisible `%` is
// classified as `invisible`, NEVER as membership — the position-4 `%` (the
// trailing status glyph) is the only `%` that means halfop. Any trailing char
// grappa never enumerated is preserved in `unknown` (never dropped — the
// server relays the field verbatim and bahamut can emit new flags).
const parseWhoFlags = (raw: string): WhoFlags => {
  const chars = [...raw];
  const flags: WhoFlags = {
    away: "here",
    oper: false,
    invisible: false,
    secure: false,
    membership: null,
    unknown: [],
  };
  let i = 0;
  // pos 1 — away marker (H here / G gone), always first on the wire.
  if (chars[i] === "H") i += 1;
  else if (chars[i] === "G") {
    flags.away = "gone";
    i += 1;
  }
  // pos 2 — oper (*) XOR the oper-view invisible (+i) marker (%).
  if (chars[i] === "*") {
    flags.oper = true;
    i += 1;
  } else if (chars[i] === "%") {
    flags.invisible = true;
    i += 1;
  }
  // pos 3 — secure (S, TLS-connected).
  if (chars[i] === "S") {
    flags.secure = true;
    i += 1;
  }
  // pos 4 — channel membership (the trailing status glyph). A `%` here is
  // halfop, distinct from the position-2 invisible `%` already consumed.
  const m = chars[i];
  if (m !== undefined && isMembership(m)) {
    flags.membership = m;
    i += 1;
  }
  // anything left over — an unenumerated flag. Surfaced raw, never dropped.
  for (; i < chars.length; i += 1) {
    const ch = chars[i];
    if (ch !== undefined) flags.unknown.push(ch);
  }
  return flags;
};

// Authoritative membership sigil for a WHO row, cross-checked against the
// NAMES roster (`membersByChannel`) — the same unambiguous prefix source
// MembersPane renders. Returns:
//   * a `Membership` glyph        — roster carries `@`/`%`/`+` for the nick
//   * `null`                      — roster has the nick as a PLAIN member
//                                   (authoritative "no sigil")
//   * `undefined`                 — no roster snapshot for the channel, or
//                                   the nick isn't in it (`WHO <nick|mask>`,
//                                   a non-joined channel) → caller falls back
//                                   to the positional flags parse.
// `null` vs `undefined` matters: a roster-plain member must NOT fall through
// to the flags field (which may carry a stray oper-view `%`).
const rosterMembership = (
  slug: string,
  channel: string,
  nick: string,
): Membership | null | undefined => {
  const list = membersByChannel()[channelKey(slug, channel)];
  if (list === undefined) return undefined;
  const member = list.find((m) => nickEquals(m.nick, nick));
  if (member === undefined) return undefined;
  const sigil = memberSigil(member.modes);
  return sigil === " " ? null : sigil;
};

const MEMBERSHIP_CHIP: Record<Membership, WhoFlagChip> = {
  "@": { label: "chanop", cssMod: "chanop" },
  "%": { label: "halfop", cssMod: "halfop" },
  "+": { label: "voice", cssMod: "voice" },
};

// #176/#272 — decode a WHO row into human-labeled, per-flag styled chips. The
// non-membership flags (away / oper / +i / secure / unknown) come from the
// positional flags parse; the membership chip comes from the roster-resolved
// sigil (so a mislabeled oper-view `%` never renders "halfop"). Labels +
// colors are cic-owned display strings — NOT mIRC codes — so they render as
// CSS chips, never through MircBody.
const whoChips = (flags: WhoFlags, membership: Membership | null): WhoFlagChip[] => {
  const chips: WhoFlagChip[] = [
    flags.away === "gone" ? { label: "gone", cssMod: "gone" } : { label: "here", cssMod: "here" },
  ];
  if (flags.oper) chips.push({ label: "ircop", cssMod: "ircop" });
  if (flags.invisible) chips.push({ label: "invisible", cssMod: "invisible" });
  if (flags.secure) chips.push({ label: "secure", cssMod: "secure" });
  if (membership !== null) chips.push(MEMBERSHIP_CHIP[membership]);
  for (const ch of flags.unknown) chips.push({ label: ch, cssMod: "unknown" });
  return chips;
};

const membershipPrefix = (membership: Membership | null): PrefixGlyph => membership ?? "";

const WhoModal: Component = () => {
  const activeSlug = (): string | undefined => selectedChannel()?.networkSlug;
  const bundle = () => {
    const slug = activeSlug();
    return slug === undefined ? undefined : whoModalBySlug()[slug];
  };

  const close = (): void => {
    const slug = activeSlug();
    if (slug !== undefined) dismissWhoModal(slug);
  };

  // Refcounted overlay scroll-lock — same wiring as NamesModal. Tracks "is a
  // roster shown for the active network?". The scroller is `.who-modal-body`
  // (header + footer are pinned). #232 — the shared Esc-to-close routes
  // through the same lock (topmost-first, focus-independent).
  createOverlayLock(() => bundle() !== undefined, ".who-modal-body", close);

  // Clicking a nick opens a query window + switches focus, then closes the
  // modal. Mirrors NamesModal / MembersPane's left-click verb pair
  // (canonicalQueryNick → openQueryWindowState → setSelectedChannel). Race-
  // safe: no-op when networks() hasn't resolved (leaves the modal open).
  const onNickClick = (slug: string, nick: string): void => {
    const nid = networks()?.find((n) => n.slug === slug)?.id;
    if (nid === undefined) return;
    const canonical = canonicalQueryNick(nid, nick);
    openQueryWindowState(nid, canonical, new Date().toISOString());
    setSelectedChannel({ networkSlug: slug, channelName: canonical, kind: "query" });
    close();
  };

  return (
    <Show when={bundle()} keyed>
      {(b) => {
        const total = (): number => b.users.length;
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop close-on-outside; Esc via the shared overlay stack (keybindings → runTopmostOverlayEscape)
          // biome-ignore lint/a11y/noStaticElementInteractions: backdrop is non-interactive scrim
          <div class="who-modal-backdrop" onClick={close}>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: inner dialog onClick only stops backdrop-click propagation; Esc closes via the shared overlay stack */}
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="who-modal-title"
              class="who-modal"
              data-testid="who-modal"
              onClick={(e) => e.stopPropagation()}
              tabIndex={-1}
            >
              <header class="who-modal-header">
                <h2 id="who-modal-title">
                  {b.target} — {total()} {total() === 1 ? "user" : "users"}
                </h2>
                <button
                  type="button"
                  class="who-modal-close"
                  aria-label="close who"
                  onClick={close}
                >
                  ×
                </button>
              </header>
              <div class="who-modal-body">
                <ul class="who-modal-rows">
                  <For each={b.users}>
                    {(u: WhoUser) => {
                      // #176 — one word-wrapping COLUMN block per user (was a
                      // flat single flex-row that overflowed sideways). Head
                      // line = nick + decoded flag chips; then realname, host,
                      // and server/hops each on their own wrapping line.
                      //
                      // #272 — membership is roster-authoritative: the row's
                      // NAMES snapshot decides `@`/`%`/`+`, and only the
                      // positional flags parse is used when no roster exists.
                      // Read as getters (calling `membersByChannel()` in JSX)
                      // so the sigil stays correct if the roster updates while
                      // the ephemeral modal is open.
                      const flags = parseWhoFlags(u.modes);
                      const membership = (): Membership | null => {
                        const fromRoster = rosterMembership(b.network, u.channel, u.nick);
                        return fromRoster === undefined ? flags.membership : fromRoster;
                      };
                      return (
                        <li class="who-modal-row" data-testid="who-modal-row">
                          <div class="who-modal-line who-modal-line-head">
                            <button
                              type="button"
                              class="who-modal-nick"
                              onClick={() => onNickClick(b.network, u.nick)}
                            >
                              <NickText nick={u.nick} prefix={membershipPrefix(membership())} />
                            </button>
                            {/* #176 — decoded flag chips. cic-owned display
                              labels colored per flag via CSS — NOT mIRC codes,
                              so they do NOT route through MircBody. */}
                            <span class="who-modal-flags">
                              <For each={whoChips(flags, membership())}>
                                {(chip) => (
                                  <span
                                    class={`who-modal-flag-tag who-modal-flag-tag-${chip.cssMod}`}
                                  >
                                    {chip.label}
                                  </span>
                                )}
                              </For>
                            </span>
                          </div>
                          <Show when={u.realname}>
                            {/* #175/#176 — the WHO realname (gecos) is arbitrary
                              user free-text carrying mIRC control bytes; route
                              it through the shared renderer (keep the #175
                              MircBody wrapping) and give it its OWN word-
                              wrapping line. The other fields (nick, flags,
                              user@host, server, hops) are identifiers and stay
                              literal. */}
                            <div class="who-modal-line who-modal-line-realname">
                              <span class="who-modal-realname">
                                <MircBody body={u.realname ?? ""} />
                              </span>
                            </div>
                          </Show>
                          <div class="who-modal-line who-modal-line-host">
                            <span class="who-modal-userhost">
                              {u.user}@{u.host}
                            </span>
                          </div>
                          <div class="who-modal-line who-modal-line-meta">
                            <span class="who-modal-server">{u.server}</span>
                            <Show when={u.hops !== null}>
                              <span class="who-modal-hops">· {u.hops} hops</span>
                            </Show>
                          </div>
                        </li>
                      );
                    }}
                  </For>
                </ul>
              </div>
              <footer class="who-modal-footer">End of /WHO list: {total()}</footer>
            </div>
          </div>
        );
      }}
    </Show>
  );
};

export default WhoModal;
