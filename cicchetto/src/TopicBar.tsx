import { type Component, createSignal, type JSX, Show } from "solid-js";
import { postTopic } from "./lib/api";
import { token } from "./lib/auth";
import { ownHoldsChannelEditorSigil } from "./lib/channelEditPerm";
import { channelKey } from "./lib/channelKey";
import {
  compactModeString,
  flattenTopicNewlines,
  hasNoTopic,
  modesByChannel,
  topicByChannel,
} from "./lib/channelTopic";
import { friendlyError } from "./lib/friendlyError";
import { isComposingKeystroke } from "./lib/imeComposition";
import { mircPlainText } from "./lib/mircFormat";
import { openModeModal } from "./lib/modeModal";
import { networkIdBySlug } from "./lib/networks";
import { createOverlayLock } from "./lib/overlayScrollLock";
import { pushChannelTopicClear } from "./lib/socket";
import { windowIsJoined } from "./lib/windowState";
import { MircBody } from "./MircText";
import PaneTopBar, { PaneTopBarRailOpener } from "./PaneTopBar";

// Top bar of the middle pane. Hosts:
//  * channel-name + modes box (#275): the channel name (bold accent) on line
//    one, the compact mode-string (e.g. "+nt", C3.1 — only when modes are
//    cached and non-empty) stacked BELOW it on line two. The whole box is a
//    single width-capped click target that opens the /mode viewer/editor
//    modal (reuse `openModeModal` — the same verb `/mode` uses).
//  * topic strip: up to TWO lines (#74), "(no topic set)" placeholder when
//    no topic is cached. Click/tap → ALWAYS opens the read-only topic modal
//    (#263), for everyone; the strip is view-only and its only action is
//    "open modal".
//  * right ☰ hamburger — opens members drawer (desktop + mobile)
//
// #263 (2026-07-16) — topic editing lives INSIDE the modal (supersedes the
// #74 inline-strip <input>). Tapping the strip opens the READ-ONLY modal for
// everyone. When the operator can set this channel's topic (canEditTopic:
// joined + not +t-locked OR op per the shared editor-sigil derivation), the
// modal shows a ✏️ toggle. ✏️ swaps the topic text for a multi-line
// <textarea> + ❌ cancel + ✅ save; the ✏️ disappears. ❌ cancel DISCARDS the
// draft, reverts to read-only, brings the ✏️ back, and KEEPS the modal open.
// ✅ save — or Enter inside the textarea, issue 2035 — flattens newlines →
// submits via the EXISTING send doors (postTopic
// REST for a non-empty set, pushChannelTopicClear WS verb for an empty clear —
// one-feature-every-door, the same doors the `/topic` slashes use) and CLOSES
// the modal on success. A server reject surfaces inline (S21 no-false-success)
// and PRESERVES the draft + editing state + open modal so the operator can
// retry without retyping. cic mirrors the server: NO optimistic write — the
// strip repaints only when the server's relayed `topic_changed` updates
// `topicByChannel`. A non-op sees a read-only modal — no ✏️, no textarea, no
// ❌/✅.
//
// Newline flatten (domain gotcha): an IRC topic is a SINGLE wire line; the
// server REJECTS a body containing \r/\n outright (Identifier.safe_line_token?
// → :invalid_line). The <textarea> is a display/editing affordance only —
// `flattenTopicNewlines` collapses every newline run to one space on submit
// BEFORE the send door, so a multi-line edit reaches upstream as one line.
// Still true after issue 2035 stopped Enter from inserting one: a PASTE
// carries newlines in, and the flatten is what spends them.
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
  /**
   * #1766 — `PaneTopBar`'s leading slot, passed straight through. REQUIRED
   * and not defaulted, mirroring the band's own contract: Shell's DESKTOP
   * branch passes `null` (there is a permanent sidebar; the band's ☰ is
   * `display: none` up there anyway) and the MOBILE branch passes the windows
   * opener only while the bottom bar is off. Threaded rather than read from
   * `showBottomBar.ts` here so this component stays presentation-only and the
   * mobile/desktop decision keeps living in the one place that already knows
   * the form factor.
   */
  leading: JSX.Element;
};

type ModalState = "closed" | "open";

