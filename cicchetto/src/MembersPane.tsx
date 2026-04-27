import { type Component, createEffect, For, Show } from "solid-js";
import { channelKey } from "./lib/channelKey";
import { loadMembers, type MemberEntry, membersByChannel } from "./lib/members";

// Right-pane member list. Reads from `membersByChannel`; renders each
// entry with a mode-tier class (.member-op / .member-voiced /
// .member-plain) that the stylesheet uses to colour the nick + emit a
// prefix (@ / + / space) via ::before.
//
// Loads via the once-per-channel gate on first render of a (slug,
// channel) pair. The store itself filters out re-fetches.

export type Props = {
  networkSlug: string;
  channelName: string;
};

const tierClass = (modes: string[]): string => {
  if (modes.includes("@")) return "member-op";
  if (modes.includes("+")) return "member-voiced";
  return "member-plain";
};

const MembersPane: Component<Props> = (props) => {
  const key = () => channelKey(props.networkSlug, props.channelName);
  const list = (): MemberEntry[] => membersByChannel()[key()] ?? [];

  // Load on first render of a (slug, channel) pair. The verb's once-
  // per-channel gate handles repeated mounts (channel re-selection).
  createEffect(() => {
    void loadMembers(props.networkSlug, props.channelName);
  });

  return (
    <div class="members-pane">
      <h3>members ({list().length})</h3>
      <Show when={list().length > 0} fallback={<p class="muted">no members yet</p>}>
        <ul>
          <For each={list()}>{(m) => <li class={tierClass(m.modes)}>{m.nick}</li>}</For>
        </ul>
      </Show>
    </div>
  );
};

export default MembersPane;
