import { type Component, createSignal, Show } from "solid-js";
import { postTopic } from "./lib/api";
import { token } from "./lib/auth";
import { ownHoldsChannelEditorSigil } from "./lib/channelEditPerm";
import { channelKey } from "./lib/channelKey";
import { compactModeString, modesByChannel, topicByChannel } from "./lib/channelTopic";
import { friendlyError } from "./lib/friendlyError";
import { membersByChannel } from "./lib/members";
import { mircPlainText } from "./lib/mircFormat";
import { openModeModal } from "./lib/modeModal";
import { networkIdBySlug } from "./lib/networks";
import { createOverlayLock } from "./lib/overlayScrollLock";
import { channelPresenceVisible, setChannelPresencePref } from "./lib/presenceFilter";
import { pushChannelTopicClear } from "./lib/socket";
import { windowIsJoined } from "./lib/windowState";
import { MircBody } from "./MircText";

// Top bar of the middle pane. Hosts:
//  * channel name (bold accent)
//  * topic strip: up to TWO lines (#74), "(no topic set)" placeholder when
//    no topic is cached. Click/tap → edit the topic IN PLACE when the
//    operator can set it (#74); otherwise → read-only modal (full topic,
//    setter nick, set-at timestamp) as the non-editable fallback.
//  * compact mode-string (e.g. "+nt") with hover tooltip listing modes.
//    Rendered only when modes are cached and non-empty (C3.1).
//  * right ☰ hamburger — opens members drawer (desktop + mobile)
//
// #74 (2026-07-16) — inline topic edit. Clicking the strip on an editable
// window swaps it for an inline <input> seeded with the RAW topic; Enter
// submits, Escape/blur cancels. Submit reuses the EXISTING send doors —
// `postTopic` (REST) for a non-empty set, `pushChannelTopicClear` (WS verb)
// for an empty clear — the same doors the `/topic` compose slashes use
// (one-feature-every-door). cic mirrors the server: NO optimistic write —
// the strip repaints only when the server's relayed `topic_changed`
// updates `topicByChannel`. Editability is gated by the SAME editor-sigil
// derivation ModeModal uses (`ownHoldsChannelEditorSigil`), combined with
// the +t topic-lock: any joined member can set the topic unless +t is set,
// in which case only ops (per PREFIX rank) can. A server reject (WS-down /
// 482) surfaces inline and preserves the draft (S21 no-false-success).
//
// The read-only modal is now the FALLBACK for the non-editable case — a
// window we can't edit (not joined, or +t-locked and not op) still lets
// the operator VIEW the full topic + setter. The editable path is
// deliberately dialog-less per #74 ("no separate dialog"); the setter /
// set-at metadata surfaces only in the read-only fallback.
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
// that BT introduced was dropped — BM moves archive + cog into the
// mobile members drawer footer as launchers, so the topic-bar's right
// edge holds ONLY the hamburger again.
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
  // #74 — inline-edit state. `editing` swaps the display strip for the
  // <input>; `draft` is the operator's in-progress raw text; `editError`
  // carries the inline server-reject copy; `saving` de-bounces submit.
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [editError, setEditError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);

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

  // #74 — can the operator set this channel's topic? Any joined member can,
  // UNLESS +t (topic-lock) is set, in which case only an op (per the
  // shared PREFIX-rank editor-sigil derivation) can. Not joined → never.
  // The ircd is the real authority (482 on an unauthorized TOPIC); this
  // gate only decides whether to OFFER the inline editor vs the read-only
  // modal — a server reject is still surfaced inline on submit.
  const topicLocked = () => (modesByChannel()[key()]?.modes ?? []).includes("t");
  const canEditTopic = () => {
    if (!windowIsJoined(key())) return false;
    if (!topicLocked()) return true;
    const id = networkIdBySlug(props.networkSlug);
    if (id === undefined) return false;
    return ownHoldsChannelEditorSigil(props.networkSlug, key(), id);
  };

  const beginEdit = () => {
    setDraft(topicText() ?? "");
    setEditError(null);
    setEditing(true);
  };
  const cancelEdit = () => {
    setEditing(false);
    setDraft("");
    setEditError(null);
  };

  // Strip activation: edit-in-place when the operator can set the topic;
  // otherwise the read-only modal (view full topic + setter).
  const onStripActivate = () => {
    if (canEditTopic()) beginEdit();
    else openModal();
  };

  const submitEdit = async (): Promise<void> => {
    if (saving()) return;
    const next = draft();
    const trimmed = next.trim();
    setEditError(null);
    const id = networkIdBySlug(props.networkSlug);
    try {
      setSaving(true);
      if (trimmed === "") {
        // Empty submit = clear the topic — via the SAME WS verb the
        // `/topic -delete` slash uses (`postTopic` server-side rejects an
        // empty body). No-op when there's nothing to clear.
        const current = topicText();
        if (current === null || current === "") {
          cancelEdit();
          return;
        }
        if (id === undefined) {
          setEditError("That network doesn't exist.");
          return;
        }
        await pushChannelTopicClear(id, props.channelName);
      } else {
        const t = token();
        if (!t) {
          setEditError("You're not signed in.");
          return;
        }
        // Non-empty set — the SAME REST door the `/topic <text>` slash uses.
        await postTopic(t, props.networkSlug, props.channelName, next);
      }
      // Success — cic mirrors the server: NO optimistic write. The relayed
      // `topic_changed` repaints the strip. Just leave edit mode.
      setEditing(false);
      setDraft("");
    } catch (e) {
      // S21 — surface the server reject inline and PRESERVE the editor +
      // draft so the operator can retry without retyping. Never paint a
      // false success on a dropped frame.
      setEditError(friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

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
      {/* Topic strip — always present; shows placeholder when no topic cached.
          #74: swaps to an inline editor on click when editable. */}
      <Show
        when={editing()}
        fallback={
          <button
            type="button"
            class="topic-bar-topic"
            onClick={onStripActivate}
            aria-label={canEditTopic() ? "edit topic" : "expand topic"}
            title={topicTitle()}
            data-testid="topic-strip"
          >
            <Show when={topicText() !== null} fallback={"(no topic set)"}>
              {/* #220 — the bar NEVER navigates a link directly; a tap on a
                  link "surface-wins" (suppresses navigation) and bubbles to
                  the strip's onClick, which either opens the editor (editable)
                  or the read-only modal (not). */}
              <MircBody body={topicText() ?? ""} linkPolicy="surface-wins" />
            </Show>
          </button>
        }
      >
        {/* #74 — inline editor. Single-line <input> (IRC topics are one
            wire line); the 2-line clamp is a DISPLAY concern only. Seeded
            with the raw topic. Enter submits, Escape/blur cancels. */}
        <input
          type="text"
          class="topic-bar-topic-editor"
          data-testid="topic-editor"
          aria-label="edit topic"
          placeholder="Set a topic…"
          value={draft()}
          ref={(el) => queueMicrotask(() => el.focus())}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submitEdit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelEdit();
            }
          }}
          onBlur={cancelEdit}
        />
      </Show>
      {/* #74 — inline submit-error surface (S21 pattern). Only while editing. */}
      <Show when={editError()}>
        <span class="topic-bar-edit-error" role="alert">
          {editError()}
        </span>
      </Show>
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
        aria-label="filter join/part/quit signalling"
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

      {/* Read-only topic modal — the non-editable fallback (#74). Opens on
          strip click when the operator can't set the topic; shows full
          topic, setter, timestamp. */}
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
