import { type Component, For, Show } from "solid-js";
import { postPart } from "./lib/api";
import { token } from "./lib/auth";
import { awayByNetwork } from "./lib/awayStatus";
import { channelKey } from "./lib/channelKey";
import { mentionCounts } from "./lib/mentions";
import { channelsBySlug, networks } from "./lib/networks";
import { closeQueryWindowState, queryWindowsByNetwork } from "./lib/queryWindows";
import { eventsUnread, messagesUnread, selectedChannel, setSelectedChannel } from "./lib/selection";
import type { WindowKind } from "./lib/windowKinds";

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

  const handleClick = (slug: string, name: string, kind: WindowKind) => {
    setSelectedChannel({ networkSlug: slug, channelName: name, kind });
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
            <h3>
              {network.slug}
              {/* C8.3 — away visual indicator. Shows [away] badge when the
                  user is in away state on this network. Driven by the
                  away_confirmed server event via awayStatus.ts. */}
              <Show when={awayByNetwork()[network.slug]}>
                <span class="sidebar-away-badge">[away]</span>
              </Show>
            </h3>
            <ul>
              {/* Server window — always present, not closeable */}
              <li classList={{ selected: isSelected(network.slug, "$server") }}>
                <button
                  type="button"
                  onClick={() => handleClick(network.slug, "$server", "server")}
                  class="sidebar-window-btn"
                >
                  <span class="sidebar-channel-name">Server</span>
                  {/* CP13 — server-window receives :notice rows for server-routed
                      numerics + NickServ + MOTD + ChanServ-fallback. Same badge
                      treatment as channels so unread counts surface uniformly. */}
                  {(() => {
                    const key = channelKey(network.slug, "$server");
                    return (
                      <>
                        <Show when={(messagesUnread()[key] ?? 0) > 0}>
                          <span class="sidebar-msg-unread">{messagesUnread()[key]}</span>
                        </Show>
                        <Show when={(eventsUnread()[key] ?? 0) > 0}>
                          <span class="sidebar-events-unread">{eventsUnread()[key]}</span>
                        </Show>
                        <Show when={(mentionCounts()[key] ?? 0) > 0}>
                          <span class="sidebar-mention">@{mentionCounts()[key]}</span>
                        </Show>
                      </>
                    );
                  })()}
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
                        onClick={() => handleClick(network.slug, channel.name, "channel")}
                        class="sidebar-window-btn"
                      >
                        <span class="sidebar-channel-name" classList={{ parted: !channel.joined }}>
                          {channel.name}
                        </span>
                        <Show when={(messagesUnread()[key] ?? 0) > 0}>
                          <span class="sidebar-msg-unread">{messagesUnread()[key]}</span>
                        </Show>
                        <Show when={(eventsUnread()[key] ?? 0) > 0}>
                          <span class="sidebar-events-unread">{eventsUnread()[key]}</span>
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
                        onClick={() => handleClick(network.slug, qw.targetNick, "query")}
                        class="sidebar-window-btn"
                      >
                        <span class="sidebar-channel-name">{qw.targetNick}</span>
                        <Show when={(messagesUnread()[key] ?? 0) > 0}>
                          <span class="sidebar-msg-unread">{messagesUnread()[key]}</span>
                        </Show>
                        <Show when={(eventsUnread()[key] ?? 0) > 0}>
                          <span class="sidebar-events-unread">{eventsUnread()[key]}</span>
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
