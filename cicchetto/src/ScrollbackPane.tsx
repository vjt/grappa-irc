import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import LusersCard from "./LusersCard";
import { isContentKind, ownNickForNetwork, postJoin, type ScrollbackMessage } from "./lib/api";
import { token } from "./lib/auth";
import { channelKey, decodeChannelKey } from "./lib/channelKey";
import { isDocumentVisible } from "./lib/documentVisibility";
import { type InviteAckEntry, inviteAckBySlug } from "./lib/inviteAck";
import { mediaViewerState } from "./lib/mediaViewer";
import { membersByChannel } from "./lib/members";
import { matchesWatchlist, mentionsUser } from "./lib/mentionMatch";
import { networks, user } from "./lib/networks";
import { senderPrefix, snapshotSenderPrefix } from "./lib/nickColor";
import { nickEquals } from "./lib/nickEquals";
import { isOperatorActionEcho } from "./lib/operatorActionEcho";
import { isOwnPresenceEvent } from "./lib/ownPresenceEvent";
import { canonicalQueryNick, openQueryWindowState } from "./lib/queryWindows";
import { getReadCursor } from "./lib/readCursor";
import {
  lastOwnSend,
  loadMore as loadMoreScrollback,
  loadNewer as loadNewerScrollback,
  refreshScrollback,
  scrollbackByChannel,
} from "./lib/scrollback";
import { setCursorIfAdvances, setSelectedChannel } from "./lib/selection";
import { formatTimestamp } from "./lib/timeFormat";
import { SERVER_WINDOW_NAME, type WindowKind } from "./lib/windowKinds";
import { MircBody } from "./MircText";
import NickText from "./NickText";
import PeerAwayBanner from "./PeerAwayBanner";
import UserContextMenu from "./UserContextMenu";
import WhoisCard from "./WhoisCard";
import WhowasCard from "./WhowasCard";

// Right-pane component: pure projection of the per-channel scrollback list.
// Mounted by `Shell.tsx` only when `selectedChannel()` is non-null; the
// parent passes the (slug, name) tuple as props.
//
// Auto-scroll: stick to the bottom when a new message arrives ONLY if
// the user is already near the bottom (within 50px). If they've
// scrolled up to read history, we leave the scroll position alone so
// reading isn't yanked away.
//
// Compose split (P4-1 Task 22+23): the inline form moved to
// `ComposeBox.tsx`. This pane is now compose-free; the parent layout
// composes ScrollbackPane + ComposeBox vertically.
//
// Mention highlight (P4-1): privmsg lines whose `body` word-boundary
// case-insensitive-matches the operator's own nick get .scrollback-mention
// class. The matcher reads `networks.user()` for the nick.
//
// C5.0 (UX-5 BJ rewrite — 2026-05-19): own-nick JOIN auto-focus.
// When the operator's own nick has a JOIN row in scrollback for this
// channel, switch focus to it. This is a user action (the operator
// issued /join), so the C4.2 cluster-wide focus-only-on-user-action
// rule is not violated; the rule guards against incoming-traffic
// focus shifts, not user-initiated ones. Pre-BJ the same effect ALSO
// gated the "JOIN-self banner" mount; the banner was killed in BJ
// (vjt 2026-05-19 dogfood — duplicated TopicBar + MembersPane) and
// the focus side-effect lives on alone via `autoFocusedJoins` Set.
//
// C7.1: Day-separator rows — when consecutive messages cross a local-TZ
// day boundary, render a `── <date> ──` separator row between them.
// Pure client-side computation from server_time (epoch-ms).
//
// C7.2: Muted-events rendering — presence/op event rows get
// .scrollback-muted (dimmer, smaller, italic) so PRIVMSG/NOTICE/ACTION
// dominate visually. PRESENCE_KINDS is the closed set.
//
// C7.3: Unread marker — when the user opens a channel with a stored read
// cursor (server-owned; hydrated via getReadCursor from readCursor.ts),
// messages after the cursor are "unread". The rows() memo injects an
// `── XX unread messages ──` marker row between the last read message and
// the first unread message. On first mount of an unread window, the pane
// scrolls to the marker (block: "start") so the user sees
// context-then-unread without manual scroll.
//
// FREEZE CONTRACT (2026-06-08): the divider derives from a FROZEN snapshot
// of the cursor (`markerCursorId`), NOT the live value — it does not move
// while the operator reads. It re-latches on focus acquisition
// (channel-switch, visibility-return). The live cursor advances + POSTs to
// the server on settle events (scroll-settle, focus-leave, blur, send) via
// setCursorIfAdvances / setReadCursor; see the markerCursorId signal doc
// below for the full contract.
//
// C7.4: Scroll-to-bottom floating button — appears when scrolled more than
// SCROLL_BOTTOM_THRESHOLD_PX from the tail. Click → smooth-scroll to bottom
// and resume auto-follow (resets atBottom to true).
//
// C7.6: Clickable nicks in scrollback — sender spans on PRIVMSG / NOTICE /
// ACTION get .nick-clickable class. Left-click → open query window + focus.
// Right-click → show UserContextMenu at cursor position (same component as
// MembersPane, ZERO new components). ownModes is derived from membersByChannel
// for the logged-in nick so op-gated items are correctly enabled/disabled.
//
// C7.7: Watchlist highlight rendering — PRIVMSG / NOTICE / ACTION lines where
// `matchesWatchlist(body, ownNick)` is true get .scrollback-highlight class.
// MVP: watchlist = own nick only (no user_settings, no /watch). Named
// separately from mentionsUser so the future /watch cluster can extend it.

export type Props = {
  networkSlug: string;
  channelName: string;
  kind: WindowKind;
};

const SCROLL_BOTTOM_THRESHOLD_PX = 50;

// UX-8 (b): scroll-settle debounce — fire the cursor update 500ms after
// the last scroll event. Resets on every scroll, so iOS momentum
// scrolling (events fire for 1-2s after finger lift) settles to a
// single POST at the natural stop. Long enough that snap-to-bottom +
// the resulting scroll event don't trigger a write before the user
// has actually moved.
const SCROLL_SETTLE_DEBOUNCE_MS = 500;

// BUGHUNT-2: input-event-recency window for the scroll-settle gate.
// onScroll only arms the settle timer if a real operator input event
// (pointerdown / wheel / touchmove / qualifying keydown) fired within
// this many ms before the scroll. 1500ms covers user-wheel → 500ms
// debounce + browser layout slop. Programmatic activation
// `scrollIntoView`: no preceding input event → no arm.
const INPUT_EVENT_RECENCY_MS = 1500;

// BUGHUNT-2: keyboard keys that scroll the scrollback pane. Used by
// the keydown handler to decide whether a key event qualifies as an
// "operator scrolled" input for the settle-arm gate.
const SCROLL_KEYS = new Set<string>([
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "ArrowUp",
  "ArrowDown",
  " ", // Space — page-down convention
]);

// CP14 B2: trigger `loadMore` when the user scrolls within this many
// pixels of the top. 200px is a standard infinite-scroll threshold —
// fires before the user actually hits the top so the new rows can
// land while there's still scroll runway, avoiding the "land at the
// very top, brief stutter, then content shifts" UX. The verb itself
// (lib/scrollback.ts loadMore) gates the burst and end-of-history
// cases; this constant only controls when to *try*.
const LOAD_MORE_THRESHOLD_PX = 200;

// Module-level tracking of which channels have already auto-focused on
// own-nick JOIN this session. Intentionally not persisted to server or
// localStorage — ephemeral, per page-load. Pre-BJ this Set ALSO gated
// the "JOIN-self banner" mount; the banner died in UX-5 BJ and the Set
// survives to keep the C5.0 auto-focus side-effect idempotent (one
// focus-switch per (slug, channel) per page load — repeated session-
// internal /join cycles for the same channel must not re-snatch focus).
//
// Test seam: `resetAutoFocusedJoinsForTest()` lets unit tests wipe the
// Set between cases without vi.resetModules() gymnastics. Mirrors the
// `seedFromTest` pattern in members.ts.
const autoFocusedJoins = new Set<string>();

export function resetAutoFocusedJoinsForTest(): void {
  autoFocusedJoins.clear();
}

// Message-row timestamp. #208 dropped seconds to recover gutter space;
// #217 makes the format user-configurable (Settings → timestamp format),
// defaulting to WITH seconds. The format lives in lib/timeFormat.ts as a
// closed-set key backed by a Solid signal — calling `formatTimestamp` here
// tracks that signal, so every rendered row re-formats live when the
// operator switches format. Kept as an exported thin wrapper so the format
// is guarded via the module seam without rendering the whole pane.
export const formatTime = (epochMs: number): string => formatTimestamp(epochMs);

// Format epoch-ms as a human-readable date label (e.g. "Saturday, May 3")
// in the user's local timezone. Used for day-separator rows (C7.1).
const formatDateLabel = (epochMs: number): string => {
  return new Date(epochMs).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
};

// Returns true if a and b fall on different calendar days in local TZ.
// Comparison is by (year, month, date) triple so DST transitions don't
// produce false positives.
const isDifferentDay = (aMs: number, bMs: number): boolean => {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return (
    a.getFullYear() !== b.getFullYear() ||
    a.getMonth() !== b.getMonth() ||
    a.getDate() !== b.getDate()
  );
};

// UX-8 (b): scroll-settle visible-row math. Returns the id of the last
// fully-visible message. When the pane is pinned to the bottom (#163)
// this is the DOM true tail; otherwise it walks `.scrollback-line`
// children of the listRef container and returns the highest `data-msg-id`
// whose bottom edge is at-or-above the viewport bottom. Returns null when
// no row qualifies (empty scrollback, or scrollTop above the first row's
// bottom).
//
// O(n) where n = rows in scrollback. Called from the 500ms-debounced
// scroll-settle path so the cost is bounded; for a 200-row #bofh
// scrollback this is sub-millisecond.
const lastFullyVisibleRowId = (listRef: HTMLDivElement): number | null => {
  const rows = listRef.querySelectorAll<HTMLElement>(".scrollback-line");

  // #163 — at-bottom short-circuit. When the pane is pinned to the
  // bottom, the geometric walk below silently drops the TRUE TAIL: the
  // last row's `offsetTop + offsetHeight` and `viewportBottom` are
  // nominally equal, but sub-pixel/fractional geometry (fractional
  // scrollHeight, last-card margin/padding, integer scrollTop rounding)
  // makes the strict `>` test fire on the last row → the loop `break`s
  // BEFORE assigning it → the cursor lands one message short and the
  // channel keeps a phantom "1 unread" that re-appears on every leave.
  // Derive the SAME pane-level distance-to-bottom the authoritative
  // `atBottom` signal uses (onScroll, below) — robust by construction
  // against the rounding a per-row epsilon can't fix — and return the
  // DOM true-tail id directly. The true tail is always >= the geometric-
  // walk id, so the forward-only `setCursorIfAdvances` gate is preserved
  // (this only ever advances the cursor, never rewinds). Kept inside this
  // pure fn so all four settle feed paths (onCleanup unmount, onScroll
  // snapshot, 500ms scroll-settle, visibility-hide) inherit the fix with
  // no per-caller duplication.
  const distanceToBottom = listRef.scrollHeight - listRef.scrollTop - listRef.clientHeight;
  if (distanceToBottom <= SCROLL_BOTTOM_THRESHOLD_PX) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const id = rows[i]?.dataset.msgId;
      if (id) return Number.parseInt(id, 10);
    }
    return null;
  }

  // Not pinned to the bottom: the last fully-visible row is the highest
  // whose bottom edge is at-or-above the viewport bottom.
  const viewportBottom = listRef.scrollTop + listRef.clientHeight;
  let candidate: number | null = null;
  for (const row of rows) {
    if (row.offsetTop + row.offsetHeight > viewportBottom) break;
    const id = row.dataset.msgId;
    if (id) candidate = Number.parseInt(id, 10);
  }
  return candidate;
};

// Wire-shape source-of-truth: the server's `Grappa.Scrollback.Message.kind()`
// enum is the canonical producer (lib/grappa/scrollback/message.ex).
// `MessageKind` mirrors it; this switch must stay exhaustive over the
// union. The `default` arm's `assertNever` makes adding a new kind to
// the union a compile error here — the contract is enforced at the
// type system layer, not by tests or runtime fallbacks.
//
// Framing follows irssi convention: PRIVMSG `<nick> body`, NOTICE
// `-nick- body`, ACTION + presence/op kinds `* nick <verb> [target]`.

