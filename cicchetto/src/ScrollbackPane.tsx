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
import InviteAckRows from "./InviteAckRows";
import LusersCard from "./LusersCard";
import { ownNickForNetwork, postJoin, type ScrollbackMessage } from "./lib/api";
import { token } from "./lib/auth";
import { channelKey, decodeChannelKey } from "./lib/channelKey";
import { isDocumentVisible } from "./lib/documentVisibility";
import { linkify } from "./lib/linkify";
import { membersByChannel } from "./lib/members";
import { matchesWatchlist, mentionsUser } from "./lib/mentionMatch";
import { MIRC_PALETTE_16, parseMircFormat, type Run } from "./lib/mircFormat";
import { networks, user } from "./lib/networks";
import { senderPrefix } from "./lib/nickColor";
import { nickEquals } from "./lib/nickEquals";
import { isOperatorActionEcho } from "./lib/operatorActionEcho";
import { isOwnPresenceEvent } from "./lib/ownPresenceEvent";
import { canonicalQueryNick, openQueryWindowState } from "./lib/queryWindows";
import { getReadCursor } from "./lib/readCursor";
import { loadMore as loadMoreScrollback, scrollbackByChannel } from "./lib/scrollback";
import { setCursorIfAdvances, setSelectedChannel } from "./lib/selection";
import type { WindowKind } from "./lib/windowKinds";
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
// cursor (via getReadCursor from readCursor.ts), messages after the cursor
// are "unread". The rows() memo injects an `── XX unread messages ──`
// marker row between the last read message and the first unread message.
// On first mount of an unread window, the pane scrolls to the marker
// (block: "start") so the user sees context-then-unread without manual
// scroll. Cursor is advanced to the latest message's server_time when the
// user reaches the bottom (atBottom = true). Client-side only — no server
// MARKREAD per CLAUDE.md invariant.
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
// (pointerdown / touchmove / qualifying keydown) fired within this
// many ms before the scroll. 1500ms covers user-wheel → 500ms
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

const formatTime = (epochMs: number): string => {
  const d = new Date(epochMs);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
};

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

// UX-8 (b): scroll-settle visible-row math. Walks `.scrollback-line`
// children of the listRef container, returns the highest `data-msg-id`
// whose bottom edge is at-or-above the viewport bottom — i.e. the
// last fully-visible message. Returns null when no row qualifies
// (empty scrollback, or scrollTop above the first row's bottom).
//
// O(n) where n = rows in scrollback. Called from the 500ms-debounced
// scroll-settle path so the cost is bounded; for a 200-row #bofh
// scrollback this is sub-millisecond.
const lastFullyVisibleRowId = (listRef: HTMLDivElement): number | null => {
  const viewportBottom = listRef.scrollTop + listRef.clientHeight;
  let candidate: number | null = null;
  for (const row of listRef.querySelectorAll<HTMLElement>(".scrollback-line")) {
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

// CP13 S10: render an IRC body string with mIRC formatting expanded into
// per-run <span> elements. Plain text (no control chars) collapses into a
// single Run and renders as one <span>; the no-formatting fast path is
// the common case so this stays cheap. Each Run gets a class for each
// active toggle attribute + inline style for fg/bg colors (the palette is
// 16 fixed values — we don't generate per-color CSS classes).
const renderRun = (run: Run): JSX.Element => {
  const style: Record<string, string> = {};
  // Reverse swaps fg/bg. mIRC reverses the rendered colors AND falls back
  // to the terminal default when fg/bg aren't set, but in a web context
  // we don't have a "terminal default" — fall back to plain text colors
  // and let the .scrollback-mirc-reverse class style the swap (CSS owns
  // the visual). Inline style still applies the explicit fg/bg if set.
  if (run.fg !== undefined) {
    style[run.reverse ? "background-color" : "color"] = MIRC_PALETTE_16[run.fg] ?? "";
  }
  if (run.bg !== undefined) {
    style[run.reverse ? "color" : "background-color"] = MIRC_PALETTE_16[run.bg] ?? "";
  }
  // No-silent-drops bucket 4 (2026-05-14): linkify the run text so URLs
  // render as <a href target="_blank" rel="noopener noreferrer">. Done
  // INSIDE the formatting <span> so URL links inherit the run's bold /
  // color / etc. attributes (mIRC formatting + linkification compose
  // cleanly). Plain-text runs go through linkify too -- the cost is
  // one regex scan per run; if no URL matches the result is a single
  // text segment which renders identically to the pre-linkify path.
  const segments = linkify(run.text);
  return (
    <span
      classList={{
        "scrollback-mirc-bold": run.bold,
        "scrollback-mirc-italic": run.italic,
        "scrollback-mirc-underline": run.underline,
        "scrollback-mirc-reverse": run.reverse && run.fg === undefined && run.bg === undefined,
      }}
      style={style}
    >
      <For each={segments}>
        {(seg) =>
          seg.type === "url" ? (
            <a href={seg.href} target="_blank" rel="noopener noreferrer" class="scrollback-link">
              {seg.value}
            </a>
          ) : (
            seg.value
          )
        }
      </For>
    </span>
  );
};

const MircBody: Component<{ body: string }> = (props) => {
  const runs = (): Run[] => parseMircFormat(props.body);
  return <For each={runs()}>{renderRun}</For>;
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
          {trailing && trailing !== target ? ` (${trailing})` : ""}
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
          *** {senderSpan(sender)} {verb} {params.join(" ")}
        </span>
      );
    }
    default:
      // Generic fallback: render verb + raw params so unknown verbs are
      // never invisible. New verbs get a dedicated arm by adding a case
      // above; the default keeps the principle of "no silent drops".
      return (
        <span class="scrollback-body">
          *** {senderSpan(sender)} {verb} {params.join(" ")}
        </span>
      );
  }
};

