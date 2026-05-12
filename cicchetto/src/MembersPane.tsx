import { type Component, createSignal, For, Show } from "solid-js";
import { ownNickForNetwork } from "./lib/api";
import { channelKey } from "./lib/channelKey";
import { memberSigil } from "./lib/memberSigil";
import { type MemberEntry, membersByChannel } from "./lib/members";
import { networkBySlug, networks, user } from "./lib/networks";
import { nickEquals } from "./lib/nickEquals";
import { openQueryWindowState } from "./lib/queryWindows";
import { setSelectedChannel } from "./lib/selection";
import { windowStateByChannel } from "./lib/windowState";
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
};

const tierClass = (modes: string[]): string => {
  if (modes.includes("@")) return "member-op";
  if (modes.includes("+")) return "member-voiced";
  return "member-plain";
};

type MenuFor = { nick: string; x: number; y: number } | null;

const MembersPane: Component<Props> = (props) => {
  const key = () => channelKey(props.networkSlug, props.channelName);
  const list = (): MemberEntry[] => membersByChannel()[key()] ?? [];
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
    const entry = list().find((m) => nickEquals(m.nick, nick));
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
    openQueryWindowState(nid, nick, new Date().toISOString());
    setSelectedChannel({
      networkSlug: props.networkSlug,
      channelName: nick,
      kind: "query",
    });
  };

  const closeMenu = (): void => {
    setMenuFor(() => null);
  };

  return (
    <div class="members-pane">
      <h3>members ({list().length})</h3>
      <Show when={state() === "joined"} fallback={<p class="muted">not joined</p>}>
        <Show when={list().length > 0} fallback={<p class="muted">loading…</p>}>
          <ul>
            <For each={list()}>
              {(m) => (
                <li class={tierClass(m.modes)}>
                  <button
                    type="button"
                    class="member-name"
                    onClick={() => onClick(m.nick)}
                    onContextMenu={(e) => onContextMenu(e, m.nick)}
                  >
                    {memberSigil(m.modes)}
                    {m.nick}
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
