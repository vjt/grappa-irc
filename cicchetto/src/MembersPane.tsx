import { type Component, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ownNickForNetwork } from "./lib/api";
import { sigilRankForSlug } from "./lib/casemapping";
import { channelKey } from "./lib/channelKey";
import { getColoredNicklist } from "./lib/colorNicklist";
import { casemappingForNetwork } from "./lib/isupport";
import { memberSigil } from "./lib/memberSigil";
import { type MemberEntry, type MemberGender, membersByChannel, sortMembers } from "./lib/members";
import { networkBySlug, networks, user } from "./lib/networks";
import { nickEquals } from "./lib/nickEquals";
import { bindNickLongPress } from "./lib/nickLongPress";
import { canonicalQueryNick, openQueryWindowState } from "./lib/queryWindows";
import { setSelectedChannel } from "./lib/selection";
import { windowStateByChannel } from "./lib/windowState";
import NickText, { type PrefixGlyph } from "./NickText";
import UserContextMenu from "./UserContextMenu";

// Right-pane member list. Reads from `membersByChannel`; renders each
// entry with a mode-tier class (.member-op / .member-voiced /
// .member-plain) that the stylesheet uses to colour the nick. The
// prefix sigil (@ / + / space) is rendered as the first character of
// the click button's text content via `memberSigil/1` — NOT via CSS
// `::before` content. Why: see memory
// `feedback_css_block_button_wraps_inline_prefix` — a `width: 100%`
// block-level button inside an li with a `::before` inline prefix
// wraps the button to a new line below the prefix and gets clipped by
// the li's `overflow: hidden`. Putting the prefix in DOM text content
// keeps the entire row in one inline flow.
//
// CP15 B5: render branches now key on `windowStateByChannel[key]`:
//   * state ∉ {joined}    → "not joined" muted text. No fetch ever.
//   * state == joined &&
//       members empty      → "loading…" (members_seeded inflight from
//                            after_join; arrives on the channel topic).
//   * state == joined &&
//       members non-empty  → render the list.
//
// Pre-B5 the pane fetched GET /members on mount via a once-per-channel
// gate. Server now pushes `members_seeded` on after_join (B3) AND on
// every 366 RPL_ENDOFNAMES; cic has no remaining reason to fetch — the
// WS push is the source of truth.
//
// C5.1: right-click on a nick opens `UserContextMenu` with ops actions
// gated on own-nick's @ mode in this channel. Own-nick's modes are
// derived from `membersByChannel()` (same `MemberEntry.modes` array as
// the member list renders — no parallel state). onClose dismisses the
// menu; clicking an action auto-closes too.

export type Props = {
  networkSlug: string;
  channelName: string;
  // UX-5 bucket BV (2026-05-20) — optional hook fired after the
  // query-window opens on left-click. Mobile Shell wires this to
  // `setMembersOpen(false)` so tapping a nick dismisses the members
  // drawer (pre-BV the drawer stayed open over the new query's
  // ComposeBox, blocking input focus through the iOS keyboard
  // overlay). Desktop omits the prop — the desktop drawer is
  // a permanent column, not a transient overlay. Race-safe: only
  // fires AFTER the query verb pair succeeds, so a network-unresolved
  // no-op leaves the drawer open (mirrors selection.setSelectedChannel
  // not firing in the same branch).
  onMemberSelect?: () => void;
};

// The `<li>` tier class. Retained for the sortMembers contract and for
// reviewer-facing diagnosis (see themes/default.css) — the per-tier colour
// cascade moved onto the prefix span in BC2.
//
// issue 1999 — keyed off the member's rendered SIGIL rather than a
// hardcoded `@ % +` scan, so the class always agrees with the glyph beside
// it. The theme names only the three classic grades; a sigil outside that
// set gets `member-plain`, the same deliberate stop `prefixClass` takes in
// NickText, since no stylesheet in `themes/` answers for it yet.
const CLASSIC_TIER_CLASS: Record<string, string> = {
  "@": "member-op",
  "%": "member-halfop",
  "+": "member-voiced",
};