const renderBody = (msg: ScrollbackMessage, handlers: NickHandlers): JSX.Element => {
  // UX-5 bucket BC2: per-message sender prefix glyph (@/%/+) derived
  // from the LIVE members store keyed by (channel, sender). Scrollback
  // rows are mode-agnostic on the wire — the prefix is a render-time
  // join against `membersByChannel()` so re-renders track MODE events.
  // Returns "" (not " ") for plain / unknown senders — see
  // `senderPrefix` docstring in `lib/nickColor.ts`.
  const prefixFor = (nick: string): "@" | "%" | "+" | "" => {
    if (!msg.channel) return "";
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
          * {bareSenderSpan(msg.sender)} has joined {msg.channel}
        </span>
      );
    case "part": {
      const reason = reasonOf(msg);
      return (
        <span class="scrollback-body">
          * {bareSenderSpan(msg.sender)} has left {msg.channel}
          {reason ? ` (${reason})` : ""}
        </span>
      );
    }
    case "quit": {
      const reason = reasonOf(msg);
      return (
        <span class="scrollback-body">
          * {bareSenderSpan(msg.sender)} has quit{reason ? ` (${reason})` : ""}
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
          * {bareSenderSpan(msg.sender)} changed topic: {msg.body}
        </span>
      );
    case "kick": {
      const target = typeof msg.meta.target === "string" ? msg.meta.target : "?";
      const reason = reasonOf(msg);
      return (
        <span class="scrollback-body">
          * {bareSenderSpan(msg.sender)} kicked{" "}
          <NickText nick={target} prefix={prefixFor(target)} /> from {msg.channel}
          {reason ? ` (${reason})` : ""}
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
          *** {bareSenderSpan(msg.sender)} {msg.body ?? ""}
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
type Row = SeparatorRow | UnreadMarkerRow | MessageRow;

const ScrollbackPane: Component<Props> = (props) => {
  let listRef!: HTMLDivElement;
  // UX-8 (b): scroll-settle debounce timer. Plain let — pure mutation,
  // no Solid reactivity. Cleared on the next scroll event; fires once
  // when scroll has been quiescent for SCROLL_SETTLE_DEBOUNCE_MS.
  // onCleanup at component teardown clears any in-flight timer so a
  // channel switch doesn't fire a stale settle for the previous
  // window.
  let scrollSettleTimer: number | undefined;
  // REV-G H23 (2026-05-22): function-ref signal instead of let-bound
  // ref. Combined with an explicit `onCleanup` wired at the marker
  // JSX site (`{ ref={(el) => { setMarkerRef(el); onCleanup(...) }} }`),
  // the signal flips back to undefined when the marker row unmounts —
  // either on channel switch OR on mid-channel removal (cursor advance
  // while staying on the same channel). Pre-REV-G the let-bound ref
  // leaked across <For> diffs; the channel-switch case was compensated
  // by an explicit reset, mid-channel removal was not — every read
  // after a cursor-advance saw a stale detached DOM node. Per
  // `feedback_solidjs_for_ref_leak`.
  //
  // SolidJS gotcha: unlike React, Solid function-refs are called
  // ONCE on mount; they do NOT auto-null on unmount. `onCleanup` is
  // the explicit hook for that lifecycle. The two together (ref-set +
  // onCleanup-null) give the React-equivalent behavior.
  const [markerRef, setMarkerRef] = createSignal<HTMLDivElement | undefined>();
  const [atBottom, setAtBottom] = createSignal(true);
  // UX-3 Z3 R4: actual-overflow gate for the `pan-y → chrome reveal`
  // trap. Recomputed on every layout-affecting signal (messages,
  // window resize, visualViewport resize → keyboard open/close).
  // True when scrollback content actually exceeds the viewport.
  const [isOverflowing, setIsOverflowing] = createSignal(false);
  // C7.3: track whether we've done the initial scroll-to-marker for this
  // window mount. Reset on channel switch (key change).
  const [markerScrolled, setMarkerScrolled] = createSignal(false);

  // BUGHUNT-2: timestamp of the most recent real operator input event
  // (pointerdown / touchmove / qualifying keydown) on the listRef.
  // `null` until the operator interacts; reset to `null` on `on(key)`
  // transitions so the new pane starts with a fresh gate (programmatic
  // scrollIntoView during the activation routine must NOT inherit the
  // leaving pane's input timestamp).
  const [lastInputEventAtMs, setLastInputEventAtMs] = createSignal<number | null>(null);

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
  //   cursor = getReadCursor(networkSlug, channelName) — server-owned id.
  //   sessionTopId = max(message.id) captured at window mount (key change).
  //   unread count = messages.filter(m =>
  //                    m.id > cursor AND
  //                    m.id <= sessionTopId  // pre-arrival only
  //                  ).length
  //   The cursor is a stable value for the lifetime of this channel view;
  //   it only advances when the user navigates AWAY from the window
  //   (selection.ts on(selectedChannel)'s focus-leave hook). The
  //   sessionTopId bound prevents NEW arrivals during the focus session
  //   from spawning a fresh marker — they're live-read by definition.
  const rows = createMemo((): Row[] => {
    const msgs = messages();
    if (!msgs || msgs.length === 0) return [];
    const cursor = getReadCursor(props.networkSlug, props.channelName);
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
    const onResize = () => scrollToActivation();
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

  // Channel-switch reset (Solid's <Show> reuses the ScrollbackPane
  // component instance across selectedChannel changes; per-channel
  // local state would otherwise leak across).
  // C7.3: reset markerScrolled so the next channel's unread marker
  // gets its own scroll-to-marker behavior.
  //
  // UX-4 bucket K (2026-05-19) — canonical window-activation scroll.
  //
  // Two activation triggers converge on ONE routine
  // (`scrollToActivation`):
  //   1. `selectedChannel` change — operator switched windows (the
  //      effect below tracks `key()`).
  //   2. `document.visibilitychange` → visible — PWA backgrounded then
  //      re-opened (the second effect below tracks `isDocumentVisible`
  //      transitions false→true).
  //
  // Single source of truth: any future activation trigger plugs into
  // `scrollToActivation` and inherits the marker-or-bottom routine
  // for free. No ad-hoc scrollTop preserve/restore lives anywhere
  // else in this component for the activation path — `onScroll`'s
  // `loadMore` block has its own preservation but that's pagination-
  // prepend bookkeeping, semantically distinct (operator IS scrolling
  // up, we keep their reading position stable while older rows
  // PREPEND from REST).
  //
  // Decision body: marker present → scrollIntoView({block: "center"})
  // + latch markerScrolled; no marker → scrollTop = scrollHeight
  // + atBottom = true. queueMicrotask defers the DOM read+write until
  // Solid commits the row diffs (per the markerRef-staleness fix
  // below). atBottom is set per branch so the floating "scroll to
  // bottom" button doesn't flash visible mid-activation.
  const scrollToActivation = (): void => {
    if (!listRef) return;
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
    // UX-8(a3): for the bottom-snap branch, `lastElementChild?.scrollIntoView`
    // is more reliable than `scrollTop = scrollHeight` math — the browser
    // walks the element's box and scrolls its container natively, which
    // is layout-aware even when scrollHeight bookkeeping is mid-update
    // (channel-back path: query → #bofh cached, scrollback store reload
    // races key-effect even after rAF×2). Fallback scrollHeight write is
    // preserved if scrollback is empty (no element to scroll into view).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!listRef) return;
        const msgs = messages();
        if (!msgs || msgs.length === 0) return;
        const marker = markerRef();
        if (marker) {
          marker.scrollIntoView?.({ block: "center" });
          setMarkerScrolled(true);
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
      });
    });
  };

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
  //   * markerScrolled — latch reset so the new channel's marker
  //     gets its own scroll-to-marker (re-fires for a future window
  //     where the marker shows up only after a delayed REST page).
  //   * sessionTopId — capture the focus-session boundary (highest
  //     id present right now) so future arrivals during this session
  //     are "live-read" and never spawn a fresh marker.
  //
  // REV-G H23 (2026-05-22): the previous `markerRef = undefined` reset
  // here is removed — the function-ref signal nulls itself on unmount,
  // so the channel-switch case no longer needs explicit compensation.
  // The mid-channel-removal case (cursor advance) ALSO benefits — it
  // had no compensation pre-REV-G and silently held a stale DOM
  // pointer.
  //
  // `defer: true` skips the initial mount run so the auto-focus
  // effect's first-mount evaluation isn't pre-emptively cleared.
  createEffect(
    on(
      key,
      (newKey, prevKey) => {
        // BUGHUNT-2: leave-arm cursor write. When key transitions
        // away from a window, listRef.scrollTop STILL reflects the
        // leaving pane's geometry (Solid's <Show> in Shell.tsx is
        // non-keyed for channel↔channel switches, so the DOM node +
        // component instance survive; scrollToActivation runs INSIDE
        // double-rAF, which happens AFTER this effect body returns).
        // Read lastFullyVisibleRowId NOW for the OLD key, decode
        // prevKey back to (slug, channel), POST via
        // setCursorIfAdvances.
        //
        // Skip on initial mount (prevKey undefined) and on identical-
        // key re-fires (prevKey === newKey — defensive; shouldn't
        // happen with `defer: true` + Solid's signal equality).
        // Skip if listRef hasn't initialized yet or if visible-tail
        // is null (empty pane, nothing to mark).
        //
        // Channel→home/mentions switches DON'T fire this — they
        // unmount the component entirely. onCleanup covers that
        // case (added in A5).
        if (prevKey !== undefined && prevKey !== newKey && listRef) {
          const id = lastFullyVisibleRowId(listRef);
          if (id !== null) {
            const decoded = decodeChannelKey(prevKey);
            if (decoded !== null) {
              setCursorIfAdvances(decoded.slug, decoded.name, id);
            }
          }
        }

        // BUGHUNT-2: reset input-gate so the new pane starts fresh.
        // Programmatic activation `scrollIntoView` in scrollToActivation
        // must not inherit the leaving pane's timestamp.
        setLastInputEventAtMs(null);

        setMarkerScrolled(false);
        // CP29 R-4: capture the boundary as the highest message id present
        // RIGHT NOW. `messages()` is the same store the rows memo reads;
        // an empty window leaves the boundary null and the latching
        // effect below picks it up the first time a row lands.
        const msgs = messages();
        const top = msgs && msgs.length > 0 ? (msgs[msgs.length - 1]?.id ?? null) : null;
        setSessionTopId(top);
        scrollToActivation();
      },
      { defer: true },
    ),
  );

  // Activation trigger 2 — `isDocumentVisible` false→true transition.
  // PWA backgrounded (visibility-hide, browser-tab-switch, OS app
  // switch) then re-opened. selection.ts owns the cursor settle on
  // false→true (clearBadgesForWindow); this effect owns the scroll
  // settle. NO per-channel pre-work — visibility-return on the SAME
  // selectedChannel must preserve markerScrolled / sessionTopId (the
  // operator hasn't left the window; only the browser tab lost
  // visibility). The function-ref signal owns markerRef lifecycle
  // (REV-G H23).
  //
  // `prev === undefined` guards the initial-mount run (signal owns
  // the prev sentinel pattern; mirrors selection.ts's identical guard
  // shape at on(isDocumentVisible)). false→true is the only edge that
  // triggers; true→false is owned by selection.ts.
  createEffect(
    on(isDocumentVisible, (visible, prev) => {
      if (prev === undefined) return;
      if (prev === false && visible === true) {
        scrollToActivation();
      }
    }),
  );

  // BUGHUNT-2: browser-blur cursor write. Fires on
  // `prev === true && visible === false` (tab → hidden, app switch on
  // mobile, OS lock). Reads lastFullyVisibleRowId for the CURRENT pane
  // and POSTs via setCursorIfAdvances. Mirror of the leave-arm in
  // A3's key-effect, but for the no-key-change case.
  //
  // No false→true arm — focus-regain does NOT advance cursor;
  // marker stays where it is.
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

  // After Solid commits new DOM nodes, scroll to the tail iff the user
  // was at the bottom before the update. The effect tracks
  // `messages().length` so it re-runs on every append, not on signal
  // identity (the whole record changes every WS event by design).
  //
  // C7.3: On the FIRST render of a channel with unread messages, scroll to
  // the unread-marker (centered in the viewport so the user sees both
  // context above and unread messages below at a glance — same UX as
  // the on-switch effect's marker branch above). `markerScrolled` latches
  // after the first scroll so subsequent appends follow the normal
  // auto-scroll logic (tail-follow when atBottom, preserve position
  // otherwise).
  createEffect(
    on(
      () => messages()?.length ?? 0,
      () => {
        if (!listRef) return;
        // C7.3: first mount with unread — scroll to marker, not tail.
        const marker = markerRef();
        if (!markerScrolled() && marker) {
          // scrollIntoView is not implemented in jsdom (test environment).
          // Optional-chain so tests don't throw; real browsers have it.
          marker.scrollIntoView?.({ block: "center" });
          setMarkerScrolled(true);
          // atBottom is false after scroll-to-marker (marker is not at tail).
          const distance = listRef.scrollHeight - listRef.scrollTop - listRef.clientHeight;
          setAtBottom(distance <= SCROLL_BOTTOM_THRESHOLD_PX);
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
  // Why three handlers (not just pointerdown):
  //   * `pointerdown` covers wheel-with-mouse-over-element, drag-of-
  //     scrollbar, and the start of touch interactions on iOS Safari
  //     (PointerEvent unified since iOS 13).
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
    const distance = listRef.scrollHeight - listRef.scrollTop - listRef.clientHeight;
    setAtBottom(distance <= SCROLL_BOTTOM_THRESHOLD_PX);

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
      const oldScrollHeight = listRef.scrollHeight;
      const oldScrollTop = listRef.scrollTop;
      void loadMoreScrollback(props.networkSlug, props.channelName).then(() => {
        if (!listRef) return;
        const newScrollHeight = listRef.scrollHeight;
        if (newScrollHeight === oldScrollHeight) return;
        listRef.scrollTop = newScrollHeight - oldScrollHeight + oldScrollTop;
      });
    }

    // BUGHUNT-2: scroll-settle gated on recent operator input.
    // Programmatic scrolls fired by `scrollToActivation` (window
    // activation routine) emit DOM `scroll` events but no preceding
    // `pointerdown` / `touchmove` / `keydown` — `lastInputEventAtMs`
    // stays null or stale, the gate skips arming the settle timer,
    // cursor is not advanced. Real operator scrolls (wheel / touch /
    // PageDown) set `lastInputEventAtMs` first → onScroll arms →
    // 500ms later POSTs the visible-tail id.
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
  const scrollToBottom = () => {
    if (!listRef) return;
    listRef.scrollTo({ top: listRef.scrollHeight, behavior: "smooth" });
    setAtBottom(true);
  };

  return (
    <div class="scrollback-pane">
      {/* C2 — WHOIS card renders inline above the scrollback when a
          bundle exists for the selected window's network. The card
          itself short-circuits to null when no bundle is present, but
          we gate the mount on networkSlug being a string to avoid
          subscribing the signal from non-channel renders. */}
      <WhoisCard networkSlug={props.networkSlug} />
      {/* P-0c — WHOWAS card. Inline above the active window scrollback,
          mirrors WhoisCard mount shape (every window kind, not just
          $server). The card itself short-circuits to null when no
          bundle exists for the selected window's network. */}
      <WhowasCard networkSlug={props.networkSlug} />
      {/* P-0b — peer-away banner. Mount only on DM windows; the
          banner short-circuits to null when no entry exists for
          (slug, peer). The "peer" is the channelName itself for
          query windows. */}
      <Show when={props.kind === "query"}>
        <PeerAwayBanner networkSlug={props.networkSlug} peer={props.channelName} />
      </Show>
      {/* P-0d — LUSERS card. Mount only on the $server window for the
          network. Card short-circuits to null when no snapshot exists.
          Snapshot replaces last-write-wins on every /lusers (manual or
          welcome-time auto-emit). */}
      <Show when={props.kind === "server"}>
        <LusersCard networkSlug={props.networkSlug} />
      </Show>
      <div
        ref={listRef}
        class="scrollback"
        classList={{ "scrollback-overflowing": isOverflowing() }}
        role="log"
        tabIndex={-1}
        onScroll={onScroll}
        onPointerDown={onPointerDown}
        onTouchMove={onTouchMove}
        onKeyDown={onKeyDown}
        data-testid="scrollback"
      >
        <Show
          when={(messages()?.length ?? 0) > 0}
          fallback={<p class="muted scrollback-empty">no messages yet</p>}
        >
          {/* C7.1 + C7.3: render mixed rows (separator | unread-marker | message). */}
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
                return (
                  <div
                    ref={(el) => {
                      // REV-G H23: SolidJS function-refs are called
                      // ONCE on mount; for `<For>`-rendered elements
                      // they are NOT auto-called with `undefined` on
                      // unmount the way React refs are. Wire an
                      // explicit `onCleanup` here so the stale-ref
                      // bug doesn't re-emerge — when the marker row
                      // is removed (cursor advance mid-channel OR
                      // channel switch), the signal flips back to
                      // undefined and downstream readers
                      // (`scrollToActivation` + the length-effect)
                      // take the marker-absent branch.
                      setMarkerRef(el);
                      onCleanup(() => setMarkerRef(undefined));
                    }}
                    class="scrollback-unread-marker"
                    data-testid="unread-marker"
                  >
                    <span class="scrollback-unread-marker-line" />
                    <span class="scrollback-unread-marker-label">
                      {row.count} unread message{row.count !== 1 ? "s" : ""}
                    </span>
                    <span class="scrollback-unread-marker-line" />
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
        {/* P-0e + P-0f — invite-ack ephemeral synthetic rows. Mount on
            $server window only (P-0f flipped from per-channel; operators
            usually invite peers to channels they are NOT in, so the
            channel-scoped routing silent-dropped in the common case).
            Aggregates across all target channels for this network. */}
        <Show when={props.kind === "server"}>
          <InviteAckRows networkSlug={props.networkSlug} />
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