// `:part` / `:quit` / `:kick` carry their reason in `body` per
// `Grappa.Scrollback.Meta`'s per-kind shape table ("body carries
// reason"). The Meta allowlist intentionally has no `:reason` key —
// review S29 closed the dead key on the server side, so a single
// `body`-only lookup is the contract.
const reasonOf = (msg: ScrollbackMessage): string | null => msg.body || null;

// #142: render a reason / trailing as a parenthesized mIRC-formatted suffix
// (" (reason)"), or nothing when absent. The paren chrome stays plain text;
// only the user-originated reason routes through the shared `MircBody`
// renderer so its control bytes render as formatting instead of leaking raw
// to the DOM. Shared by the PART / QUIT / KICK reason sites and the KILL
// trailing — same chrome, one implementation.
const reasonSuffix = (reason: string | null): JSX.Element =>
  reason ? (
    <>
      {" ("}
      <MircBody body={reason} />
      {")"}
    </>
  ) : null;

// irssi-style " [user@host]" suffix for presence events (join/part/quit).
// The server lifts the sender's user@host off the IRC prefix into the
// persist meta (Grappa.Scrollback.Meta join/part/quit shape). Both keys
// present or neither — a +x-cloaked prefix yields no mask, so this
// returns "" and the line reads "* nick has joined" unchanged.
const userhostSuffix = (msg: ScrollbackMessage): string => {
  const user = msg.meta.sender_user;
  const host = msg.meta.sender_host;
  return typeof user === "string" && typeof host === "string" ? ` [${user}@${host}]` : "";
};

// Strip the CTCP ACTION envelope (`\x01ACTION ...\x01`) from a body for
// rendering. The server stores the wire-form body verbatim per the
// CLAUDE.md "preserved as-is" rule (round-trip fidelity for ACTION
// and other CTCP verbs); the display layer unwraps the envelope when
// the kind discriminator already classifies the row as `:action`.
// Defensive: if the envelope isn't there (e.g. a future server-side
// pre-strip lands), fall through to the raw body.
const CTCP_ACTION_PREFIX = "\x01ACTION ";
const CTCP_DELIMITER = "\x01";
const stripCtcpAction = (body: string | null): string => {
  if (!body) return "";
  if (!body.startsWith(CTCP_ACTION_PREFIX)) return body;
  const inner = body.slice(CTCP_ACTION_PREFIX.length);
  return inner.endsWith(CTCP_DELIMITER) ? inner.slice(0, -1) : inner;
};

type NickHandlers = {
  onNickClick: (nick: string) => void;
  onNickContextMenu: (nick: string, e: MouseEvent) => void;
  // No-silent-drops bucket 2: INVITE row's [Join] CTA. Click handler
  // is wired by the parent ScrollbackLine, which has access to the
  // active networkSlug + auth token via createScope.
  onJoinChannel: (channel: string) => void;
  // UX-5 bucket BC2: needed by `prefixFor` inside `renderBody` to
  // build the channelKey for the per-channel members store lookup.
  // Threaded as a string (not signal) — `renderBody` is reactive at
  // the SolidJS render boundary; the parent ScrollbackLine reads
  // `props.networkSlug` on each row render, so the value is fresh.
  networkSlug: string;
};