const TopicBar: Component<Props> = (props) => {
  const [modalState, setModalState] = createSignal<ModalState>("closed");
  // #263 — modal-edit state. `editing` swaps the modal's read-only topic view
  // for the <textarea>; `draft` is the operator's in-progress raw text;
  // `editError` carries the inline server-reject copy; `saving` de-bounces
  // submit and OWNS the editor lifecycle across an in-flight send (S21).
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [editError, setEditError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  // Live ref to the modal textarea, set on mount so `beginEdit` can focus it
  // synchronously inside the tap gesture (iOS keyboard). Stale between edits is
  // harmless — we only focus right after a fresh mount.
  let editorRef: HTMLTextAreaElement | undefined;

  const key = () => channelKey(props.networkSlug, props.channelName);

  const topicEntry = () => topicByChannel()[key()] ?? null;
  const topicText = () => topicEntry()?.text ?? null;
  // #1505 — the placeholder gate. `hasNoTopic` and not `text !== null`: a
  // CLEARED topic arrives as `""` (the empty trailing the wire carried), and
  // the old gate let it through to `MircBody`, which emits zero runs for an
  // empty body. The strip then painted an EMPTY box and the tooltip an empty
  // string — a blank rectangle where "(no topic set)" belongs.
  const topicMissing = () => hasNoTopic(topicText());
  // #142: the `title` tooltip + the rendered strip both come from the same
  // topic. The strip routes the raw text through `MircBody` (formatting
  // renders); the tooltip is a plain-text-only attribute surface, so it
  // gets the parser-derived de-formatted text — control bytes stripped by
  // the ONE parser, never leaked raw into the attribute.
  const topicTitle = () => {
    const t = topicText();
    return topicMissing() ? "(no topic set)" : mircPlainText(t ?? "");
  };
  const modesEntry = () => modesByChannel()[key()] ?? null;
  const modeStr = () => {
    const entry = modesEntry();
    if (!entry) return "";
    return compactModeString(entry.modes);
  };

  const openModal = () => setModalState("open");
  // Full reset of the modal-edit state so the NEXT open is read-only. Called
  // whenever the modal closes and whenever an edit is cancelled/reverted.
  const resetEdit = () => {
    setEditing(false);
    setDraft("");
    setEditError(null);
  };
  const closeModal = () => {
    // An in-flight submit OWNS the lifecycle: a ✕/backdrop/Esc that races the
    // awaited send must NOT tear the editor down (breaks S21 preserve-draft).
    // The submit itself closes on success / keeps-open on error.
    if (saving()) return;
    setModalState("closed");
    resetEdit();
  };

  // #263 — can the operator set this channel's topic? Any joined member can,
  // UNLESS +t (topic-lock) is set, in which case only an op (per the shared
  // PREFIX-rank editor-sigil derivation) can. Not joined → never. The ircd is
  // the real authority (482 on an unauthorized TOPIC); this gate only decides
  // whether to OFFER the ✏️ edit toggle in the modal — a server reject is
  // still surfaced inline on submit.
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
    // Focus synchronously, in-gesture: setEditing is synchronous, so Solid has
    // already mounted + connected the textarea and set editorRef by now. iOS
    // raises the soft keyboard only for a focus() that runs inside the tap's
    // call stack (no microtask/timeout hop).
    editorRef?.focus();
  };
  const cancelEdit = () => {
    // Same S21 guard as closeModal: an in-flight submit owns teardown.
    if (saving()) return;
    // Revert to read-only, modal STAYS OPEN, ✏️ reappears (does NOT close).
    resetEdit();
  };

  const submitEdit = async (): Promise<void> => {
    if (saving()) return;
    const next = draft();
    const trimmed = next.trim();
    setEditError(null);
    const id = networkIdBySlug(props.networkSlug);
    // Empty submit with nothing to clear → nothing to send: revert to read-only
    // (modal stays open), like cancel. Done BEFORE `setSaving(true)` so the
    // (saving-guarded) `cancelEdit` reverts cleanly.
    if (trimmed === "" && topicMissing()) {
      cancelEdit();
      return;
    }
    try {
      setSaving(true);
      if (trimmed === "") {
        // Empty submit = clear the topic via `pushChannelTopicClear` — the
        // SAME WS verb the `/topic -delete` slash uses. (We can't reuse
        // `postTopic` here: it rejects an empty body server-side. That's
        // WHY the clear needs the dedicated verb.)
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
        // Flatten newlines FIRST: the <textarea> can hold multiple lines, but
        // an IRC topic is one wire line and the server REJECTS raw \r/\n
        // (:invalid_line). Without the flatten the save would always fail.
        await postTopic(t, props.networkSlug, props.channelName, flattenTopicNewlines(next));
      }
      // Success — cic mirrors the server: NO optimistic write. The relayed
      // `topic_changed` repaints the strip. Release the saving guard, then
      // close the modal (the #263 save-closes contract).
      setSaving(false);
      closeModal();
      return;
    } catch (e) {
      // S21 — surface the server reject inline and PRESERVE the editor +
      // draft + open modal so the operator can retry without retyping. Never
      // paint a false success on a dropped frame.
      setEditError(friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  // issue 2035 — Enter SETS the topic. This REVERSES the #263 decision that
  // used to be recorded a few lines down ("Enter in the textarea must stay a
  // newline, save is the ✅ button only"): the product owner ruled the
  // asserted behaviour wrong. The premise was weak besides — an IRC topic is
  // ONE wire line, and `flattenTopicNewlines` spends every newline BEFORE the
  // send door, so the break Enter bought was worth exactly one space and could
  // never reach the wire as a break.
  //
  // EVERY Enter submits, modifier or not. The issue left Shift+Enter
  // explicitly unruled; vjt then ruled it FOR THIS SURFACE — "anche
  // shift-invio setta il topic" (2026-09-10, his words on #grappa, relayed
  // in session; not observed on IRC by the author of this line).
  //
  // It agrees with #974, which is why the code predates the ruling rather
  // than waiting on it: that is vjt's 2026-08-07 ruling on `ComposeBox`, the
  // sibling surface with the same one-wire-line domain, reversing his own
  // day-old split because a Shift+Enter that refuses also EATS the keystroke,
  // and on his device the modifier arms itself on presses he never meant as
  // Shift+Enter — so the send silently does not happen. One chord, one
  // semantics, across both surfaces.
  //
  // 🔴 Escape is NOT handled here and must never be: #232 makes the shared
  // overlay stack the SINGLE Esc authority (it deleted every per-dialog
  // handler), and this modal's edit-aware close verb already lives on it —
  // see `createOverlayLock` below. An element-level keydown for Enter is
  // allowed to exist; one that grows an Escape branch is a second authority.
  //
  // `preventDefault` is what stops the textarea inserting its own break; the
  // flatten STAYS regardless, because a PASTE still carries newlines in.
  //
  // issue 2041 — the IME guard comes FIRST, above the chord. With a
  // compose-based input (Japanese, Chinese, Korean) the Enter that COMMITS
  // the candidate arrives as a plain `key: "Enter"`; without the check it
  // sets the topic to a half-typed line AND the `preventDefault` below eats
  // the keystroke the IME needed, so the word never finishes either. Above
  // the chord and not inside it, because the 2026-09-10 ruling made EVERY
  // Enter a commit here, modifier included. Same shape, same predicate, on
  // ComposeBox — one chord, one semantics, on both surfaces.
  const onEditorKeyDown = (e: KeyboardEvent): void => {
    if (isComposingKeystroke(e)) return;
    if (e.key !== "Enter") return;
    e.preventDefault();
    void submitEdit();
  };

  // #71 INC-2 — the per-channel presence-filter toggle (👁/🙈, #222) MOVED OUT
  // of the topic bar into the right-rail RailActions drawer (channel-gated). Q2
  // ruling: "one design" wants that toggle in the rail drawer on both form
  // factors, and a topic bar is not a per-window action surface. See
  // RailActions.tsx for the (verbatim) presence-toggle logic (#473: folded in
  // from the retired ActionCluster).

  // #219-general — the topic modal covers the ScrollbackPane (fixed
  // full-viewport `.topic-modal-backdrop`). Register it with the shared
  // overlay refcount so ScrollbackPane's freeze gate engages while it is up,
  // like every other covering modal (Names/Who/Confirm/Archive/…). Without
  // this, opening the topic modal on mobile shrinks the visualViewport →
  // ScrollbackPane's resize authority → tail-snap under the covered pane.
  // The lock scroller is the modal element (matches the createOverlayLock
  // contract for iOS touch-lock; the freeze that matters here is the
  // refcount, which drives the pane's overlay-snapshot effect).
  //
  // #232 + #263 — the topic modal joins the shared Esc-to-close stack via
  // onEscape, but the close verb is EDIT-AWARE: while editing, Esc runs
  // `cancelEdit` (revert the draft, stay open, ✏️ back — the #263 cancel
  // contract), NOT `closeModal`. A naive `closeModal` here would tear down the
  // draft, violating #263. In read-only, Esc runs `closeModal` (the same verb
  // the × / backdrop use). The textarea's own keydown (issue 2035, above)
  // handles Enter and NOTHING else — this stack remains the single ESC
  // authority (#232 deleted all per-dialog handlers).
  createOverlayLock(
    () => modalState() === "open",
    ".topic-modal",
    () => {
      if (editing()) cancelEdit();
      else closeModal();
    },
  );

  const formatSetAt = (setAt: string | null): string => {
    if (!setAt) return "(unknown time)";
    try {
      return new Date(setAt).toLocaleString();
    } catch {
      return setAt;
    }
  };

  return (
    <>
      {/* UX-4 bucket L (2026-05-19): TopicBar's left channel-sidebar
          hamburger was dropped (sidebar is always-visible on desktop,
          not rendered on mobile — no toggle needed). The settings cog
          moved out of TopicBar into ShellChrome (always-visible bar
          above) per the cluster-wide "settings cog reachable from
          every window" rule.
          UX-5 bucket A (2026-05-19): ShellChrome's own hamburger was
          also dropped — it was a desktop no-op and duplicated this
          bar's right members hamburger on mobile. `.topic-bar-hamburger`
          (CSS-hidden on desktop via @media) is now the SINGLE hamburger
          across the whole shell — and since #1073 it lives in
          `PaneTopBar`, which is also where the admin console gets it.
          #1073 — the band itself (`.topic-bar` + the `.topic-bar-header`
          slot + the trailing ☰) moved to `PaneTopBar` so the admin
          console renders the SAME bar with different content in it. What
          stays here is what was always channel-shaped: the namebox, the
          mode string, the topic strip and the two modals. The #644
          grouping rationale — the two text columns centre as ONE unit
          against the ☰, while the wrapper's own `flex-start` preserves
          #344's line registration — now lives on the slot, in
          `PaneTopBar`.
          The modals are SIBLINGS of the bar rather than children of it
          now. They are `position: fixed` at `z-index: 201` with no
          selector descending from `.topic-bar`, so the move is inert;
          and while closed `<Show>` renders no element, which is what
          keeps the bar's child list at exactly two. */}
      <PaneTopBar
        /* #1766 — the windows ☰ when the mobile bottom bar is off; `null`
           otherwise and always on desktop. Shell decides; this bar carries. */
        leading={props.leading}
        trailing={
          /* #1697 — the ☰ is passed IN now: the band's trailing control became
             a slot when the rail's radio picker needed a ✕ there instead. Same
             button, same class, same position — the markup is unchanged. */
          <PaneTopBarRailOpener
            onOpenRail={props.onToggleMembers}
            railLabel="open members sidebar"
          />
        }
      >
        {/* #275 — channel name + modes STACKED in ONE width-capped clickable
          box. The whole box opens the /mode viewer/editor modal (reuse
          `openModeModal` — the SAME verb `/mode #chan`, bare `/mode`, and the
          old inline indicator used; "reuse the verbs, not the nouns"). The
          mode string drops to a SECOND line below the name (see
          `.topic-bar-namebox` flex column) so the box is two-line-tall —
          visually balanced against a two-line topic — and width-capped so the
          topic keeps ~80% of the bar. Was: a bare `.topic-bar-channel` span
          plus a separate `.topic-bar-modes` <button> rendered inline AFTER the
          topic strip. The mode string is now a <span> INSIDE this box (no
          button-in-button); a tap anywhere on the box — name OR modes —
          bubbles to this onClick, so the `.topic-bar-modes` click paths that
          issue216 / issue240 exercise still open the modal. */}
        <button
          type="button"
          class="topic-bar-namebox"
          data-testid="channel-mode-box"
          aria-label={`channel ${props.channelName} — view modes`}
          title={
            modeStr().length > 0 ? (modesEntry()?.modes.join(", ") ?? "") : "view channel modes"
          }
          onClick={() => openModeModal(props.networkSlug, props.channelName)}
        >
          <span class="topic-bar-channel">{props.channelName}</span>
          {/* Compact mode string (e.g. "+nt") — rendered only when modes are
            cached and non-empty (C3.1). Second line of the box. */}
          <Show when={modeStr().length > 0}>
            <span class="topic-bar-modes" title={modesEntry()?.modes.join(", ") ?? ""}>
              {modeStr()}
            </span>
          </Show>
        </button>
        {/* Topic strip — always present; shows placeholder when no topic cached.
          #263: view-only, its only action is to open the (read-only) modal for
          everyone; editing lives inside the modal. */}
        <button
          type="button"
          class="topic-bar-topic"
          onClick={openModal}
          aria-label="expand topic"
          title={topicTitle()}
          data-testid="topic-strip"
        >
          {/* #307 — the clamped runs MUST be the direct children of a NON-button
            `-webkit-box` for `-webkit-line-clamp` to engage (a <button> wraps
            its children in an internal box and defeats the clamp — the #262
            bug: geometric clip with no ellipsis). This inner span carries the
            clamp (see `.topic-bar-topic-text`); the click affordance + a11y
            stay on the real <button> above, so no role/tabindex/keydown
            reimplementation is needed. MircBody emits its runs with no block
            wrapper, so they land as the span's direct line-box content. */}
          <span class="topic-bar-topic-text">
            <Show when={!topicMissing()} fallback={"(no topic set)"}>
              {/* #220 — the bar NEVER navigates a link directly; a tap on a
                link "surface-wins" (suppresses navigation) and bubbles to
                the strip's onClick, which opens the modal. */}
              <MircBody body={topicText() ?? ""} linkPolicy="surface-wins" emphasis />
            </Show>
          </span>
        </button>
      </PaneTopBar>
      {/* #71 INC-2 — the presence-filter toggle (👁/🙈) moved to the right-rail
          RailActions drawer (channel-gated). It is no longer rendered here. */}

      {/* Topic modal (#263) — opens read-only for everyone on strip click;
          shows full topic, setter, timestamp. An op (canEditTopic) also sees a
          ✏️ toggle → the topic text swaps for a multi-line editor + ❌/✅. */}
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
            <Show
              when={editing()}
              fallback={
                <>
                  <p class="topic-modal-text">
                    <Show when={!topicMissing()} fallback={"(no topic set)"}>
                      <MircBody body={topicText() ?? ""} emphasis />
                    </Show>
                  </p>
                  <Show when={topicEntry() !== null}>
                    <p class="topic-modal-meta">
                      Set by: {topicEntry()?.set_by ?? "(unknown)"}
                      {" — "}
                      {formatSetAt(topicEntry()?.set_at ?? null)}
                    </p>
                  </Show>
                  {/* ✏️ edit toggle — only when the operator can set the topic.
                      Pressing it enters edit mode (textarea + ❌/✅); the ✏️
                      itself disappears (edit view has no read-only branch). */}
                  <Show when={canEditTopic()}>
                    <div class="topic-modal-actions">
                      <button
                        type="button"
                        class="topic-modal-edit"
                        data-testid="topic-modal-edit"
                        aria-label="edit topic"
                        onClick={beginEdit}
                      >
                        ✏️
                      </button>
                    </div>
                  </Show>
                </>
              }
            >
              {/* #263 — multi-line editor. IRC topics are one wire line, so
                  newlines are flattened on submit (see submitEdit); a paste is
                  the route they still arrive by. Enter SETS the topic (issue
                  2035 — see onEditorKeyDown), ✅ is the other door. NO
                  element-level Esc handler — the shared #232 overlay stack
                  owns Esc (edit-aware onEscape → cancelEdit). Seeded with the
                  raw topic.
                  `rows` is the height knob (issue 2035): the platform's own
                  "how many text lines", which tracks font-size + line-height
                  by itself. See `.topic-modal-editor` for the min-height it
                  replaced and the arithmetic that one got wrong. */}
              <textarea
                class="topic-modal-editor"
                data-testid="topic-modal-editor"
                aria-label="edit topic"
                placeholder="Set a topic…"
                rows={8}
                value={draft()}
                ref={(el) => {
                  editorRef = el;
                }}
                onInput={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={onEditorKeyDown}
              />
              {/* #263 — inline submit-error surface (S21 no-false-success). */}
              <Show when={editError()}>
                <span class="topic-modal-edit-error" role="alert">
                  {editError()}
                </span>
              </Show>
              <div class="topic-modal-actions">
                <button
                  type="button"
                  class="topic-modal-cancel"
                  data-testid="topic-modal-cancel"
                  aria-label="cancel edit"
                  onClick={cancelEdit}
                >
                  ❌
                </button>
                <button
                  type="button"
                  class="topic-modal-save"
                  data-testid="topic-modal-save"
                  aria-label="save topic"
                  onClick={() => void submitEdit()}
                >
                  ✅
                </button>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </>
  );
};

export default TopicBar;
