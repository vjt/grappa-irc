import { type Component, createSignal, Show } from "solid-js";
import { channelKey } from "./lib/channelKey";
import { compactModeString, modesByChannel, topicByChannel } from "./lib/channelTopic";
import { membersByChannel } from "./lib/members";
import { mircPlainText } from "./lib/mircFormat";
import { openModeModal } from "./lib/modeModal";
import { createOverlayLock } from "./lib/overlayScrollLock";
import { channelPresenceVisible, setChannelPresencePref } from "./lib/presenceFilter";
import { windowIsJoined } from "./lib/windowState";
import { MircBody } from "./MircText";

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
  // #142: the `title` tooltip + the rendered strip both come from the same
  // topic. The strip routes the raw text through `MircBody` (formatting
  // renders); the tooltip is a plain-text-only attribute surface, so it
  // gets the parser-derived de-formatted text — control bytes stripped by
  // the ONE parser, never leaked raw into the attribute.
  const topicTitle = () => {
    const t = topicText();
    return t !== null ? mircPlainText(t) : "(no topic set)";
  };
  const modesEntry = () => modesByChannel()[key()] ?? null;
  const modeStr = () => {
    const entry = modesEntry();
    if (!entry) return "";
    return compactModeString(entry.modes);
  };

  const openModal = () => setModalState("open");
  const closeModal = () => setModalState("closed");

  // #222 — per-channel join/part/quit/nick-change suppression toggle.
  // The button flips the CURRENTLY EFFECTIVE visibility and always writes
  // an EXPLICIT pref ("show"/"hide"), which by the precedence rule WINS
  // over the size default. So one tap pins the channel regardless of its
  // member count. Reading `channelPresenceVisible` (which tracks the pref
  // signal) here keeps the label/icon reactive to the toggle. The member
  // count feeds the size-default arm for a channel with no explicit pref
  // yet (the icon reflects what the operator currently sees).
  const memberCount = (): number => (membersByChannel()[key()] ?? []).length;
  const presenceShown = (): boolean => channelPresenceVisible(key(), memberCount());
  const togglePresence = (): void => {
    // Explicit-wins: write the opposite of what is currently effective.
    setChannelPresencePref(key(), presenceShown() ? "hide" : "show");
  };

  // #219-general — the topic modal covers the ScrollbackPane (fixed
  // full-viewport `.topic-modal-backdrop`). Register it with the shared
  // overlay refcount so ScrollbackPane's freeze gate engages while it is up,
  // like every other covering modal (Names/Who/Confirm/Archive/…). Without
  // this, opening the topic modal on mobile shrinks the visualViewport →
  // ScrollbackPane's resize authority → tail-snap under the covered pane.
  // The lock scroller is the modal element (matches the createOverlayLock
  // contract for iOS touch-lock; the freeze that matters here is the
  // refcount, which drives the pane's overlay-snapshot effect).
  createOverlayLock(() => modalState() === "open", ".topic-modal");

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
        title={topicTitle()}
      >
        <Show when={topicText() !== null} fallback={"(no topic set)"}>
          {/* #220 — the bar ALWAYS opens the modal first; a tap NEVER
              navigates a link directly. "surface-wins" suppresses the
              anchor's navigation and lets the click bubble to openModal.
              Links are handled inside the modal (default "navigate"). */}
          <MircBody body={topicText() ?? ""} linkPolicy="surface-wins" />
        </Show>
      </button>
      {/* Compact mode string — only rendered when modes are non-empty.
          #216: tapping it opens the /mode viewer/editor modal for this
          channel (the third entry point, alongside `/mode #chan` and
          bare `/mode`). A <button> not a <span> — a static element with
          onClick trips biome's noStaticElementInteractions (#220 lesson)
          and loses keyboard access. */}
      <Show when={modeStr().length > 0}>
        <button
          type="button"
          class="topic-bar-modes"
          title={modesEntry()?.modes.join(", ") ?? ""}
          aria-label="view channel modes"
          onClick={() => openModeModal(props.networkSlug, props.channelName)}
        >
          {modeStr()}
        </button>
      </Show>
      {/* #222 — per-channel presence-filter toggle. Suppresses (or
          re-shows) join/part/quit/nick-change rows for THIS channel; the
          choice is an explicit client pref that WINS over the large-channel
          size default and persists in localStorage. A <button> not a
          <span> — a static element with onClick trips biome's
          noStaticElementInteractions (#220) and loses keyboard access. */}
      <button
        type="button"
        class="topic-bar-presence-toggle"
        classList={{ "presence-hidden": !presenceShown() }}
        data-testid="presence-toggle"
        aria-pressed={!presenceShown()}
        title={
          presenceShown()
            ? "Hide join/part/quit for this channel"
            : "Show join/part/quit for this channel"
        }
        aria-label={
          presenceShown() ? "hide join/part/quit signalling" : "show join/part/quit signalling"
        }
        onClick={togglePresence}
      >
        {presenceShown() ? "👁" : "🙈"}
      </button>
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
            <p class="topic-modal-text">
              <Show when={topicText() !== null} fallback={"(no topic set)"}>
                <MircBody body={topicText() ?? ""} />
              </Show>
            </p>
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
