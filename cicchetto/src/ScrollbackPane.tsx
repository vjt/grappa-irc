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
import { type TopicJoinLine, topicByChannel, topicJoinLine } from "./lib/channelTopic";
import { isDocumentVisible } from "./lib/documentVisibility";
import { type InviteAckEntry, inviteAckBySlug } from "./lib/inviteAck";
import { membersByChannel } from "./lib/members";
import { matchesWatchlist, mentionsUser } from "./lib/mentionMatch";
import { mentionsBelowViewport, type ScrollbackLineGeom } from "./lib/mentionScroll";
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
import {
  lastOwnSend,
  loadMore as loadMoreScrollback,
  loadNewer as loadNewerScrollback,
  refreshScrollback,
  scrollbackByChannel,
} from "./lib/scrollback";
import { scrollToBottomRequest } from "./lib/scrollToBottomCommand";
import { setCursorIfAdvances, setSelectedChannel } from "./lib/selection";
import { isMobile } from "./lib/theme";
import { formatTimestamp } from "./lib/timeFormat";
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
// SCROLL_BOTTOM_THRESHOLD_PX from the tail. Click → instant scroll to the
// tail + resume auto-follow (resets atBottom to true), AND (since #310) —
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

// #239 — debounce for the trailing-hidden cursor advance (Facet B). Coalesces
// join/part storms (netsplits on a large / presence-hidden channel) to a single
// forward cursor POST once arrivals quiesce. Same magnitude as the scroll-settle
// debounce; the badge is suppressed while focused so the operator never sees the
// delay, and the DOM settle paths stay eager.
const PRESENCE_CURSOR_SETTLE_MS = 500;

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