const tierClass = (modes: string[], rank: readonly string[]): string =>
  CLASSIC_TIER_CLASS[memberSigil(modes, rank)] ?? "member-plain";

// Translate member modes to the NickText prefix glyph contract.
// memberSigil/1 returns " " for plain (column-alignment in the
// pre-BC2 single-color render); NickText's PrefixGlyph union treats
// plain as `""` so the irssi-style two-part nick render doesn't
// inject a leading whitespace span. The sigil column-alignment
// concern is moot now that the prefix gets its own bold-colored
// span (the `@` / `%` / `+` chars are wider than a space anyway, so
// the pre-existing alignment was approximate; per-mode color makes
// the tier obvious without the padding).
const sigilToPrefix = (modes: string[], rank: readonly string[]): PrefixGlyph => {
  const sigil = memberSigil(modes, rank);
  return sigil === " " ? "" : sigil;
};

// M2 — the gender badge glyph, or "" when unknown/unset (no badge
// rendered). ♂/♀ are the long-standing symbols; ⚧ is the widely-
// recognised transgender/non-binary glyph, used here for :nonbinary.
// Swappable in one place if a different glyph set is ever wanted.
const genderGlyph = (gender: MemberGender | null | undefined): string => {
  switch (gender) {
    case "male":
      return "♂";
    case "female":
      return "♀";
    case "nonbinary":
      return "⚧";
    default:
      return "";
  }
};

type MenuFor = { nick: string; x: number; y: number } | null;

