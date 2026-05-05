import { type Component, For, Show } from "solid-js";
import { postPart } from "./lib/api";
import { token } from "./lib/auth";
import { channelKey } from "./lib/channelKey";
import { mentionCounts } from "./lib/mentions";
import { channelsBySlug, networks } from "./lib/networks";
import { closeQueryWindowState, queryWindowsByNetwork } from "./lib/queryWindows";
import { selectedChannel, setSelectedChannel, unreadCounts } from "./lib/selection";

// Left-pane sidebar: network → window tree. Renders ordered windows:
//   1. Server (always present, not closeable)
//   2. Channels (from IRC JOIN state; closeable via PART)
//   3. Query windows (DM targets; closeable via close_query_window event)
//   4. Ephemeral pseudo-windows (list, mentions) when present
//
// Close behavior per kind (spec #6):
//   - server   → no X button rendered
//   - channel  → X button → postPart REST (PART IRC command)
//   - query    → X button → closeQueryWindowState (server deletes row)
//   - list     → X button → client-side dismiss (no server call)
//   - mentions → X button → client-side dismiss (no server call)
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

  const handleCloseChannel = (slug: string, channelName: string) => {
    const t = token();
    if (!t) return;
    void postPart(t, slug, channelName);
  };

  const handleCloseQuery = (networkId: number, targetNick: string) => {
    closeQueryWindowState(networkId, targetNick);
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
              {/* Server window — always present, not closeable */}
              <li classList={{ selected: isSelected(network.slug, ":server") }}>
                <button
                  type="button"
                  onClick={() => handleClick(network.slug, ":server")}
                  class="sidebar-window-btn"
                >
                  <span class="sidebar-channel-name">Server</span>
                </button>
              </li>

              {/* Channel windows */}
              <For each={channelsBySlug()?.[network.slug] ?? []}>
                {(channel) => {
                  const key = channelKey(network.slug, channel.name);
                  return (
                    <li classList={{ selected: isSelected(network.slug, channel.name) }}>
                      <button
                        type="button"
                        onClick={() => handleClick(network.slug, channel.name)}
                        class="sidebar-window-btn"
                      >
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
                      <button
                        type="button"
                        class="sidebar-close"
                        aria-label={`Close ${channel.name}`}
                        onClick={() => handleCloseChannel(network.slug, channel.name)}
                      >
                        ×
                      </button>
                    </li>
                  );
                }}
              </For>

              {/* Query (DM) windows */}
              <For each={queryWindowsByNetwork()[network.id] ?? []}>
                {(qw) => {
                  const key = channelKey(network.slug, qw.targetNick);
                  return (
                    <li classList={{ selected: isSelected(network.slug, qw.targetNick) }}>
                      <button
                        type="button"
                        onClick={() => handleClick(network.slug, qw.targetNick)}
                        class="sidebar-window-btn"
                      >
                        <span class="sidebar-channel-name">{qw.targetNick}</span>
                        <Show when={(unreadCounts()[key] ?? 0) > 0}>
                          <span class="sidebar-unread">{unreadCounts()[key]}</span>
                        </Show>
                        <Show when={(mentionCounts()[key] ?? 0) > 0}>
                          <span class="sidebar-mention">@{mentionCounts()[key]}</span>
                        </Show>
                      </button>
                      <button
                        type="button"
                        class="sidebar-close"
                        aria-label={`Close DM with ${qw.targetNick}`}
                        onClick={() => handleCloseQuery(network.id, qw.targetNick)}
                      >
                        ×
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
