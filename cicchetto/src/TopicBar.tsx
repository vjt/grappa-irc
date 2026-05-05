import { type Component, createSignal, Show } from "solid-js";
import { channelKey } from "./lib/channelKey";
import { compactModeString, modesByChannel, topicByChannel } from "./lib/channelTopic";
import { membersByChannel } from "./lib/members";
import { isMobile } from "./lib/theme";

// Top bar of the middle pane. Hosts:
//  * left ☰ hamburger — opens the channel sidebar drawer (DESKTOP ONLY;
//    on mobile the sidebar is replaced by BottomBar, so this hamburger is
//    hidden via isMobile() gating — C6.3 single-hamburger reshape)
//  * channel name (bold accent)
//  * topic strip: single-line ellipsized; "(no topic set)" placeholder
//    when no topic is cached. Click/tap → modal expand with full topic,
//    setter nick, and set-at timestamp (C3.1).
//  * compact mode-string (e.g. "+nt") with hover tooltip listing modes.
//    Rendered only when modes are cached and non-empty (C3.1).
//  * nick count from members.length
//  * right ☰ hamburger — opens members drawer (desktop + mobile; this is
//    the SINGLE hamburger on mobile per spec #10)
//  * ⚙ settings button — opens SettingsDrawer
//
// Modal state uses `"closed" | "open"` string-literal union per the
// closed-set rule (CLAUDE.md).
//
// Always pinned at the top of the channel-window scrollback area — no
// auto-collapse on scroll (vjt-blessed 2026-05-04).
//
// C6.3: Left hamburger hidden on mobile via <Show when={!isMobile()}>. The
// right hamburger (members) remains on both desktop and mobile and becomes
// the sole hamburger on mobile — providing thumb-friendly members access
// without the channel sidebar that no longer exists on mobile.

export type Props = {
  networkSlug: string;
  channelName: string;
  onToggleSidebar: () => void;
  onToggleMembers: () => void;
  onOpenSettings: () => void;
};

type ModalState = "closed" | "open";

const TopicBar: Component<Props> = (props) => {
  const [modalState, setModalState] = createSignal<ModalState>("closed");

  const key = () => channelKey(props.networkSlug, props.channelName);
  const memberCount = () => membersByChannel()[key()]?.length ?? 0;

  const topicEntry = () => topicByChannel()[key()] ?? null;
  const topicText = () => topicEntry()?.text ?? null;
  const modesEntry = () => modesByChannel()[key()] ?? null;
  const modeStr = () => {
    const entry = modesEntry();
    if (!entry) return "";
    return compactModeString(entry.modes);
  };

  const openModal = () => setModalState("open");
  const closeModal = () => setModalState("closed");

  const formatSetAt = (setAt: string | null): string => {
    if (!setAt) return "(unknown time)";
    try {
      return new Date(setAt).toLocaleString();
    } catch {
      return setAt;
    }
  };

  return (
    <div class="topic-bar">
      {/* C6.3: left channel-sidebar hamburger hidden on mobile.
          On mobile, channels live in BottomBar — no left drawer exists.
          Only the right members hamburger survives as the single tap target. */}
      <Show when={!isMobile()}>
        <button
          type="button"
          class="topic-bar-hamburger"
          aria-label="open channel sidebar"
          onClick={props.onToggleSidebar}
        >
          ☰
        </button>
      </Show>
      <span class="topic-bar-channel">{props.channelName}</span>
      {/* Topic strip — always present; shows placeholder when no topic cached */}
      <button
        type="button"
        class="topic-bar-topic"
        onClick={openModal}
        aria-label="expand topic"
        title={topicText() ?? "(no topic set)"}
      >
        {topicText() ?? "(no topic set)"}
      </button>
      {/* Compact mode string — only rendered when modes are non-empty */}
      <Show when={modeStr().length > 0}>
        <span class="topic-bar-modes" title={modesEntry()?.modes.join(", ") ?? ""}>
          {modeStr()}
        </span>
      </Show>
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

      {/* Topic modal — opens on topic strip click; shows full topic, setter, timestamp */}
      <Show when={modalState() === "open"}>
        <div class="topic-modal-backdrop" onClick={closeModal} aria-hidden="true" />
        <div role="dialog" aria-modal="true" aria-label="Channel topic" class="topic-modal">
          <div class="topic-modal-header">
            <span class="topic-modal-title">Channel topic: {props.channelName}</span>
            <button
              type="button"
              class="topic-modal-close"
              aria-label="close topic"
              onClick={closeModal}
            >
              ✕
            </button>
          </div>
          <div class="topic-modal-body">
            <p class="topic-modal-text">{topicText() ?? "(no topic set)"}</p>
            <Show when={topicEntry() !== null}>
              <p class="topic-modal-meta">
                Set by: {topicEntry()?.set_by ?? "(unknown)"}
                {" — "}
                {formatSetAt(topicEntry()?.set_at ?? null)}
              </p>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default TopicBar;
