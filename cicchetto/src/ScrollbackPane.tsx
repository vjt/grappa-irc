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
import { confirmJoinChannel } from "./lib/channelJoin";
import { canonicalChannel, channelKey, decodeChannelKey } from "./lib/channelKey";
import { type TopicJoinLine, topicByChannel, topicJoinLine } from "./lib/channelTopic";
import { isDocumentVisible } from "./lib/documentVisibility";
import { highlightPatterns } from "./lib/highlightList";
import { type InviteAckEntry, inviteAckBySlug } from "./lib/inviteAck";
import { membersByChannel } from "./lib/members";
import { matchesWatchlist } from "./lib/mentionMatch";
import {
  mentionJumpTargetId,
  mentionsBelowViewport,
  type ScrollbackLineGeom,
} from "./lib/mentionScroll";
import { networks, user } from "./lib/networks";
import { senderPrefix, snapshotSenderPrefix } from "./lib/nickColor";
import { nickEquals } from "./lib/nickEquals";
import { isOperatorActionEcho } from "./lib/operatorActionEcho";
import { overlayCount } from "./lib/overlayScrollLock";
import { isOwnPresenceEvent } from "./lib/ownPresenceEvent";
import {
  channelPresenceVisible,
  presenceRowVisible,
  trailingHiddenAdvanceTarget,
} from "./lib/presenceFilter";
import { canonicalQueryNick, openQueryWindowState } from "./lib/queryWindows";
import { getReadCursor } from "./lib/readCursor";
import { isSettled, nextFollowMode, resolveIntent, type ScrollIntent } from "./lib/scrollAuthority";
import {
  dismissFarBehind,
  farBehindByChannel,
  jumpToUnread,
  lastOwnSend,
  loadMore as loadMoreScrollback,
  loadNewer as loadNewerScrollback,
  ownSendSubmitted,
  refreshScrollback,
  scrollbackByChannel,
} from "./lib/scrollback";
import { scrollToBottomRequest } from "./lib/scrollToBottomCommand";
import { setCursorIfAdvances, setSelectedChannel } from "./lib/selection";
import { isMobile } from "./lib/theme";
import { formatTimestamp } from "./lib/timeFormat";
import { dismissWhoisCard, whoisCardBySlug } from "./lib/whoisCard";
import { SERVER_WINDOW_NAME, type WindowKind } from "./lib/windowKinds";
import { MircBody } from "./MircText";
import NextActiveButton from "./NextActiveButton";
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
// Mention highlight (P4-1, extended #370): privmsg lines whose `body`
// word-boundary case-insensitive-matches the operator's own nick OR a custom
// /hilight pattern get the .scrollback-mention class. The matcher reads
// `networks.user()` for the nick and `highlightList.highlightPatterns()` for
// the keyword list — the SAME `matchesWatchlist` source the notify path uses.
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
// SCROLL_BOTTOM_THRESHOLD_PX from the tail. Click → instant scroll to the
// tail + resume auto-follow (re-arms followMode + atBottomNow), AND (since #310) —
// like a manual scroll to the bottom — advances the read cursor to the newest
// line and releases the marker-activation latch so the view does not snap back
// to the divider. See `scrollToBottomGesture`.
//
// C7.6: Clickable nicks in scrollback — sender spans on PRIVMSG / NOTICE /
// ACTION get .nick-clickable class. Left-click → open query window + focus.
// Right-click → show UserContextMenu at cursor position (same component as
// MembersPane, ZERO new components). ownModes is derived from membersByChannel
// for the logged-in nick so op-gated items are correctly enabled/disabled.
//
// C7.7 / #370: Watchlist highlight rendering — PRIVMSG / NOTICE / ACTION
// lines where `matchesWatchlist(body, ownNick, highlightPatterns())` is true
// get .scrollback-highlight class. The watchlist is own nick ∪ the custom
// /hilight keyword list (highlightList.ts), mirroring the server SSOT
// `Grappa.Mentions.mentioned?/3`.

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

// #239 — debounce for the trailing-hidden cursor advance (Facet B). Coalesces
// join/part storms (netsplits on a large / presence-hidden channel) to a single
// forward cursor POST once arrivals quiesce. Same magnitude as the scroll-settle
// debounce; the DOM settle paths stay eager. #887 — the focused window's badge
// is no longer suppressed, so this delay IS now visible as a badge that lingers
// half a second over a hidden join burst before dropping. Deliberate: the
// alternative is a POST per netsplit line.
const PRESENCE_CURSOR_SETTLE_MS = 500;

// #887 — debounce for the read-at-the-tail cursor advance. Coalesces a burst of
// arrivals into one forward POST, and — the load-bearing part — outlasts the
// activation routine's rAF-deferred geometry write: a cold open into an unread
// window mounts with `atBottomNow` at its `createSignal(true)` default and only
// learns it actually jumped to a far divider a frame or two later (~:2094).
// Firing inside that window would mark the backlog read from under the
// operator. 500ms is ~30 frames of margin; it is NOT a tuning knob.
const READ_AT_TAIL_SETTLE_MS = 500;

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

// #285 reopen part (3) — defensive post-mount settle re-measure schedule. The
// reported cold-iOS-PWA relaunch latch corrects via a viewport settle that
// fires NO resize / box change, so neither the resize listener nor the
// ResizeObserver catches it. These event-independent re-measures re-run the
// gate against the settled geometry a few hundred ms after mount, bracketing a
// fast and a slower settle. Belt-and-suspenders on top of the fail-open base.
const SETTLE_REMEASURE_DELAYS_MS = [150, 500] as const;

// #608 STEP 6 — bounded-wait cap for the measured-settle tail-follow. Each frame
// forces a reflow and re-checks `isSettled`; if the appended content never
// registers a measurable growth (an in-place rows change — e.g. a marker-row
// toggle — or an already-at-tail replacement), the write fails SAFE after this
// many frames and tails once, so a tail is never stranded waiting on a settle
// that will not come. ~30 frames ≈ 500ms @60fps: generous headroom for a slow
// iOS layout flush, still a hard bound (condition-based-waiting: bounded).
const SETTLE_MAX_FRAMES = 30;

// #230 — the pure underfill-rescue DECISION seam, shared by the desktop wheel
// path and the mobile touch path (implement-once). Both detect an operator
// intent to reveal OLDER history on a pane that has NO native scroll (content
// underfills the viewport, so `.scrollback` never emits a `scroll` event and
// the onScroll → loadMore path never fires). Returns true only when the rescue
// should page older history:
//
//   * `!nativelyScrollable` (scrollHeight <= clientHeight) — LOAD-BEARING. On an
//     OVERFLOWING pane the browser emits a native `scroll`, so onScroll already
//     owns loadMore with the CORRECT post-scroll geometry for the position
//     restore. The wheel/touch paths fire one tick BEFORE that native scroll
//     lands, so acting there would capture a stale scrollTop and restore to the
//     wrong anchor. Stay OUT whenever the pane can natively scroll.
//   * `scrollTop <= thresholdPx` — near the top (trivially true when content
//     underfills, since scrollTop is pinned at 0; mirrors maybeLoadOlder's gate).
//   * `revealOlderIntent` — the normalized "operator wants older" signal: a
//     desktop wheel-UP (deltaY < 0) OR a mobile finger-drag DOWN the screen
//     (clientY increases → content scrolls up → older revealed).
//
// Pure + exported so the mobile-underfill trigger is unit-testable without real
// iOS scroll physics (Playwright webkit does not reproduce them).
export function shouldRescueUnderfillLoadOlder(geometry: {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  revealOlderIntent: boolean;
  thresholdPx: number;
}): boolean {
  const nativelyScrollable = geometry.scrollHeight > geometry.clientHeight;
  if (nativelyScrollable) return false;
  if (geometry.scrollTop > geometry.thresholdPx) return false;
  return geometry.revealOlderIntent;
}

// #285 reopen — the pure FAIL-OPEN scroll-gate decision. Returns whether to
// LOCK `.scrollback` to `touch-action: none`. The CSS base rule is fail-open
// (`touch-action: pan-y`); we lock ONLY when a TRUSTWORTHY measurement
// definitively proves the content does not overflow. An untrusted clientHeight
// — 0 / negative / NaN, i.e. an unsettled or pre-settle cold-boot read — NEVER
// locks: a false-positive pannable pane is harmless (worst case iOS reveals
// chrome on a pane with nothing to pan), whereas a false-negative lock is the
// P0 (scroll DEAD in every tab after a cold iOS-PWA relaunch, because the
// corrective settle fires no event to re-open the gate). The inflated-boot read
// that triggers the P0 is corrected at the SOURCE (viewportHeight boot settle
// re-read) and on the post-mount settle re-measure; the gate itself stays
// deliberately simple — a local heuristic cannot detect a *relative* inflation
// (`.scrollback` is always shorter than the document thanks to the top bar +
// compose siblings), so it does not try.
//
// Pure + exported so the fail-open decision is unit-testable without real iOS
// layout (Playwright webkit does not reproduce it —
// feedback_playwright_webkit_not_ios_scroll).
export function shouldLockScrollGate(geometry: {
  scrollHeight: number;
  clientHeight: number;
}): boolean {
  // Untrusted read (0 / negative / NaN) → fail open (stay pannable).
  if (!(geometry.clientHeight > 0)) return false;
  // Trusted read + content fits → lock (touch-action: none).
  return geometry.scrollHeight <= geometry.clientHeight;
}

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
  // `atBottomNow` geometry uses (onScroll, below) — robust by construction
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

