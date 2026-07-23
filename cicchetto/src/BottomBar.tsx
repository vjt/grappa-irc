import { type Component, createEffect, For, on, Show } from "solid-js";
import CloseButton from "./CloseButton";
import { channelKey } from "./lib/channelKey";
import { mentionCounts } from "./lib/mentions";
import { channelsBySlug, networks } from "./lib/networks";
import { queryWindowsByNetwork } from "./lib/queryWindows";
import { requestScrollToBottom } from "./lib/scrollToBottomCommand";
import {
  eventsUnread,
  isActiveSelection,
  messagesUnread,
  selectedChannel,
  setSelectedChannel,
} from "./lib/selection";
import { closeQueryWindow, confirmDisconnectNetwork, confirmLeaveChannel } from "./lib/windowClose";
import type { WindowKind } from "./lib/windowKinds";
import { SERVER_WINDOW_NAME } from "./lib/windowKinds";
import NickText from "./NickText";

// BottomBar: mobile-only window picker rendered UNDER ComposeBox.
//
// Spec #10 mobile layout. Horizontally scrollable strip with per-network
// sections. Ordering within each network: server (header) → channels →
// queries. Reuses the same data stores as Sidebar (networks(),
// channelsBySlug(), queryWindowsByNetwork()) and the same selection verb
// (setSelectedChannel). One feature, one code path — total consistency.
// Close × helpers are shared with Sidebar via lib/windowClose.ts.
//
// UX-6-E (2026-05-21) — the per-network header IS the server-window
// entry. Pre-fix narrow rendered TWO entries per network: a passive
// `.bottom-bar-network-chip` span + a standalone `.bottom-bar-tab`
// labelled "Server". That diverged from wide mode, where the
// `.sidebar-network-header` row carries the emoji ⚙️ + slug AND is the
// clickable server-window selector (kind = "server"). Narrow now mirrors
// wide: one clickable `.bottom-bar-network-header` per network. The
// disconnect × sibling matches the wide-mode UX-4-D affordance (visitor
// = quit-all / registered = park-one).
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
    const target = { networkSlug: slug, channelName: name, kind };
    // #243 — mirror Sidebar: re-tapping the ALREADY-active tab jumps the
    // scrollback to the newest message; a tab SWITCH is unchanged.
    if (isActiveSelection(target)) requestScrollToBottom();
    setSelectedChannel(target);
    props.onSelect?.();
  };

  // Auto-scroll the selected tab into view when selection changes. The
  // bottom-bar is horizontal-scroll only, so we only ever touch scrollLeft —
  // never the page's vertical scroll.
  //
  // #327 — this stacks TWO fixes:
  //
  //   1. DEFER (5d44b7f8). Selecting a window zeroes its unread/mention
  //      badges in the SAME reactive flush (selection.ts perChannelUnread
  //      reads selectedChannel), so `.bottom-bar-msg-unread` /
  //      `.bottom-bar-mention` spans unmount and the tab's width changes,
  //      reflowing the strip. Reading geometry synchronously sees STALE
  //      pre-reflow widths. So we defer via the codebase double-rAF idiom
  //      (ScrollbackPane.tsx ~:1569): the first rAF lands in the next frame's
  //      pre-layout phase, the second guarantees layout has settled. We
  //      RE-QUERY `.bottom-bar-tab.selected` INSIDE the deferred callback so
  //      it resolves against the settled DOM, not a ref captured pre-reflow.
  //
  //   2. STICKY-HEADER-AWARE scroll (#327 reopen, 2026-07-20). The network
  //      header is `position: sticky; left: 0; z-index: 1` (#260), pinned to
  //      the scroller's leading edge. `scrollIntoView({inline:"nearest"})`
  //      brings the tab flush to that same edge — i.e. UNDER the pinned
  //      header — so it stays occluded; scrollIntoView has no notion of the
  //      sticky offset. Instead compute scrollLeft manually: the visible
  //      region EXCLUDING the pinned header is [scrollerLeft + headerWidth,
  //      scrollerRight]; nudge scrollLeft only far enough to bring the tab's
  //      near edge to that boundary (left-occluded → reveal past the header;
  //      right-overflow → reveal at the right edge). Already-visible tabs
  //      (delta 0) don't scroll.
  //
  // ALL selection changes (sidebar tap, Alt+A, Ctrl+N, tab tap) funnel
  // through selectedChannel, so this one effect covers every trigger.
  //
  // Guard: jsdom implements neither scrollTo nor layout; the typeof guard +
  // zero-geometry no-op keep tests from weakening production behavior.
  createEffect(
    on(selectedChannel, () => {
      if (!navRef) return;
      const scroller = navRef;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (typeof scroller.scrollTo !== "function") return;
          const selected = scroller.querySelector<HTMLElement>(".bottom-bar-tab.selected");
          if (!selected) return;
          const header = selected
            .closest(".bottom-bar-network")
            ?.querySelector<HTMLElement>(".bottom-bar-network-header");
          const scRect = scroller.getBoundingClientRect();
          const tabRect = selected.getBoundingClientRect();
          const headerWidth = header ? header.getBoundingClientRect().width : 0;
          const visibleLeft = scRect.left + headerWidth;
          let delta = 0;
          if (tabRect.left < visibleLeft) {
            delta = tabRect.left - visibleLeft; // occluded under the sticky header
          } else if (tabRect.right > scRect.right) {
            delta = tabRect.right - scRect.right; // clipped off the right edge
          }
          if (delta !== 0) {
            scroller.scrollTo({ left: scroller.scrollLeft + delta, behavior: "smooth" });
          }
        }),
      );
    }),
  );

  return (
    <div class="bottom-bar" role="tablist" ref={navRef}>
      <For each={networks()}>
        {(network) => {
          const headerKey = channelKey(network.slug, SERVER_WINDOW_NAME);
          return (
            <div class="bottom-bar-network">
              {/* Network header = clickable server-window entry.
                  Mirrors `.sidebar-network-header` on desktop: emoji + slug
                  + unread/event/mention badges. The chip itself is now a
                  button (the standalone "Server" tab is gone). */}
              <button
                type="button"
                role="tab"
                class="bottom-bar-tab bottom-bar-network-header"
                classList={{ selected: isSelected(network.slug, SERVER_WINDOW_NAME) }}
                data-network-slug={network.slug}
                onClick={() => handleClick(network.slug, SERVER_WINDOW_NAME, "server")}
              >
                <span class="bottom-bar-network-emoji" aria-hidden="true">
                  ⚙️
                </span>
                <span class="bottom-bar-network-name">{network.slug}</span>
                <Show when={(messagesUnread()[headerKey] ?? 0) > 0}>
                  <span class="bottom-bar-msg-unread">{messagesUnread()[headerKey]}</span>
                </Show>
                <Show when={(eventsUnread()[headerKey] ?? 0) > 0}>
                  <span class="bottom-bar-events-unread">{eventsUnread()[headerKey]}</span>
                </Show>
                <Show when={(mentionCounts()[headerKey] ?? 0) > 0}>
                  <span class="bottom-bar-mention">@{mentionCounts()[headerKey]}</span>
                </Show>
              </button>
              {/* Disconnect × — sibling of the header, same flat-flex
                  discipline as channel/query closes (post-UX-3-DEC).
                  Routes through disconnectNetwork → quitAll for visitors,
                  PATCH-one for registered users. #195: the most destructive
                  close — gated behind an explicit "Disconnect from <slug>?"
                  confirm modal so an accidental tap can't nuke the network. */}
              <CloseButton
                class="bottom-bar-close"
                ariaLabel={`Disconnect ${network.slug}`}
                onConfirm={() => confirmDisconnectNetwork(network.slug)}
              />

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
                        data-window-name={channel.name}
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
                      <CloseButton
                        class="bottom-bar-close"
                        ariaLabel={`Close ${channel.name}`}
                        onConfirm={() => confirmLeaveChannel(network.slug, channel.name)}
                      />
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
                        data-window-name={qw.targetNick}
                        onClick={() => handleClick(network.slug, qw.targetNick, "query")}
                      >
                        <NickText nick={qw.targetNick} extraClass="bottom-bar-tab-nick" />
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
                      <CloseButton
                        class="bottom-bar-close"
                        ariaLabel={`Close DM with ${qw.targetNick}`}
                        onConfirm={() => closeQueryWindow(network.id, qw.targetNick)}
                      />
                    </>
                  );
                }}
              </For>
            </div>
          );
        }}
      </For>
    </div>
  );
};

export default BottomBar;
