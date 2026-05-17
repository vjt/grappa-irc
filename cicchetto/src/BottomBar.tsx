import { type Component, createEffect, For, on, Show } from "solid-js";
import { channelKey } from "./lib/channelKey";
import { mentionCounts } from "./lib/mentions";
import { channelsBySlug, networks } from "./lib/networks";
import { queryWindowsByNetwork } from "./lib/queryWindows";
import { eventsUnread, messagesUnread, selectedChannel, setSelectedChannel } from "./lib/selection";
import { closeChannelWindow, closeQueryWindow } from "./lib/windowClose";
import type { WindowKind } from "./lib/windowKinds";
import { SERVER_WINDOW_NAME } from "./lib/windowKinds";

// BottomBar: mobile-only window picker rendered UNDER ComposeBox.
//
// Spec #10 mobile layout. Horizontally scrollable strip with per-network
// sections. Ordering within each network: server → channels → queries.
// (Mentions/list pseudo-windows are C5 spec gap #4 — not wired yet; they
// don't appear in BottomBar for C6. Documented.)
//
// Reuses the same data stores as Sidebar (networks(), channelsBySlug(),
// queryWindowsByNetwork()) and the same selection verb (setSelectedChannel).
// One feature, one code path — total consistency. Close × helpers are
// shared with Sidebar via lib/windowClose.ts (iOS-3 added the mobile
// affordance; previous mobile-only X-button omission reversed).
//
// Server window has NO close × — always-present per network.
//
// Horizontal scroll: overflow-x: auto on .bottom-bar; native touch
// momentum via the browser default. Active-tab auto-scroll-into-view
// fires via createEffect on selectedChannel.
//
// Display gating: Shell renders <BottomBar /> ONLY inside the mobile JSX
// branch (isMobile() === true), so no CSS display:none guard is needed
// inside this component.

export type Props = {
  onSelect?: () => void;
};

const BottomBar: Component<Props> = (props) => {
  let navRef: HTMLDivElement | undefined;

  const isSelected = (slug: string, name: string): boolean => {
    const s = selectedChannel();
    return s !== null && s.networkSlug === slug && s.channelName === name;
  };

  const handleClick = (slug: string, name: string, kind: WindowKind) => {
    setSelectedChannel({ networkSlug: slug, channelName: name, kind });
    props.onSelect?.();
  };

  // Auto-scroll selected tab into view when selection changes.
  // Uses scrollIntoView with inline:"nearest" so we don't disrupt
  // vertical scroll (the bottom-bar is horizontal-scroll only).
  // Guard: jsdom does not implement scrollIntoView; the guard is a
  // no-op in tests without weakening production behavior.
  createEffect(
    on(selectedChannel, () => {
      if (!navRef) return;
      const selected = navRef.querySelector<HTMLElement>(".bottom-bar-tab.selected");
      if (selected && typeof selected.scrollIntoView === "function") {
        selected.scrollIntoView({ inline: "nearest", behavior: "smooth", block: "nearest" });
      }
    }),
  );

  return (
    <div class="bottom-bar" role="tablist" ref={navRef}>
      <For each={networks()}>
        {(network) => (
          <div class="bottom-bar-network">
            <span class="bottom-bar-network-chip">{network.slug}</span>

            {/* Server window — always present per network */}
            <button
              type="button"
              role="tab"
              class="bottom-bar-tab"
              classList={{ selected: isSelected(network.slug, SERVER_WINDOW_NAME) }}
              onClick={() => handleClick(network.slug, SERVER_WINDOW_NAME, "server")}
            >
              Server
              {/* CP13 — server-window receives :notice rows for server-routed
                  numerics + NickServ + MOTD + ChanServ-fallback. Same badge
                  treatment as channels so unread counts surface uniformly. */}
              {(() => {
                const key = channelKey(network.slug, SERVER_WINDOW_NAME);
                return (
                  <>
                    <Show when={(messagesUnread()[key] ?? 0) > 0}>
                      <span class="bottom-bar-msg-unread">{messagesUnread()[key]}</span>
                    </Show>
                    <Show when={(eventsUnread()[key] ?? 0) > 0}>
                      <span class="bottom-bar-events-unread">{eventsUnread()[key]}</span>
                    </Show>
                    <Show when={(mentionCounts()[key] ?? 0) > 0}>
                      <span class="bottom-bar-mention">@{mentionCounts()[key]}</span>
                    </Show>
                  </>
                );
              })()}
            </button>

            {/* Channel windows */}
            <For each={channelsBySlug()?.[network.slug] ?? []}>
              {(channel) => {
                const key = channelKey(network.slug, channel.name);
                return (
                  <span class="bottom-bar-tab-wrap">
                    <button
                      type="button"
                      role="tab"
                      class="bottom-bar-tab"
                      classList={{
                        selected: isSelected(network.slug, channel.name),
                        parted: !channel.joined,
                      }}
                      onClick={() => handleClick(network.slug, channel.name, "channel")}
                    >
                      {channel.name}
                      <Show when={(messagesUnread()[key] ?? 0) > 0}>
                        <span class="bottom-bar-msg-unread">{messagesUnread()[key]}</span>
                      </Show>
                      <Show when={(eventsUnread()[key] ?? 0) > 0}>
                        <span class="bottom-bar-events-unread">{eventsUnread()[key]}</span>
                      </Show>
                      <Show when={(mentionCounts()[key] ?? 0) > 0}>
                        <span class="bottom-bar-mention">@{mentionCounts()[key]}</span>
                      </Show>
                    </button>
                    <button
                      type="button"
                      class="bottom-bar-close"
                      aria-label={`Close ${channel.name}`}
                      onClick={() => closeChannelWindow(network.slug, channel.name)}
                    >
                      ×
                    </button>
                  </span>
                );
              }}
            </For>

            {/* Query (DM) windows */}
            <For each={queryWindowsByNetwork()[network.id] ?? []}>
              {(qw) => {
                const key = channelKey(network.slug, qw.targetNick);
                return (
                  <span class="bottom-bar-tab-wrap">
                    <button
                      type="button"
                      role="tab"
                      class="bottom-bar-tab"
                      classList={{ selected: isSelected(network.slug, qw.targetNick) }}
                      onClick={() => handleClick(network.slug, qw.targetNick, "query")}
                    >
                      {qw.targetNick}
                      <Show when={(messagesUnread()[key] ?? 0) > 0}>
                        <span class="bottom-bar-msg-unread">{messagesUnread()[key]}</span>
                      </Show>
                      <Show when={(eventsUnread()[key] ?? 0) > 0}>
                        <span class="bottom-bar-events-unread">{eventsUnread()[key]}</span>
                      </Show>
                      <Show when={(mentionCounts()[key] ?? 0) > 0}>
                        <span class="bottom-bar-mention">@{mentionCounts()[key]}</span>
                      </Show>
                    </button>
                    <button
                      type="button"
                      class="bottom-bar-close"
                      aria-label={`Close DM with ${qw.targetNick}`}
                      onClick={() => closeQueryWindow(network.id, qw.targetNick)}
                    >
                      ×
                    </button>
                  </span>
                );
              }}
            </For>
          </div>
        )}
      </For>
    </div>
  );
};

export default BottomBar;