// No-silent-drops bucket 1 (2026-05-14, B6.1 reshape): pretty-render
// arms for unknown IRC command verbs that EventRouter's catch-all
// persists as :notice rows on $server with FLAT atom-keyed
// meta.{raw_verb, raw_sender, raw_params}. Server emits typed
// primitives only — cic owns the localized human-readable strings here,
// per feedback_no_localized_strings_server_side. New verbs land as
// additional case arms; the default arm renders a generic "<sender>
// VERB params" row so the event is never invisible.
//
// B6.1 HIGH-6 reshape: the pre-fix nested `meta.raw = {verb, sender,
// params}` shape mixed atom outer + string inner keys, bypassing the
// Scrollback.Meta @known_keys allowlist. Flattening to three top-level
// atom-keyed fields keeps both the closed-set discipline and the
// Logger metadata sync intact.
type RawEvent = { raw_verb?: string; raw_sender?: string; raw_params?: string[] };
const renderRawEvent = (
  raw: RawEvent,
  msg: ScrollbackMessage,
  senderSpan: (nick: string) => JSX.Element,
  handlers: NickHandlers,
): JSX.Element => {
  const verb = raw.raw_verb ?? "?";
  const params = raw.raw_params ?? [];
  const sender = raw.raw_sender ?? msg.sender;
  const trailing = params[params.length - 1] ?? "";

  switch (verb) {
    case "WALLOPS":
      return (
        <span class="scrollback-body">
          *** Wallops from {senderSpan(sender)}: <MircBody body={trailing} />
        </span>
      );
    case "GLOBOPS":
      return (
        <span class="scrollback-body">
          *** Globops from {senderSpan(sender)}: <MircBody body={trailing} />
        </span>
      );
    case "KILL": {
      const target = params[0] ?? "?";
      return (
        <span class="scrollback-body">
          *** {senderSpan(sender)} killed {target}
          {reasonSuffix(trailing && trailing !== target ? trailing : null)}
        </span>
      );
    }
    case "ERROR":
      return (
        <span class="scrollback-body">
          *** Server error: <MircBody body={trailing} />
        </span>
      );
    case "CHGHOST": {
      // Per IRCv3: CHGHOST <new_user> <new_host>
      const newUser = params[0] ?? "?";
      const newHost = params[1] ?? "?";
      return (
        <span class="scrollback-body">
          *** {senderSpan(sender)} changed host to {newUser}@{newHost}
        </span>
      );
    }
    case "INVITE": {
      // No-silent-drops bucket 2: inbound INVITE from a peer.
      // Wire shape: `:vjt!~vjt@host INVITE grappa :#sbiffo`. params =
      // ["grappa" (own_nick), "#sbiffo" (channel)]. Operator can join
      // immediately by clicking [Join] — handler routes through the
      // existing /join flow (postJoin + setSelectedChannel) wired at
      // the ScrollbackLine layer where networkSlug + token are in
      // scope.
      //
      // Defensive: if params[1] isn't a channel-prefixed string, fall
      // through to the generic arm so the row remains visible (the
      // catch-all from bucket 1 stays the safety net).
      const invitedChannel = params[1];
      if (typeof invitedChannel === "string" && /^[#&+!]/.test(invitedChannel)) {
        return (
          <span class="scrollback-body">
            *** {senderSpan(sender)} invited you to {invitedChannel}{" "}
            <button
              type="button"
              class="scrollback-invite-join"
              onClick={() => handlers.onJoinChannel(invitedChannel)}
            >
              [Join]
            </button>
          </span>
        );
      }
      // Fall through to default arm if the channel param looks malformed.
      return (
        <span class="scrollback-body">
          *** {senderSpan(sender)} {verb} <MircBody body={params.join(" ")} />
        </span>
      );
    }
    default:
      // Generic fallback: render verb + raw params so unknown verbs are
      // never invisible. New verbs get a dedicated arm by adding a case
      // above; the default keeps the principle of "no silent drops".
      return (
        <span class="scrollback-body">
          *** {senderSpan(sender)} {verb} <MircBody body={params.join(" ")} />
        </span>
      );
  }
};

const renderBody = (msg: ScrollbackMessage, handlers: NickHandlers): JSX.Element => {
  // UX-5 bucket BC2 + #25: per-message sender prefix glyph (@/%/+).
  //
  // For a CONTENT row (privmsg/action/notice) the SENDER's glyph is the
  // grade snapshotted at SEND time by the server into `meta.sender_prefix`
  // — NOT a live join against the members store. A render-time live join
  // (the pre-#25 behaviour) retroactively re-prefixed a nick's old lines
  // the instant their grade changed. An absent snapshot (plain sender, or
  // a row persisted before #25 landed) renders no glyph — never a
  // live-derived guess, which would reintroduce the bug.
  //
  // Everything else — presence-row senders (join/part/quit/mode) and the
  // kick TARGET — keeps the live members join: those describe a "now"
  // event, not a frozen send, so the current grade is the correct glyph.
  const prefixFor = (nick: string): "@" | "%" | "+" | "" => {
    if (!msg.channel) return "";
    if (isContentKind(msg.kind) && nickEquals(nick, msg.sender)) {
      return snapshotSenderPrefix(msg.meta);
    }
    const key = channelKey(handlers.networkSlug, msg.channel);
    return senderPrefix(membersByChannel()[key], nick);
  };

  // C7.6: sender button for content kinds — left-click (→ query) or
  // right-click (→ UserContextMenu). Rendered as <button> to satisfy
  // biome a11y rules (noStaticElementInteractions / useKeyWithClickEvents).
  // Styled via .scrollback-sender.nick-clickable to appear inline.
  //
  // UX-5 BC2: the displayed nick goes through `<NickText>` for the
  // deterministic palette color + irssi-style prefix glyph. The
  // bracket pair (`<...>` for privmsg, `-...-` for notice) wraps the
  // NickText so the entire `<@nick>` reads as one inline unit inside
  // the brackets.
  const senderSpan = (bracketLeft: string, bracketRight: string, nick: string): JSX.Element => (
    <button
      type="button"
      class="scrollback-sender nick-clickable"
      onClick={() => handlers.onNickClick(nick)}
      onContextMenu={(e: MouseEvent) => handlers.onNickContextMenu(nick, e)}
    >
      {bracketLeft}
      <NickText nick={nick} prefix={prefixFor(nick)} />
      {bracketRight}
    </button>
  );

  // Variant used by `renderRawEvent` (WALLOPS/GLOBOPS/KILL/CHGHOST/
  // INVITE) — no surrounding brackets, just the colored nick. Kept as
  // a separate closure so the bracket-vs-bare distinction is explicit
  // at the call site (no magic-default-arg).
  const bareSenderSpan = (nick: string): JSX.Element => (
    <button
      type="button"
      class="scrollback-sender nick-clickable"
      onClick={() => handlers.onNickClick(nick)}
      onContextMenu={(e: MouseEvent) => handlers.onNickContextMenu(nick, e)}
    >
      <NickText nick={nick} prefix={prefixFor(nick)} />
    </button>
  );

  switch (msg.kind) {
    case "privmsg":
      return (
        <>
          {senderSpan("<", ">", msg.sender)}{" "}
          <span class="scrollback-body">
            <MircBody body={msg.body ?? ""} />
          </span>
        </>
      );
    case "notice": {
      // No-silent-drops bucket 1: structured raw-event rendering.
      // EventRouter's catch-all persists unhandled command verbs as
      // :notice rows on $server with FLAT atom-keyed meta:
      // {raw_verb, raw_sender, raw_params} (B6.1 HIGH-6 reshape from
      // the prior nested `meta.raw = {...}`). Pretty-render arms key
      // off raw_verb and grow incrementally (KILL, WALLOPS, ERROR,
      // GLOBOPS, CHGHOST common cases). Body is the trailing-param
      // (or verb-name fallback per B6.1 HIGH-2); the structured
      // render takes precedence when raw_verb is present.
      const meta = msg.meta as RawEvent | undefined;
      if (meta && typeof meta.raw_verb === "string") {
        return renderRawEvent(meta, msg, bareSenderSpan, handlers);
      }
      return (
        <>
          {senderSpan("-", "-", msg.sender)}{" "}
          <span class="scrollback-body">
            <MircBody body={msg.body ?? ""} />
          </span>
        </>
      );
    }
    case "action":
      return (
        <span class="scrollback-body">
          *{"  "}
          {bareSenderSpan(msg.sender)} <MircBody body={stripCtcpAction(msg.body)} />
        </span>
      );
    case "join":
      return (
        <span class="scrollback-body">
          * {bareSenderSpan(msg.sender)}
          {userhostSuffix(msg)} has joined {msg.channel}
        </span>
      );
    case "part": {
      const reason = reasonOf(msg);
      return (
        <span class="scrollback-body">
          * {bareSenderSpan(msg.sender)}
          {userhostSuffix(msg)} has left {msg.channel}
          {reasonSuffix(reason)}
        </span>
      );
    }
    case "quit": {
      const reason = reasonOf(msg);
      return (
        <span class="scrollback-body">
          * {bareSenderSpan(msg.sender)}
          {userhostSuffix(msg)} has quit{reasonSuffix(reason)}
        </span>
      );
    }
    case "nick_change": {
      const newNick = typeof msg.meta.new_nick === "string" ? msg.meta.new_nick : "?";
      return (
        <span class="scrollback-body">
          * {bareSenderSpan(msg.sender)} is now known as <NickText nick={newNick} />
        </span>
      );
    }
    case "mode": {
      const modes = typeof msg.meta.modes === "string" ? msg.meta.modes : "";
      const args = Array.isArray(msg.meta.args) ? ` ${msg.meta.args.join(" ")}` : "";
      // #154(b): own-nick user-MODE transitions (+iS/+ixS at connect, +r at
      // IDENTIFY, +a from services) are persisted server-side on the
      // synthetic "$server" window (EventRouter's user-MODE-on-self branch).
      // A user-mode has no channel, so render "sets user mode +x" without the
      // "on <channel>" suffix. No real channel is ever named "$server"
      // (reserved SERVER_WINDOW_NAME), so the routing target is an
      // unambiguous discriminator — same boundary `operatorActionEcho` keys
      // off. Channel MODEs (`* op sets mode +o nick on #chan`) are unchanged.
      if (msg.channel === SERVER_WINDOW_NAME) {
        return (
          <span class="scrollback-body">
            * {bareSenderSpan(msg.sender)} sets user mode {modes}
            {args}
          </span>
        );
      }
      return (
        <span class="scrollback-body">
          * {bareSenderSpan(msg.sender)} sets mode {modes}
          {args} on {msg.channel}
        </span>
      );
    }
    case "topic":
      return (
        <span class="scrollback-body">
          * {bareSenderSpan(msg.sender)} changed topic: <MircBody body={msg.body ?? ""} />
        </span>
      );
    case "kick": {
      const target = typeof msg.meta.target === "string" ? msg.meta.target : "?";
      const reason = reasonOf(msg);
      return (
        <span class="scrollback-body">
          * {bareSenderSpan(msg.sender)} kicked{" "}
          <NickText nick={target} prefix={prefixFor(target)} /> from {msg.channel}
          {reasonSuffix(reason)}
        </span>
      );
    }
    case "server_event": {
      // No-silent-drops B6.11 (HIGH-7) — typed kind for catch-all
      // rows. EventRouter's fallthrough now writes :server_event
      // (was: :notice + meta.raw_verb). Both flow through the same
      // structured renderer; the legacy `case "notice"` arm above
      // keeps its raw_verb fallback for cold-deploy backfill misses.
      const meta = msg.meta as RawEvent | undefined;
      if (meta && typeof meta.raw_verb === "string") {
        return renderRawEvent(meta, msg, bareSenderSpan, handlers);
      }
      // Defensive: a :server_event row with no raw_verb is a server
      // bug, but render the body so it isn't invisible.
      return (
        <span class="scrollback-body">
          *** {bareSenderSpan(msg.sender)} <MircBody body={msg.body ?? ""} />
        </span>
      );
    }
    default: {
      const _exhaustive: never = msg.kind;
      void _exhaustive;
      return null;
    }
  }
};

const PRESENCE_KINDS: ReadonlySet<ScrollbackMessage["kind"]> = new Set([
  "join",
  "part",
  "quit",
  "nick_change",
  "mode",
  "topic",
  "kick",
  "server_event",
]);

const ScrollbackLine: Component<{
  msg: ScrollbackMessage;
  userNick: string | null;
  networkSlug: string;
  onNickClick: (nick: string) => void;
  onNickContextMenu: (nick: string, e: MouseEvent) => void;
  onJoinChannel: (channel: string) => void;
}> = (props) => {
  const isMention = () =>
    props.msg.kind === "privmsg" && mentionsUser(props.msg.body, props.userNick);

  // C7.2: muted — presence/event kinds are visually de-emphasized.
  const isMuted = () => PRESENCE_KINDS.has(props.msg.kind);

  // C7.7: highlight — content kinds where body matches watchlist (own nick MVP).
  const isHighlight = () =>
    !PRESENCE_KINDS.has(props.msg.kind) && matchesWatchlist(props.msg.body, props.userNick);

  const handlers: NickHandlers = {
    onNickClick: props.onNickClick,
    onNickContextMenu: props.onNickContextMenu,
    onJoinChannel: props.onJoinChannel,
    networkSlug: props.networkSlug,
  };

  return (
    <div
      class="scrollback-line"
      classList={{
        "scrollback-action": props.msg.kind === "action",
        "scrollback-notice": props.msg.kind === "notice",
        "scrollback-notice-error":
          props.msg.kind === "notice" && props.msg.meta?.severity === "error",
        "scrollback-presence": PRESENCE_KINDS.has(props.msg.kind),
        "scrollback-muted": isMuted(),
        "scrollback-mention": isMention(),
        "scrollback-highlight": isHighlight(),
      }}
      data-testid="scrollback-line"
      data-kind={props.msg.kind}
      data-msg-id={props.msg.id}
    >
      <span class="scrollback-time">{formatTime(props.msg.server_time)}</span>{" "}
      {renderBody(props.msg, handlers)}
    </div>
  );
};

// C7.1: row types for the mixed separator+message rendering list.
type SeparatorRow = { type: "separator"; label: string; id: string };
// C7.3: unread-marker row — distinct variant so JSX render branch is a
// clean discriminated union (no `kind` subfield conditionals inside SeparatorRow).
type UnreadMarkerRow = { type: "unread-marker"; count: number; id: string };
type MessageRow = { type: "message"; msg: ScrollbackMessage };
// 2026-06-01 (invite-ack timeline fix): invite-ack rows are now part
// of the same `rows()` memo as messages and separators — pre-fix they
// rendered as a sibling AFTER the `<For each={rows()}>` inside the
// scrollback container and visually pinned to the bottom regardless of
// subsequent server-message arrivals (vjt prod report). Interleaving
// by wallclock `at` (epoch ms, same unit as ScrollbackMessage's
// server_time) puts each ack at its arrival position in the timeline.
type InviteAckRow = { type: "invite-ack"; entry: InviteAckEntry; channel: string; id: string };
type Row = SeparatorRow | UnreadMarkerRow | MessageRow | InviteAckRow;

const ScrollbackPane: Component<Props> = (props) => {
  let listRef!: HTMLDivElement;
  // UX-8 (b): scroll-settle debounce timer. Plain let — pure mutation,
  // no Solid reactivity. Cleared on the next scroll event; fires once
  // when scroll has been quiescent for SCROLL_SETTLE_DEBOUNCE_MS.
  // onCleanup at component teardown clears any in-flight timer so a
  // channel switch doesn't fire a stale settle for the previous
  // window.
  let scrollSettleTimer: number | undefined;
  // #168 — last observed scrollTop, so onScroll can tell an operator scroll
  // UP (scrollTop decreased → leave the tail) from a programmatic content-
  // grow above the viewport (scrollTop unchanged → keep following).
  let lastScrollTop = 0;
  // #196 — scrollTop snapshot captured when the media-viewer overlay opens,
  // re-asserted across the overlay's open/close so the preview never strands
  // the reader (see the effect near the activation block below). Plain let —
  // pure mutation, no Solid reactivity.
  let viewerScrollSnapshot: number | null = null;
  const [atBottom, setAtBottom] = createSignal(true);
  // UX-3 Z3 R4: actual-overflow gate for the `pan-y → chrome reveal`
  // trap. Recomputed on every layout-affecting signal (messages,
  // window resize, visualViewport resize → keyboard open/close).
  // True when scrollback content actually exceeds the viewport.
  const [isOverflowing, setIsOverflowing] = createSignal(false);

  // #130 — window-activation flicker gate. The activation scroll lands
  // inside `scrollToActivation`'s double-rAF (load-bearing — see its doc
  // comment), which is necessarily AFTER the browser has painted the
  // swapped-in content at the OLD preserved scrollTop. That paint-then-
  // snap is the visible jump. While `true`, the scrollback container is
  // hidden (visibility, NOT display — layout/scrollHeight stay readable
  // for the deferred geometry read); set synchronously at activation
  // (pre-paint) and cleared once the deferred scroll has settled, so the
  // wrong-scroll frame is never shown. Cold/empty windows skip the hide
  // (nothing to scroll; the length-effect owns their first snap).
  const [activating, setActivating] = createSignal(false);

  // #168 (2026-07-03) — marker-activation LATCH. `<For each={rows()}>` is
  // ref-keyed and the `rows` memo rebuilds fresh wrapper objects every
  // recompute, so EVERY rows change re-creates the list DOM and resets
  // scrollTop to 0 (this is why the length-effect + scrollToActivation exist:
  // to re-establish the scroll position pre-paint via rAF×2 after each
  // recreation). A one-shot marker jump therefore does NOT survive the next
  // rows recreation — the post-switch catch-up `refreshScrollback`
  // (selection.ts) or a late read-cursor hydration recreates the DOM AFTER the
  // jump, and because the jump set `atBottom=false` the length-effect's only
  // re-establish path is suppressed → the marker strands off-screen (the 307
  // race). This latch marks "a channel activation is in effect; keep
  // re-asserting marker-or-tail on every rows recreation until the operator
  // takes over". Set by the channel-SWITCH key-effect AND cold-mount (so
  // app-startup / first-focus jumps to the marker too — vjt point-2, reverses
  // the #46 cold-mount-tail wontfix); cleared on real operator input or an own
  // send (both hand scroll authority back). Visibility-return / resize stay
  // tail-only one-shot — their `atBottom=true` means the length-effect's
  // tail-follow already re-establishes them, no latch needed.
  const [markerActivationPending, setMarkerActivationPending] = createSignal(false);

  // FREEZE CONTRACT (2026-06-08, vjt "step-away" request): the FROZEN
  // bottom boundary of the unread block — sibling to `sessionTopId` (the
  // frozen TOP boundary). The `rows` memo derives the divider from THIS
  // snapshot, NOT the live `getReadCursor`, so a mid-view cursor advance
  // (own scroll-settle echo OR cross-device `read_cursor_set`) does not
  // yank the divider under the operator's eyes while they read. Re-latched
  // to the live cursor on every focus acquisition — channel-switch (key
  // effect) and tab/app visibility-return (option b) — so the divider
  // settles to the new position when the operator steps away and back.
  // `null` = not yet latched / no cursor known (cold-load pre-hydration);
  // the cold-latch effect below picks up the first non-null cursor,
  // mirroring the sessionTopId cold-mount latch. The live signal map stays
  // the single source of truth for sidebar badges + selection.ts unread
  // counts — only the in-pane divider reads this frozen snapshot.
  const [markerCursorId, setMarkerCursorId] = createSignal<number | null>(null);

  // BUGHUNT-2: timestamp of the most recent real operator input event
  // (pointerdown / wheel / touchmove / qualifying keydown) on the
  // listRef. `null` until the operator interacts; reset to `null` on
  // `on(key)` transitions so the new pane starts with a fresh gate
  // (programmatic scrollIntoView during the activation routine must
  // NOT inherit the leaving pane's input timestamp).
  const [lastInputEventAtMs, setLastInputEventAtMs] = createSignal<number | null>(null);

  // BUGHUNT-2 B7: per-window visible-tail snapshot, captured on every
  // onScroll. The leave-arm in `on(key, …)` below reads from this map
  // for `prevKey` — by the time that effect fires, Solid has already
  // re-rendered the `<For each={messages()}>` with the NEW key's rows
  // and `lastFullyVisibleRowId(listRef)` returns the new pane's data,
  // not the leaving pane's. The snapshot freezes the leaving pane's
  // geometry from the LAST scroll event that fired against it (or
  // initial-mount measure), surviving the Solid commit. Closure-scoped
  // Map is fine: only one ScrollbackPane is mounted at a time, the
  // snapshots persist until the component unmounts.
  const visibleTailSnapshot = new Map<string, number>();

  // Focus-session boundary id — the highest message id present in this
  // window AT MOUNT TIME. Marker injection only considers messages whose
  // id falls in `(cursor, sessionTopId]`. Anything arriving DURING the
  // focus session (id > sessionTopId) is "live read" and never spawns a
  // new marker, even peer replies after an own-msg send. Reset on key
  // change so each window mount captures its own boundary.
  //
  // CP29 R-4: id replaces the previous server_time-based bound. Server
  // ids are strictly monotonic (sqlite AUTOINCREMENT) so "highest id at
  // mount" is the unambiguous "everything that existed when I started
  // looking at this window". `null` until the messages signal flushes —
  // an empty window has no meaningful upper bound and the marker stays
  // hidden until a real row lands.
  const [sessionTopId, setSessionTopId] = createSignal<number | null>(null);

  // C7.6: context menu state — null when closed.
  type ContextMenuState = { targetNick: string; x: number; y: number };
  const [contextMenu, setContextMenu] = createSignal<ContextMenuState | null>(null);

  const key = () => channelKey(props.networkSlug, props.channelName);
  const messages = () => scrollbackByChannel()[key()];
  // Per-network IRC nick for self-highlight + JOIN-banner + ownModes —
  // single-source via `ownNickForNetwork(net, me)` so account-name vs
  // IRC-nick drift cannot misfire highlights or own-action detection.
  // Pre-fix this fell through to displayNick(me) === me.name and could
  // miscolor a peer's lines as "self" when account-name matched the
  // peer's IRC nick on a network where the operator runs under a
  // different IRC nick. See api.ts moduledoc + cic H3.
  const userNick = (): string | null => {
    const net = networks()?.find((n) => n.slug === props.networkSlug) ?? null;
    if (net === null) return null;
    return ownNickForNetwork(net, user());
  };

  // C7.6: networkId for UserContextMenu — derive from networks() by slug.
  const networkId = (): number | undefined =>
    networks()?.find((n) => n.slug === props.networkSlug)?.id;

  // C7.6: ownModes — own nick's mode set in this channel (for op-gated items).
  const ownModes = (): string[] => {
    const nick = userNick();
    if (!nick) return [];
    const members = membersByChannel()[key()];
    if (!members) return [];
    return members.find((m) => nickEquals(m.nick, nick))?.modes ?? [];
  };

  // C7.6: left-click a nick → open query window + switch focus.
  // canonicalQueryNick wraps to keep the focus on an existing
  // case-insensitive match (RFC 2812 §2.2); members-list nick is
  // usually canonical already but the NAMES casing can drift from
  // the originally-opened query window's casing (NickServ
  // GhostRECOVER, /nick foo → /nick FOO mid-conversation).
  const handleNickClick = (nick: string): void => {
    const nid = networkId();
    if (nid === undefined) return;
    const canonical = canonicalQueryNick(nid, nick);
    openQueryWindowState(nid, canonical, new Date().toISOString());
    setSelectedChannel({ networkSlug: props.networkSlug, channelName: canonical, kind: "query" });
  };

  // C7.6: right-click a nick → show UserContextMenu at cursor.
  const handleNickContextMenu = (nick: string, e: MouseEvent): void => {
    e.preventDefault();
    setContextMenu({ targetNick: nick, x: e.clientX, y: e.clientY });
  };

  // No-silent-drops bucket 2: [Join] CTA in INVITE rows. Mirrors the
  // /join slash command flow in compose.ts: postJoin REST call +
  // immediate setSelectedChannel for user-intent-driven focus. Server-
  // driven `:pending` window-state origination still flows via
  // record_in_flight_join; this handler only initiates.
  const handleJoinChannel = (channel: string): void => {
    const t = token();
    if (!t) return;
    // INVITE-CTA does not pass a +k key (no UX surface for it on the
    // invite row; keyed-channel invites are rare and the operator can
    // still type `/join #chan key` in compose if needed).
    void postJoin(t, props.networkSlug, channel, null).then(() => {
      setSelectedChannel({ networkSlug: props.networkSlug, channelName: channel, kind: "channel" });
    });
  };

  // C7.1 + C7.3: Build a mixed list of (day-separator | unread-marker | message)
  // rows for rendering. Day-separator injected BETWEEN consecutive rows that
  // cross a local-TZ day boundary. Unread-marker injected between the last
  // read message and the first unread message when a read cursor exists.
  // The first message never gets a day-separator before it.
  //
  // Unread computation (C7.3 / CLAUDE.md "derive, don't duplicate"):
  //   cursor = markerCursorId() — the FROZEN snapshot of the read cursor,
  //            NOT the live getReadCursor. See the signal's doc comment:
  //            it is latched at every focus acquisition and held constant
  //            between, so the divider does not move while the operator
  //            reads (the freeze contract).
  //   sessionTopId = max(message.id) captured at window mount (key change).
  //   unread count = messages.filter(m =>
  //                    m.id > cursor AND
  //                    m.id <= sessionTopId  // pre-arrival only
  //                  ).length
  //   Both bounds are frozen for the focus session: markerCursorId pins
  //   the BOTTOM (last-read) edge, sessionTopId pins the TOP. A mid-view
  //   live-cursor advance (scroll-settle echo, cross-device read_cursor_set)
  //   does NOT move the divider — markerCursorId only re-latches on a focus
  //   acquisition. The sessionTopId bound prevents NEW arrivals during the
  //   focus session from spawning a fresh marker — they're live-read by
  //   definition.
  const rows = createMemo((): Row[] => {
    const msgs = messages() ?? [];
    // 2026-06-01: invite-ack rows for the $server window only. Mirrors
    // the previous `<Show when={props.kind === "server"}>` gate on
    // the now-deleted sibling render. Flatten across all target-channel
    // buckets — one $server window aggregates invites issued to any
    // channel on the network, sorted into the timeline by wallclock
    // `at` alongside server-message arrivals so they no longer pin
    // visually to the bottom.
    const inviteAckEntries: Array<{ entry: InviteAckEntry; channel: string }> = [];
    if (props.kind === "server") {
      const networkEntries = inviteAckBySlug()[props.networkSlug];
      if (networkEntries) {
        for (const [chan, list] of Object.entries(networkEntries)) {
          for (const entry of list) inviteAckEntries.push({ entry, channel: chan });
        }
      }
    }
    if (msgs.length === 0 && inviteAckEntries.length === 0) return [];
    // Freeze contract: read the FROZEN snapshot, not live getReadCursor.
    const cursor = markerCursorId();
    const sessionTop = sessionTopId();
    // How many messages have id strictly after the cursor AND
    // at-or-before the focus-session boundary?
    // Operator-action echoes (e.g. /msg → 401 notice) are excluded — the
    // operator owns the action that produced them, mirroring the
    // subscribe.ts sidebar-badge gate so badge and in-pane marker agree.
    // CP29 R-6: same rule for own presence verbs (own JOIN/PART/etc.) —
    // the sidebar badge gate suppressed them at the bump site, but the
    // in-pane marker derived from raw scrollback rows would still count
    // an own JOIN row landing in `(cursor, sessionTopId]` after a
    // `/part → /join` cycle. `isOwnPresenceEvent` is the shared
    // single-source predicate (see lib/ownPresenceEvent.ts).
    const ownNick = userNick();
    const unreadCount =
      cursor !== null && sessionTop !== null
        ? msgs.filter(
            (m) =>
              m.id > cursor &&
              m.id <= sessionTop &&
              !isOperatorActionEcho(m) &&
              !isOwnPresenceEvent(m, ownNick),
          ).length
        : 0;
    // Only inject the marker if there are unread messages AND some read messages
    // to show as context above it. When all messages are unread, put the marker
    // at the very top (before index 0). When none are unread, skip the marker.
    const injectMarker = cursor !== null && sessionTop !== null && unreadCount > 0;
    const result: Row[] = [];
    let prevTime: number | null = null;
    let markerInjected = false;
    for (const msg of msgs) {
      // C7.3: inject unread-marker BEFORE the first message with id > cursor
      // AND <= sessionTopId. Messages above sessionTopId never get a
      // marker — they're live-read arrivals during the focus session.
      // CP29 R-6: skip own-presence + operator-action-echo rows here so
      // the marker doesn't land above a row that isn't counted in
      // `unreadCount` — the predicate set MUST stay in lock-step with
      // the count filter above.
      if (
        injectMarker &&
        !markerInjected &&
        cursor !== null &&
        sessionTop !== null &&
        msg.id > cursor &&
        msg.id <= sessionTop &&
        !isOperatorActionEcho(msg) &&
        !isOwnPresenceEvent(msg, ownNick)
      ) {
        result.push({ type: "unread-marker", count: unreadCount, id: "unread-marker" });
        markerInjected = true;
        // Day-separator logic: if the previous message (last read) and this first
        // unread message are on different days, the day-separator goes AFTER the
        // unread-marker so the date label describes the first unread message's day.
        // (prevTime is already set to the last read message's time.)
      }
      if (prevTime !== null && isDifferentDay(prevTime, msg.server_time)) {
        result.push({
          type: "separator",
          label: formatDateLabel(msg.server_time),
          id: `sep-${msg.id}`,
        });
      }
      result.push({ type: "message", msg });
      prevTime = msg.server_time;
    }
    // 2026-06-01: weave invite-ack rows into the timeline by wallclock
    // `at` vs message `server_time`. Forward pass: insertion index is
    // the position of the FIRST message-row whose `server_time > entry.at`,
    // or the end of the list when no such message exists. Invite-ack
    // rows skip the unread-marker / day-separator logic on purpose —
    // they're ephemeral operator-action echoes, not server-persisted
    // rows. Stable across re-renders: sorted by `(at, ts)` first so
    // same-ms acks keep insertion order via the closure-monotonic `ts`.
    if (inviteAckEntries.length > 0) {
      inviteAckEntries.sort((a, b) => a.entry.at - b.entry.at || a.entry.ts - b.entry.ts);
      for (const { entry, channel } of inviteAckEntries) {
        let insertAt = result.length;
        for (let i = 0; i < result.length; i += 1) {
          const r = result[i];
          if (r?.type === "message" && r.msg.server_time > entry.at) {
            insertAt = i;
            break;
          }
        }
        result.splice(insertAt, 0, {
          type: "invite-ack",
          entry,
          channel,
          id: `invite-ack-${entry.ts}`,
        });
      }
    }
    return result;
  });

  // C5.0 (UX-5 BJ rewrite — 2026-05-19): own-nick JOIN auto-focus-switch.
  // Derive whether the own nick has a JOIN row for this channel from
  // the scrollback. Channel-window-only per spec #7 — query/server/list/
  // mentions windows have no JOIN concept; gate on kind first. The memo
  // re-runs when messages change; once auto-focus has fired for a key
  // (key ∈ autoFocusedJoins), it stays false so repeated session-internal
  // /join cycles for the same channel don't re-snatch focus from a window
  // the operator has since moved away from.
  //
  // Pre-BJ this memo also gated the "JOIN-self banner" mount; BJ killed
  // the banner (TopicBar + MembersPane already cover topic + members)
  // and the focus side-effect lives on alone. The Set rename
  // (`shownBanners` → `autoFocusedJoins`) tracks the semantic shift.
  const shouldAutoFocusOnOwnJoin = createMemo((): boolean => {
    if (props.kind !== "channel") return false;
    const nick = userNick();
    if (!nick) return false;
    if (autoFocusedJoins.has(key())) return false;
    const msgs = messages();
    if (!msgs) return false;
    return msgs.some((m) => m.kind === "join" && nickEquals(m.sender, nick));
  });

  // UX-3 Z3 R4 — actual-overflow gate. CSS-only fix is impossible:
  // there is no `:has-overflow` selector. `overflow-y: scroll` (R3)
  // didn't help — iOS bubbles `pan-y` to chrome reveal whenever the
  // gesture finds no scroll target, regardless of the container's
  // declared overflow mode.
  //
  // Real fix is JS-measured: read scrollHeight vs clientHeight on
  // every layout-affecting change and toggle a class on `.scrollback`
  // so the CSS rule `.scrollback-overflowing { touch-action: pan-y }`
  // / `.scrollback { touch-action: none }` (base) flips accordingly.
  //
  // Triggers: messages count, window resize, visualViewport resize
  // (keyboard open/close shrinks the scrollback). Measured in a
  // microtask after the layout settles via queueMicrotask.
  //
  // Append-time + initial-mount measurement: overflow class only,
  // never touches scrollTop. Scroll position is owned by the
  // post-append effect (~:1062) or by `scrollToActivation`.
  //
  // UX-6 D9 (2026-05-21) — resize-driven scroll restoration is
  // delegated to the existing `scrollToActivation` routine (see
  // ~:976, the canonical UX-4-K marker-or-tail path). D7's
  // re-pin-to-bottom + D8's preserve-distance-from-bottom math
  // both reinvented behavior that scrollToActivation already
  // encodes correctly: marker present → scroll-into-view({block:
  // "center"}); no marker → scroll to scrollHeight. One source
  // of truth, no new math, no rAF-coalesce primitive.
  //
  // The same routine fires on channel switch + visibility-return
  // + (D9) every vv.resize. iOS keyboard slide-in's intermediate
  // resize fires are tolerated naturally — each microtask reads
  // current scrollHeight + clientHeight, ends at the right place.
  // Eight failed attempts cost: see docs/DESIGN_NOTES.md UX-6-D.
  const measureOverflow = (): void => {
    if (!listRef) return;
    // Same microtask-vs-layout race as scrollToActivation: scrollHeight
    // read before layout returns stale values immediately after a row
    // append. Double rAF ensures layout has run before we read.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!listRef) return;
        setIsOverflowing(listRef.scrollHeight > listRef.clientHeight);
      });
    });
  };

  // BUGHUNT-2: unmount-time cursor write. ScrollbackPane unmounts
  // when sel().kind transitions from "channel"/"query"/"server" to
  // "home"/"mentions"/"admin" — different `<Show>` branch in
  // Shell.tsx. The `on(key, …)` effect above only fires for same-
  // branch switches (channel↔channel, query↔channel, etc.); the
  // unmount path bypasses it.
  //
  // onCleanup runs BEFORE Solid removes the listRef DOM, so
  // listRef.scrollTop is still readable. Reads visible-tail for the
  // CURRENT pane (props.networkSlug, props.channelName — captured in
  // the closure at component-init time, won't change before unmount
  // because the component IS this (slug, channel) instance).
  onCleanup(() => {
    if (!listRef) return;
    const id = lastFullyVisibleRowId(listRef);
    if (id === null) return;
    setCursorIfAdvances(props.networkSlug, props.channelName, id);
  });

  createEffect(
    on(
      () => messages()?.length ?? 0,
      () => measureOverflow(),
    ),
  );

  onMount(() => {
    measureOverflow();
    // COLD-MOUNT activation (#168 completion, vjt point-2 2026-07-03) — the
    // channel-SWITCH key-effect below is `defer`-skipped on mount, so the FIRST
    // focus / app-startup used to fall through to the length-effect's tail
    // (the #46 cold-mount-tail wontfix). It is now a marker activation, SAME as
    // a switch: latch + establish so an app-startup into an unread channel
    // jumps to the divider. rows may still be empty here (REST/cursor not
    // landed) — scrollToActivation early-returns and the latched length-effect
    // re-asserts on the first load / cursor hydration.
    setMarkerActivationPending(true);
    scrollToActivation("marker-or-tail", true);
    // UX-6 D9 — every vv.resize (keyboard open OR close, orientation
    // change, browser zoom) re-runs the canonical scroll routine so
    // the visible content stays anchored to what the operator was
    // reading. scrollToActivation is defined below at ~:976 (closure
    // resolves at call time, not registration time). Symmetric for
    // open + close — vjt accepted yank-on-close in the D9 plan
    // ("we can start with symmetry and then reset scroll marker
    // later"). Future: marker-reset-on-scroll so close-side preserve
    // is finer-grained.
    //
    // window.resize is also wired — desktop window resize, devtools,
    // browser zoom — same canonical behavior.
    // resize (keyboard open/close, orientation, zoom) = resume family → TAIL,
    // never the divider (#46); one-shot, no latch.
    const onResize = () => scrollToActivation("tail-only", true);
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    onCleanup(() => {
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
      if (scrollSettleTimer !== undefined) {
        window.clearTimeout(scrollSettleTimer);
      }
    });
  });

  // #196 — preserve the reader's scroll position across the media-viewer
  // overlay (image/video/audio preview). Opening the preview was dropping the
  // scrollback list's scrollTop, stranding the reader far from where they
  // were ("re-reading old messages as if new"). ScrollbackPane owns the scroll
  // container and is the single scroll authority — the fixed overlay can't
  // reach `listRef` — so the capture/restore lives here, keyed on the
  // overlay's open/close EDGE (`defer: true` skips the initial mount). Snapshot
  // the position when the overlay opens; re-assert it across the next two
  // frames (matching `scrollToActivation`'s rAF×2 — any perturbation lands
  // after the overlay's layout commits) and again on close, so NEITHER
  // transition yanks the viewport. Restoring the operator's own captured
  // position can never move them anywhere they weren't already.
  createEffect(
    on(
      () => mediaViewerState() !== null,
      (open) => {
        if (!listRef) return;
        if (open) viewerScrollSnapshot = listRef.scrollTop;
        const target = viewerScrollSnapshot;
        if (target === null) return;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (listRef && listRef.scrollTop !== target) listRef.scrollTop = target;
            if (!open) viewerScrollSnapshot = null;
          }),
        );
      },
      { defer: true },
    ),
  );

  createEffect(
    on(shouldAutoFocusOnOwnJoin, (shouldFocus) => {
      if (shouldFocus && !autoFocusedJoins.has(key())) {
        autoFocusedJoins.add(key());
        setSelectedChannel({
          networkSlug: props.networkSlug,
          channelName: props.channelName,
          kind: "channel",
        });
      }
    }),
  );

  // UX-4 bucket K (2026-05-19) — canonical window-activation scroll.
  //
  // Activation triggers share ONE routine (`scrollToActivation`), passing the
  // `mode` that fits their intent (see the routine doc below):
  //   1. `selectedChannel` change — operator switched windows (the effect
  //      below tracks `key()`). "marker-or-tail" + latches
  //      `markerActivationPending`: a deliberate switch into an unread channel
  //      jumps to the divider, re-asserted until the operator takes over.
  //   2. COLD-MOUNT — first-focus / app-startup (onMount, the key-effect is
  //      `defer`-skipped on mount). "marker-or-tail" + latch, SAME as a switch:
  //      app-startup into an unread channel jumps to the divider too (vjt
  //      point-2, 2026-07-03 — reverses the #46 cold-mount-tail wontfix).
  //   3. `document.visibilitychange` → visible — PWA backgrounded then
  //      re-opened (the effect below tracks `isDocumentVisible` false→true).
  //      "tail-only", no latch: resume ≠ switch (#46).
  //
  // Single source of truth for the DOM read/scroll mechanics: any future
  // activation trigger plugs into `scrollToActivation` and picks its mode.
  // No ad-hoc scrollTop preserve/restore lives anywhere else in this
  // component for the activation path — `onScroll`'s `loadMore` block has its
  // own preservation but that's pagination-prepend bookkeeping, semantically
  // distinct (operator IS scrolling up, we keep their reading position stable
  // while older rows PREPEND from REST).
  //
  // #168 (2026-07-02) collapsed scroll to one always-bottom authority to
  // kill a send-time race (the #163/#161/#156 scroll-to-marker branch was a
  // SECOND scrollTop authority that won after a send, yanking the viewport
  // up to the divider — P0). Regression fix (2026-07-03a): that collapse
  // OVER-REACHED — it also killed the jump-to-marker on a channel-SWITCH.
  // Completion (2026-07-03b, vjt point-2): marker-jump now fires on ALL
  // channel activation (switch AND cold-mount/app-startup), and is RE-ASSERTED
  // across rows recreations (the 307 race fix). The `mode` param + the
  // `markerActivationPending` latch scope the divergence WITHOUT reintroducing
  // the send-race (DESIGN_NOTES 2026-07-03):
  //   * "marker-or-tail" — channel activation (SWITCH + cold-mount). If the
  //     RENDERED frozen unread divider exists, scroll to it (`block:"start"`)
  //     and set `atBottom` from the resulting distance; else the tail. The
  //     divider is the frozen row the `rows()` memo already injected — we
  //     read its DOM node, never a recomputed cursor geometry. While the latch
  //     is set the length-effect re-asserts this on every rows recreation, so
  //     the post-switch catch-up refresh / late cursor hydration can't strand
  //     it (307). Cleared on operator input / own send.
  //   * "tail-only" — visibility-return / resize (#46 resume family). Never
  //     the divider; `atBottom=true`; no latch (the length-effect's
  //     `atBottom` tail-follow already re-establishes the tail).
  // Post-send / live-append stay at the BOTTOM via the length-effect +
  // `lastOwnSend`→`scrollToBottom` (both untouched; the send clears the latch
  // first). The divider still RENDERS at its frozen position (freeze-display
  // contract, DESIGN_NOTES 2026-06-08) for every trigger. `atBottom` is set
  // per branch so the floating "scroll to bottom" button doesn't flash
  // mid-activation.
  // `withHide` (#130 flicker gate) applies ONLY to the initial establish from
  // an activation trigger — a cross-key window swap paints the new content at
  // the old preserved scrollTop before the deferred scroll corrects it, so we
  // hide (visibility) until the rAF×2 lands. A RE-ASSERT (same key, driven by
  // the length-effect when `markerActivationPending`) passes `false`: the
  // rows-recreation reset happens in the SAME frame and the rAF×2 corrects it
  // pre-paint, so the intermediate scrollTop=0 is never painted — no hide
  // needed, and toggling `activating` on every rows change would itself flicker.
  const scrollToActivation = (mode: "marker-or-tail" | "tail-only", withHide: boolean): void => {
    if (!listRef) return;
    // #219 — while a media-viewer overlay covers the pane, its scroll position is
    // frozen by the #196 capture/restore below (`viewerScrollSnapshot` is held
    // non-null for the whole open→close-settle window). No activation authority
    // may move a COVERED pane: on mobile a fullscreen modal changes the
    // visualViewport, firing the onMount `resize` listener → scrollToActivation(
    // "tail-only") → a tail snap that strands the reader far from where they were
    // (jump-to-bottom, the #219 report). Bail while the snapshot is held; the
    // #196 effect owns restoration on the open edge and on close.
    if (viewerScrollSnapshot !== null) return;
    // #130 — hide the container synchronously NOW (pre-paint) so the
    // browser never paints the new content at the OLD preserved scrollTop
    // before the deferred scroll below corrects it. Revealed in every exit
    // path of the rAF body. Cold/empty windows have nothing to scroll
    // (the length-effect owns their first snap) — skip the hide and stay
    // visible so they can't be stranded hidden.
    const pending = messages();
    if (!pending || pending.length === 0) {
      if (withHide) setActivating(false);
      return;
    }
    if (withHide) setActivating(true);
    // Double rAF: queueMicrotask flushes BEFORE the browser's layout
    // pass, so listRef.scrollHeight reads stale geometry when called
    // immediately after a channel switch (Solid commits the new rows,
    // but their box heights aren't yet included in scrollHeight). First
    // rAF lands inside the next frame's pre-layout phase; second rAF
    // guarantees layout has completed. Standard "read DOM geometry
    // after the browser has settled" idiom.
    //
    // UX-8(a2): if messages() hasn't flushed yet (cached re-entry to a
    // window where the scrollback store reload races the key-effect),
    // skip — the length-effect below catches the bottom-snap on the
    // first non-empty length transition.
    //
    // UX-8(a3): `lastElementChild?.scrollIntoView` is more reliable than
    // `scrollTop = scrollHeight` math — the browser walks the element's
    // box and scrolls its container natively, which is layout-aware even
    // when scrollHeight bookkeeping is mid-update (channel-back path:
    // query → #bofh cached, scrollback store reload races key-effect even
    // after rAF×2). Fallback scrollHeight write is preserved if scrollback
    // is empty (no element to scroll into view).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // #130 — reveal in EVERY exit path so the pane is never stranded
        // hidden. The real strand vector is an emptied store between the
        // sync-top check and here (next guard); the listRef guard mirrors
        // the pre-existing top guard for symmetry.
        if (!listRef) {
          if (withHide) setActivating(false);
          return;
        }
        const msgs = messages();
        if (!msgs || msgs.length === 0) {
          if (withHide) setActivating(false);
          return;
        }
        // #168 regression fix — the channel-SWITCH trigger jumps to the
        // RENDERED frozen unread divider when one exists; every other trigger
        // (cold-mount, visibility-return, resize) lands at the tail. Read the
        // marker's DOM node the `rows()` memo already injected (same
        // data-testid the render emits) — do NOT recompute the cursor
        // geometry a second way. Its ABSENCE (fully-read channel, or a cold
        // switch whose rows haven't landed) naturally falls to the tail.
        const marker =
          mode === "marker-or-tail"
            ? (listRef.querySelector('[data-testid="unread-marker"]') as HTMLElement | null)
            : null;
        if (marker?.scrollIntoView) {
          marker.scrollIntoView({ block: "start" });
          // Set `atBottom` from the settled distance (layout is stable inside
          // the rAF×2). A far divider ⇒ false: the floating "scroll to
          // bottom" button shows AND the length-effect's `if (!atBottom())
          // return` guard yields, so its tail-follow does not race this jump
          // (same atBottom coordination the pre-#168 marker branch used). A
          // near-tail divider (tiny unread) ⇒ true: effectively at the
          // bottom, tail-follow is correct.
          const distance = listRef.scrollHeight - listRef.scrollTop - listRef.clientHeight;
          setAtBottom(distance <= SCROLL_BOTTOM_THRESHOLD_PX);
        } else {
          const tail = listRef.lastElementChild as HTMLElement | null;
          if (tail?.scrollIntoView) {
            tail.scrollIntoView({ block: "end" });
          } else {
            listRef.scrollTop = listRef.scrollHeight;
          }
          setAtBottom(true);
        }
        // Scroll has settled at the correct position — reveal.
        if (withHide) setActivating(false);
      });
    });
  };

  // #163 — leave-arm cursor write, in its OWN effect WITHOUT `defer`.
  // On leaving a window (channel↔query↔server key change; the pane stays
  // MOUNTED per Shell's shared `kindHasScrollback` Match, so `onCleanup`
  // does NOT fire) mark the LEAVING window read up to what the operator saw.
  //
  // The `defer` split is the actual #163 fix and is load-bearing. This
  // arm used to live inside the activation effect below, which carries
  // `{defer:true}`. Solid's `on(key, fn, {defer:true})` skips the mount
  // call and `return`s BEFORE assigning its internal `prevInput` (see
  // solid-js `on`), so the FIRST real key change after mount invokes the
  // callback with `prevKey === undefined`. The arm's guard
  // `prevKey !== undefined` — meant to skip the mount — therefore skipped
  // the first genuine leave after every mount/remount: no cursor was
  // written and the just-read channel kept a phantom "1 unread" (proven by
  // runtime instrumentation — the arm never fired, zero cursor POSTs). The
  // activation effect still NEEDS `defer` (its mount run would pre-emptively
  // clear the auto-focus scroll), so the arm moves to its own plain
  // (non-deferred) effect: fn runs at mount (the guard skips it) AND Solid
  // assigns `prevInput`, so the first real change carries a DEFINED
  // `prevKey` and the arm runs.
  //
  // Which id: NOT `atBottom()`. That signal is unreliable HERE — the
  // sibling activation effect runs in the SAME key-change batch and
  // `setAtBottom(true)`s before this arm reads it (instrumentation caught
  // `atBottom() === true` while the leaving pane sat 407px off the bottom).
  // Use the leaving pane's OWN captured onScroll `visibleTailSnapshot`
  // instead (a post-hoc `lastFullyVisibleRowId(listRef)` can't be used —
  // Solid's `<For>` has already swapped rows to the new key). At the bottom
  // the snapshot equals the store true-tail (the `lastFullyVisibleRowId`
  // at-bottom short-circuit guarantees onScroll captured the true tail);
  // scrolled up it is the last row the operator actually saw. Fall back to
  // the store-tail only when no snapshot exists (pure auto-follow, never
  // scrolled — still at the bottom, so the tail is correct).
  // `setCursorIfAdvances` is forward-only, so a scrolled-up snapshot below
  // the cursor is dropped, never rewinding. Channel→home/mentions switches
  // unmount the pane and are covered by `onCleanup`.
  createEffect(
    on(key, (newKey, prevKey) => {
      // `prevKey === undefined` only on the mount run (no `defer` here);
      // `prevKey === newKey` shouldn't happen. Skip both.
      if (prevKey === undefined || prevKey === newKey) return;
      const snapshotted = visibleTailSnapshot.get(prevKey);
      const prevMsgs = scrollbackByChannel()[prevKey];
      const storeTail =
        prevMsgs && prevMsgs.length > 0 ? (prevMsgs[prevMsgs.length - 1]?.id ?? null) : null;
      const id = snapshotted ?? storeTail;
      if (id !== null) {
        const decoded = decodeChannelKey(prevKey);
        if (decoded !== null) {
          setCursorIfAdvances(decoded.slug, decoded.name, id);
        }
      }
      // Free the snapshot for the leaving key — we won't visit this
      // `prevKey` as `prev` again until a fresh scroll captures a new one.
      visibleTailSnapshot.delete(prevKey);
    }),
  );

  // Activation trigger 1 — `selectedChannel` change. The underlying
  // `[data-testid="scrollback"]` <div> is the SAME DOM node across
  // selectedChannel changes (Solid's <Show> in Shell.tsx is non-keyed),
  // so its `scrollTop` survives the switch. Without an explicit reset,
  // opening an empty query window (scrollTop=0) and then re-selecting
  // a populated channel leaves the channel pinned at scrollTop=0 — the
  // length-effect below only fires when `messages().length` changes,
  // and a previously-loaded channel's length is identical to the last
  // time we viewed it.
  //
  // Per-channel pre-work this trigger owns (does NOT belong in
  // `scrollToActivation` because visibility-return on the SAME channel
  // must NOT reset these):
  //   * sessionTopId — capture the focus-session boundary (highest
  //     id present right now) so future arrivals during this session
  //     are "live-read" and never spawn a fresh marker.
  //
  // `defer: true` skips the initial mount run so the auto-focus
  // effect's first-mount evaluation isn't pre-emptively cleared.
  createEffect(
    on(
      key,
      () => {
        // BUGHUNT-2: reset input-gate so the new pane starts fresh.
        // Programmatic activation `scrollIntoView` in scrollToActivation
        // must not inherit the leaving pane's timestamp.
        setLastInputEventAtMs(null);

        // 2026-06-01 (scroll-contamination fix): re-arm auto-follow on
        // every window activation. The `[data-testid="scrollback"]`
        // <div> is the SAME DOM node across kind transitions (Shell.tsx
        // bundles channel|query|server into ONE Match), so its
        // `scrollTop` survives the swap — and the `atBottom` signal,
        // unless explicitly reset here, carries the LEAVING pane's
        // user-scrolled-up state into the arriving pane. When the
        // arriving pane is cold (`messages()` empty/undefined),
        // `scrollToActivation`'s rAF×2 body early-returns at :1089
        // without resetting scroll OR `atBottom`. The length-effect
        // at :1292 then reads stale `atBottom=false` once REST lands
        // and skips the auto-snap, leaving the DOM at whatever
        // scrollTop the browser preserved from the source pane. vjt
        // prod-reported as "scroll contamination after few back and
        // forths of focusing many windows". The auto-snap branch in
        // `scrollToActivation` writes the new pane's true bottom on
        // its own; if the operator scrolls up in the new pane, the
        // first real onScroll restores `atBottom=false`. Re-arming
        // here is therefore safe + correct — every activation starts
        // tail-following, and the operator's own input takes it back.
        setAtBottom(true);

        // CP29 R-4: capture the boundary as the highest message id present
        // RIGHT NOW. `messages()` is the same store the rows memo reads;
        // an empty window leaves the boundary null and the latching
        // effect below picks it up the first time a row lands.
        const msgs = messages();
        const top = msgs && msgs.length > 0 ? (msgs[msgs.length - 1]?.id ?? null) : null;
        setSessionTopId(top);
        // Freeze contract: re-latch the FROZEN bottom boundary to the new
        // window's live cursor. Channel-switch is a focus acquisition — the
        // divider settles to wherever the cursor reached. `props` already
        // point to the arriving window here (same reason the leave-arm above
        // decodes `prevKey` for the LEAVING window). A `null` cursor (cold,
        // unhydrated) is picked up by the cold-latch effect below.
        setMarkerCursorId(getReadCursor(props.networkSlug, props.channelName));
        // Deliberate channel-SWITCH → jump to the frozen divider if this
        // window has unread; else the tail. Latch so the post-switch catch-up
        // refresh / late cursor hydration re-asserts the jump instead of
        // stranding it (307 race). (This effect is `defer`-skipped on the
        // initial mount; first-focus-after-login is the COLD MOUNT handled by
        // onMount — also a marker activation now. #168, 2026-07-03.)
        setMarkerActivationPending(true);
        scrollToActivation("marker-or-tail", true);
      },
      { defer: true },
    ),
  );

  // Activation trigger 2 — `isDocumentVisible` false→true transition.
  // PWA backgrounded (visibility-hide, browser-tab-switch, OS app
  // switch) then re-opened. selection.ts owns the cursor settle on
  // false→true (clearBadgesForWindow); this effect owns the scroll
  // settle AND the freeze-contract bottom-boundary re-latch.
  //
  // Top/bottom boundaries diverge on visibility-return (deliberate, see
  // the markerCursorId / sessionTopId doc comments):
  //   * sessionTopId (TOP) is PRESERVED — a brief tab-blur is not
  //     "leaving the window"; messages that arrived while hidden stay
  //     live-read, no fresh marker. (Re-latching it would mis-classify
  //     them.)
  //   * markerCursorId (BOTTOM) is RE-LATCHED to the live cursor —
  //     option (b): a step-away-and-back settles the divider to wherever
  //     the cursor reached while frozen. The re-latch runs BEFORE
  //     scrollToActivation so the activation scroll sees the updated
  //     marker state.
  //
  // `prev === undefined` guards the initial-mount run (signal owns
  // the prev sentinel pattern; mirrors selection.ts's identical guard
  // shape at on(isDocumentVisible)). false→true is the only edge this
  // effect handles. true→false cursor write lives in the BUGHUNT-2
  // blur-arm effect immediately below; selection.ts's redundant
  // true→false copy is deleted in A6.
  createEffect(
    on(isDocumentVisible, (visible, prev) => {
      if (prev === undefined) return;
      if (prev === false && visible === true) {
        // #159 item 2 — VISIBILITY freshness. The re-foreground of a
        // backgrounded PWA is an activation trigger just like a tab
        // select, but only `scrollToActivation` (scroll position) fired
        // here — no scrollback catch-up. If this channel stopped
        // receiving live while hidden (socket stayed open; this one topic
        // went quiet), the missed rows never arrive until a full reload.
        // Fire the same catch-up verb the selection arm uses (#159 item 1
        // in selection.ts). It is deliberately NOT folded into
        // `scrollToActivation`: that routine early-returns on an empty
        // pane (`messages().length === 0`), which is exactly the gap case
        // we must heal — the fetch has to run independent of pane
        // geometry. This pane only mounts for `kindHasScrollback` windows
        // (Shell.tsx `<Match>`), so `props` is always a real /messages
        // channel — no synthetic-window 404.
        void refreshScrollback(props.networkSlug, props.channelName);
        setMarkerCursorId(getReadCursor(props.networkSlug, props.channelName));
        // visibility-return (PWA re-foreground) = resume family → TAIL, never
        // the divider (#46); one-shot, no latch. Only a channel activation
        // (switch / cold-mount) jumps to the marker (#168, 2026-07-03).
        scrollToActivation("tail-only", true);
      }
    }),
  );

  // Send-relatch (2026-06-09, vjt: "marker showing + you send → hide
  // it"). An own send is an explicit caught-up action, so it re-latches
  // the frozen marker to the now-advanced live cursor — collapsing the
  // divider immediately instead of waiting for a window-switch. Keyed:
  // only a send to THIS pane's `(slug, channel)` hides its marker (a
  // `/msg` elsewhere doesn't). `lastOwnSend` fires ONLY on an own send,
  // so passive advances (scroll-settle echo, cross-device) stay frozen.
  // `defer: true` skips the mount run — the key/cold-latch effects own
  // the mount-time baseline.
  //
  // #168 — a send ALSO re-enters follow mode unconditionally: even if the
  // operator had paged UP to re-read, sending snaps the pane back to the
  // tail so the just-sent line is visible (issue #168 acceptance: "send
  // scrolls to the bottom unconditionally"). `scrollToBottom` is the same
  // tail authority the length-effect uses (scroll + atBottom=true); a
  // pending WS-echo row is then followed by the length-effect. This is NOT
  // event-type branching — the send resets the follow-STATE and the single
  // always-bottom authority does the scrolling.
  createEffect(
    on(
      lastOwnSend,
      (sent) => {
        if (sent !== key()) return;
        // An own send ends the activation: clear the marker latch FIRST so the
        // length-effect's re-assert can't fight the bottom snap, then re-latch
        // the frozen divider to the now-advanced cursor (collapse it) and snap
        // to the tail. Post-send stays unconditionally at the BOTTOM (#168 gate
        // — do NOT re-open the send-jump).
        setMarkerActivationPending(false);
        setMarkerCursorId(getReadCursor(props.networkSlug, props.channelName));
        scrollToBottom();
      },
      { defer: true },
    ),
  );

  // BUGHUNT-2: browser-blur cursor write. Fires on
  // `prev === true && visible === false` (tab → hidden, app switch on
  // mobile, OS lock). Reads lastFullyVisibleRowId for the CURRENT pane
  // and POSTs via setCursorIfAdvances. Mirror of the leave-arm in
  // A3's key-effect, but for the no-key-change case.
  //
  // No false→true arm here — focus-regain does NOT write the live
  // cursor. (The DISPLAY snapshot IS re-latched on focus-regain by the
  // sibling activation effect above — freeze contract option (b) — but
  // that re-reads the existing cursor, it doesn't advance it.)
  //
  // `prev === undefined` guards the initial-mount run (mirrors the
  // sibling effect's identical guard).
  createEffect(
    on(isDocumentVisible, (visible, prev) => {
      if (prev === undefined) return;
      if (prev !== true || visible !== false) return;
      if (!listRef) return;
      const id = lastFullyVisibleRowId(listRef);
      if (id === null) return;
      setCursorIfAdvances(props.networkSlug, props.channelName, id);
    }),
  );

  // CP29 R-4: cold-mount + delayed-REST settle. The key-change effect
  // above runs with `defer: true` (skips the initial mount) and only
  // captures sessionTopId when there's already a row in the store.
  // Cold mounts where REST has not yet landed start with `messages()
  // === undefined` and would leave sessionTopId at null forever — every
  // subsequent WS arrival would then be considered "during the focus
  // session" and never injected as unread, even when it landed before
  // the operator looked. Latch the first non-empty observation here:
  // when sessionTopId is null AND messages have a row, capture the
  // tail id as the boundary. Idempotent — no-op once set; key-change
  // resets to null and re-arms.
  createEffect(() => {
    if (sessionTopId() !== null) return;
    const msgs = messages();
    if (!msgs || msgs.length === 0) return;
    const last = msgs[msgs.length - 1];
    if (last === undefined) return;
    setSessionTopId(last.id);
  });

  // Freeze contract: cold-latch the FROZEN bottom boundary. Mirror of the
  // sessionTopId cold-mount latch above, but gated on the cursor signal
  // instead of messages — the read cursor hydrates from /me + join-reply,
  // which can land AFTER mount (the same race documented at the
  // scroll-to-marker length-effect below). The key/visibility re-latch
  // points set markerCursorId eagerly, but on a cold load they may run
  // while the cursor is still null; this arm picks up the first non-null
  // observation. Idempotent + freeze-safe: the `markerCursorId() !== null`
  // guard is read FIRST, so once latched the effect no longer tracks the
  // live cursor and a later mid-view advance can NOT re-run it — the
  // divider stays frozen until a focus acquisition re-latches it.
  //
  // Optimistic-cursor note (2026-06-08): setReadCursor now advances the
  // live cursor optimistically, so the "first non-null observation" this
  // arm latches CAN be an optimistic value if a cursor write (send /
  // scroll-settle / blur) fires inside the cold-load-before-hydration
  // window. Narrow corner (the channel is joined → join-reply has
  // hydrated the cursor by the time the operator can interact), and the
  // pre-optimistic code had the symmetric race (it latched whichever
  // applyReadCursorSet echo landed first). Acceptable; flagged for honesty.
  createEffect(() => {
    if (markerCursorId() !== null) return;
    const c = getReadCursor(props.networkSlug, props.channelName);
    if (c === null) return;
    setMarkerCursorId(c);
  });

  // After Solid commits new DOM nodes, scroll to the tail iff the user
  // was at the bottom before the update (auto-follow). The effect tracks
  // `rows().length` so it re-runs on every append AND on cursor
  // hydration (which inserts/removes the unread-marker row inside the
  // memo, changing rows().length without changing messages().length).
  //
  // BUGHUNT-3 sub-cluster B (2026-05-25): tracking `messages().length`
  // was insufficient — when the readCursor signal hydrates AFTER
  // initial scrollback REST (the `me` resource and `loadInitialScrollback`
  // race; the loser determines which path runs), `rows()` re-runs and
  // injects the marker, but `messages().length` is unchanged so this
  // effect didn't fire, leaving the pane one snap short. Tracking
  // `rows().length` catches the marker insertion as a length delta and
  // re-runs the tail-follow on the same cycle.
  //
  // #168 (2026-07-02) — this length-effect (post-append / cursor-hydration)
  // is TAIL-ONLY and stays so. The former C7.3 scroll-to-marker branch here
  // was a second scrollTop authority that parked the viewport on the divider
  // and set atBottom=false, so a send did not follow to the tail — removed.
  // New content ⇒ bottom while following (atBottom); scrolled-up
  // (atBottom=false) preserves position — irssi-shape, only the operator's
  // own scroll leaves the tail. The scroll-to-marker jump was RESCOPED to the
  // deliberate channel-SWITCH trigger inside `scrollToActivation`
  // ("marker-or-tail" mode, #168 regression fix 2026-07-03) — NOT here: when
  // a switch parks on the divider it sets atBottom=false first, so the
  // `if (!atBottom()) return` guard below yields and never races that jump
  // back to the tail. The frozen divider renders in place (DESIGN_NOTES
  // 2026-06-08) for every trigger; this effect just never scrolls to it.
  //
  // The `atBottom` gate stays honest through the #156 anchored initial load
  // (which prepends the read-context page above the tail while following)
  // because `onScroll` only flips `atBottom` false on a real scroll UP
  // (scrollTop decreases) — a content-grow-above keeps scrollTop put, so the
  // spurious scroll event it fires no longer lies "left the bottom" (#168).
  createEffect(
    on(
      () => rows()?.length ?? 0,
      () => {
        if (!listRef) return;
        // #219 — a media viewer covering the pane freezes its scroll (see the
        // #196 capture/restore + the scrollToActivation guard). A message
        // arriving WHILE the viewer is up must not tail-follow the covered pane
        // out from under the reader; the #196 effect restores their held
        // position on close. `viewerScrollSnapshot` is non-null for the whole
        // open→close-settle window.
        if (viewerScrollSnapshot !== null) return;
        // #168 completion / 307 race fix — while a channel activation is
        // latched AND a rendered unread divider EXISTS, EVERY rows recreation
        // (post-switch catch-up refresh, late read-cursor hydration inserting
        // the divider) must RE-ASSERT the marker jump; the ref-keyed `<For>`
        // reset scrollTop to 0 on this recreation and a one-shot jump would
        // strand (the 307 bug — a far marker sets atBottom=false, which without
        // this branch suppresses ALL re-establish). Pre-paint (rAF×2,
        // withHide=false) so the reset frame is never shown.
        //
        // Gated on the marker actually EXISTING (not just the latch): when
        // there is no divider — a read channel's cold-mount, OR a scroll-up
        // loadMore prepend on a read channel — we FALL THROUGH to the atBottom
        // tail-follow below. That preserves the two cases correctly with ONE
        // rule: initial cold-mount (atBottom=true) tails; a loadMore prepend
        // after the operator scrolled up (atBottom=false) does nothing → the
        // prepend's own height-delta restore preserves position (cp14-b2). A
        // no-marker re-assert would instead TAIL and yank the prepend — the
        // oscillation this gate prevents. The latch still clears on operator
        // input / own send.
        if (markerActivationPending() && listRef.querySelector('[data-testid="unread-marker"]')) {
          scrollToActivation("marker-or-tail", false);
          return;
        }
        if (atBottom()) {
          // Same scrollHeight-vs-layout race as scrollToActivation /
          // measureOverflow: reading scrollHeight synchronously inside
          // the Solid effect callback fires BEFORE the browser's layout
          // pass has measured the newly-committed <For> rows, so the
          // write lands one-or-two rows short of true bottom.
          // CI sentinel (scroll-on-window-switch:141) consistently saw a
          // 66px gap pre-double-rAF; vjt prod-dogfooded the same as
          // "short channel scrolled above its own height" 2026-05-23.
          // Double rAF guarantees layout has settled before the read.
          // UX-8(a3): use lastElementChild.scrollIntoView for native
          // layout-aware bottom-anchor (avoids scrollHeight-mid-update
          // race even after rAF×2).
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (!listRef) return;
              if (!atBottom()) return;
              const tail = listRef.lastElementChild as HTMLElement | null;
              if (tail?.scrollIntoView) {
                tail.scrollIntoView({ block: "end" });
              } else {
                listRef.scrollTop = listRef.scrollHeight;
              }
            });
          });
        }
      },
    ),
  );

  // #168 completion — clear the marker-activation latch the moment the operator
  // takes over scrolling. `lastInputEventAtMs` is set by every operator scroll
  // gesture (pointerdown / wheel / touchmove / scroll-keys) and reset to null
  // on key-change; a non-null transition means the operator is driving, so we
  // stop re-asserting the marker and hand scroll authority back (subsequent
  // live appends then follow the `atBottom` rule below — preserve when scrolled
  // up, tail when at the bottom). The `null` guard skips the key-change reset
  // and the initial-mount run.
  createEffect(
    on(lastInputEventAtMs, (ts) => {
      if (ts !== null) setMarkerActivationPending(false);
    }),
  );

  // Cursor settling is owned by selection.ts (on focus-leave +
  // browser-blur). Per the marker spec: a marker is shown ONCE per
  // "I read this window" event — leaving the window is the "I've
  // moved on" signal that sets the cursor. Doing it here on
  // `atBottom` had two bugs: (1) the createSignal initial true fired
  // the effect on mount before the user could see anything; (2) any
  // auto-follow scroll on a new message kept atBottom true and
  // re-set the cursor on every append, hiding the marker on the
  // focused window before the user moved away. The selection-store
  // leave hook lives at `lib/selection.ts`'s `on(selectedChannel)`
  // effect.

  // BUGHUNT-2: real-input markers. Set on every operator-driven event
  // that could plausibly cause a scroll; consulted by onScroll's
  // settle-arm gate to distinguish operator scrolls from programmatic
  // `scrollIntoView` calls fired by `scrollToActivation`.
  //
  // Why four handlers (not just pointerdown):
  //   * `pointerdown` covers drag-of-scrollbar and the start of touch
  //     interactions on iOS Safari (PointerEvent unified since iOS 13).
  //   * `wheel` covers desktop mouse-wheel rotation. Per W3C the wheel
  //     event is a real user input but does NOT emit a preceding
  //     `pointerdown` — pointerdown fires only on button press, not on
  //     scroll-wheel rotation. Missed in bucket A; the cursor would
  //     never advance on desktop wheel scroll without this handler.
  //   * `touchmove` covers iOS-Safari touch-scroll where pointerdown
  //     fires but the scroll lands AFTER pointerup if the drag is
  //     short — pointerdown alone leaves a gap if the operator taps
  //     and releases on a flung scroll.
  //   * `keydown` covers desktop keyboard scrolling (PageDown / Space /
  //     arrows). Requires the listRef to be focusable (`tabIndex="-1"`
  //     on the element so click-to-focus works without adding a tab-
  //     stop).
  const onPointerDown = (): void => {
    setLastInputEventAtMs(Date.now());
  };

  const onWheel = (): void => {
    setLastInputEventAtMs(Date.now());
  };

  const onTouchMove = (): void => {
    setLastInputEventAtMs(Date.now());
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (SCROLL_KEYS.has(e.key)) {
      setLastInputEventAtMs(Date.now());
    }
  };

  const onScroll = () => {
    if (!listRef) return;
    const st = listRef.scrollTop;
    const distance = listRef.scrollHeight - st - listRef.clientHeight;
    // #168 — the follow authority (`atBottom`) flips FALSE only on an
    // operator scroll UP (scrollTop DECREASES). Reaching the tail (distance
    // within threshold) always re-arms the follow. A programmatic content-
    // grow ABOVE the viewport — the #156 anchored read-context page, or the
    // WS join-ok `refreshScrollback` prepend, both landing while the pane is
    // following — fires a `scroll` event whose geometry shows a huge
    // distance-to-tail (older rows now sit above) even though scrollTop did
    // NOT decrease. The old `setAtBottom(distance <= threshold)` treated
    // that as "the operator left the bottom" and killed the always-bottom
    // follow, stranding the pane mid-buffer on window open (P0 regression;
    // ~1056px above the tail). Gating the false-flip on `st < lastScrollTop`
    // keeps a prepend from lying about intent — only a real upward scroll
    // (operator OR the programmatic scroll-to-top a loadMore test performs,
    // both of which DECREASE scrollTop) leaves the tail.
    if (distance <= SCROLL_BOTTOM_THRESHOLD_PX) {
      setAtBottom(true);
    } else if (st < lastScrollTop) {
      setAtBottom(false);
    }
    lastScrollTop = st;

    // BUGHUNT-2 B7: snapshot the current visible-tail for the CURRENT
    // (key) so the leave-arm in `on(key, …)` can recover the leaving
    // pane's geometry — by the time that effect fires Solid has
    // already swapped the For-rendered rows to the new key, and a
    // post-hoc `lastFullyVisibleRowId(listRef)` reads the WRONG pane.
    // Snapshot fires on EVERY scroll (real + programmatic), so any
    // scroll-driven viewport change is captured. Initial-mount + post-
    // activation scrolls also fire scroll events so the snapshot stays
    // current without an explicit measure.
    const tailNow = lastFullyVisibleRowId(listRef);
    if (tailNow !== null) {
      visibleTailSnapshot.set(key(), tailNow);
    }

    // CP14 B2: scroll-up triggers loadMore. The verb is idempotent
    // under burst (per-key in-flight Set) and forward-latched on
    // empty pages (exhausted Set), so we don't need our own guard
    // here — fire-and-forget on every scroll event within threshold.
    //
    // Scroll-position preservation: REST returns older rows that get
    // PREPENDED to the merged list. Without restoration, the user's
    // viewport would either jump to the new top (scrollTop=0 stays
    // pinned) — where they were already looking — or stay numerically
    // pinned to scrollTop=N relative to the OLD scrollHeight, which
    // is now a different position relative to the new content. We
    // capture (scrollHeight, scrollTop) BEFORE the await, then after
    // merge restore as `newScrollHeight - oldScrollHeight + oldScrollTop`
    // so the rows the user was looking at remain in the same on-
    // screen position. DOM mutation lives here in the component;
    // lib/scrollback.ts stays DOM-free.
    if (listRef.scrollTop <= LOAD_MORE_THRESHOLD_PX) {
      // Scroll-position preservation on prepend — see the length-effect for how
      // an active marker activation is kept from yanking this (it re-asserts
      // ONLY when a marker exists; a no-marker latch falls through to the
      // atBottom-follow, which preserves here because the operator scrolled UP).
      const oldScrollHeight = listRef.scrollHeight;
      const oldScrollTop = listRef.scrollTop;
      void loadMoreScrollback(props.networkSlug, props.channelName).then(() => {
        if (!listRef) return;
        const newScrollHeight = listRef.scrollHeight;
        if (newScrollHeight === oldScrollHeight) return;
        listRef.scrollTop = newScrollHeight - oldScrollHeight + oldScrollTop;
      });
    }

    // #161: scroll-to-bottom triggers forward-paging — the mirror image of
    // the scroll-to-top loadMore above. After #156's anchored fetch a
    // channel with > 200 unread loads only [cursor .. cursor+200]; the
    // newest rows stay unreachable until the operator scrolls down into
    // them. Fire `loadNewer` when the pane nears the bottom of the LOADED
    // content (`distance` = px from the tail, computed above; same 200px
    // threshold as loadMore, mirrored). The verb gates burst + the
    // growing-tail latch, so fire-and-forget: at the genuine live tail one
    // empty forward page latches and further scrolls are no-ops (no fetch
    // storm). NO scroll-position restore — forward rows APPEND below the
    // viewport, so the operator's view doesn't shift (loadMore prepends
    // above the viewport, which is why it needs the height-delta correction
    // and this does not).
    if (distance <= LOAD_MORE_THRESHOLD_PX) {
      // loadNewer appends below the fold and preserves the view. We do NOT clear
      // the marker latch here (unlike loadMore): this BOTTOM boundary is hit by
      // a cold-mount's own tail scroll before the cursor hydrates, and clearing
      // then would strand a late-hydration marker. A real operator scroll-down
      // to this boundary already clears the latch via the input gate; loadNewer
      // fetches only in the #156 >200-unread anchored case, where the length-
      // effect's preserve (atBottom=false in the 50–200px band) still holds.
      void loadNewerScrollback(props.networkSlug, props.channelName);
    }

    // BUGHUNT-2: scroll-settle gated on recent operator input.
    // Programmatic scrolls fired by `scrollToActivation` (window
    // activation routine) emit DOM `scroll` events but no preceding
    // `pointerdown` / `wheel` / `touchmove` / `keydown` —
    // `lastInputEventAtMs` stays null or stale, the gate skips arming
    // the settle timer, cursor is not advanced. Real operator scrolls
    // (wheel / touch / PageDown) set `lastInputEventAtMs` first →
    // onScroll arms → 500ms later POSTs the visible-tail id.
    //
    // forward-only gate in setCursorIfAdvances (selection.ts) drops
    // the POST when candidate <= current cursor — scroll-up from the
    // tail is harmless. loadMore block above runs independently on
    // the same scroll event; the two are unrelated.
    const inputAt = lastInputEventAtMs();
    const recentInput = inputAt !== null && Date.now() - inputAt < INPUT_EVENT_RECENCY_MS;
    if (!recentInput) return;

    if (scrollSettleTimer !== undefined) {
      window.clearTimeout(scrollSettleTimer);
    }
    scrollSettleTimer = window.setTimeout(() => {
      if (!listRef) return;
      const id = lastFullyVisibleRowId(listRef);
      if (id !== null) {
        setCursorIfAdvances(props.networkSlug, props.channelName, id);
      }
    }, SCROLL_SETTLE_DEBOUNCE_MS);
  };

  // C7.4: scroll-to-bottom click handler — forces scroll to tail and
  // resumes auto-follow by setting atBottom(true).
  //
  // 2026-06-02 (scroll-to-bottom button contamination): the snap is
  // INSTANT, not `behavior: "smooth"`. The `[data-testid="scrollback"]`
  // <div> is the SAME DOM node across selectedChannel changes (Shell.tsx
  // bundles channel|query|server into one non-keyed Match). A smooth
  // scroll is an ASYNCHRONOUS animation that lives on that node — tap the
  // button on a tall window, switch away mid-animation and back, and the
  // in-flight animation SURVIVES the row swap, racing `scrollToActivation`
  // on the shared node and leaving scrollTop at a stale/overshot offset
  // (viewport below content = blank; restored only by a real scroll
  // event). vjt prod-reported 2026-06-02. Mirror `scrollToActivation`'s
  // no-marker branch (instant, layout-aware tail anchor) — every other
  // scroll path in this file is instant for exactly this reason; nothing
  // async then survives a window switch.
  const scrollToBottom = () => {
    if (!listRef) return;
    const tail = listRef.lastElementChild as HTMLElement | null;
    if (tail?.scrollIntoView) {
      tail.scrollIntoView({ block: "end" });
    } else {
      listRef.scrollTop = listRef.scrollHeight;
    }
    setAtBottom(true);
  };

  return (
    <div class="scrollback-pane">
      {/* #133 — top-pinned overlay layer. WHOIS / WHOWAS / peer-away /
          LUSERS are ephemeral lookup affordances the operator opens from
          the window they're reading. Rendered as flex siblings BEFORE
          `.scrollback` they shrank the scroll list on mount, shifting the
          reader's anchor and losing their place in the channel buffer.
          They now float in this absolutely-positioned overlay: the scroll
          list keeps its full height and scrollTop, the cards paint on top.
          The container is `pointer-events: none` so the uncovered
          scrollback below stays scrollable; each card re-enables pointer
          events for its own box. Each child still short-circuits to null
          when no bundle exists for the selected window's network. */}
      <div class="scrollback-overlay" data-testid="scrollback-overlay">
        {/* C2 — WHOIS card. Mounts on every window kind; the card itself
            short-circuits to null when no bundle is present. */}
        <WhoisCard networkSlug={props.networkSlug} />
        {/* P-0c — WHOWAS card. Mirrors WhoisCard mount shape (every window
            kind, not just $server). */}
        <WhowasCard networkSlug={props.networkSlug} />
        {/* P-0b — peer-away banner. Mount only on DM windows; the banner
            short-circuits to null when no entry exists for (slug, peer).
            The "peer" is the channelName itself for query windows. */}
        <Show when={props.kind === "query"}>
          <PeerAwayBanner networkSlug={props.networkSlug} peer={props.channelName} />
        </Show>
        {/* P-0d — LUSERS card. Mount only on the $server window for the
            network. Snapshot replaces last-write-wins on every /lusers
            (manual or welcome-time auto-emit). */}
        <Show when={props.kind === "server"}>
          <LusersCard networkSlug={props.networkSlug} />
        </Show>
      </div>
      <div
        ref={listRef}
        class="scrollback"
        classList={{ "scrollback-overflowing": isOverflowing() }}
        // #130 — hidden (pre-paint) while the activation scroll settles so
        // the wrong-scroll frame is never shown; visibility (not display)
        // keeps layout/scrollHeight readable for the deferred geometry read.
        style={{ visibility: activating() ? "hidden" : "visible" }}
        role="log"
        tabIndex={-1}
        onScroll={onScroll}
        onPointerDown={onPointerDown}
        onWheel={onWheel}
        onTouchMove={onTouchMove}
        onKeyDown={onKeyDown}
        data-testid="scrollback"
      >
        <Show
          when={rows().length > 0}
          fallback={<p class="muted scrollback-empty">no messages yet</p>}
        >
          {/* C7.1 + C7.3 + invite-ack (2026-06-01): render mixed rows
              (separator | unread-marker | message | invite-ack). The
              invite-ack arm replaces the prior sibling-after-`<For>`
              mount of `<InviteAckRows>` which visually pinned acks to
              the bottom of the scrollback regardless of subsequent
              server-message arrivals. Now interleaved by wallclock
              `at` inside the `rows()` memo. */}
          <For each={rows()}>
            {(row) => {
              if (row.type === "separator") {
                return (
                  <div class="scrollback-day-separator" data-testid="day-separator">
                    <span class="scrollback-day-separator-line" />
                    <span class="scrollback-day-separator-label">{row.label}</span>
                    <span class="scrollback-day-separator-line" />
                  </div>
                );
              }
              if (row.type === "unread-marker") {
                // Frozen divider (freeze-display contract, DESIGN_NOTES
                // 2026-06-08). No PERSISTENT ref — the REV-G H23 stale-ref
                // machinery stays dead. It renders at its frozen position for
                // every activation trigger; on a deliberate channel-SWITCH the
                // activation routine reads this node ONCE by data-testid to
                // scroll to it (#168 regression fix, 2026-07-03), so the
                // `scrollToActivation` marker-or-tail branch owns the lookup —
                // there is no long-lived pointer to go stale.
                return (
                  <div class="scrollback-unread-marker" data-testid="unread-marker">
                    <span class="scrollback-unread-marker-line" />
                    <span class="scrollback-unread-marker-label">
                      {row.count} unread message{row.count !== 1 ? "s" : ""}
                    </span>
                    <span class="scrollback-unread-marker-line" />
                  </div>
                );
              }
              if (row.type === "invite-ack") {
                return (
                  <div class="invite-ack-row" data-testid="invite-ack-row">
                    <span class="invite-ack-arrow">→</span>
                    <span class="invite-ack-text">
                      invited <NickText nick={row.entry.peer} extraClass="invite-ack-peer" /> to{" "}
                      <span class="invite-ack-channel">{row.channel}</span>
                    </span>
                  </div>
                );
              }
              return (
                <ScrollbackLine
                  msg={row.msg}
                  userNick={userNick()}
                  networkSlug={props.networkSlug}
                  onNickClick={handleNickClick}
                  onNickContextMenu={handleNickContextMenu}
                  onJoinChannel={handleJoinChannel}
                />
              );
            }}
          </For>
        </Show>
      </div>
      {/* C7.4: scroll-to-bottom floating button — shown when NOT at bottom. */}
      <Show when={!atBottom()}>
        <button
          type="button"
          class="scroll-to-bottom-btn"
          data-testid="scroll-to-bottom"
          onClick={scrollToBottom}
          aria-label="Scroll to bottom"
        >
          ↓
        </button>
      </Show>
      {/* C7.6: nick right-click context menu. Rendered outside the scrollback
          div so it positions freely in the viewport. Closed by backdrop or
          Escape (handled inside UserContextMenu). */}
      <Show when={contextMenu()}>
        {(cm) => (
          <UserContextMenu
            networkSlug={props.networkSlug}
            networkId={networkId() ?? 0}
            channelName={props.channelName}
            targetNick={cm().targetNick}
            ownModes={ownModes()}
            position={{ x: cm().x, y: cm().y }}
            onClose={() => setContextMenu(null)}
          />
        )}
      </Show>
    </div>
  );
};

export default ScrollbackPane;
