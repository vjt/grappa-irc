import type { Component } from "solid-js";
import { channelKey } from "./lib/channelKey";
import { membersByChannel } from "./lib/members";

// Top bar of the middle pane. Hosts:
//  * left ☰ hamburger — opens the channel sidebar drawer (mobile only)
//  * channel name (bold accent)
//  * topic placeholder (P4-1 ships empty; topic-derivation store lands
//    in M-cluster polish — current state.topic isn't surfaced via the
//    REST/WS contract today, so the bar reserves space for it)
//  * nick count from members.length
//  * right ☰ hamburger — opens members drawer (mobile only)
//  * ⚙ settings button — opens SettingsDrawer
//
// Hamburger buttons use display: none on desktop via CSS media query;
// visible at ≤768px. Same DOM in both layouts so Shell.tsx doesn't have
// to branch on isMobile() for layout — purely a CSS swap.

export type Props = {
  networkSlug: string;
  channelName: string;
  onToggleSidebar: () => void;
  onToggleMembers: () => void;
  onOpenSettings: () => void;
};

const TopicBar: Component<Props> = (props) => {
  const key = () => channelKey(props.networkSlug, props.channelName);
  const memberCount = () => membersByChannel()[key()]?.length ?? 0;

  return (
    <div class="topic-bar">
      <button
        type="button"
        class="topic-bar-hamburger"
        aria-label="open channel sidebar"
        onClick={props.onToggleSidebar}
      >
        ☰
      </button>
      <span class="topic-bar-channel">{props.channelName}</span>
      <span class="topic-bar-topic">{/* P4-1 placeholder; topic store in M-cluster */}</span>
      <span class="topic-bar-count">{memberCount()} nicks</span>
      <button
        type="button"
        class="topic-bar-hamburger"
        aria-label="open members sidebar"
        onClick={props.onToggleMembers}
      >
        ☰
      </button>
      <button
        type="button"
        class="topic-bar-settings"
        aria-label="open settings"
        onClick={props.onOpenSettings}
      >
        ⚙
      </button>
    </div>
  );
};

export default TopicBar;