const MembersPane: Component<Props> = (props) => {
  const key = () => channelKey(props.networkSlug, props.channelName);
  // issue 1999 — the network's advertised sigil run, highest rank first.
  // Drives BOTH the sort tier and the rendered glyph, so the order of the
  // pane and the sigil on each row can never disagree. Reactive: a 005
  // arriving after the pane mounted re-ranks it.
  const rank = createMemo((): string[] => sigilRankForSlug(props.networkSlug));
  // UX-4 bucket J: render order is highest advertised grade first, plain
  // last, alpha within tier (case-insensitive per RFC 2812 §2.2).
  // `sortMembers/2` owns the rule; MembersPane is the sole consumer today
  // but the helper sits in lib/members.ts alongside the data store so the
  // sort contract co-locates with the source-of-truth shape.
  // `createMemo` caches the sorted array reference across reactive
  // reads — only re-sorts when `membersByChannel`, `key()` or the rank
  // actually change (i.e. once per WS event burst per channel, not once
  // per For-each iteration).
  const list = createMemo((): MemberEntry[] =>
    sortMembers(membersByChannel()[key()] ?? [], rank()),
  );
  const state = (): string | undefined => windowStateByChannel()[key()];

  // C5.1: context menu state — which nick was right-clicked + screen coords.
  const [menuFor, setMenuFor] = createSignal<MenuFor>(null);

  // Resolve integer networkId for socket push helpers.
  const networkId = (): number | undefined =>
    networks()?.find((n) => n.slug === props.networkSlug)?.id;

  // Own-nick's modes in this channel — derived from membersByChannel
  // (same source as the rendered list; no parallel state per CLAUDE.md rule).
  //
  // Bucket F H1 fix: own-nick is the per-network IRC nick from
  // `ownNickForNetwork(net, me)`, NOT `displayNick(me)` which returns the
  // operator account name for users. The two diverge after NickServ ghost
  // recovery (account "vjt", IRC nick "vjt-grappa") OR when the account
  // name happens to match a peer's IRC nick on a network where the
  // operator's configured nick is something else — pre-fix the lookup
  // returned that peer's modes and op-gated UserContextMenu items
  // surfaced as enabled when the operator does NOT actually hold @ on
  // this channel. See lib/api.ts ownNickForNetwork docstring for the
  // canonical resolution rules.
  const ownModes = (): string[] => {
    const me = user();
    if (!me) return [];
    const net = networkBySlug(props.networkSlug);
    if (!net) return [];
    const nick = ownNickForNetwork(net, me);
    if (!nick) return [];
    const entry = list().find((m) => nickEquals(m.nick, nick, casemappingForNetwork(net.id)));
    return entry?.modes ?? [];
  };

  const onContextMenu = (e: MouseEvent, nick: string): void => {
    e.preventDefault();
    setMenuFor({ nick, x: e.clientX, y: e.clientY });
  };

  // Spec #5 — left-click on a member opens a query window for that nick
  // AND switches focus. Mirrors UserContextMenu's "Query" item verb so
  // both entry points (left-click, right-click submenu) compose the same
  // pair of stores. Race-safe: skip when networks() hasn't resolved
  // (members can render slightly ahead of the networks list during the
  // first paint after /join — left-click before that resolves should be
  // a no-op, not a crash).
  const onClick = (nick: string): void => {
    const nid = networkId();
    if (nid === undefined) return;
    // canonicalQueryNick wraps to keep focus on an existing
    // case-insensitive match (RFC 2812 §2.2). NAMES casing can drift
    // from the originally-opened query window's stored casing
    // (NickServ ghost recover, mid-conversation /nick foo → /nick FOO);
    // without this wrap a member-left-click would phantom-focus a
    // ChannelKey no sidebar row knows about.
    const canonical = canonicalQueryNick(nid, nick);
    openQueryWindowState(nid, canonical, new Date().toISOString());
    setSelectedChannel({
      networkSlug: props.networkSlug,
      channelName: canonical,
      kind: "query",
    });
    // UX-5 BV — fire AFTER the query verbs succeed so a network-
    // unresolved no-op above leaves the drawer untouched (mirrors
    // selection's no-op in the same branch).
    props.onMemberSelect?.();
  };

  const closeMenu = (): void => {
    setMenuFor(() => null);
  };

  // issue 2346 — a hold on a member opens the same menu a right-click does,
  // for the touch devices that send no `contextmenu` of their own (iOS).
  let paneRef: HTMLDivElement | undefined;
  onMount(() => {
    if (paneRef) onCleanup(bindNickLongPress(paneRef, ".member-name"));
  });

  return (
    <div class="members-pane" ref={paneRef}>
      <h3>members ({list().length})</h3>
      <Show when={state() === "joined"} fallback={<p class="muted">not joined</p>}>
        <Show when={list().length > 0} fallback={<p class="muted">loading…</p>}>
          <ul>
            <For each={list()}>
              {(m) => (
                <li class={tierClass(m.modes, rank())}>
                  <button
                    type="button"
                    class="member-name"
                    onClick={() => onClick(m.nick)}
                    onContextMenu={(e) => onContextMenu(e, m.nick)}
                  >
                    {/* #443 — colored nicklist opt-in (off by default). When
                        on, drop `noColor` so NickText applies the per-nick
                        hash hue; the mode-prefix glyph keeps its tier color
                        either way. Reading the signal here re-renders the
                        open list live on toggle. */}
                    <NickText
                      nick={m.nick}
                      prefix={sigilToPrefix(m.modes, rank())}
                      noColor={!getColoredNicklist()}
                    />
                    {/* M2 — gender badge, text content (not CSS ::before)
                        matching the mode-prefix convention above; renders
                        nothing when unknown/unset. */}
                    <Show when={genderGlyph(m.gender)}>
                      {(glyph) => <span class="member-gender">{glyph()}</span>}
                    </Show>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
      <Show when={menuFor()}>
        {(mf) => {
          const nid = networkId();
          if (nid === undefined) return null;
          return (
            <UserContextMenu
              networkSlug={props.networkSlug}
              networkId={nid}
              channelName={props.channelName}
              targetNick={mf().nick}
              targetHost={null}
              ownModes={ownModes()}
              position={{ x: mf().x, y: mf().y }}
              onClose={closeMenu}
            />
          );
        }}
      </Show>
    </div>
  );
};

export default MembersPane;
