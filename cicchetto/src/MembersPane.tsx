import { type Component, createEffect, createSignal, For, Show } from "solid-js";
import { displayNick } from "./lib/api";
import { channelKey } from "./lib/channelKey";
import { loadMembers, type MemberEntry, membersByChannel } from "./lib/members";
import { networks, user } from "./lib/networks";
import UserContextMenu from "./UserContextMenu";

// Right-pane member list. Reads from `membersByChannel`; renders each
// entry with a mode-tier class (.member-op / .member-voiced /
// .member-plain) that the stylesheet uses to colour the nick + emit a
// prefix (@ / + / space) via ::before.
//
// Loads via the once-per-channel gate on first render of a (slug,
// channel) pair. The store itself filters out re-fetches.
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

  // Load on first render of a (slug, channel) pair. The verb's once-
  // per-channel gate handles repeated mounts (channel re-selection).
  createEffect(() => {
    void loadMembers(props.networkSlug, props.channelName);
  });

  // C5.1: context menu state — which nick was right-clicked + screen coords.
  const [menuFor, setMenuFor] = createSignal<MenuFor>(null);

  // Resolve integer networkId for socket push helpers.
  const networkId = (): number | undefined =>
    networks()?.find((n) => n.slug === props.networkSlug)?.id;

  // Own-nick's modes in this channel — derived from membersByChannel
  // (same source as the rendered list; no parallel state per CLAUDE.md rule).
  const ownModes = (): string[] => {
    const me = user();
    if (!me) return [];
    const ownNick = displayNick(me);
    const entry = list().find((m) => m.nick.toLowerCase() === ownNick.toLowerCase());
    return entry?.modes ?? [];
  };

  const onContextMenu = (e: MouseEvent, nick: string): void => {
    e.preventDefault();
    setMenuFor({ nick, x: e.clientX, y: e.clientY });
  };

  const closeMenu = (): void => {
    setMenuFor(() => null);
  };

  return (
    <div class="members-pane">
      <h3>members ({list().length})</h3>
      <Show when={list().length > 0} fallback={<p class="muted">no members yet</p>}>
        <ul>
          <For each={list()}>
            {(m) => (
              <li class={tierClass(m.modes)} onContextMenu={(e) => onContextMenu(e, m.nick)}>
                {m.nick}
              </li>
            )}
          </For>
        </ul>
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