// #360 — per-row geometry read for the mention-aware scroll-to-bottom badge.
// Mirrors `lastFullyVisibleRowId`'s offsetTop-based walk (cheap, layout-cached
// — no getBoundingClientRect thrash) but tags each `.scrollback-line` with its
// `.scrollback-mention` state (own nick ∪ /hilight patterns, #370) so the
// pure `mentionsBelowViewport` can decide which mentions sit below the fold. O(n)
// over rendered rows; called from the (debounced-ish) onScroll + rows-effect
// recompute paths, and once per tap — mentions are rare, the cost is bounded.
const readMentionGeom = (listRef: HTMLDivElement): ScrollbackLineGeom[] => {
  const out: ScrollbackLineGeom[] = [];
  for (const row of listRef.querySelectorAll<HTMLElement>(".scrollback-line")) {
    const idAttr = row.dataset.msgId;
    if (idAttr === undefined) continue;
    out.push({
      id: Number.parseInt(idAttr, 10),
      top: row.offsetTop,
      isMention: row.classList.contains("scrollback-mention"),
    });
  }
  return out;
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
      <MircBody body={reason} emphasis />
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

// #641 — scrub the CTCP delimiter (U+0001) from a typed CTCP verb/args BEFORE
// it renders. The server's SSOT classifier (Grappa.IRC.CTCP.verb_args/1) strips
// only the ONE optional TRAILING \x01, so a malformed or concatenated frame
// (`\x01VERSION a\x01b\x01`, `\x01V x\x01\x01PING y\x01`) can leave an INTERIOR
// \x01 in the typed verb or args. A CTCP line is a control surface, and "cic
// NEVER shows \x01" is absolute — scrub the display string. This is NOT parsing
// \x01 (we still render off typed meta, never off delimiters); the stored body
// stays verbatim (round-trip fidelity is a STORAGE property, not a display one).
// Shared by BOTH CTCP arms — the outbound privmsg self-echo and the inbound
// notice reply — so neither can leak (fix the class, not the instance).
const stripCtcpDelim = (s: string): string => s.replaceAll("\u0001", "");
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
          *** Wallops from {senderSpan(sender)}: <MircBody body={trailing} emphasis />
        </span>
      );
    case "GLOBOPS":
      return (
        <span class="scrollback-body">
          *** Globops from {senderSpan(sender)}: <MircBody body={trailing} emphasis />
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
              class="scrollback-inline-button scrollback-invite-join"
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

// #569 — numeric rows (meta.numeric, no raw_verb) persisted by
// Session.Server's generic `{:numeric, _}` handler. `body` is only the
// TRAILING param; the payload for STATS (211-219, 240-250), 396
// RPL_HOSTHIDDEN, and every other middle-param numeric lives in
// `meta.raw_params` — #424 kept the full list there but cic discarded it,
// so a Q-line rendered a bare `-1` and a cloak sat invisible. This is the
// numeric twin of `renderRawEvent`: `raw_params[0]` is the recipient's own
// nick on virtually every numeric and is dropped, not printed; per-numeric
// pretty arms (217, 396, …) grow here incrementally keyed on
// `raw.numeric`, like renderRawEvent's per-verb arms, while the default
// joins the surviving params so no payload is ever invisible. Returns the
// body span only — the caller frames it with the dash-bracketed server
// sender. The #455 textual-emphasis layer stays OFF: numerics are a
// server-generated surface (STATS masks, host cloaks, config fields —
// exactly the snake_case / path / `*`-junk the per-surface ruling keeps
// unstyled), like the sibling ERROR / server_event / generic-numeric arms.
// Only the wire mIRC layer (\x02/\x1D/\x1F) renders.
type NumericEvent = { numeric?: number; raw_params?: string[] };
const renderNumeric = (raw: NumericEvent): JSX.Element => {
  const params = (raw.raw_params ?? []).slice(1);
  return (
    <span class="scrollback-body">
      <MircBody body={params.join(" ")} />
    </span>
  );
};

const renderBody = (msg: ScrollbackMessage, handlers: NickHandlers): JSX.Element => {
  // #648 — click-to-join affordance for a `#channel` in a CONTENT body. Passed
  // ONLY to the privmsg / notice / action MircBody calls below — the same set
  // the `.nick-clickable` sender affordance covers (#354), and the "user-typed
  // text" surfaces (they pass `emphasis`). Presence/topic/raw-event lines and
  // out-of-scope surfaces (topic bar, whois, /list) get no handler, so their
  // `#channel` segments render as plain text. `confirmJoinChannel` owns the
  // confirm-or-switch decision; here we only supply the network + raw channel.
  const onChannelClick = (channel: string): void =>
    confirmJoinChannel(handlers.networkSlug, channel);

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
      class="scrollback-sender scrollback-inline-button nick-clickable"
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
      class="scrollback-sender scrollback-inline-button nick-clickable"
      onClick={() => handlers.onNickClick(nick)}
      onContextMenu={(e: MouseEvent) => handlers.onNickContextMenu(nick, e)}
    >
      <NickText nick={nick} prefix={prefixFor(nick)} />
    </button>
  );

  switch (msg.kind) {
    case "privmsg": {
      // #591 — the operator's OWN outbound CTCP query (/ctcp, /ping) self-echoes
      // here as a :privmsg whose body is the raw \x01VERB args\x01 frame, tagged
      // by the server with typed meta.ctcp_verb / meta.ctcp_args (SSOT
      // Grappa.IRC.CTCP.verb_args/1). Render a human "→ CTCP VERB [args] to
      // <target>" line instead of the raw \x01 body. cic reads the TYPED meta,
      // NEVER \x01 (the "one IRC parser, on the server" invariant). ACTION never
      // reaches here carrying ctcp meta — it rides the :action kind, which the
      // server excludes from ctcp classification. This is a control surface, so
      // it renders as plain text (no mIRC \x02/\x1D emphasis, like the numeric /
      // raw-event surfaces). A matched inbound PING reply is consumed upstream
      // (subscribe.ts) and never reaches any render path.
      const ctcpVerb = msg.meta.ctcp_verb;
      if (typeof ctcpVerb === "string") {
        // #641 — scrub any interior \x01 the server's one-trailing-strip left
        // behind (shared with the notice arm); "cic NEVER shows \x01" is absolute.
        const verb = stripCtcpDelim(ctcpVerb);
        const ctcpArgs = stripCtcpDelim(
          typeof msg.meta.ctcp_args === "string" ? msg.meta.ctcp_args : "",
        );
        const query = ctcpArgs === "" ? `CTCP ${verb}` : `CTCP ${verb} ${ctcpArgs}`;
        // #640 — the echo is now keyed to the SOURCE window (msg.channel), so
        // the wire recipient travels in meta.ctcp_target: read the target OFF
        // the message, not the routing key. Fall back to msg.channel for
        // pre-#640 rows (keyed to the target, no ctcp_target) so historical
        // echoes still name the right peer.
        const ctcpTarget =
          typeof msg.meta.ctcp_target === "string" ? msg.meta.ctcp_target : msg.channel;
        return (
          <span class="scrollback-body">
            → {query} to {ctcpTarget}
          </span>
        );
      }
      return (
        <>
          {senderSpan("<", ">", msg.sender)}{" "}
          <span class="scrollback-body">
            <MircBody body={msg.body ?? ""} emphasis onChannelClick={onChannelClick} />
          </span>
        </>
      );
    }
    case "notice": {
      // #641 — an inbound CTCP reply arrives as a server-typed :notice whose
      // body is the raw \x01VERB [args]\x01 frame, classified ONCE on the server
      // (SSOT Grappa.IRC.CTCP.verb_args/1) into typed meta.ctcp_verb /
      // meta.ctcp_args. A CORRELATED /ping reply is consumed upstream
      // (subscribe.ts maybeConsumePingReply) and never reaches here; an
      // UNCORRELATED CTCP reply (a stray VERSION/TIME, or a token-less PING that
      // matched no pending /ping) does. Before this arm it fell through to the
      // generic body render below and leaked the raw \x01 into the DOM. Render a
      // human INBOUND line from the TYPED meta instead — cic NEVER parses \x01
      // (the "one IRC parser, on the server" invariant). This is the notice twin
      // of the privmsg CTCP arm (#591), but INBOUND: direction ← / "reply from
      // <sender>", and ctcp_args is the reply PAYLOAD rendered irssi-style after
      // the sender (a query's outbound args mean something different — see the
      // privmsg arm — so the two are deliberately NOT a shared helper). Plain
      // control-surface text (no mIRC emphasis), like the numeric/raw surfaces.
      const noticeCtcpVerb = msg.meta.ctcp_verb;
      if (typeof noticeCtcpVerb === "string") {
        const verb = stripCtcpDelim(noticeCtcpVerb);
        const args = stripCtcpDelim(
          typeof msg.meta.ctcp_args === "string" ? msg.meta.ctcp_args : "",
        );
        return (
          <span class="scrollback-body">
            ← CTCP {verb} reply from {msg.sender}
            {args === "" ? "" : `: ${args}`}
          </span>
        );
      }
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
      // #569 — numeric rows carry meta.numeric + meta.raw_params (no
      // raw_verb). Render the whole param list (own-nick dropped) so
      // middle-param payloads (STATS masks, the 396 cloak) are visible,
      // not just the trailing token. A numeric missing raw_params
      // (pre-#424 backfill) falls through to the trailing-body branch.
      const numericMeta = msg.meta as NumericEvent | undefined;
      if (
        numericMeta &&
        typeof numericMeta.numeric === "number" &&
        Array.isArray(numericMeta.raw_params)
      ) {
        return (
          <>
            {senderSpan("-", "-", msg.sender)} {renderNumeric(numericMeta)}
          </>
        );
      }
      return (
        <>
          {senderSpan("-", "-", msg.sender)}{" "}
          <span class="scrollback-body">
            <MircBody body={msg.body ?? ""} emphasis onChannelClick={onChannelClick} />
          </span>
        </>
      );
    }
    case "action":
      return (
        <span class="scrollback-body">
          * {bareSenderSpan(msg.sender)}{" "}
          <MircBody body={stripCtcpAction(msg.body)} emphasis onChannelClick={onChannelClick} />
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
          * {bareSenderSpan(msg.sender)} changed topic: <MircBody body={msg.body ?? ""} emphasis />
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
      // bug, but render the body so it isn't invisible. Server-generated
      // → the #455 marker layer stays OFF here, like the sibling ERROR /
      // generic-numeric arms (only the wire mIRC layer renders).
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
  // #370 — a mention is now own nick ∪ custom highlight patterns (the same
  // set the server counts as a mention, and the same `matchesWatchlist`
  // predicate the notify path uses). A privmsg matching a /hilight word gets
  // the exact `.scrollback-mention` treatment an own-nick mention gets.
  const isMention = () =>
    props.msg.kind === "privmsg" &&
    matchesWatchlist(props.msg.body, props.userNick, highlightPatterns());

  // C7.2: muted — presence/event kinds are visually de-emphasized.
  const isMuted = () => PRESENCE_KINDS.has(props.msg.kind);

  // C7.7 / #370: highlight — content kinds where body matches the watchlist
  // (own nick ∪ custom highlight patterns).
  const isHighlight = () =>
    !PRESENCE_KINDS.has(props.msg.kind) &&
    matchesWatchlist(props.msg.body, props.userNick, highlightPatterns());

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
// #237: on-JOIN inline topic line — a PRESENTATIONAL row (string id, NOT a
// ScrollbackMessage), so it never enters the unread/cursor/ring-cap math. It is
// derived from the `topicByChannel` store and anchored after the own-JOIN row.
// `type: "topic-join"` (matching its data-kind/data-testid) deliberately DIFFERS
// from `ScrollbackMessage.kind === "topic"` (the persisted mid-session change
// row) so the two never blur — distinct rows, distinct code paths.
type TopicRow = { type: "topic-join"; line: TopicJoinLine; id: string };
type Row = SeparatorRow | UnreadMarkerRow | MessageRow | InviteAckRow | TopicRow;

const ScrollbackPane: Component<Props> = (props) => {
  let listRef!: HTMLDivElement;
  // Every settle writer in this component answers the SAME question — "what
  // is the last row the operator can actually see?" — and hands the answer to
  // the one forward-only door (`setCursorIfAdvances`, which owns the #233
  // monotonic clamp and the #693 far-behind freeze). Unmount, channel-leave,
  // browser-blur, scroll-settle, the scroll-to-bottom gesture and the #887
  // read-at-the-tail arm all shared this three-line body verbatim; it lives
  // here once so a future guard cannot land in four of the five.
  const settleCursorToVisibleTail = (): void => {
    // `listRef!` is a definite-assignment ref: typed non-null, but genuinely
    // undefined until Solid assigns it at mount (and every caller guarded it).
    if (!listRef) return;
    const id = lastFullyVisibleRowId(listRef);
    if (id === null) return;
    setCursorIfAdvances(props.networkSlug, props.channelName, id);
  };
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
  // #608 STEP 6 — the scrollHeight at the LAST tail-follow write: the baseline
  // the measured-settle `isSettled` compares the current extent against. Using
  // the last-tail extent (NOT a dispatch-time read, which on a fast engine
  // already includes the just-appended row — reading scrollHeight forces layout —
  // leaving nothing to detect as "grew") makes the settle exit reachable on BOTH
  // a deferred iOS layout AND an immediate chromium one: "grew since we last
  // tailed" is true the frame the new row's box lands. Reset to 0 on key change
  // so a switched-to pane's first tail always registers growth (extent > 0).
  // Plain let — pure mutation, no Solid reactivity.
  let lastTailScrollHeight = 0;
  // #196 / #219-general — scrollTop snapshot captured when ANY covering
  // overlay opens, re-asserted across the overlay's open/close so a covered
  // pane never strands the reader (see the effect near the activation block
  // below). #196 introduced this for the media viewer; #219-general widens the
  // trigger from the media-viewer signal to the shared overlay refcount
  // (`overlayCount()`) — every covering modal/drawer already pushes into it,
  // so a single derived predicate ("a covering overlay is open") drives the
  // freeze instead of one flag per modal. #608 (deep-review §6.2): this is now
  // ONLY the px to restore — the freeze itself derives from the live
  // `overlayCount()` in `isOverlayFrozen`, NOT from this being non-null — so it
  // is captured on each open edge and left harmlessly stale after close (no
  // clear). Plain let — pure mutation, no Solid reactivity.
  let overlayScrollSnapshot: number | null = null;
  // #219-general — the channel key the overlay snapshot was captured on. The
  // pane instance survives channel↔query switches (shared non-keyed Match), so
  // a covering modal that switches the window on close (nick-click in /names,
  // /who) must not restore the leaving channel's offset onto the arriving one.
  // Both the freeze gate and the restore require this === key(); a switched-to
  // window activates normally. `null` when no overlay snapshot is held.
  let overlaySnapshotKey: string | null = null;
  // #608 (deep-review §6.1) — the overloaded `atBottom` split into its two
  // independent concerns, the PRIMARY reshape of the single-scroll-authority
  // work:
  //   * `followMode` — the persistent "stick to the tail" INTENT. Drives
  //     tail-follow (the length-effect gate), the resize re-anchor gate, and
  //     the visibility-return gate. Transitions ONLY via `nextFollowMode`
  //     edges (lib/scrollAuthority): an operator scroll-up turns it OFF;
  //     reaching the tail or an own send turns it back ON; a programmatic
  //     content-grow above the fold leaves it unchanged (the #168 distinction —
  //     a prepend is not a leave).
  //   * `atBottomNow` — the GEOMETRIC measurement (within threshold of the
  //     tail). Drives ONLY the floating scroll-to-bottom button (`!atBottomNow`).
  // Conflating the two was the source of the R-B/R-C races the leave-arm
  // documents as "atBottom unreliable here". Both default true (a fresh pane
  // follows the tail; the button is hidden). Until the send/settle reshapes
  // land they are written together — this split is the foundation those later
  // steps build the divergence on.
  const [followMode, setFollowMode] = createSignal(true);
  const [atBottomNow, setAtBottomNow] = createSignal(true);
  // #285 reopen — FAIL-OPEN touch-action gate. The CSS base is `pan-y`; this
  // signal drives the `.scrollback-locked` class that LOCKS the pane to
  // `touch-action: none` ONLY when a trustworthy measurement proves the content
  // does not overflow (see `shouldLockScrollGate`). Default `false` = not
  // locked = pannable: the pane is scrollable from the first frame and a bad /
  // pre-settle measurement can never latch it dead (the reported P0). Recomputed
  // on every layout-affecting trigger (messages, window/visualViewport resize,
  // ResizeObserver container box change, post-mount settle timer).
  const [scrollLocked, setScrollLocked] = createSignal(false);

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
  // jump, and because the jump set `followMode=false` the length-effect's only
  // re-establish path is suppressed → the marker strands off-screen (the 307
  // race). This latch marks "a channel activation is in effect; keep
  // re-asserting marker-or-tail on every rows recreation until the operator
  // takes over". Set by the channel-SWITCH key-effect AND cold-mount (so
  // app-startup / first-focus jumps to the marker too — vjt point-2, reverses
  // the #46 cold-mount-tail wontfix); cleared on real operator input or an own
  // send (both hand scroll authority back). Visibility-return / resize stay
  // tail-only one-shot — their `followMode=true` means the length-effect's
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

  // #360 — mention-aware scroll-to-bottom badge. Holds the nearest-first ids
  // of mentions (own nick ∪ /hilight keywords, #370) currently below the fold
  // in THIS window; its length is the badge count, its head (`[0]`) the next
  // jump target. DERIVED from live geometry + scroll position (neither is a
  // Solid signal), so it is recomputed at the same edges `atBottomNow` is: every
  // onScroll (operator scroll AND the settle scrolls that activation /
  // message-arrival fire) and, belt-and-suspenders, after each rows()
  // recreation via rAF (a rows change that lands without a scroll event still
  // refreshes the badge). Scope is the `.scrollback-mention` class; the
  // broader `.scrollback-highlight` (same match set, all content kinds) is not
  // what the badge tracks.
  const [mentionsBelow, setMentionsBelow] = createSignal<number[]>([]);
  const mentionBadgeCount = (): number => mentionsBelow().length;
  const recomputeMentionsBelow = (): void => {
    if (!listRef) {
      setMentionsBelow([]);
      return;
    }
    const viewportBottom = listRef.scrollTop + listRef.clientHeight;
    setMentionsBelow(mentionsBelowViewport(readMentionGeom(listRef), viewportBottom));
  };

  const key = () => channelKey(props.networkSlug, props.channelName);
  const messages = () => scrollbackByChannel()[key()];
  // #219-general / #608 (deep-review §6.2) — "is THIS pane frozen under a
  // covering overlay?" DERIVED from the LIVE overlay refcount, not a separately-
  // cleared latch: a covering overlay is up NOW (`overlayCount() > 0`) and the
  // snapshot belongs to the channel it was captured on (`overlaySnapshotKey ===
  // key()`). Both scroll authorities (scrollToActivation + the length-effect)
  // bail on this so no authority moves a covered pane; the overlay-snapshot
  // effect owns the single restore.
  //
  // Pre-#608 this read `overlayScrollSnapshot !== null` — a latch cleared
  // separately inside the overlay effect's rAF (gated on `overlayCount() === 0`).
  // That parallel latch could DRIFT from the count: a leaked refcount (the
  // Shell.tsx same-tick open→close, fixed in C1) meant the clear never fired and
  // the pane stayed frozen for the session (the field bug). Deriving the freeze
  // from the count makes that drift class structurally impossible ("derive,
  // don't duplicate") and thaws the pane the instant the last overlay closes,
  // without waiting on the deferred clear.
  //
  // Key-scoped so a window switched-to WHILE an overlay is up (nick-click in
  // /names or /who opens a query + dismisses the modal) is not frozen — it
  // activates normally. `overlayCount()` is reactive but read imperatively here
  // (from inside the authorities), not in a tracking scope.
  const isOverlayFrozen = (): boolean => overlayCount() > 0 && overlaySnapshotKey === key();
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
      // #799 — the FOLDED name, like channelJoin.switchTo, compose.ts `/join`
      // and DirectoryPane. `channel` is `params[1]` off a stored INVITE row:
      // ingress folds it today (EventRouter's `:invite` clause, the #537 fix),
      // but per the #525 posture `refold_identifiers_ascii` does not rewrite
      // stored values, so a pre-#537 row still carries mixed case. Selection
      // and window_states are keyed folded — a raw target foregrounds a window
      // the sidebar can't match. Only the KEY folds: the postJoin above and
      // the rendered row label keep the invite's spelling.
      setSelectedChannel({
        networkSlug: props.networkSlug,
        channelName: canonicalChannel(channel),
        kind: "channel",
      });
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
    const allMsgs = messages() ?? [];
    // #222 — render-layer presence filter. On a "large" channel the
    // join/part/quit/nick_change rows are pure noise; suppress them by
    // default, with a per-channel pref that WINS over the size default.
    // Reading BOTH the pref signal (via channelPresenceVisible) AND the
    // live member count inside this memo makes the filter reactive to the
    // toggle AND to membership crossing the threshold. Filter at the
    // RENDER layer only — the message store stays intact so unread-count,
    // the read-cursor divider, and own-JOIN auto-focus (all read
    // messages(), not rows()) keep working. Narrow set: mode/topic/kick/
    // server_event are NOT noise and are never dropped.
    //
    // Consequence: everything below (day separators, the unread-marker count
    // + placement) derives from the FILTERED `msgs`, so on a suppressed
    // channel the in-pane divider counts only the rows the operator can
    // actually SEE (a divider above a hidden join row would be a phantom).
    //
    // #239 — the sidebar/bottom-bar unread badge now counts through the SAME
    // predicate (selection.ts `perChannelUnread` → `presenceRowVisible`). Pre-
    // #239 the badge counted presence events off the UNFILTERED store while
    // the pane dropped them, so a trailing run of hidden control rows left the
    // badge stuck > 0 with no way to read it clear. The badge and the pane
    // must agree on which rows "count" — reconcile to one predicate, never a
    // forked filter (CLAUDE.md "one feature, one code path").
    const memberCount = (membersByChannel()[key()] ?? []).length;
    const msgs = allMsgs.filter((m) => presenceRowVisible(key(), memberCount, m.kind));
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
    //
    // #693 — except when this pane is FAR BEHIND. There the loader abandoned
    // the cursor region and anchored at the tail, so the cursor sits below
    // every loaded row: the divider would slam to the top of the buffer
    // labelled with the count of the rows that happen to be loaded (~50)
    // rather than the thousands actually unread — a confident wrong number in
    // the one place the operator reads to decide where they left off. The
    // jump-back affordance carries the true count instead.
    const injectMarker =
      cursor !== null &&
      sessionTop !== null &&
      unreadCount > 0 &&
      farBehindByChannel()[key()] === undefined;
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
      // #422 Part 2: emit a day-separator before the FIRST rendered row
      // (prevTime === null), labeled from that row's own day — not only on a
      // day CHANGE. A window opened out of the Archive holding a single old
      // message otherwise shows a bare `HH:MM` with no date anywhere. No-op
      // visual addition for busy windows, which already separate each day.
      if (prevTime === null || isDifferentDay(prevTime, msg.server_time)) {
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
    // #237 — inline topic-on-JOIN. irssi prints the topic to the window when
    // YOU join; we mirror it by anchoring a presentational topic row right
    // after the operator's own-JOIN row, derived from the `topicByChannel`
    // store (seeded by the join-time 332 → topic_changed with full text +
    // setter + time). Channel windows only; the store carries no topic for
    // query/server/list panes. Anchored to the LAST own-JOIN in the loaded
    // buffer so a part/rejoin cycle re-prints against the newest join (and
    // there is exactly one line, not one per historical join). Reading
    // `topicByChannel()` makes the memo re-run when the topic seeds/changes —
    // on a mid-session change the line reflects the new topic AND the
    // server-persisted `:topic` row renders the change event separately.
    //
    // Kept out of the unread/cursor math by construction: it is a TopicRow,
    // not a "message" row, so the `unreadCount` filter (over `msgs`) and the
    // `data-msg-id` cursor walk never see it — no faked scrollback id.
    if (props.kind === "channel") {
      const tjl = topicJoinLine(props.channelName, topicByChannel()[key()] ?? null);
      if (tjl !== null && ownNick !== null) {
        // #325 — anchor to the newest own-JOIN in the UNFILTERED buffer, NOT
        // the visible JOIN row. When presence is hidden (#222) the own-JOIN row
        // is dropped from `result`, so scanning the rendered rows found no
        // anchor and the topic line vanished as collateral. Locate the newest
        // own-JOIN in `allMsgs`, then splice the line after the last surviving
        // message row at-or-before that timeline point ([server_time, id]
        // order) — which degrades to the buffer head when every row before the
        // JOIN was filtered out. When presence is shown the anchor JOIN is
        // itself the last such row, so the line still lands right after the
        // own-JOIN row (behaviour unchanged).
        let anchor: ScrollbackMessage | null = null;
        for (const m of allMsgs) {
          if (
            m.kind === "join" &&
            nickEquals(m.sender, ownNick) &&
            (anchor === null ||
              m.server_time > anchor.server_time ||
              (m.server_time === anchor.server_time && m.id > anchor.id))
          ) {
            anchor = m;
          }
        }
        if (anchor !== null) {
          let insertAt = 0;
          for (let i = 0; i < result.length; i += 1) {
            const r = result[i];
            if (
              r?.type === "message" &&
              (r.msg.server_time < anchor.server_time ||
                (r.msg.server_time === anchor.server_time && r.msg.id <= anchor.id))
            ) {
              insertAt = i + 1;
            }
          }
          result.splice(insertAt, 0, { type: "topic-join", line: tjl, id: "topic-join" });
        }
      }
    }
    return result;
  });

  // #360 — refresh the mention badge after every rows() recreation (a live
  // message, the switch-time `refreshScrollback` catch-up, a cross-device
  // read-cursor hydration). The ref-keyed `<For>` rebuilds the list DOM on
  // every rows change and resets scrollTop, so the settle scroll usually fires
  // onScroll (which recomputes) — but a rows change that lands the geometry
  // without a scroll event would leave the badge stale; the rAF read here
  // (after the browser lays out the recreated list) closes that gap. Tracks
  // rows() only; recompute reads geometry imperatively, no other deps.
  createEffect(
    on(rows, () => {
      requestAnimationFrame(() => recomputeMentionsBelow());
    }),
  );

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
  // every layout-affecting change and toggle a class on `.scrollback`.
  // #285 reopen — the gate is now FAIL-OPEN: base `.scrollback
  // { touch-action: pan-y }`, and `.scrollback-locked { touch-action: none }`
  // LOCKS the pane only when `shouldLockScrollGate` says the content
  // definitively fits a trustworthy clientHeight. A bad/pre-settle read can
  // never latch it dead (the reported cold-boot P0).
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
        setScrollLocked(
          shouldLockScrollGate({
            scrollHeight: listRef.scrollHeight,
            clientHeight: listRef.clientHeight,
          }),
        );
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
  onCleanup(settleCursorToVisibleTail);

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
    applyActivation("marker-or-tail", true);
    // UX-6 D9 / #253 — every vv.resize (keyboard open OR close,
    // orientation change, browser zoom) and window.resize (desktop
    // resize, devtools, zoom) re-anchors the scroll — but ONLY when the
    // reader was already following the tail. scrollToActivation is
    // defined below at ~:1494 (closure resolves at call time, not
    // registration time).
    //
    // #253 — the D9 plan STARTED with symmetric yank-on-{open,close}
    // (vjt: "we can start with symmetry and then reset scroll marker
    // later"), snapping to the tail on EVERY resize regardless of
    // position. A soft-keyboard open (a vv.resize) while the operator
    // was parked above the tail (unread marker / scrolled-up history)
    // therefore yanked them to the bottom, losing their place. This
    // gate IS the deferred "finer-grained close-side preserve" the D9
    // note promised.
    //
    // REUSE the length-effect's irssi-shape follow rule (~:2033), do
    // not invent a parallel one:
    //   * followMode() true  → the operator was following live; re-pin to
    //     the tail (a shrinking viewport keeps the bottom visible) =
    //     resume family → TAIL, never the divider (#46), one-shot, no
    //     latch.
    //   * followMode() false → PRESERVE their scrollTop: do nothing, the
    //     browser holds scrollTop across the clientHeight change (a
    //     shrink never clamps; content still overflows).
    // #608 — the resize gate reads the follow INTENT (`followMode`), not the
    // geometric `atBottomNow`: it turns false ONLY on a real operator scroll-UP
    // (onScroll), so it is an honest "parked above the tail" signal HERE —
    // unlike the leave-arm below, whose caveat is a key-change batch where a
    // sibling activation effect re-arms follow; a resize is not a key change,
    // so `followMode()` is trustworthy (the length-effect trusts it the same
    // way).
    //
    // #245 — ALSO re-measure the gate on resize, UNCONDITIONALLY: it runs
    // BEFORE the followMode() gate above, regardless of scroll position.
    // `scrollLocked` drives the `.scrollback-locked` class (#285 reopen:
    // fail-open base `pan-y`, lock to `none` only on a trustworthy fit). The
    // gate is a function of `clientHeight`, which is viewport-derived (the
    // mobile shell height tracks `--vh`/`visualViewport.height`), yet
    // `measureOverflow` ran only on mount + message-length-change, NEVER on a
    // viewport change until #245 wired it here. A viewport resize (keyboard
    // open/close, modal-driven shrink) that changes whether the content
    // overflows re-runs the gate so a stale lock never survives the geometry
    // change. Cheap + safe: measureOverflow only toggles the touch-action class
    // (no scrollTop / position:fixed / keyboard touch). Deliberately NOT gated
    // by `isOverlayFrozen()` the way scrollToActivation is: measuring on a
    // covered pane only recomputes a class no one is touching, and a modal that
    // shrinks the visualViewport must NOT leave a stale `touch-action` latched
    // after it closes — gating this would re-open a jam on the overlay's
    // close-edge resize.
    const onResize = () => {
      measureOverflow();
      // #360 — a viewport resize (soft-keyboard open/close, orientation, zoom)
      // changes `clientHeight` → moves the fold, so the mention-below-fold count
      // can change with NO scroll event. Recompute the badge unconditionally,
      // mirroring the #245 gate re-measure above; onScroll owns the scroll-
      // driven recompute. Matters most on mobile: the keyboard opening while the
      // operator is parked mid-buffer must not strand a stale badge.
      recomputeMentionsBelow();
      if (followMode()) applyActivation("tail-only", true);
    };
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);

    // #230 (mobile) — touch counterpart of the desktop wheel underfill rescue.
    // On iOS an underfilled `.scrollback` is `touch-action: none` +
    // non-overflowing, so a touch drag emits NO native `scroll` event →
    // `onScroll` never fires → the operator is stuck with no way to page up into
    // older history (the wheel rescue has no touch path). A finger drag DOWN the
    // screen (clientY increases → dy > 0) reveals content ABOVE = older — the
    // touch analogue of wheel deltaY < 0 — and funnels into the SAME
    // `shouldRescueUnderfillLoadOlder` decision + `maybeLoadOlder` closure the
    // wheel path uses (implement-once). The decision's `!nativelyScrollable`
    // guard keeps the touch path OUT of the overflowing case, where native
    // pan-y scroll + `onScroll` own loadMore with correct geometry.
    //
    // Element-level {passive:false}, NOT a JSX onTouch*: SolidJS delegates touch
    // handlers to a PASSIVE document listener, so a JSX handler can neither
    // reliably own the gesture nor `preventDefault`. iOS PWA UIKit can still
    // claim a touch as a page-pan even under `touch-action: none` (see
    // lib/overlayScrollLock moduledoc — CSS-only proved insufficient to stop
    // UIKit), so we bind directly and `preventDefault` ONLY when the rescue
    // fires, stopping any residual viewport rubber-band during the load-older
    // drag; on the overflowing case the decision is false → no preventDefault →
    // native scroll proceeds. This handler also stamps `lastInputEventAtMs` (the
    // BUGHUNT-2 settle-gate input signal) — the job the removed JSX
    // `onTouchMove` used to do.
    let touchStartY: number | null = null;
    const onTouchStartEl = (e: TouchEvent): void => {
      touchStartY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMoveEl = (e: TouchEvent): void => {
      setLastInputEventAtMs(Date.now());
      if (!listRef) return;
      // Single-finger drag only — a two-finger pinch is not a page-up intent
      // (touch-action: none already suppresses browser pinch on the underfilled
      // pane; this keeps a stray first-finger drift from paging history).
      if (e.touches.length !== 1) return;
      const currentY = e.touches[0]?.clientY;
      if (currentY === undefined || touchStartY === null) return;
      // dy > 0 = finger moved DOWN the screen = content scrolls up = reveal older.
      const dragDy = currentY - touchStartY;
      if (
        shouldRescueUnderfillLoadOlder({
          scrollHeight: listRef.scrollHeight,
          clientHeight: listRef.clientHeight,
          scrollTop: listRef.scrollTop,
          revealOlderIntent: dragDy > 0,
          thresholdPx: LOAD_MORE_THRESHOLD_PX,
        })
      ) {
        if (e.cancelable) e.preventDefault();
        maybeLoadOlder();
      }
    };
    const onTouchEndEl = (): void => {
      touchStartY = null;
    };
    if (listRef) {
      listRef.addEventListener("touchstart", onTouchStartEl, { passive: true });
      listRef.addEventListener("touchmove", onTouchMoveEl, { passive: false });
      listRef.addEventListener("touchend", onTouchEndEl, { passive: true });
      listRef.addEventListener("touchcancel", onTouchEndEl, { passive: true });
    }

    // #285 — ResizeObserver on the scroll container so the gate follows REAL
    // container geometry, not just discrete events. It fires on ANY container
    // height change (e.g. a flex-chain propagation that emits no `resize`), so a
    // gate recompute rides the box change itself. Cheap + loop-free:
    // measureOverflow toggles only the touch-action class (no box-size change →
    // no RO re-fire). Guarded on `typeof ResizeObserver` for graceful
    // degradation (mirrors `window.visualViewport?.` above; also lets jsdom
    // tests that don't stub it skip construction). Create-in-onMount /
    // disconnect-in-onCleanup mirrors the #230 passive-touch discipline.
    //
    // #285 REOPEN — the RO is necessary but NOT sufficient. On a cold iOS-PWA
    // kill+relaunch the boot read latches an INFLATED `--viewport-height`, the
    // container BAKES to that inflated height, and NO subsequent box change ever
    // occurs to correct it (the corrective settle fires no `resize` and — with
    // the container frozen inflated — no RO callback either). Under the OLD
    // default-deny gate that left scroll DEAD forever (worse in tabs with no
    // unread marker, whose content sits just under the inflated threshold). The
    // durable fix is layered: (1) the FAIL-OPEN base + `shouldLockScrollGate`
    // (a pre-settle read can no longer latch the pane dead); (2) the
    // viewportHeight boot settle RE-READ that corrects the inflated
    // `--viewport-height` event-independently (so the container un-bakes → RO
    // fires → gate recomputes); (3) the post-mount settle timer below, an
    // event-independent re-measure for the no-box-change settle.
    let overflowObserver: ResizeObserver | undefined;
    let lastContainerHeight: number | null = null;
    if (listRef && typeof ResizeObserver !== "undefined") {
      lastContainerHeight = listRef.clientHeight;
      overflowObserver = new ResizeObserver(() => {
        measureOverflow();
        // #360 — a container box change (flex-chain propagation with no `resize`
        // event) also moves the fold; keep the mention badge in step here too.
        recomputeMentionsBelow();
        // #778 — and a moved fold must RE-PIN a follower to the tail, exactly as
        // the `onResize` arm above does. The window/visualViewport events fire
        // only for VIEWPORT changes; chrome growing inside the shell shrinks THIS
        // box with no event at all — measured on the #580 e2e, the 25px
        // `.compose-box-error` line mounting after the tail write left the pane
        // 32px short of the tail with the just-sent row clipped under the fold
        // (an intermittent "own send does not scroll" in the field). Same gate
        // (`followMode`, the follow INTENT: a reader parked above the tail is
        // preserved), same verb, same precedence — the RO is simply the honest
        // signal for the class the event arm cannot see.
        //
        // Height-CHANGE gated: RO also delivers a callback on observe() and on
        // width-only changes, neither of which moves the fold, and tail-snapping
        // there would fight the cold-mount marker activation.
        //
        // `withHide: false` (the resize arm passes true): this fires on every
        // composer growth, and the #130 visibility hide would blink the whole
        // pane on each wrapped line. The rAF×2 correction lands two frames later
        // with no intervening reader-visible wrong-scroll state to hide.
        const height = listRef?.clientHeight ?? null;
        const moved = lastContainerHeight !== null && height !== lastContainerHeight;
        lastContainerHeight = height;
        if (moved && followMode()) applyActivation("tail-only", false);
      });
      overflowObserver.observe(listRef);
    }

    // #285 reopen part (3) — defensive post-mount settle re-measure. Fires
    // regardless of any resize / box change, so the no-event settle that RO and
    // onResize both miss still re-runs the gate against the settled geometry.
    const settleTimers = SETTLE_REMEASURE_DELAYS_MS.map((ms) =>
      window.setTimeout(() => measureOverflow(), ms),
    );

    onCleanup(() => {
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
      listRef?.removeEventListener("touchstart", onTouchStartEl);
      listRef?.removeEventListener("touchmove", onTouchMoveEl);
      listRef?.removeEventListener("touchend", onTouchEndEl);
      listRef?.removeEventListener("touchcancel", onTouchEndEl);
      for (const t of settleTimers) window.clearTimeout(t);
      overflowObserver?.disconnect();
      if (scrollSettleTimer !== undefined) {
        window.clearTimeout(scrollSettleTimer);
      }
    });
  });

  // #196 / #219-general — preserve the reader's scroll position across ANY
  // covering overlay (media viewer, /names, /who, confirm, archive, delete,
  // server-reply, privacy, topic modal, side drawers — every surface that
  // pushes the shared `overlayScrollLock` refcount). #196 introduced this for
  // the media viewer keyed on `mediaViewerState`; #219-general widens the
  // trigger to `overlayCount() > 0` so a SINGLE derived predicate ("a covering
  // overlay is open") owns the freeze — no per-modal flag to keep in sync
  // (derive, don't duplicate). Opening the overlay was dropping / tail-snapping
  // the scrollback's scrollTop (a fullscreen modal shrinks the mobile
  // visualViewport → the onMount `resize` listener → scrollToActivation →
  // tail snap; a message arriving under the overlay ran the length-effect's
  // tail-follow). ScrollbackPane owns the scroll container and is the single
  // scroll authority — the fixed overlay can't reach `listRef` — so the
  // capture/restore lives here, keyed on the refcount's 0↔n edge (`defer: true`
  // skips the initial mount). Snapshot the position when the first overlay
  // opens; re-assert it across the next two frames (matching
  // `scrollToActivation`'s rAF×2 — any perturbation lands after the overlay's
  // layout commits) and again on close, so NEITHER transition yanks the
  // viewport.
  //
  // KEY-GUARD (#219-general): #196's media viewer never switched channels, so
  // its restore was always safe. A covering MODAL can switch the window on
  // close — clicking a nick in /names or /who opens a query AND dismisses the
  // modal in one gesture. The ScrollbackPane instance persists across
  // channel↔query (Shell bundles them in one non-keyed Match), so a blind
  // restore would write the OLD channel's scrollTop onto the switched-to
  // window. Pin the snapshot to the channel key it was captured on:
  // `overlaySnapshotKey`. The gate (scrollToActivation + length-effect) and
  // this restore both require `overlaySnapshotKey === key()`, so a window
  // switched-to while an overlay is up activates normally and is never
  // corrupted by the leaving channel's held offset.
  createEffect(
    on(
      () => overlayCount() > 0,
      (open) => {
        if (!listRef) return;
        if (open) {
          overlayScrollSnapshot = listRef.scrollTop;
          overlaySnapshotKey = key();
        }
        const target = overlayScrollSnapshot;
        const snapKey = overlaySnapshotKey;
        if (target === null || snapKey === null) return;
        // Re-assert across rAF×2 (matching scrollToActivation's frame budget so
        // it lands after the overlay's layout commits) via the applier's W1
        // restore entrypoint — the single owner of this write, key-guarded there.
        //
        // #608 (deep-review §6.2) — NO snapshot clear. The freeze is DERIVED from
        // the live `overlayCount()` (see `isOverlayFrozen`), so the snapshot no
        // longer doubles as the freeze flag; it is only the px to restore,
        // harmlessly stale once the count hits 0 and re-captured on the next open
        // edge. Dropping the clear removes the separately-cleared latch that could
        // drift from the count — the review's PLAUSIBLE stale-clear race (a
        // close→reopen nulling a just-re-armed snapshot) is now structurally
        // impossible, as is the field-bug "frozen forever under a leaked count".
        requestAnimationFrame(() =>
          requestAnimationFrame(() => applyOverlayRestore(target, snapKey)),
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
  //      GATED on the follow-state at hide time (#535), no latch: resume ≠
  //      switch (#46). followMode() true → "tail-only" (the reader was following
  //      live). followMode() false → "marker-or-preserve" (the reader had
  //      deliberately scrolled up; land on the divider or hold their scrollTop
  //      — NEVER tail-snap them).
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
  //     and set `followMode`/`atBottomNow` from the resulting distance; else the
  //     tail. The divider is the frozen row the `rows()` memo already injected —
  //     we read its DOM node, never a recomputed cursor geometry. While the latch
  //     is set the length-effect re-asserts this on every rows recreation, so
  //     the post-switch catch-up refresh / late cursor hydration can't strand
  //     it (307). Cleared on operator input / own send.
  //   * "tail-only" — resize (#46 resume family) + the follow-live arm of
  //     visibility-return. Never the divider; `followMode`/`atBottomNow=true`; no
  //     latch (the length-effect's `followMode` tail-follow already re-establishes
  //     the tail).
  //   * "marker-or-preserve" — the scrolled-up arm of visibility-return (#535).
  //     Same marker DOM read as "marker-or-tail", but when NO divider renders it
  //     PRESERVES the reader's scrollTop instead of tailing. It is safe to skip
  //     the scroll then: the re-latch (`setMarkerCursorId`) only recomputes
  //     `rows()` — which resets scrollTop to 0 via the ref-keyed `<For>` — when
  //     it MOVES the cursor, and a moved cursor still below the tail always
  //     renders a divider, so "no marker" means the re-latch left scrollTop
  //     untouched. The sibling `refreshScrollback` (fired one line before this)
  //     is an ASYNC co-trigger that CAN recompute `rows()` later by appending
  //     rows missed while hidden, but a TAIL append preserves a scrolled-up
  //     reader's position (the length-effect's `followMode` gate does nothing +
  //     browser scroll anchoring holds the viewport) — empirically pinned by the
  //     #535 "messages missed while hidden" e2e case, not just asserted here. No
  //     latch (one-shot resume). Owner ruling 2026-07-29 (#535): the only
  //     legitimate jump-to-bottom is the operator's own send in the active
  //     window; every other trigger preserves position or lands on the divider.
  // Post-send / live-append stay at the BOTTOM via the length-effect: the send
  // ARMS `followMode` (#608 STEP 5, clearing the marker latch first) and the
  // applier tail-follows the echo when it mounts. The divider still RENDERS at
  // its frozen position (freeze-display
  // contract, DESIGN_NOTES 2026-06-08) for every trigger. `atBottomNow` is set
  // per branch so the floating "scroll to bottom" button doesn't flash
  // mid-activation (and `followMode` alongside it drives the tail-follow gate).
  // `withHide` (#130 flicker gate) applies ONLY to the initial establish from
  // an activation trigger — a cross-key window swap paints the new content at
  // the old preserved scrollTop before the deferred scroll corrects it, so we
  // hide (visibility) until the rAF×2 lands. A RE-ASSERT (same key, driven by
  // the length-effect when `markerActivationPending`) passes `false`: the
  // rows-recreation reset happens in the SAME frame and the rAF×2 corrects it
  // pre-paint, so the intermediate scrollTop=0 is never painted — no hide
  // needed, and toggling `activating` on every rows change would itself flicker.
  const scrollToActivation = (
    mode: "marker-or-tail" | "tail-only" | "marker-or-preserve",
    withHide: boolean,
  ): void => {
    if (!listRef) return;
    // #219 / #219-general — while a covering overlay is up, the pane's scroll is
    // frozen by the overlay-snapshot capture/restore below (`isOverlayFrozen()`
    // is true for the whole open→close-settle window). No activation authority
    // may move a COVERED pane: on mobile a fullscreen modal changes the
    // visualViewport, firing the onMount `resize` listener → scrollToActivation(
    // "tail-only") → a tail snap that strands the reader far from where they were
    // (jump-to-bottom, the #219 report). #219 gated on the media viewer only;
    // #219-general keys off the shared overlay refcount so EVERY covering modal /
    // drawer freezes the pane. Bail while frozen; the overlay-snapshot effect
    // owns restoration on the open edge and on close.
    if (isOverlayFrozen()) return;
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
          mode === "marker-or-tail" || mode === "marker-or-preserve"
            ? (listRef.querySelector('[data-testid="unread-marker"]') as HTMLElement | null)
            : null;
        if (marker?.scrollIntoView) {
          marker.scrollIntoView({ block: "start" });
          // Set both concerns from the settled distance (layout is stable
          // inside the rAF×2). A far divider ⇒ false: `followMode` off so the
          // length-effect's `if (!followMode()) return` guard yields (its
          // tail-follow does not race this jump) AND `atBottomNow` off so the
          // floating "scroll to bottom" button shows. A near-tail divider (tiny
          // unread) ⇒ true: effectively at the bottom, tail-follow is correct.
          const distance = listRef.scrollHeight - listRef.scrollTop - listRef.clientHeight;
          const near = distance <= SCROLL_BOTTOM_THRESHOLD_PX;
          setFollowMode(near);
          setAtBottomNow(near);
        } else if (mode === "marker-or-preserve") {
          // #535 — scrolled-up visibility-return with NO divider to land on
          // (e.g. a fully-read channel the reader paged up into). The re-latch
          // left `markerCursorId` — hence this synchronous `rows()`, hence
          // scrollTop — untouched. PRESERVE the reader's position: do NOT
          // tail-snap, and leave `followMode`/`atBottomNow` false (they are
          // still parked above the tail). Nothing to scroll here. (A later async
          // `refreshScrollback` append can still recompute `rows()`, but a tail
          // append preserves a scrolled-up viewport — guarded by the #535 gap
          // e2e case.)
        } else {
          const tail = listRef.lastElementChild as HTMLElement | null;
          if (tail?.scrollIntoView) {
            tail.scrollIntoView({ block: "end" });
          } else {
            listRef.scrollTop = listRef.scrollHeight;
          }
          setFollowMode(true);
          setAtBottomNow(true);
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
  // Which id: NOT the follow/geometry signals. They are unreliable HERE — the
  // sibling activation effect runs in the SAME key-change batch and re-arms
  // `followMode`/`atBottomNow` true before this arm reads them (instrumentation
  // caught the old conflated `atBottom() === true` while the leaving pane sat
  // 407px off the bottom; the #608 split keeps the same caveat — the batch
  // re-arm is the reason, not the conflation).
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

        // #608 STEP 6 — reset the measured-settle baseline for the arriving pane
        // (a different channel has a different extent). 0 ⇒ its first tail-follow
        // registers growth (real extent > 0) and settles once the tail lays out.
        lastTailScrollHeight = 0;

        // 2026-06-01 (scroll-contamination fix): re-arm auto-follow on
        // every window activation. The `[data-testid="scrollback"]`
        // <div> is the SAME DOM node across kind transitions (Shell.tsx
        // bundles channel|query|server into ONE Match), so its
        // `scrollTop` survives the swap — and the follow/geometry signals,
        // unless explicitly reset here, carry the LEAVING pane's
        // user-scrolled-up state into the arriving pane. When the
        // arriving pane is cold (`messages()` empty/undefined),
        // `scrollToActivation`'s rAF×2 body early-returns without resetting
        // scroll OR the signals. The length-effect then reads stale
        // `followMode=false` once REST lands and skips the auto-snap, leaving
        // the DOM at whatever scrollTop the browser preserved from the source
        // pane. vjt prod-reported as "scroll contamination after few back and
        // forths of focusing many windows". The auto-snap branch in
        // `scrollToActivation` writes the new pane's true bottom on
        // its own; if the operator scrolls up in the new pane, the
        // first real onScroll clears `followMode`. Re-arming both here is
        // therefore safe + correct — every activation starts tail-following
        // (followMode) with the button hidden (atBottomNow), and the operator's
        // own input takes it back.
        setFollowMode(true);
        setAtBottomNow(true);

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
        applyActivation("marker-or-tail", true);
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
        // #535 — gate the resume scroll on the follow-state that was in effect
        // when the document hid. `followMode()` (#608: the follow INTENT, not
        // the geometric `atBottomNow`) turns false ONLY on a real operator
        // scroll-UP (onScroll), so it is an honest "the reader chose to leave
        // the tail" signal — the SAME gate the resize re-anchor uses (onMount
        // `onResize`). Both arms are one-shot with no latch: resume ≠ switch, so
        // only a channel activation (switch / cold-mount) latches a re-asserted
        // marker jump (#168, 2026-07-03).
        //   * followMode() true  → the reader was following live → TAIL (#46).
        //   * followMode() false → the reader deliberately scrolled up mid-backlog
        //     → land on the re-latched divider if one renders, else PRESERVE
        //     their scrollTop. NEVER tail-snap them (the pre-#535 bug: the
        //     unconditional "tail-only" here dropped a mid-backlog reader at the
        //     tail on every return from an external link).
        if (followMode()) {
          applyActivation("tail-only", true);
        } else {
          applyActivation("marker-or-preserve", true);
        }
      }
    }),
  );

  // #580 / #608 (deep-review §6.5) — submit-time follow authority. Pressing
  // enter is the operator declaring "follow the tail again", NOT a reaction to
  // the server, so it fires on `ownSendSubmitted` (published SYNCHRONOUSLY before
  // the POST in scrollback.sendMessage) — the instant enter is pressed,
  // independent of the network round-trip (the #580 property: a slow / failed
  // POST must not park the pane; the follow-arm here never waits on it).
  //
  // #608 STEP 5 — the submit ARMS the follow INTENT; it does NOT scroll to a
  // non-existent node. There is NO optimistic append (scrollback.sendMessage
  // publishes this signal SYNC before the POST; the row renders only on the WS
  // echo), so the pre-#608 `scrollToBottom()` here read PRE-append geometry and
  // scrolled to the STALE tail — one message behind (#608 §5 off-by-one). Now the
  // send sets `followMode` via the `nextFollowMode` "send" edge (re-enters follow
  // even if the operator had paged UP — "send follows the tail
  // unconditionally"), and the APPLIER tail-follows when the echo row actually
  // mounts + lays out (length-effect → tail-follow, reading POST-append
  // geometry). This is where `followMode` and `atBottomNow` first DIVERGE:
  // `followMode` is armed HERE (the intent); `atBottomNow` only flips true once
  // the echo lays out and the tail-follow's scroll fires `onScroll` reach-tail —
  // the floating button may briefly show between submit and echo on a
  // scrolled-up send, which is correct (the tail does not yet exist).
  //
  // Clear the marker-activation latch FIRST so the length-effect's marker
  // re-assert can't fight the tail-follow the echo triggers. Keyed: only a send
  // to THIS pane's `(slug, channel)` arms it (a `/msg` elsewhere doesn't).
  // `defer: true` skips the mount run — the key/cold-latch effects own the
  // mount-time baseline. The divider re-latch stays on `lastOwnSend`
  // (post-resolve, below) — the #580 split is preserved.
  createEffect(
    on(
      ownSendSubmitted,
      (sent) => {
        if (sent !== key()) return;
        setMarkerActivationPending(false);
        setFollowMode(nextFollowMode(followMode(), "send"));
      },
      { defer: true },
    ),
  );

  // Send-relatch (2026-06-09, vjt: "marker showing + you send → hide it").
  // An own send is an explicit caught-up action, so it re-latches the frozen
  // marker to the now-advanced live cursor — collapsing the `── XX unread ──`
  // divider immediately instead of waiting for a window-switch. #580 split the
  // network-independent snap (submit-time, above) from this divider re-latch:
  // the re-latch reads the cursor `sendMessage` advanced from the CONFIRMED
  // row id, so it stays on `lastOwnSend` (fired AFTER the POST resolves). A
  // rejected send never confirms → `lastOwnSend` never fires → the divider
  // stays put, which is correct (nothing was persisted to mark read). Keyed:
  // only a send to THIS pane's `(slug, channel)` hides its marker (a `/msg`
  // elsewhere doesn't); passive advances (scroll-settle echo, cross-device)
  // stay frozen. `defer: true` skips the mount run — the key/cold-latch
  // effects own the mount-time baseline.
  createEffect(
    on(
      lastOwnSend,
      (sent) => {
        if (sent !== key()) return;
        setMarkerCursorId(getReadCursor(props.networkSlug, props.channelName));
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
  // No false→true arm HERE — the hide edge is this effect's whole job. The
  // return edge is owned by the #887 read-at-the-tail arm below, which reaches
  // the same door under a geometry gate this one does not need. (The DISPLAY
  // snapshot is re-latched on focus-regain by the sibling activation effect
  // above — freeze contract option (b) — by re-reading the cursor, not
  // advancing it; that stays true whichever arm advances it.)
  //
  // `prev === undefined` guards the initial-mount run (mirrors the
  // sibling effect's identical guard).
  createEffect(
    on(isDocumentVisible, (visible, prev) => {
      if (prev === undefined) return;
      if (prev !== true || visible !== false) return;
      settleCursorToVisibleTail();
    }),
  );

  // #887 — read-at-the-tail. THE arm that makes a visible badge honest.
  //
  // Removing the focused-window suppression (selection.ts) exposed a cadence
  // the badge could not survive: the pre-existing writers all fire when the
  // operator STOPS looking (leave, blur, unmount) or when they SCROLL
  // (scroll-settle, gated on a real input event). An operator sitting at the
  // tail of a quiet window generates neither — so a message arriving while
  // they watch it land would bump the badge to 1 and leave it there until
  // they walked away. Suppression used to hide that; without an arm here the
  // change would just trade a vanishing badge for a stuck one, which is the
  // same complaint in a different flavour (#887's own warning).
  //
  // The rule is the honest one: while the tab is visible AND the pane is at
  // the tail, what is rendered is what the operator is reading, so mark it
  // read. Both gates are load-bearing:
  //   * `isDocumentVisible()` — a selected-but-BACKGROUNDED tab must keep
  //     accruing (the property the old suppression's visibility gate had, and
  //     the one thing about it worth keeping).
  //   * `atBottomNow()` — the GEOMETRIC measurement, not the `followMode`
  //     intent. A reader parked above the tail, and a cold activation that
  //     jumped to a far `── N unread ──` divider (which sets both false, ~:2094),
  //     are NOT reading the rows below the fold; their badge must stand.
  // Everything dangerous past those gates is already refused downstream:
  // `setCursorIfAdvances` freezes a far-behind window (#693 — the case #888
  // then makes legible) and is forward-only (#233), so a scrolled-up snapshot
  // can never rewind.
  //
  // Debounced, and the timer is cleared+re-armed on EVERY re-run BEFORE the
  // guards, because the fire callback reads `props` at fire time — a schedule
  // left over from the previous window must never write the switched-to one
  // (same hazard, same shape, as the #239 presence arm below). `key()` is read
  // for exactly that reason: a channel switch must re-arm, not inherit.
  let readAtTailSettleTimer: number | undefined;
  createEffect(() => {
    key();
    const rowCount = rows()?.length ?? 0;
    const visible = isDocumentVisible();
    const atTail = atBottomNow();
    if (readAtTailSettleTimer !== undefined) {
      window.clearTimeout(readAtTailSettleTimer);
      readAtTailSettleTimer = undefined;
    }
    if (!visible || !atTail || rowCount === 0) return;
    readAtTailSettleTimer = window.setTimeout(settleCursorToVisibleTail, READ_AT_TAIL_SETTLE_MS);
  });
  onCleanup(() => {
    if (readAtTailSettleTimer !== undefined) {
      window.clearTimeout(readAtTailSettleTimer);
    }
  });

  // #239 — advance the server read-cursor over the TRAILING run of hidden
  // control messages while this window is DISPLAYED. The #222 presence filter
  // hides join/part/quit/nick_change; those rows have NO DOM node, so the
  // DOM-geometry settle paths above (scroll-settle / leave / blur / unmount)
  // can only ever advance the cursor to the last RENDERED row. A trailing run
  // of hidden control messages past the cursor therefore never receives a
  // settle event → `last_read_message_id` stays stuck below them → the server-
  // owned unread count (join-reply / `/me` seed, cross-device, reload) never
  // clears even though the operator has seen everything they CAN see. Facet A
  // (selection.ts) already keeps the LOCAL badge honest; this closes the
  // server-owned-cursor gap so it stays cleared cross-device and after reload.
  //
  // Reconcile to the ONE shared predicate: only when this channel is HIDING
  // presence AND the tab is visible (the operator is actually looking) do we
  // walk the store from the live cursor and advance over the trailing hidden
  // run — to the tail if the whole post-cursor tail is hidden, otherwise up to
  // just before the first VISIBLE unread (`trailingHiddenAdvanceTarget`), so a
  // real visible unread keeps its badge + divider. Read state stays server-
  // owned: this supplies the read-position signal the hidden tail cannot settle
  // on its own, through the existing forward-only `setCursorIfAdvances` path
  // (#233 monotonic clamp preserved). The in-pane divider reads the FROZEN
  // `markerCursorId`, so advancing the live cursor here never yanks it.
  //
  // No mark-as-unread escape hatch exists in cic today; when one lands it MUST
  // suppress this auto-advance (issue #239 interaction) — flagged, not built.
  //
  // Debounced: coalesce join/part storms (netsplits) to a single forward POST
  // once arrivals quiesce. The timer is cleared+reset on EVERY re-run (key
  // switch / pref flip / tab hide) BEFORE the early-return guards, because the
  // fire callback reads `key()`/`props` at fire time — a stale schedule must
  // never fire against a switched-to window.
  let presenceCursorSettleTimer: number | undefined;
  createEffect(() => {
    const msgs = messages();
    const memberCount = (membersByChannel()[key()] ?? []).length;
    const presenceVisible = channelPresenceVisible(key(), memberCount);
    const visible = isDocumentVisible();
    if (presenceCursorSettleTimer !== undefined) {
      window.clearTimeout(presenceCursorSettleTimer);
      presenceCursorSettleTimer = undefined;
    }
    // Nothing hidden on this channel, or the operator isn't looking: the DOM
    // settle paths already own the cursor — there is no trailing-hidden gap.
    if (presenceVisible || !visible) return;
    if (!msgs || msgs.length === 0) return;
    presenceCursorSettleTimer = window.setTimeout(() => {
      const rowsNow = messages();
      if (!rowsNow || rowsNow.length === 0) return;
      const mc = (membersByChannel()[key()] ?? []).length;
      const cursorNow = getReadCursor(props.networkSlug, props.channelName) ?? 0;
      const target = trailingHiddenAdvanceTarget(rowsNow, cursorNow, (kind) =>
        presenceRowVisible(key(), mc, kind),
      );
      setCursorIfAdvances(props.networkSlug, props.channelName, target);
    }, PRESENCE_CURSOR_SETTLE_MS);
  });
  onCleanup(() => {
    if (presenceCursorSettleTimer !== undefined) {
      window.clearTimeout(presenceCursorSettleTimer);
    }
  });

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

  // #608 (deep-review §6.3) — THE SINGLE SCROLL APPLIER.
  //
  // Historically N effects each independently decided to write `scrollTop` /
  // `scrollIntoView`, arbitrated only by whichever ran LAST in the frame — the
  // un-coordinated race the reshape kills. The applier is the ONE place that
  // resolves precedence (via the pure `resolveIntent` core) and performs the
  // single winning DOM write, with a dev-only log per run so the next field
  // report is a log line, not a guess.
  //
  // Intents are built from LIVE state at call time: the sticky ones are DERIVED
  // (overlay-freeze from `isOverlayFrozen()`, marker-activation from the latch +
  // a rendered divider, tail-follow from `followMode()`); the one-shot ones
  // (operator-tail, mention-jump) are DECLARED by their trigger and consumed
  // here. This increment funnels the length-effect (rows() content change)
  // through it; later increments route the remaining writers (overlay edge,
  // send, gesture, mention, key-change) in one at a time.

  // Dev-only decision log — (trigger, intents, winner, reason, geometry) per
  // applier run. Gated on the dev-server MODE: Vite statically replaces
  // `import.meta.env.MODE`, so this is dead-code-eliminated in the prod bundle
  // and silent under vitest (MODE "test"). listRef is read for geometry only.
  const logScrollDecision = (
    trigger: string,
    intents: readonly ScrollIntent[],
    winner: ScrollIntent | null,
    reason: string,
  ): void => {
    if (import.meta.env.MODE !== "development" || !listRef) return;
    console.debug("[scroll-authority]", {
      trigger,
      key: key(),
      intents: intents.map((i) => i.kind),
      winner: winner?.kind ?? null,
      reason,
      geometry: {
        scrollTop: listRef.scrollTop,
        scrollHeight: listRef.scrollHeight,
        clientHeight: listRef.clientHeight,
      },
    });
  };

  // #608 STEP 6 — the tail-follow's MEASURED-settle wait. Replaces the fixed
  // rAF×2 (not a layout flush on iOS WebKit — it read the just-committed node's
  // pre-layout geometry and scrolled to the PREVIOUS tail, the #608 §5
  // off-by-one). Each frame forces a synchronous reflow (reading `scrollHeight` +
  // the tail's `offsetHeight` are layout properties) and re-checks the pure
  // `isSettled` core against the last-tail baseline: the extent has GROWN since we
  // last tailed AND the new tail row has a laid-out box. Scrolls the frame that
  // holds, updating the baseline. Bounded by `SETTLE_MAX_FRAMES` (fail-safe: a
  // rows change with no measurable growth still tails once IF the pane is behind
  // the tail — never strands; but #625: it does NOT fire when already at the tail,
  // else a follow-on no-growth rows change on a single send double-scrolls).
  // Re-checks `followMode()`/`listRef` each frame (the operator may scroll up, or
  // the pane unmount, mid-wait). condition-based-waiting: wait for the real
  // layout state, not two guessed frames.
  const tailFollowWhenSettled = (): void => {
    let frame = 0;
    const step = (): void => {
      // Stop if the pane unmounted mid-wait: `listRef` is not nulled on cleanup,
      // so gate on DOM attachment — otherwise a poll outliving the component
      // keeps firing on the detached node (and, since scrollIntoView is a
      // prototype method, would pollute a later-mounted pane's spy under test).
      if (!listRef?.isConnected) return;
      if (!followMode()) return;
      // #608 — a DEFERRED settle poll must re-validate the freeze precedence each
      // frame, not just at dispatch time. tail-follow only wins `resolveIntent`
      // when nothing higher is active, but this poll can outlive that decision by
      // up to SETTLE_MAX_FRAMES: if a covering overlay opens mid-poll,
      // overlay-freeze now outranks tail-follow, so the poll must YIELD rather
      // than write through the freeze. Keeps the single-writer precedence holding
      // across the poll's whole lifetime (same class as the followMode/isConnected
      // re-checks above), not just the frame it was scheduled.
      if (isOverlayFrozen()) return;
      const tail = listRef.lastElementChild as HTMLElement | null;
      const currScrollHeight = listRef.scrollHeight;
      const targetNodeHeight = tail?.offsetHeight ?? 0;
      const settled = isSettled({
        prevScrollHeight: lastTailScrollHeight,
        currScrollHeight,
        targetNodeHeight,
      });
      if (settled || frame >= SETTLE_MAX_FRAMES) {
        // #625 — the fail-safe must NOT fire a redundant DELAYED write. A single
        // send fires MORE THAN ONE `rows().length` change (the echo append, then
        // a follow-on change: the marker collapse / cursor advance). Each spawns
        // a poll sharing `lastTailScrollHeight`; the echo's poll settles first and
        // advances the baseline to the final extent, so the follow-on poll can
        // NEVER measure growth (`currScrollHeight > lastTailScrollHeight` is false)
        // and runs its whole SETTLE_MAX_FRAMES budget — firing a second
        // `scrollIntoView` ~0.5s AFTER the send ("the scroll resets after a
        // while", the #608-regression double-scroll). When that fail-safe reaches
        // its budget WITHOUT measured growth AND the pane is already AT the tail,
        // there is nothing to follow — skip the write. The genuine no-flush case
        // (fail-safe reached but the pane is still BEHIND the tail, e.g. an iOS
        // layout that never reported growth) still tails, so nothing strands.
        const atTail =
          currScrollHeight - listRef.scrollTop - listRef.clientHeight <= SCROLL_BOTTOM_THRESHOLD_PX;
        if (settled || !atTail) {
          if (tail?.scrollIntoView) {
            tail.scrollIntoView({ block: "end" });
          } else {
            listRef.scrollTop = listRef.scrollHeight;
          }
        }
        lastTailScrollHeight = listRef.scrollHeight;
        return;
      }
      frame += 1;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  // Perform the winning intent's DOM write. Each kind keeps the exact timing its
  // pre-applier writer used (rAF×2 / instant where geometry must settle after the
  // <For> commit; tail-follow now uses the measured-settle wait above). The
  // caller guarantees `listRef` is non-null on entry, but the deferred rAF
  // bodies re-check it (it can null on unmount between frames).
  const dispatchScrollWrite = (winner: ScrollIntent): void => {
    switch (winner.kind) {
      case "overlay-freeze": {
        // W4 — re-assert the held snapshot px. The ref-keyed <For> has just
        // recreated the list DOM, resetting scrollTop to 0; re-assert SYNC (no
        // transient-0 frame for a reader to catch) then AGAIN across rAF×2 as
        // belt-and-braces for any late layout shift. Re-check `isOverlayFrozen()`
        // in the rAF: the overlay may have closed, in which case the overlay
        // effect's close restore owns it.
        const snapNow = overlayScrollSnapshot;
        if (listRef && snapNow !== null && listRef.scrollTop !== snapNow) {
          listRef.scrollTop = snapNow;
        }
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const snap = overlayScrollSnapshot;
            if (listRef && isOverlayFrozen() && snap !== null) {
              listRef.scrollTop = snap;
            }
          }),
        );
        return;
      }
      case "marker-activation":
        // W2/W3 — jump to the rendered unread divider (or the tail if none).
        // `scrollToActivation` owns the rAF×2 + the frozen bail (unreachable
        // here: overlay-freeze outranks marker-activation, so we only dispatch
        // marker-activation when not frozen).
        scrollToActivation("marker-or-tail", false);
        return;
      case "tail-follow":
        // W5 — stick to the tail via the MEASURED-settle wait (#608 STEP 6),
        // replacing the fixed rAF×2 which is not a layout flush on iOS WebKit and
        // scrolled to the STALE pre-layout tail (the #608 §5 off-by-one). See
        // `tailFollowWhenSettled` — it re-checks `followMode()` each frame.
        tailFollowWhenSettled();
        return;
      case "operator-tail": {
        // W7 — the explicit operator tail (scroll-to-bottom button / #243 re-tap /
        // active-window re-tap). INSTANT + SYNC (no rAF): the 2026-06-02
        // contamination fix — a smooth/async animation on the SHARED `.scrollback`
        // node would survive a window switch and race the arriving pane's
        // activation, stranding scrollTop at a stale offset (vjt prod report). The
        // rows are already in the DOM at gesture time (the operator taps after
        // content exists), so `lastElementChild` is the true tail — no settle
        // needed. Re-arm follow + geometry, exactly as the former scrollToBottom()
        // helper did; running SYNC keeps the caller's post-scroll
        // `lastFullyVisibleRowId` read on the pinned tail.
        const tail = listRef.lastElementChild as HTMLElement | null;
        if (tail?.scrollIntoView) {
          tail.scrollIntoView({ block: "end" });
        } else {
          listRef.scrollTop = listRef.scrollHeight;
        }
        setFollowMode(true);
        setAtBottomNow(true);
        return;
      }
      default:
        // mention-jump (applyMentionJump) + prepend-preserve (applyPrependPreserve)
        // own dedicated entrypoints and never reach dispatchScrollWrite, so this
        // arm stays unreachable.
        return;
    }
  };

  // The applier entrypoint for a content change (the length-effect below).
  // Builds the live-derived intents that compete when rows() changes, resolves
  // precedence, logs, and performs the single winning write.
  const applyScrollForContentChange = (): void => {
    if (!listRef) return;
    const k = key();
    const intents: ScrollIntent[] = [];
    if (isOverlayFrozen()) {
      intents.push({ kind: "overlay-freeze", key: k, lifetime: "sticky" });
    }
    if (markerActivationPending() && listRef.querySelector('[data-testid="unread-marker"]')) {
      intents.push({ kind: "marker-activation", key: k, lifetime: "sticky" });
    }
    if (followMode()) {
      intents.push({ kind: "tail-follow", key: k, lifetime: "sticky" });
    }
    const { winner, reason } = resolveIntent(intents, k);
    logScrollDecision("content-change", intents, winner, reason);
    if (winner) dispatchScrollWrite(winner);
  };

  // #608 (deep-review §6.4) — the prepend-preserve applier entrypoint. UNLIKE
  // the commit-frame intents, loadMore preserve is POST-AWAIT: an older page is
  // fetched, PREPENDED, and the reader's on-screen row must stay put across that
  // mutation. It is a DISTINCT entrypoint (not `resolveIntent` at the commit
  // frame) because the restore needs the geometry captured BEFORE the await and
  // runs on the commit AFTER the prepend lands — the commit-frame length-effect
  // already ran for that same rows() change and, per the followMode gate, left a
  // scrolled-up reader in place. `prepend-preserve` is the LOWEST precedence in
  // the array: it never fights a higher authority because it fires only on the
  // operator's own scroll-to-top / #230 underfill-rescue, when nothing higher is
  // arming. The single owner of the W6 write; logs via the shared dev-log.
  // `oldScrollHeight` / `oldScrollTop` are the geometry captured pre-await.
  const applyPrependPreserve = (oldScrollHeight: number, oldScrollTop: number): void => {
    if (!listRef) return;
    const intent: ScrollIntent = { kind: "prepend-preserve", key: key(), lifetime: "one-shot" };
    const newScrollHeight = listRef.scrollHeight;
    if (newScrollHeight === oldScrollHeight) {
      // No growth (empty / already-exhausted page) — nothing prepended, nothing
      // to preserve.
      logScrollDecision("prepend-preserve", [intent], null, "no-growth");
      return;
    }
    logScrollDecision("prepend-preserve", [intent], intent, "prepend-preserve");
    // The prepended rows sit ABOVE the viewport, so shifting scrollTop by the
    // growth keeps the row the reader was looking at in the same on-screen spot.
    listRef.scrollTop = newScrollHeight - oldScrollHeight + oldScrollTop;
  };

  // #608 (deep-review §6.2) — the W1 overlay-restore applier entrypoint: the
  // overlay-freeze intent's RESTORE. Called from the overlay effect on BOTH
  // refcount edges (the open-edge re-assert under the overlay + the close-edge
  // final restore), so — UNLIKE the commit-frame overlay-freeze dispatch, which
  // requires `isOverlayFrozen()` (count>0) — it must NOT gate on the live freeze:
  // on the close edge the count is already 0. It gates only on the KEY (a
  // mid-overlay channel switch owns its own activation; never stamp the leaving
  // channel's px onto it) and skips a no-op write. `target` is the px captured on
  // the open edge; `snapKey` the channel it was captured on.
  const applyOverlayRestore = (target: number, snapKey: string): void => {
    if (!listRef || snapKey !== key()) return;
    // #608 (regression fix) — reconcile the follow INTENT with the reader's
    // trusted position. The snapshot is the authoritative position across the
    // overlay's whole lifetime, so `followMode` must match whether it sits at the
    // tail. Without this, a reader who scrolled up (snapshot mid-list) whose
    // scroll-up `onScroll` edge was DROPPED by the freeze bail (a scroll racing
    // the freeze engaging) is left with `followMode` stale-true; the deferred
    // `tailFollowWhenSettled` poll — which gates on `followMode`, not the freeze —
    // then fail-safe-tails the pane the instant the overlay closes, yanking the
    // reader to the bottom (the #219 media-viewer close snap; e2e
    // issue219-overlay-scroll-hold). Derived from the restored geometry — one-shot
    // per overlay edge, NO separately-cleared latch (the freeze stays derived from
    // the live `overlayCount()`). Runs even when the position is already held
    // (`scrollTop === target`), so a scrolled-up reader whose px never moved still
    // gets the stale intent corrected.
    setFollowMode(
      listRef.scrollHeight - target - listRef.clientHeight <= SCROLL_BOTTOM_THRESHOLD_PX,
    );
    if (listRef.scrollTop === target) return;
    const intent: ScrollIntent = { kind: "overlay-freeze", key: snapKey, lifetime: "sticky" };
    logScrollDecision("overlay-restore", [intent], intent, "overlay-restore");
    listRef.scrollTop = target;
  };

  // #608 — the applier's smooth-scroll INTERRUPT (W9). The mention-jump is the
  // ONE animated scroll in this pane; a channel switch must cancel an in-flight
  // animation so it cannot survive the shared `.scrollback` DOM row swap and
  // race the arriving pane's activation. NOT a position intent — a `scrollTo` to
  // the CURRENT offset is an instant (default-behavior) scroll instruction that
  // stops the native smooth animation without moving. Owned here so no scrollTo
  // lives outside the applier surface.
  const interruptSmoothScroll = (): void => {
    if (!listRef) return;
    logScrollDecision("interrupt-smooth", [], null, "interrupt-smooth");
    listRef.scrollTo({ top: listRef.scrollTop });
  };

  // #608 — the W8 mention-jump applier entrypoint. Tapping the floating button
  // with a mention below the fold smooth-scrolls the anchor into view (the #360
  // iOS msg+1 anchoring is resolved by the caller). Declared as a one-shot
  // `mention-jump` intent so the write is owned + logged by the applier. STEP 3
  // keeps it BEHAVIOUR-IDENTICAL: the tap is the operator's explicit gesture, so
  // it resolves a single-intent list and fires unconditionally, exactly as the
  // inline code did. (Arbitrating it against a live overlay-freeze / operator-
  // tail would SUPPRESS the scroll — a behaviour change deliberately left out of
  // this behaviour-preserving step; the write is now an applier intent that a
  // later step can fold into full precedence.)
  const applyMentionJump = (anchor: HTMLElement): void => {
    const k = key();
    const intent: ScrollIntent = { kind: "mention-jump", key: k, lifetime: "one-shot" };
    const { winner, reason } = resolveIntent([intent], k);
    logScrollDecision("mention-jump", [intent], winner, reason);
    if (winner) anchor.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  // #608 (STEP 3) — the window-activation applier entrypoint (W2/W3), the LAST
  // step-3 writer. The activation triggers (cold-mount, channel switch,
  // visibility-return, resize) DECLARE their intent HERE instead of calling
  // `scrollToActivation` directly, so the single applier — not each call-site —
  // resolves precedence and logs the decision. Behaviour-IDENTICAL to the
  // pre-STEP-3 direct calls: `scrollToActivation` already bails on
  // `isOverlayFrozen()` (= overlay-freeze precedence) and still owns the
  // marker-or-tail / tail-only / marker-or-preserve write mechanics + the #130
  // flicker hide (`withHide`) + the follow/geometry signals — this only moves the
  // DECISION into the pure `resolveIntent` core, making `scrollToActivation` an
  // applier-internal write routine (reached ONLY here and from
  // `dispatchScrollWrite`'s marker-activation case).
  //
  // The activation kind maps by mode: "tail-only" is the tail-follow intent
  // (resize resume + the follow-live visibility arm); "marker-or-tail" /
  // "marker-or-preserve" are marker-activation (jump to the rendered divider, or
  // tail/preserve when none). The intent is UNCONDITIONAL per mode — NOT gated on
  // the marker latch — because a direct `scrollToActivation` always ran when not
  // frozen; gating it would be a behaviour change. When overlay-freeze outranks
  // the activation intent we skip the delegate: `scrollToActivation`'s own frozen
  // bail produced the identical no-op, so no activation authority moves a covered
  // pane (the #219 / #219-general freeze), and the decision is now logged.
  const applyActivation = (
    mode: "marker-or-tail" | "tail-only" | "marker-or-preserve",
    withHide: boolean,
  ): void => {
    if (!listRef) return;
    const k = key();
    const intents: ScrollIntent[] = [];
    if (isOverlayFrozen()) {
      intents.push({ kind: "overlay-freeze", key: k, lifetime: "sticky" });
    }
    intents.push({
      kind: mode === "tail-only" ? "tail-follow" : "marker-activation",
      key: k,
      lifetime: "sticky",
    });
    const { winner, reason } = resolveIntent(intents, k);
    logScrollDecision(`activation:${mode}`, intents, winner, reason);
    // overlay-freeze wins ⇒ no activation write (scrollToActivation would have
    // bailed identically). Otherwise the activation intent won ⇒ delegate.
    if (winner?.kind === "overlay-freeze") return;
    scrollToActivation(mode, withHide);
  };

  // #608 STEP 5 — the W7 operator-tail applier entrypoint: the explicit
  // scroll-to-bottom gesture (floating button onClick, #243 re-tap). Declared as
  // an `operator-tail` one-shot intent (2nd-highest precedence, below only
  // overlay-freeze) so the write is OWNED + logged by the applier — this is where
  // the last raw scrollIntoView/scrollTop= moves off the direct call surface into
  // `dispatchScrollWrite`. Behaviour-identical to the former `scrollToBottom()`
  // helper: a single-intent list fired unconditionally (the gesture is the
  // operator's explicit action; full arbitration against a live overlay-freeze is
  // the designed rank but unreachable — the overlay covers the button — and
  // matching the pre-migration no-guard write keeps this behaviour-preserving,
  // mirroring the W8 mention-jump migration). The dispatch is SYNC (instant), so
  // the caller's post-scroll `lastFullyVisibleRowId` read still sees the pinned
  // tail.
  const applyOperatorTail = (): void => {
    if (!listRef) return;
    const k = key();
    const intent: ScrollIntent = { kind: "operator-tail", key: k, lifetime: "one-shot" };
    const { winner, reason } = resolveIntent([intent], k);
    logScrollDecision("operator-tail", [intent], winner, reason);
    if (winner) dispatchScrollWrite(winner);
  };

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
  // and turned follow off, so a send did not follow to the tail — removed.
  // New content ⇒ bottom while following (#608: gated on `followMode`);
  // scrolled-up (followMode false) preserves position — irssi-shape, only the
  // operator's own scroll leaves the tail. The scroll-to-marker jump was
  // RESCOPED to the deliberate channel-SWITCH trigger inside
  // `scrollToActivation` ("marker-or-tail" mode, #168 regression fix
  // 2026-07-03) — NOT here: when a switch parks on the divider it sets
  // `followMode=false` first, so the `if (!followMode()) return` guard below
  // yields and never races that jump back to the tail. The frozen divider
  // renders in place (DESIGN_NOTES 2026-06-08) for every trigger; this effect
  // just never scrolls to it.
  //
  // The `followMode` gate stays honest through the #156 anchored initial load
  // (which prepends the read-context page above the tail while following)
  // because `onScroll` only flips `followMode` false on a real scroll UP
  // (scrollTop decreases) — a content-grow-above keeps scrollTop put, so the
  // spurious scroll event it fires no longer lies "left the bottom" (#168).
  createEffect(
    on(
      () => rows()?.length ?? 0,
      // #608 (deep-review §6.3) — routed through the single applier. This
      // effect used to hand-code the precedence overlay-freeze ▸
      // marker-activation ▸ tail-follow as an if/else ladder; it now DECLARES
      // the live-derived intents and the applier resolves + writes exactly one.
      // The per-branch rationale (frozen re-assert on the ref-keyed <For>
      // recreation, the #307 marker re-assert, the followMode tail-follow rAF×2)
      // lives in `dispatchScrollWrite` / `applyScrollForContentChange` above.
      () => applyScrollForContentChange(),
    ),
  );

  // #168 completion — clear the marker-activation latch the moment the operator
  // takes over scrolling. `lastInputEventAtMs` is set by every operator scroll
  // gesture (pointerdown / wheel / touchmove / scroll-keys) and reset to null
  // on key-change; a non-null transition means the operator is driving, so we
  // stop re-asserting the marker and hand scroll authority back (subsequent
  // live appends then follow the `followMode` rule below — preserve when scrolled
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
  //     and releases on a flung scroll. NB: touchmove is bound
  //     element-level {passive:false} in onMount (NOT a JSX handler) so
  //     it can also drive the #230 mobile underfill rescue; it stamps
  //     `lastInputEventAtMs` there, same as the other three do here.
  //   * `keydown` covers desktop keyboard scrolling (PageDown / Space /
  //     arrows). Requires the listRef to be focusable (`tabIndex="-1"`
  //     on the element so click-to-focus works without adding a tab-
  //     stop).
  const onPointerDown = (): void => {
    setLastInputEventAtMs(Date.now());
  };

  // #230 — load older history when the operator is at/near the top of the
  // buffer, preserving their on-screen position across the prepend. Shared
  // by BOTH `onScroll` (native scroll-to-top) and `onWheel` (the underfill
  // rescue below) so the loadMore call + scroll-position math live in ONE
  // place (CLAUDE.md implement-once). The `scrollTop <= threshold` gate is
  // trivially satisfied when content underfills (scrollTop is 0), which is
  // exactly the #230 case. `loadMore` is idempotent under burst (per-key
  // in-flight Set) and forward-latched on empty pages (exhausted Set), so
  // fire-and-forget is safe — no guard needed here.
  //
  // Scroll-position preservation: REST returns older rows that get PREPENDED
  // to the merged list. Without restoration, the user's viewport would either
  // jump to the new top (scrollTop=0 stays pinned) — where they were already
  // looking — or stay numerically pinned to scrollTop=N relative to the OLD
  // scrollHeight, which is now a different position relative to the new
  // content. We capture (scrollHeight, scrollTop) BEFORE the await, then the
  // #608 applier's post-await `applyPrependPreserve` restores the reader's row
  // via the height delta (see its doc). DOM mutation lives here in the
  // component; lib/scrollback.ts stays DOM-free.
  const maybeLoadOlder = (): void => {
    if (!listRef) return;
    if (listRef.scrollTop > LOAD_MORE_THRESHOLD_PX) return;
    // See the length-effect for how an active marker activation is kept from
    // yanking this (it re-asserts ONLY when a marker exists; a no-marker latch
    // falls through to the followMode tail-follow, which preserves here because the
    // operator scrolled UP).
    const oldScrollHeight = listRef.scrollHeight;
    const oldScrollTop = listRef.scrollTop;
    void loadMoreScrollback(props.networkSlug, props.channelName).then(() =>
      applyPrependPreserve(oldScrollHeight, oldScrollTop),
    );
  };

  const onWheel = (e: WheelEvent): void => {
    // #196 (reopen) — mirror the onScroll frozen-gate: while a covering overlay
    // freezes the pane, any wheel is an artifact / cannot be operator intent (the
    // modal + backdrop cover the pane). Skipping it keeps the #230 underfill
    // rescue from firing a spurious `maybeLoadOlder` that would stale the freeze
    // snapshot. Same predicate, same reason as onScroll — total consistency.
    if (isOverlayFrozen()) return;
    setLastInputEventAtMs(Date.now());
    // #230 — rescue the wheel ONLY when the content underfills the container.
    // When the loaded window is shorter than the viewport, `.scrollback` is
    // not natively scrollable (scrollHeight <= clientHeight), so a mouse wheel
    // produces NO native `scroll` event → `onScroll` never fires → `loadMore`
    // never triggers and the operator is stuck with no way to page up into
    // older scrollback. A wheel-UP (deltaY < 0) on that underfilled pane fires
    // the SAME top-of-buffer loadMore the onScroll block uses (via
    // `maybeLoadOlder`).
    //
    // The `scrollHeight <= clientHeight` guard is load-bearing, not just an
    // optimization: on an OVERFLOWING pane the browser DOES emit a native
    // `scroll` event, so `onScroll` already owns loadMore — with the CORRECT
    // post-scroll geometry for the scroll-position restore. `wheel` fires one
    // tick BEFORE the native scroll is applied, so a wheel-path loadMore would
    // capture a STALE pre-scroll `scrollTop`, then win the in-flight race and
    // restore to the wrong anchor (jerking the viewport ~wheel-delta px). So
    // the wheel path stays OUT whenever the pane can natively scroll; onScroll
    // is the single authority there.
    //
    // No preventDefault: `.scrollback` is the SOLE scroll container — every
    // ancestor (.scrollback-pane / .shell-main / .shell) is overflow:visible,
    // html/body are overflow:hidden + overscroll-behavior:none, and
    // `.scrollback` itself sets overscroll-behavior:contain — so an unconsumed
    // wheel-up on an underfilled pane has nothing to chain-scroll. (If a
    // scrollable ancestor is ever introduced, this must move to an
    // element-level {passive:false} listener to preventDefault — a JSX
    // onWheel is passive/delegated and cannot; cf. overlayScrollLock.ts.)
    if (!listRef) return;
    // Funnel through the shared decision seam (implement-once) — the same one
    // the mobile touch path uses. `deltaY < 0` (wheel-UP) is the desktop
    // "reveal older" intent; the `!nativelyScrollable` + top-gate live inside.
    if (
      shouldRescueUnderfillLoadOlder({
        scrollHeight: listRef.scrollHeight,
        clientHeight: listRef.clientHeight,
        scrollTop: listRef.scrollTop,
        revealOlderIntent: e.deltaY < 0,
        thresholdPx: LOAD_MORE_THRESHOLD_PX,
      })
    ) {
      maybeLoadOlder();
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (SCROLL_KEYS.has(e.key)) {
      setLastInputEventAtMs(Date.now());
    }
  };

  const onScroll = () => {
    if (!listRef) return;
    // #196 (reopen) — while a covering overlay freezes the pane, EVERY scroll
    // event is an artifact of the ref-keyed <For> recreating the list DOM on a
    // rows() change (a message arriving under the overlay resets scrollTop to
    // 0), NOT operator intent: the modal + backdrop cover the pane, so the
    // reader cannot scroll it. Acting on these artifacts flips the follow +
    // geometry signals, spuriously fires loadMore/loadNewer (whose prepend would STALE the
    // absolute-pixel freeze snapshot → wrong close-edge restore), snapshots a
    // bogus visible-tail, and advances the read cursor. Skip all of it; the
    // length-effect re-assert + the overlay-snapshot close restore own the
    // reader's position for the overlay's whole lifetime.
    if (isOverlayFrozen()) return;
    const st = listRef.scrollTop;
    const distance = listRef.scrollHeight - st - listRef.clientHeight;
    // #168 / #608 — the follow INTENT (`followMode`) flips FALSE only on an
    // operator scroll UP (scrollTop DECREASES); the GEOMETRIC `atBottomNow`
    // tracks the same edges but drives only the button. Reaching the tail
    // (distance within threshold) re-arms both. A programmatic content-grow
    // ABOVE the viewport — the #156 anchored read-context page, or the WS
    // join-ok `refreshScrollback` prepend, both landing while the pane is
    // following — fires a `scroll` event whose geometry shows a huge
    // distance-to-tail (older rows now sit above) even though scrollTop did
    // NOT decrease. Treating that as "the operator left the bottom" killed the
    // always-bottom follow, stranding the pane mid-buffer on window open (P0
    // regression; ~1056px above the tail). Gating the false-flip on
    // `st < lastScrollTop` keeps a prepend from lying about intent — only a
    // real upward scroll (operator OR the programmatic scroll-to-top a loadMore
    // test performs, both of which DECREASE scrollTop) leaves the tail. The
    // followMode edges route through `nextFollowMode` (lib/scrollAuthority, the
    // SSOT transition table): reach-tail→on, scroll-up→off; the untouched
    // middle branch is the table's content-grow no-op.
    if (distance <= SCROLL_BOTTOM_THRESHOLD_PX) {
      setAtBottomNow(true);
      setFollowMode(nextFollowMode(followMode(), "reach-tail"));
    } else if (st < lastScrollTop) {
      setAtBottomNow(false);
      setFollowMode(nextFollowMode(followMode(), "scroll-up"));
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

    // #360 — refresh the mention badge on every scroll (operator scroll AND
    // the settle scrolls that activation / message-arrival / the smooth
    // mention-jump fire). The badge decrements naturally as a jumped-to
    // mention clears past the fold. Cheap geometry read; overlay-frozen
    // scrolls already returned above, so this only runs for real viewport
    // changes.
    recomputeMentionsBelow();

    // CP14 B2: scroll-up triggers loadMore. Delegated to the shared
    // `maybeLoadOlder` closure (also used by the #230 wheel-underfill path)
    // — the top-of-buffer gate + loadMore call + scroll-position preservation
    // on prepend all live there (CLAUDE.md implement-once).
    maybeLoadOlder();

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
      // effect's preserve (followMode=false in the 50–200px band) still holds.
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
    scrollSettleTimer = window.setTimeout(settleCursorToVisibleTail, SCROLL_SETTLE_DEBOUNCE_MS);
  };

  // #310 — the scroll-to-bottom GESTURE, shared by the floating button's
  // onClick AND the #243 re-tap command below. Reaching the bottom via an
  // explicit operator gesture means they have read to the newest line, so —
  // exactly like a manual scroll to the bottom — it does two things the bare
  // `applyOperatorTail()` tail write (#608 STEP 5b — the W7 operator-tail
  // applier intent) deliberately does NOT:
  //
  //   1. Clears the marker-activation latch. A channel activation into an
  //      unread window leaves `markerActivationPending` set; only an operator
  //      INPUT event (`on(lastInputEventAtMs)`) or an own send cleared it. A
  //      button tap is NOT a `listRef` input event (the button is a sibling
  //      OUTSIDE `.scrollback`), so the latch stayed set — and the next rows()
  //      recreation (a live message, or the switch-time `refreshScrollback`)
  //      hit the length-effect's marker re-assert and yanked the view back to
  //      the divider ~2s later (the #310 snap-back). Handing scroll authority
  //      back here is exactly what the operator-input arm does for a manual
  //      scroll.
  //   2. Advances the server read cursor to the newest rendered id via the
  //      existing forward-only `setCursorIfAdvances` POST path — so "read to
  //      newest" persists across reload / cross-device. The button never
  //      POSTed at all (candidate a; the manual path advances via the
  //      input-gated scroll-settle, which a button tap never arms — see
  //      cursor-forward-only.spec.ts).
  //
  // The newest id is read AFTER the instant scroll: the operator-tail write pins
  // the tail synchronously (dispatchScrollWrite's operator-tail case is instant,
  // no rAF), so `lastFullyVisibleRowId`'s at-bottom short-circuit returns the
  // true DOM tail — never a stale pre-scroll id the #233 monotonic clamp would
  // drop as non-advancing (candidate b). No second cursor authority, no
  // window-state mutation. The frozen divider is left in place, same as a manual
  // scroll — it re-latches only on the next focus acquisition or own send
  // (freeze contract).
  const scrollToBottomGesture = () => {
    applyOperatorTail();
    setMarkerActivationPending(false);
    settleCursorToVisibleTail();
  };

  // #360 — the floating button's tap handler (replaces the raw
  // `scrollToBottomGesture` onClick). MENTION-AWARE: when own-nick mentions
  // sit below the fold (badge > 0) a tap SMOOTH-scrolls to the nearest one
  // below (nearest-first, cycling down), decrementing the badge each tap as
  // the target clears past the fold; once none remain (badge == 0) it falls
  // back to the existing snap-to-bottom `scrollToBottomGesture` (instant tail
  // anchor + latch release + read-cursor advance). The nearest target is
  // re-derived FRESH from the DOM at tap time (not the `mentionsBelow` signal,
  // which the badge reads) so a mention that arrived/scrolled between the last
  // recompute and the tap is honoured.
  //
  // Smooth (not instant): the jump-to-mention feel is deliberate (#360, vjt
  // device-verifies it). It is the ONE smooth scroll in this file; the
  // 2026-06-02 contamination hazard (an async animation on the SHARED
  // `.scrollback` node surviving a window switch) is neutralised by the
  // key-change cancel effect below, which interrupts any in-flight animation
  // synchronously at the switch, before `scrollToActivation` re-anchors.
  //
  // A tap is a deliberate operator navigation gesture, so it hands scroll
  // authority back (`setMarkerActivationPending(false)`) exactly as the
  // snap-to-bottom path does — otherwise a live message's rows() recreation
  // would re-assert the frozen divider and yank the view off the mention
  // (#168 latch). It does NOT advance the read cursor: a mid-buffer mention is
  // not "read to newest"; the leave-arm's forward-only cursor write covers the
  // read-up-to-here on the next switch.
  const onScrollToBottomTap = (): void => {
    if (!listRef) {
      scrollToBottomGesture();
      return;
    }
    const viewportBottom = listRef.scrollTop + listRef.clientHeight;
    const geom = readMentionGeom(listRef);
    const mentionId = mentionsBelowViewport(geom, viewportBottom)[0];
    if (mentionId === undefined) {
      scrollToBottomGesture();
      return;
    }
    // #360 iOS fix — anchor the scroll on the message AFTER the mention
    // (msg+1), not the mention itself. Anchoring ON the mention left it
    // clipped behind the on-screen keyboard on iOS (scrollIntoView aligns
    // against the LAYOUT viewport, which extends under the keyboard; the
    // mention "centered" there is behind the keyboard). Anchoring on msg+1
    // keeps the mention fully visible ABOVE the anchor, clear of the
    // keyboard. `mentionJumpTargetId` returns the mention's own id when it
    // is the last line (nothing below to anchor on).
    const anchorId = mentionJumpTargetId(geom, mentionId);
    const anchor = listRef.querySelector<HTMLElement>(
      `.scrollback-line[data-msg-id="${anchorId}"]`,
    );
    if (anchor === null) {
      // The measured row vanished between recompute and tap (a rows
      // recreation dropped it) — degrade to the plain gesture, never no-op.
      scrollToBottomGesture();
      return;
    }
    setMarkerActivationPending(false);
    applyMentionJump(anchor);
    // The badge is DERIVED: onScroll recomputes it as the smooth animation
    // clears the target past the fold. Recompute now too so a browser that
    // coalesces the settle scroll still refreshes it.
    recomputeMentionsBelow();
  };

  // #243 — re-tap "jump to latest". The Sidebar / BottomBar tap handler
  // bumps `scrollToBottomRequest` when the operator re-taps the window
  // they're already on; this pane is the sole subscriber and the only one
  // mounted (Shell bundles channel|query|server into one non-keyed Match),
  // so the command always lands on the active scrollback. `defer: true`
  // skips the value read at mount, so a channel SWITCH (no nonce change) or
  // a stale nonce carried across identity rotation never fires a spurious
  // jump — only a genuine re-tap does. Routes through the SHARED
  // `scrollToBottomGesture` the floating button uses (#310) — same instant,
  // layout-aware scroll (no second scroll authority; the #196/#230 anchor
  // machinery is untouched) PLUS the reached-bottom cursor advance + latch
  // release, since a re-tap to the bottom is the same "read to newest" intent.
  createEffect(on(scrollToBottomRequest, () => scrollToBottomGesture(), { defer: true }));

  // #360 — cancel any in-flight smooth mention-jump scroll at a window switch.
  // The mention-jump (`onScrollToBottomTap`) is the ONE smooth scroll in this
  // file; every other path is instant precisely because `.scrollback` is a
  // SHARED DOM node across channel↔query↔server switches (Shell's non-keyed
  // Match), and an async animation would survive the row swap and race
  // `scrollToActivation`, stranding the arriving pane at a stale offset
  // (2026-06-02 contamination). A synchronous `scrollTo` to the current offset
  // at the key boundary — this effect fires in the same reactive batch as the
  // switch, BEFORE scrollToActivation's deferred rAF×2 — is an instant
  // (default-behavior) scroll instruction that interrupts the native smooth
  // animation without moving anywhere, so nothing async survives to fight the
  // re-anchor. `defer` skips the mount run; a no-op when no animation runs.
  createEffect(on(key, () => interruptSmoothScroll(), { defer: true }));

  return (
    <div class="scrollback-pane">
      {/* #133 — top-pinned overlay layer. WHOIS / WHOWAS / LUSERS are
          ephemeral lookup affordances the operator opens from the window
          they're reading. Rendered as flex siblings BEFORE `.scrollback`
          they shrank the scroll list on mount, shifting the reader's anchor
          and losing their place in the channel buffer. They now float in
          this absolutely-positioned overlay: the scroll list keeps its full
          height and scrollTop, the cards paint on top. The container is
          `pointer-events: none` so the uncovered scrollback below stays
          scrollable; each card re-enables pointer events for its own box.
          Each child still short-circuits to null when no bundle exists for
          the selected window's network.
          #270 — the peer-away banner is NOT here: unlike these ephemeral
          lookup cards it is persistent + DM-contextual, so it renders
          IN-FLOW at the top of `.scrollback` (below) rather than floating
          over the y=0 first row (which it overlapped in a fresh DM). */}
      <div class="scrollback-overlay" data-testid="scrollback-overlay">
        {/* C2 — WHOIS card. Mounts on every window kind; the card itself
            short-circuits to null when no bundle is present. */}
        <WhoisCard
          bundle={whoisCardBySlug()[props.networkSlug]}
          onDismiss={() => dismissWhoisCard(props.networkSlug)}
        />
        {/* P-0c — WHOWAS card. Mirrors WhoisCard mount shape (every window
            kind, not just $server). */}
        <WhowasCard networkSlug={props.networkSlug} />
        {/* P-0d / #231 — LUSERS card. Mounts on every window kind (mirror
            WhoisCard / WhowasCard); the card itself short-circuits to null
            when no bundle is present. Only one ScrollbackPane is mounted at
            a time, so this renders in the CURRENT window — issuing /lusers
            from any scrollback window surfaces the card there, not always
            $server. Snapshot replaces last-write-wins per network on every
            /lusers (manual or welcome-time auto-emit). */}
        <LusersCard networkSlug={props.networkSlug} />
        {/* #386 — the #376 inline BANLIST card was superseded by the
            interactive BanlistModal (opened by /banlist, mounted in Shell),
            mirroring how the #169 /who modal replaced the inline WHO dump. */}
      </div>
      {/* #693 — the far-behind bar. This pane holds the tail because the gap
          back to where the operator left off was bigger than one page;
          everything above the first loaded row is loadable but NOT loaded.
          PINNED rather than in-flow at that boundary (which is where it
          semantically belongs, the #270 PeerAwayBanner shape): with no
          divider to scroll to, the activation routine parks the pane at the
          BOTTOM, so an in-flow row sits viewports above the fold and the one
          signal that a region was abandoned is the one signal nobody sees.
          It rides in the same container-anchored layer as the #133 overlay,
          one z-index below it — an ephemeral WHOIS card the operator just
          opened may cover it; it is persistent and they are not.
          Two exits, both explicit: jump back into the region, or dismiss it
          and accept the tail as read (nothing else can advance the cursor
          while this is up — see `setCursorIfAdvances`). */}
      <Show when={farBehindByChannel()[key()]}>
        {(far) => (
          <div class="scrollback-far-behind" data-testid="far-behind-bar">
            <button
              type="button"
              class="scrollback-far-behind-jump"
              data-testid="far-behind-jump"
              onClick={() => {
                // Arm the EXISTING marker-activation latch (#168) before the
                // swap: clearing the far-behind flag re-injects the divider,
                // and the rows-change that lands the anchor region is exactly
                // the content change that latch scrolls to. Set synchronously
                // so it is armed when the awaited rows arrive — one more
                // trigger on the existing scroll writer, not a second scroll
                // authority. Stood back down if the fetch failed, so a dead
                // latch can't yank a later unrelated rows() change.
                setMarkerActivationPending(true);
                void jumpToUnread(props.networkSlug, props.channelName).then((jumped) => {
                  if (!jumped) setMarkerActivationPending(false);
                });
              }}
            >
              {far().missed} unread — jump back
            </button>
            <button
              type="button"
              class="scrollback-far-behind-dismiss"
              data-testid="far-behind-dismiss"
              aria-label="Dismiss — mark everything up to here as read"
              onClick={() => {
                // Re-latch the frozen divider to whatever was marked read.
                // Dismiss is an explicit "I've read to here" gesture — the
                // same class as the send-relatch — so it is one of the few
                // things allowed to move the freeze mid-session.
                const readTo = dismissFarBehind(props.networkSlug, props.channelName);
                if (readTo !== null) setMarkerCursorId(readTo);
              }}
            >
              ×
            </button>
          </div>
        )}
      </Show>
      <div
        ref={listRef}
        class="scrollback"
        classList={{ "scrollback-locked": scrollLocked() }}
        // #130 — hidden (pre-paint) while the activation scroll settles so
        // the wrong-scroll frame is never shown; visibility (not display)
        // keeps layout/scrollHeight readable for the deferred geometry read.
        style={{ visibility: activating() ? "hidden" : "visible" }}
        role="log"
        tabIndex={-1}
        onScroll={onScroll}
        onPointerDown={onPointerDown}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        data-testid="scrollback"
      >
        {/* #270 — peer-away banner as an IN-FLOW top row. Persistent +
            DM-contextual (unlike the ephemeral WHOIS / WHOWAS / LUSERS
            overlay cards above), so it reserves its own space at the top of
            the scroll list instead of floating over the y=0 first row.
            Reactive to peerAwayBySlug() only — deliberately NOT woven into
            rows() — so its appear (301) / dismiss (×) toggle never trips the
            #196/#230 tail-follow effect keyed on rows().length. In-flow like
            the P-0e synthetic rows (a row in the scroll flow, not a floating
            card); it scrolls WITH the buffer rather than pinning to the top —
            the accepted B trade (the away context matters most at DM start).
            Mounts only on DM windows; the banner short-circuits to null when no
            entry exists for (slug, peer) — the "peer" is the channelName for
            query windows. Rendered before the `rows()` block so it stays at
            the top even in an empty DM (the "no messages yet" fallback). */}
        <Show when={props.kind === "query"}>
          <PeerAwayBanner networkSlug={props.networkSlug} peer={props.channelName} />
        </Show>
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
              if (row.type === "topic-join") {
                // #237 — the on-JOIN inline topic line. An accent+bold
                // "Topic for <#chan>:" label (the status-line affordance) then
                // the FULL topic in readable foreground via the shared MircBody
                // renderer (mIRC formatting, like TopicBar + the on-change
                // `:topic` row); optional irssi-style setter/time suffix in
                // muted. The label sits OUTSIDE `.scrollback-body` so its accent
                // colour actually renders (`.scrollback-body` forces --fg).
                // Presentational (own data-testid, NOT scrollback-line) so it
                // stays out of the unread/cursor math and row counts.
                return (
                  <div
                    class="scrollback-topic-join"
                    data-testid="topic-join-line"
                    data-kind="topic-join"
                  >
                    <span class="scrollback-topic-join-label">Topic for {row.line.channel}:</span>{" "}
                    <span class="scrollback-body">
                      <MircBody body={row.line.text} emphasis />
                    </span>
                    <Show when={row.line.meta}>
                      <span class="scrollback-topic-join-meta"> — {row.line.meta}</span>
                    </Show>
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
      {/* #280 — floating action stack, bottom-right of the message
          container. On mobile the "jump to next active window" affordance
          (NextActiveButton variant="mobile") joins the scroll-to-bottom
          button as an evenly-spaced, same-size stacked pair ANCHORED to
          the pane — so both stay constant relative to the message
          container across keyboard toggles and never overlap (root-cause
          fix for the two-independent-anchors collision). ScrollbackPane
          owns it: the scroll authority + message-container owner
          (CLAUDE.md). next-active sits ABOVE scroll-to-bottom (moved up to
          clear it). Desktop keeps next-active in the sidebar (variant
          desktop); only the mobile variant stacks here. On non-scrollback
          windows (home / mentions / list) Shell mounts the mobile variant
          itself — mutually exclusive via `kindHasScrollback` — so exactly
          one mobile next-active ever mounts. scroll-to-bottom still shows
          only when NOT at the bottom (C7.4). */}
      <div class="scrollback-float-stack">
        <Show when={isMobile()}>
          <NextActiveButton variant="mobile" />
        </Show>
        <Show when={!atBottomNow()}>
          <button
            type="button"
            class="scroll-to-bottom-btn"
            data-testid="scroll-to-bottom"
            onClick={onScrollToBottomTap}
            aria-label={
              mentionBadgeCount() > 0
                ? `Jump to next mention (${mentionBadgeCount()} below)`
                : "Scroll to bottom"
            }
          >
            ↓
            {/* #360 — mention-count badge. Shown only when own-nick mentions
                sit below the fold; a tap then jumps to the nearest one instead
                of the tail. */}
            <Show when={mentionBadgeCount() > 0}>
              <span class="scroll-to-bottom-badge" data-testid="scroll-to-bottom-badge">
                {mentionBadgeCount()}
              </span>
            </Show>
          </button>
        </Show>
      </div>
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
