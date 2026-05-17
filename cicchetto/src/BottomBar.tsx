import { type Component, createEffect, For, on, Show } from "solid-js";
import { loadArchive, setArchiveModalNetwork, visibleArchiveForNetwork } from "./lib/archive";
import { channelKey } from "./lib/channelKey";
import { keepKeyboardOnPointerDown } from "./lib/keepKeyboard";
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

  // UX-2 (2026-05-17) — eager-load archive per network on mobile so
  // the chip can decide visibility. Desktop's `<details>` lazy-loads
  // on user expand; the mobile bottom-bar has no expand affordance
  // (the chip IS the trigger), so the only way to know "should I
  // render this chip?" is to fetch the list up-front. `loadArchive`
  // is idempotent + cheap (server returns an empty list when there's
  // nothing archived), and the result is cached per identity rotation.
  //
  // Re-runs only when the `networks()` resource refetches (rare —
  // create/delete/refresh). createResource itself does not re-fire
  // unless its source signal changes, so this is not a per-render
  // cost. If a future heartbeat starts touching networks() more
  // aggressively, narrow this to a diff of new slugs only.
  createEffect(() => {
    for (const net of networks() ?? []) {
      void loadArchive(net.slug);
    }
  });

  const archiveCount = (slug: string, networkId: number): number =>
    visibleArchiveForNetwork(slug, networkId).length;

  // UX-3 NON — keep the iOS on-screen keyboard up across tab switches.
  // Shared helper extracted to `lib/keepKeyboard.ts` so the scroll-to-
  // bottom arrow (UX-3 BIS-DEC) can use the same trick.
  const keepKeyboard = keepKeyboardOnPointerDown;

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
              onPointerDown={keepKeyboard}
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
                  <>
                    <button
                      type="button"
                      role="tab"
                      class="bottom-bar-tab bottom-bar-tab-with-close"
                      classList={{
                        selected: isSelected(network.slug, channel.name),
                        parted: !channel.joined,
                      }}
                      onPointerDown={keepKeyboard}
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
                      onPointerDown={keepKeyboard}
                      onClick={() => closeChannelWindow(network.slug, channel.name)}
                    >
                      ×
                    </button>
                  </>
                );
              }}
            </For>

            {/* Query (DM) windows */}
            <For each={queryWindowsByNetwork()[network.id] ?? []}>
              {(qw) => {
                const key = channelKey(network.slug, qw.targetNick);
                return (
                  <>
                    <button
                      type="button"
                      role="tab"
                      class="bottom-bar-tab bottom-bar-tab-with-close"
                      classList={{ selected: isSelected(network.slug, qw.targetNick) }}
                      onPointerDown={keepKeyboard}
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
                      onPointerDown={keepKeyboard}
                      onClick={() => closeQueryWindow(network.id, qw.targetNick)}
                    >
                      ×
                    </button>
                  </>
                );
              }}
            </For>

            {/* UX-2 (2026-05-17) — Archive chip per network. Visible only
                when this network has at least one archived (non-active)
                entry. Tap opens `ArchiveModal` for this slug — full
                overlay with per-row × delete via UX-1's verbs. The
                effect above eagerly loads archive for every network so
                this signal flips on as soon as the server responds. */}
            {(() => {
              const count = archiveCount(network.slug, network.id);
              return (
                <Show when={count > 0}>
                  <button
                    type="button"
                    class="bottom-bar-archive-chip"
                    aria-label={`Open archive for ${network.slug}`}
                    onPointerDown={keepKeyboard}
                    onClick={() => setArchiveModalNetwork(network.slug)}
                  >
                    <span class="bottom-bar-archive-chip-icon" aria-hidden="true">
                      📁
                    </span>
                    <span class="bottom-bar-archive-chip-label">Archive</span>
                    <span class="bottom-bar-archive-chip-count">{count}</span>
                  </button>
                </Show>
              );
            })()}
          </div>
        )}
      </For>
    </div>
  );
};

export default BottomBar;
