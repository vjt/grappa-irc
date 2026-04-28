import { type Component, For, Show } from "solid-js";
import { channelKey } from "./lib/channelKey";
import { mentionCounts } from "./lib/mentions";
import { channelsBySlug, networks } from "./lib/networks";
import { selectedChannel, setSelectedChannel, unreadCounts } from "./lib/selection";

// Left-pane sidebar: network → channel tree. Consumes the post-A5
// ChannelEntry shape (joined + source); parted channels render greyed
// + italic via .parted class. Unread count + mention badge are
// separate visual signals (count = blue accent pill; mention = red
// pill).
//
// onSelect is fired AFTER the selection state is updated — Shell.tsx
// uses it to auto-close the mobile sidebar drawer.

export type Props = {
  onSelect?: () => void;
};

const Sidebar: Component<Props> = (props) => {
  const isSelected = (slug: string, name: string): boolean => {
    const s = selectedChannel();
    return s !== null && s.networkSlug === slug && s.channelName === name;
  };

  const handleClick = (slug: string, name: string) => {
    setSelectedChannel({ networkSlug: slug, channelName: name });
    props.onSelect?.();
  };

  return (
    <Show
      when={(networks()?.length ?? 0) > 0}
      fallback={<p class="muted sidebar-empty">no networks</p>}
    >
      <For each={networks()}>
        {(network) => (
          <section class="sidebar-network">
            <h3>{network.slug}</h3>
            <ul>
              <For each={channelsBySlug()?.[network.slug] ?? []}>
                {(channel) => {
                  const key = channelKey(network.slug, channel.name);
                  return (
                    <li classList={{ selected: isSelected(network.slug, channel.name) }}>
                      <button type="button" onClick={() => handleClick(network.slug, channel.name)}>
                        <span class="sidebar-channel-name" classList={{ parted: !channel.joined }}>
                          {channel.name}
                        </span>
                        <Show when={(unreadCounts()[key] ?? 0) > 0}>
                          <span class="sidebar-unread">{unreadCounts()[key]}</span>
                        </Show>
                        <Show when={(mentionCounts()[key] ?? 0) > 0}>
                          <span class="sidebar-mention">@{mentionCounts()[key]}</span>
                        </Show>
                      </button>
                    </li>
                  );
                }}
              </For>
            </ul>
          </section>
        )}
      </For>
    </Show>
  );
};

export default Sidebar;
