import { type Component, createSignal, Show } from "solid-js";
import { channelKey } from "./lib/channelKey";
import { compactModeString, modesByChannel, topicByChannel } from "./lib/channelTopic";
import { windowIsJoined } from "./lib/windowState";

// Top bar of the middle pane. Hosts:
//  * channel name (bold accent)
//  * topic strip: single-line ellipsized; "(no topic set)" placeholder
//    when no topic is cached. Click/tap → modal expand with full topic,
//    setter nick, and set-at timestamp (C3.1).
//  * compact mode-string (e.g. "+nt") with hover tooltip listing modes.
//    Rendered only when modes are cached and non-empty (C3.1).
//  * right ☰ hamburger — opens members drawer (desktop + mobile)
//
// UX-4 bucket L (2026-05-19): the settings cog AND the left channel-
// sidebar hamburger moved out of TopicBar into the cluster-wide
// ShellChrome bar — both the cog and the sidebar toggle must be
// reachable from every window kind, not just channel windows.
// TopicBar now renders only the topic / mode info + the members
// hamburger (channel-specific, has no analog in non-channel windows
// so stays here).
//
// UX-5 bucket BT (2026-05-19): the "X nicks" count strip was dropped
// (vjt 2026-05-19 dogfood — "useless"). The right MembersPane is the
// source of truth for member-count surfacing; the topic-bar didn't
// need a duplicate, and dropping it tightens the row on narrow
// viewports where every pixel matters.
//
// UX-5 bucket BM (2026-05-20): the optional `inlineChromeSlot` prop
// that BT introduced (mobile-channel rendered ChromeButtons inline
// here to absorb archive + cog from the dropped standalone chrome
// row) was dropped — BM moves archive + cog into the mobile members
// drawer footer as launchers, so the topic-bar's right edge holds
// ONLY the hamburger again. Three buttons on a narrow row was
// crowded; one button + drawer-as-panel is the new shape.
//
// Modal state uses `"closed" | "open"` string-literal union per the
// closed-set rule (CLAUDE.md).
//
// Always pinned at the top of the channel-window scrollback area — no
// auto-collapse on scroll (vjt-blessed 2026-05-04).

export type Props = {
  networkSlug: string;
  channelName: string;
  onToggleMembers: () => void;
};

type ModalState = "closed" | "open";

const TopicBar: Component<Props> = (props) => {
  const [modalState, setModalState] = createSignal<ModalState>("closed");

  const key = () => channelKey(props.networkSlug, props.channelName);

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
      {/* UX-4 bucket L (2026-05-19): TopicBar's left channel-sidebar
          hamburger was dropped (sidebar is always-visible on desktop,
          not rendered on mobile — no toggle needed). The settings cog
          moved out of TopicBar into ShellChrome (always-visible bar
          above) per the cluster-wide "settings cog reachable from
          every window" rule.
          UX-5 bucket A (2026-05-19): ShellChrome's own hamburger was
          also dropped — it was a desktop no-op and duplicated this
          bar's right members hamburger on mobile. TopicBar's
          `.topic-bar-hamburger` below (channel-only, CSS-hidden on
          desktop via @media) is now the SINGLE hamburger across the
          whole shell. */}
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
      {/* Members hamburger only when actively joined. Parked / failed
          / kicked channels have stale or absent member lists; the
          right pane is suppressed in Shell.tsx for the same reason —
          this hides the toggle that would otherwise dangle. */}
      <Show when={windowIsJoined(key())}>
        <button
          type="button"
          class="topic-bar-hamburger"
          aria-label="open members sidebar"
          onClick={props.onToggleMembers}
        >
          ☰
        </button>
      </Show>

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