// #360 — per-row geometry read for the mention-aware scroll-to-bottom badge.
// Mirrors `lastFullyVisibleRowId`'s offsetTop-based walk (cheap, layout-cached
// — no getBoundingClientRect thrash) but tags each `.scrollback-line` with its
// `.scrollback-mention` state (own-nick match, `mentionsUser`) so the pure
// `mentionsBelowViewport` can decide which mentions sit below the fold. O(n)
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
  // #196 / #219-general — scrollTop snapshot captured when ANY covering
  // overlay opens, re-asserted across the overlay's open/close so a covered
  // pane never strands the reader (see the effect near the activation block
  // below). #196 introduced this for the media viewer; #219-general widens the
  // trigger from the media-viewer signal to the shared overlay refcount
  // (`overlayCount()`) — every covering modal/drawer already pushes into it,
  // so a single derived predicate ("a covering overlay is open") drives the
  // freeze instead of one flag per modal. Plain let — pure mutation, no Solid
  // reactivity; the reactive edge is the `overlayCount() > 0` memo in the
  // effect below.
  let overlayScrollSnapshot: number | null = null;
  // #219-general — the channel key the overlay snapshot was captured on. The
  // pane instance survives channel↔query switches (shared non-keyed Match), so
  // a covering modal that switches the window on close (nick-click in /names,
  // /who) must not restore the leaving channel's offset onto the arriving one.
  // Both the freeze gate and the restore require this === key(); a switched-to
  // window activates normally. `null` when no overlay snapshot is held.
  let overlaySnapshotKey: string | null = null;
  const [atBottom, setAtBottom] = createSignal(true);
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

  // #360 — mention-aware scroll-to-bottom badge. Holds the nearest-first ids
  // of own-nick mentions currently below the fold in THIS window; its length
  // is the badge count, its head (`[0]`) the next jump target. DERIVED from
  // live geometry + scroll position (neither is a Solid signal), so it is
  // recomputed at the same edges `atBottom` is: every onScroll (operator
  // scroll AND the settle scrolls that activation / message-arrival fire) and,
  // belt-and-suspenders, after each rows() recreation via rAF (a rows change
  // that lands without a scroll event still refreshes the badge). Scope is
  // MENTIONS only (`.scrollback-mention`); watchlist highlights are a separate
  // track kept split for a follow-up (#360).
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
  // #219-general — "is THIS pane frozen under a covering overlay?" A snapshot
  // is held (non-null) for the overlay's whole open→close-settle window, and
  // it belongs to the channel it was captured on. Both scroll authorities
  // (scrollToActivation + the length-effect) bail on this so no authority
  // moves a covered pane; the overlay-snapshot effect owns the single restore.
  // Key-scoped so a window switched-to WHILE an overlay is up (nick-click in
  // /names or /who opens a query + dismisses the modal) is not frozen — it
  // activates normally. Plain-`let` reads, no reactivity (called imperatively
  // from inside the authorities).
  const isOverlayFrozen = (): boolean =>
    overlayScrollSnapshot !== null && overlaySnapshotKey === key();
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
    //   * atBottom() true  → the operator was following live; re-pin to
    //     the tail (a shrinking viewport keeps the bottom visible) =
    //     resume family → TAIL, never the divider (#46), one-shot, no
    //     latch.
    //   * atBottom() false → PRESERVE their scrollTop: do nothing, the
    //     browser holds scrollTop across the clientHeight change (a
    //     shrink never clamps; content still overflows).
    // atBottom() flips false ONLY on a real operator scroll-UP
    // (onScroll, ~:2242), so it is an honest "parked above the tail"
    // signal HERE — unlike the leave-arm at ~:1593, whose caveat is a
    // key-change batch where a sibling activation effect races
    // setAtBottom(true); a resize is not a key change, so atBottom() is
    // trustworthy (the length-effect trusts it the same way).
    //
    // #245 — ALSO re-measure the gate on resize, UNCONDITIONALLY: it runs
    // BEFORE the atBottom() gate above, regardless of scroll position.
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
      if (atBottom()) scrollToActivation("tail-only", true);
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
    if (listRef && typeof ResizeObserver !== "undefined") {
      overflowObserver = new ResizeObserver(() => {
        measureOverflow();
        // #360 — a container box change (flex-chain propagation with no `resize`
        // event) also moves the fold; keep the mention badge in step here too.
        recomputeMentionsBelow();
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
        if (target === null) return;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            // Only restore onto the SAME window the snapshot was taken on —
            // a mid-overlay channel switch (nick-click in /names or /who)
            // owns its own activation; do not stamp the old offset onto it.
            if (listRef && snapKey === key() && listRef.scrollTop !== target) {
              listRef.scrollTop = target;
            }
            // Clear ONLY when no overlay is open NOW — not on the captured
            // `open` boolean. A rapid close→reopen (refcount 1→0→1 in one
            // frame batch — one modal closing as another opens) schedules
            // this close-run's rAF BEFORE the reopen-run's; keying the clear
            // on the stale `open=false` would null the snapshot the reopen
            // just re-armed, thawing the pane while an overlay is still up
            // (review PLAUSIBLE finding). `overlayCount() === 0` is the live
            // truth: clear only when the last overlay is genuinely gone.
            if (overlayCount() === 0) {
              overlayScrollSnapshot = null;
              overlaySnapshotKey = null;
            }
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
        // #219 / #219-general / #196(reopen) — a covering overlay freezes the
        // pane's scroll (see the overlay-snapshot capture/restore + the
        // scrollToActivation guard). A message arriving WHILE an overlay is up
        // must not tail-follow the covered pane out from under the reader (#168
        // message-follow is correct ONLY when no overlay covers the pane).
        //
        // #196 reopen: bailing outright is NOT enough. This rows() change is the
        // very message arrival that triggered the effect; the ref-keyed <For>
        // has just RECREATED the list DOM, resetting scrollTop to 0. Bailing
        // leaves the covered pane stranded at the top for the overlay's whole
        // lifetime, and the single close-edge restore then lands wrong when the
        // scrollTop=0 artifact spuriously prepended older rows (onScroll gate
        // below now blocks that) — "re-reading old messages as if new", the
        // reopened desktop regression the quiet-channel e2e never saw. RE-ASSERT
        // the held snapshot instead (rAF×2, matching the overlay-snapshot
        // restore's frame budget so it lands after the <For> commit), so the
        // reader's position survives EVERY rows recreation while frozen, not
        // just the close edge. Re-check `isOverlayFrozen()` inside the rAF — the
        // overlay may have closed in the interim, in which case the close-edge
        // restore owns it.
        if (isOverlayFrozen()) {
          // This createEffect runs AFTER the ref-keyed <For> has reconciled, so
          // scrollTop has ALREADY been reset to 0 by the DOM recreation. Re-assert
          // the held snapshot SYNCHRONOUSLY (no transient-0 frame for a reader to
          // catch) — the snapshot is an absolute offset, so no post-layout
          // scrollHeight read is needed — then AGAIN across rAF×2 as belt-and-
          // braces for any late layout shift (matching the overlay-snapshot
          // restore's frame budget). Re-check `isOverlayFrozen()` in the rAF: the
          // overlay may have closed, in which case the close restore owns it.
          const snapNow = overlayScrollSnapshot;
          if (snapNow !== null && listRef.scrollTop !== snapNow) {
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
  // content. We capture (scrollHeight, scrollTop) BEFORE the await, then after
  // merge restore as `newScrollHeight - oldScrollHeight + oldScrollTop` so the
  // rows the user was looking at remain in the same on-screen position. DOM
  // mutation lives here in the component; lib/scrollback.ts stays DOM-free.
  const maybeLoadOlder = (): void => {
    if (!listRef) return;
    if (listRef.scrollTop > LOAD_MORE_THRESHOLD_PX) return;
    // See the length-effect for how an active marker activation is kept from
    // yanking this (it re-asserts ONLY when a marker exists; a no-marker latch
    // falls through to the atBottom-follow, which preserves here because the
    // operator scrolled UP).
    const oldScrollHeight = listRef.scrollHeight;
    const oldScrollTop = listRef.scrollTop;
    void loadMoreScrollback(props.networkSlug, props.channelName).then(() => {
      if (!listRef) return;
      const newScrollHeight = listRef.scrollHeight;
      if (newScrollHeight === oldScrollHeight) return;
      listRef.scrollTop = newScrollHeight - oldScrollHeight + oldScrollTop;
    });
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
    // reader cannot scroll it. Acting on these artifacts flips `atBottom`,
    // spuriously fires loadMore/loadNewer (whose prepend would STALE the
    // absolute-pixel freeze snapshot → wrong close-edge restore), snapshots a
    // bogus visible-tail, and advances the read cursor. Skip all of it; the
    // length-effect re-assert + the overlay-snapshot close restore own the
    // reader's position for the overlay's whole lifetime.
    if (isOverlayFrozen()) return;
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

  // #310 — the scroll-to-bottom GESTURE, shared by the floating button's
  // onClick AND the #243 re-tap command below. Reaching the bottom via an
  // explicit operator gesture means they have read to the newest line, so —
  // exactly like a manual scroll to the bottom — it does two things the pure
  // `scrollToBottom()` helper (kept for the send-relatch, which owns its own
  // marker + cursor bookkeeping) deliberately does NOT:
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
  // The newest id is read AFTER the instant scroll: `scrollToBottom()` pins
  // the tail synchronously, so `lastFullyVisibleRowId`'s at-bottom
  // short-circuit returns the true DOM tail — never a stale pre-scroll id the
  // #233 monotonic clamp would drop as non-advancing (candidate b). No second
  // cursor authority, no window-state mutation. The frozen divider is left in
  // place, same as a manual scroll — it re-latches only on the next focus
  // acquisition or own send (freeze contract).
  const scrollToBottomGesture = () => {
    scrollToBottom();
    setMarkerActivationPending(false);
    if (!listRef) return;
    const id = lastFullyVisibleRowId(listRef);
    if (id !== null) {
      setCursorIfAdvances(props.networkSlug, props.channelName, id);
    }
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
    const below = mentionsBelowViewport(readMentionGeom(listRef), viewportBottom);
    const targetId = below[0];
    if (targetId === undefined) {
      scrollToBottomGesture();
      return;
    }
    const target = listRef.querySelector<HTMLElement>(
      `.scrollback-line[data-msg-id="${targetId}"]`,
    );
    if (target === null) {
      // The measured mention vanished between recompute and tap (a rows
      // recreation dropped it) — degrade to the plain gesture, never no-op.
      scrollToBottomGesture();
      return;
    }
    setMarkerActivationPending(false);
    target.scrollIntoView({ behavior: "smooth", block: "center" });
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
  createEffect(
    on(
      key,
      () => {
        if (listRef) listRef.scrollTo({ top: listRef.scrollTop });
      },
      { defer: true },
    ),
  );

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
        <WhoisCard networkSlug={props.networkSlug} />
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
      </div>
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
                      <MircBody body={row.line.text} />
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
        <Show when={!atBottom()}>
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
