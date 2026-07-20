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
// with no overloading. We cross-check it first (option 1 in #272), then
// reconcile umode +i against it: since a halfop membership accounts for
// exactly one `%`, any `%` the resolved membership does NOT account for is the
// +i marker. This disambiguates BOTH directions — a real halfop never shows a
// false "invisible" chip, a plain +i member never shows a false "halfop". Only
// when no roster snapshot exists (`WHO` on a non-joined channel,
// `WHO <nick|mask>`) do we fall back to the token's trailing glyph, where a
// lone `%` reads as halfop (#272 option 2). See `resolveWhoRow`.
type Membership = "@" | "%" | "+";

type WhoFlagChip = { label: string; cssMod: string };

// The status chars grappa enumerates; any other byte is surfaced raw so no
// wire information is silently dropped (bahamut can emit flags grappa never
// enumerated — the server relays the field verbatim).
const KNOWN_WHO_FLAGS = new Set(["H", "G", "*", "S", "@", "%", "+"]);

// Structural (non-membership) attributes of a WHO row's flags token.
type WhoFlags = {
  away: "here" | "gone";
  oper: boolean;
  secure: boolean;
  // Fallback channel membership = the TRAILING status glyph (see below). Used
  // only when no NAMES roster resolves the row; the roster overrides it.
  membership: Membership | null;
  unknown: string[];
};

const isMembership = (ch: string): ch is Membership => ch === "@" || ch === "%" || ch === "+";

// Parse the raw 352 flags token per the bahamut grammar `[H|G] [*|%] [S]
// [@|%|+]`. Channel membership is read as the TRAILING status glyph — bahamut
// always emits it last — so a `%` in any earlier slot (the oper-view +i
// marker) is NEVER mistaken for halfop. `oper` (`*`) and `secure` (`S`) live
// in fixed, disjoint slots, so a membership-agnostic `includes` scan is safe
// AND robust to any unenumerated char that lands between them and the trailing
// glyph (the glyph is still the last char). Invisibility is NOT decided here —
// it is `%`-count-reconciled against the roster-resolved membership in
// `resolveWhoRow`, because a lone `%` is undecidable (halfop vs +i) without it.
const parseWhoFlags = (raw: string): WhoFlags => {
  const chars = [...raw];
  const last = chars[chars.length - 1];
  return {
    away: chars[0] === "G" ? "gone" : "here",
    oper: chars.includes("*"),
    secure: chars.includes("S"),
    membership: last !== undefined && isMembership(last) ? last : null,
    unknown: chars.filter((ch) => !KNOWN_WHO_FLAGS.has(ch)),
  };
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

// A fully-resolved WHO row: membership resolved against the roster, and
// invisibility (umode +i) reconciled with it.
type ResolvedWhoRow = {
  away: "here" | "gone";
  oper: boolean;
  invisible: boolean;
  secure: boolean;
  membership: Membership | null;
  unknown: string[];
};

// #272 — resolve a WHO row's rendered attributes, disambiguating the
// overloaded `%` in BOTH directions.
//
// Membership is roster-authoritative: `rosterM` of `undefined` means "no
// snapshot" → fall back to the token's trailing glyph; `null`/glyph is the
// roster's answer and wins. Invisibility is then derived from the count of `%`
// the RESOLVED membership does NOT account for — a halfop membership consumes
// exactly one `%`, everything else consumes none. So:
//   * a real halfop (`H%`, roster `%`)  → 1 `%`, membership eats it → NOT +i
//     (no false "invisible" chip — the pre-#272-review bug);
//   * a plain +i member (`H%`, roster plain) → 1 `%`, membership eats none →
//     +i (the honest "invisible" chip);
//   * an invisible halfop (`H%%`)        → 2 `%`, membership eats one → +i.
// Rosterless, membership is the trailing glyph, so a lone `%` reads as halfop
// (spec #272 option 2) and only a non-trailing `%` (e.g. `H%@`) reads as +i —
// the irreducible residual (a rosterless oper-view +i *plain* member, `H%`,
// reads as halfop) is documented in DESIGN_NOTES; the roster path covers the
// reported/common case.
const resolveWhoRow = (modes: string, rosterM: Membership | null | undefined): ResolvedWhoRow => {
  const flags = parseWhoFlags(modes);
  const membership = rosterM === undefined ? flags.membership : rosterM;
  const percentCount = [...modes].filter((ch) => ch === "%").length;
  return {
    away: flags.away,
    oper: flags.oper,
    invisible: percentCount > (membership === "%" ? 1 : 0),
    secure: flags.secure,
    membership,
    unknown: flags.unknown,
  };
};

// #176/#272 — decode a resolved WHO row into human-labeled, per-flag styled
// chips. Labels + colors are cic-owned display strings — NOT mIRC codes — so
// they render as CSS chips, never through MircBody.
const whoChips = (row: ResolvedWhoRow): WhoFlagChip[] => {
  const chips: WhoFlagChip[] = [
    row.away === "gone" ? { label: "gone", cssMod: "gone" } : { label: "here", cssMod: "here" },
  ];
  if (row.oper) chips.push({ label: "ircop", cssMod: "ircop" });
  if (row.invisible) chips.push({ label: "invisible", cssMod: "invisible" });
  if (row.secure) chips.push({ label: "secure", cssMod: "secure" });
  if (row.membership !== null) chips.push(MEMBERSHIP_CHIP[row.membership]);
  for (const ch of row.unknown) chips.push({ label: ch, cssMod: "unknown" });
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
                      // #272 — membership is roster-authoritative and +i is
                      // reconciled against it (see `resolveWhoRow`). Read as a
                      // getter (calling `membersByChannel()` in JSX) so the row
                      // stays correct if the roster updates while the ephemeral
                      // modal is open.
                      const resolved = (): ResolvedWhoRow =>
                        resolveWhoRow(u.modes, rosterMembership(b.network, u.channel, u.nick));
                      return (
                        <li class="who-modal-row" data-testid="who-modal-row">
                          <div class="who-modal-line who-modal-line-head">
                            <button
                              type="button"
                              class="who-modal-nick"
                              onClick={() => onNickClick(b.network, u.nick)}
                            >
                              <NickText
                                nick={u.nick}
                                prefix={membershipPrefix(resolved().membership)}
                              />
                            </button>
                            {/* #176 — decoded flag chips. cic-owned display
                              labels colored per flag via CSS — NOT mIRC codes,
                              so they do NOT route through MircBody. */}
                            <span class="who-modal-flags">
                              <For each={whoChips(resolved())}>
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
