import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  on,
  Show,
} from "solid-js";
import InviteAckRows from "./InviteAckRows";
import LusersCard from "./LusersCard";
import { ownNickForNetwork, postJoin, type ScrollbackMessage } from "./lib/api";
import { token } from "./lib/auth";
import { channelKey } from "./lib/channelKey";
import { createdByChannel, topicByChannel } from "./lib/channelTopic";
import { keepKeyboardOnPointerDown } from "./lib/keepKeyboard";
import { linkify } from "./lib/linkify";
import { memberSigil } from "./lib/memberSigil";
import { membersByChannel } from "./lib/members";
import { matchesWatchlist, mentionsUser } from "./lib/mentionMatch";
import { MIRC_PALETTE_16, parseMircFormat, type Run } from "./lib/mircFormat";
import { networks, user } from "./lib/networks";
import { nickEquals } from "./lib/nickEquals";
import { isOperatorActionEcho } from "./lib/operatorActionEcho";
import { isOwnPresenceEvent } from "./lib/ownPresenceEvent";
import { canonicalQueryNick, openQueryWindowState } from "./lib/queryWindows";
import { getReadCursor } from "./lib/readCursor";
import { loadMore as loadMoreScrollback, scrollbackByChannel } from "./lib/scrollback";
import { setSelectedChannel } from "./lib/selection";
import type { WindowKind } from "./lib/windowKinds";
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
// JOIN-self banner (C3.2): when the own nick's JOIN event appears in the
// scrollback, render a banner at the top of the pane showing:
//   - "You joined #chan"
//   - Topic (from channelTopic store)
//   - Names list with PREFIX sigils (@op, +voice, plain)
//   - "N users, M ops" summary
//
// The banner shows once per session per channel. `shownBanners` is a
// module-level Set; once a channel key is added, the banner never
// re-renders for that channel for the lifetime of the page session.
// This mirrors the spec: "Subsequent visits to the same channel within
// the session don't re-render the banner."
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

// CP14 B2: trigger `loadMore` when the user scrolls within this many
// pixels of the top. 200px is a standard infinite-scroll threshold —
// fires before the user actually hits the top so the new rows can
// land while there's still scroll runway, avoiding the "land at the
// very top, brief stutter, then content shifts" UX. The verb itself
// (lib/scrollback.ts loadMore) gates the burst and end-of-history
// cases; this constant only controls when to *try*.
const LOAD_MORE_THRESHOLD_PX = 200;

// Module-level tracking of which channels have already shown the
// JOIN-self banner this session. Intentionally not persisted to server
// or localStorage — ephemeral, per page-load.
//
// Test seam: `resetShownBannersForTest()` lets unit tests wipe the Set
// between cases without vi.resetModules() gymnastics. Named clearly;
// never called in production code. Mirrors the `seedFromTest` pattern
// in members.ts.
const shownBanners = new Set<string>();

export function resetShownBannersForTest(): void {
  shownBanners.clear();
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
  senderSpan: (display: string, nick: string) => JSX.Element,
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
          *** Wallops from {senderSpan(sender, sender)}: <MircBody body={trailing} />
        </span>
      );
    case "GLOBOPS":
      return (
        <span class="scrollback-body">
          *** Globops from {senderSpan(sender, sender)}: <MircBody body={trailing} />
        </span>
      );
    case "KILL": {
      const target = params[0] ?? "?";
      return (
        <span class="scrollback-body">
          *** {senderSpan(sender, sender)} killed {target}
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
          *** {senderSpan(sender, sender)} changed host to {newUser}@{newHost}
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
            *** {senderSpan(sender, sender)} invited you to {invitedChannel}{" "}
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
          *** {senderSpan(sender, sender)} {verb} {params.join(" ")}
        </span>
      );
    }
    default:
      // Generic fallback: render verb + raw params so unknown verbs are
      // never invisible. New verbs get a dedicated arm by adding a case
      // above; the default keeps the principle of "no silent drops".
      return (
        <span class="scrollback-body">
          *** {senderSpan(sender, sender)} {verb} {params.join(" ")}
        </span>
      );
  }
};

const renderBody = (msg: ScrollbackMessage, handlers: NickHandlers): JSX.Element => {
  // C7.6: sender button for content kinds — left-click (→ query) or
  // right-click (→ UserContextMenu). Rendered as <button> to satisfy
  // biome a11y rules (noStaticElementInteractions / useKeyWithClickEvents).
  // Styled via .scrollback-sender.nick-clickable to appear inline.
  const senderSpan = (label: string, nick: string): JSX.Element => (
    <button
      type="button"
      class="scrollback-sender nick-clickable"
      onClick={() => handlers.onNickClick(nick)}
      onContextMenu={(e: MouseEvent) => handlers.onNickContextMenu(nick, e)}
    >
      {label}
    </button>
  );

  switch (msg.kind) {
    case "privmsg":
      return (
        <>
          {senderSpan(`<${msg.sender}>`, msg.sender)}{" "}
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
        return renderRawEvent(meta, msg, senderSpan, handlers);
      }
      return (
        <>
          {senderSpan(`-${msg.sender}-`, msg.sender)}{" "}
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
          <button
            type="button"
            class="scrollback-sender nick-clickable"
            onClick={() => handlers.onNickClick(msg.sender)}
            onContextMenu={(e: MouseEvent) => handlers.onNickContextMenu(msg.sender, e)}
          >
            {msg.sender}
          </button>{" "}
          <MircBody body={stripCtcpAction(msg.body)} />
        </span>
      );
    case "join":
      return (
        <span class="scrollback-body">
          * {msg.sender} has joined {msg.channel}
        </span>
      );
    case "part": {
      const reason = reasonOf(msg);
      return (
        <span class="scrollback-body">
          * {msg.sender} has left {msg.channel}
          {reason ? ` (${reason})` : ""}
        </span>
      );
    }
    case "quit": {
      const reason = reasonOf(msg);
      return (
        <span class="scrollback-body">
          * {msg.sender} has quit{reason ? ` (${reason})` : ""}
        </span>
      );
    }
    case "nick_change": {
      const newNick = typeof msg.meta.new_nick === "string" ? msg.meta.new_nick : "?";
      return (
        <span class="scrollback-body">
          * {msg.sender} is now known as {newNick}
        </span>
      );
    }
    case "mode": {
      const modes = typeof msg.meta.modes === "string" ? msg.meta.modes : "";
      const args = Array.isArray(msg.meta.args) ? ` ${msg.meta.args.join(" ")}` : "";
      return (
        <span class="scrollback-body">
          * {msg.sender} sets mode {modes}
          {args} on {msg.channel}
        </span>
      );
    }
    case "topic":
      return (
        <span class="scrollback-body">
          * {msg.sender} changed topic: {msg.body}
        </span>
      );
    case "kick": {
      const target = typeof msg.meta.target === "string" ? msg.meta.target : "?";
      const reason = reasonOf(msg);
      return (
        <span class="scrollback-body">
          * {msg.sender} kicked {target} from {msg.channel}
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
        return renderRawEvent(meta, msg, senderSpan, handlers);
      }
      // Defensive: a :server_event row with no raw_verb is a server
      // bug, but render the body so it isn't invisible.
      return (
        <span class="scrollback-body">
          *** {senderSpan(msg.sender, msg.sender)} {msg.body ?? ""}
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
    >
      <span class="scrollback-time">{formatTime(props.msg.server_time)}</span>{" "}
      {renderBody(props.msg, handlers)}
    </div>
  );
};

// `memberSigil` derives the rendered prefix for a member's modes; it
// lives in `lib/memberSigil.ts` so MembersPane reuses it (one source of
// truth for sigil derivation).

type BannerState = "hidden" | "visible";

// C7.1: row types for the mixed separator+message rendering list.
type SeparatorRow = { type: "separator"; label: string; id: string };
// C7.3: unread-marker row — distinct variant so JSX render branch is a
// clean discriminated union (no `kind` subfield conditionals inside SeparatorRow).
type UnreadMarkerRow = { type: "unread-marker"; count: number; id: string };
type MessageRow = { type: "message"; msg: ScrollbackMessage };
type Row = SeparatorRow | UnreadMarkerRow | MessageRow;

const ScrollbackPane: Component<Props> = (props) => {
  let listRef!: HTMLDivElement;
  let markerRef: HTMLDivElement | undefined;
  const [atBottom, setAtBottom] = createSignal(true);
  const [bannerState, setBannerState] = createSignal<BannerState>("hidden");
  // C7.3: track whether we've done the initial scroll-to-marker for this
  // window mount. Reset on channel switch (key change).
  const [markerScrolled, setMarkerScrolled] = createSignal(false);

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
    void postJoin(t, props.networkSlug, channel).then(() => {
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

  // JOIN-self detection: derive whether own nick has joined this channel
  // from the scrollback. The memo re-runs when messages change; once the
  // banner has been shown (key in shownBanners), it stays hidden.
  // Channel-window-only per spec #7 — query/server/list/mentions windows
  // have no JOIN concept; gate on kind first.
  const shouldShowBanner = createMemo((): boolean => {
    if (props.kind !== "channel") return false;
    const nick = userNick();
    if (!nick) return false;
    if (shownBanners.has(key())) return false;
    const msgs = messages();
    if (!msgs) return false;
    return msgs.some((m) => m.kind === "join" && nickEquals(m.sender, nick));
  });

  // When shouldShowBanner transitions true → visible, mark the banner
  // as shown so remounts of this component (channel re-select within
  // the session) don't re-render it. Also switch focus to this channel
  // (spec #7: /join-self switches focus automatically). This is a user
  // action — the user issued /join — so the C4.2 cluster-wide focus-
  // only-on-user-action rule is not violated; the rule guards against
  // incoming-traffic focus shifts, not user-initiated ones.
  createEffect(
    on(shouldShowBanner, (show) => {
      if (show && !shownBanners.has(key())) {
        shownBanners.add(key());
        setBannerState("visible");
        // C5.0: auto-focus-switch on own-nick JOIN.
        setSelectedChannel({
          networkSlug: props.networkSlug,
          channelName: props.channelName,
          kind: "channel",
        });
      }
    }),
  );

  // Reset banner display on channel switch (Solid's <Show> reuses the
  // ScrollbackPane component instance across selectedChannel changes; the
  // local `bannerState` signal would otherwise leak the previous channel's
  // "visible" latch into the new channel's first render). Tracks `key()`
  // so it re-runs only when (networkSlug, channelName) actually changes —
  // `defer: true` skips the initial mount run so the shouldShowBanner
  // effect's first-mount evaluation isn't pre-emptively cleared.
  // C7.3: also reset markerScrolled so the next channel's unread marker
  // gets its own scroll-to-marker behavior.
  //
  // Scroll-on-window-switch fix: the underlying `[data-testid="scrollback"]`
  // <div> is the SAME DOM node across selectedChannel changes (Solid's
  // <Show> in Shell.tsx is non-keyed), so its `scrollTop` survives the
  // switch. Without an explicit reset, opening an empty query window
  // (scrollTop=0) and then re-selecting a populated channel leaves the
  // channel pinned at scrollTop=0 — the length-effect below only fires
  // when `messages().length` changes, and a previously-loaded channel's
  // length is identical to the last time we viewed it.
  //
  // Spec on switch:
  //   * window has unread marker → scroll marker into view, centered
  //     (mirrors length-effect's marker branch — same UX whether the
  //     marker appears via initial fetch or via switch-back).
  //   * no marker → snap to tail; auto-follow takes over after the
  //     first append.
  // markerScrolled latch reset so the length-effect remains free to
  // re-fire for a future window where the marker shows up only after
  // a delayed REST page lands. atBottom set per branch so the floating
  // "scroll to bottom" button doesn't flash visible mid-switch.
  // Pre-fix bug: `markerRef` retained the (now-disposed) DOM pointer
  // from the prior window after a key change because Solid's ref-binding
  // lifecycle for <For>-rendered elements doesn't auto-null the variable
  // on unmount. The createEffect would take the marker branch on the
  // wrong window, call scrollIntoView on a stale node, and never fall
  // through to scrollTop = scrollHeight — viewport stuck at top.
  //
  // Fix shape: (1) null markerRef synchronously at key change; (2) defer
  // the scroll decision via queueMicrotask so Solid commits the new
  // window's rows first — at that point markerRef is reassigned by
  // <div ref={markerRef}> if the new window has a marker, OR remains
  // undefined and we scroll-to-bottom. (3) reset sessionStart so the
  // new window captures its own focus-session boundary for marker
  // injection (target-window UX rule).
  createEffect(
    on(
      key,
      () => {
        setBannerState("hidden");
        setMarkerScrolled(false);
        markerRef = undefined;
        // CP29 R-4: capture the boundary as the highest message id present
        // RIGHT NOW. `messages()` is the same store the rows memo reads;
        // an empty window leaves the boundary null and the latching
        // effect below picks it up the first time a row lands.
        const msgs = messages();
        const top = msgs && msgs.length > 0 ? (msgs[msgs.length - 1]?.id ?? null) : null;
        setSessionTopId(top);
        if (!listRef) return;
        queueMicrotask(() => {
          if (!listRef) return;
          if (markerRef) {
            markerRef.scrollIntoView?.({ block: "center" });
            setMarkerScrolled(true);
            const distance = listRef.scrollHeight - listRef.scrollTop - listRef.clientHeight;
            setAtBottom(distance <= SCROLL_BOTTOM_THRESHOLD_PX);
          } else {
            listRef.scrollTop = listRef.scrollHeight;
            setAtBottom(true);
          }
        });
      },
      { defer: true },
    ),
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
        if (!markerScrolled() && markerRef) {
          // scrollIntoView is not implemented in jsdom (test environment).
          // Optional-chain so tests don't throw; real browsers have it.
          markerRef.scrollIntoView?.({ block: "center" });
          setMarkerScrolled(true);
          // atBottom is false after scroll-to-marker (marker is not at tail).
          const distance = listRef.scrollHeight - listRef.scrollTop - listRef.clientHeight;
          setAtBottom(distance <= SCROLL_BOTTOM_THRESHOLD_PX);
          return;
        }
        if (atBottom()) {
          listRef.scrollTop = listRef.scrollHeight;
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
  };

  // C7.4: scroll-to-bottom click handler — forces scroll to tail and
  // resumes auto-follow by setting atBottom(true).
  const scrollToBottom = () => {
    if (!listRef) return;
    listRef.scrollTo({ top: listRef.scrollHeight, behavior: "smooth" });
    setAtBottom(true);
  };

  // JOIN-self banner render — pure, no scrollback persistence.
  const JoinBanner: Component = () => {
    const topic = () => topicByChannel()[key()] ?? null;
    const createdAt = () => createdByChannel()[key()] ?? null;
    const members = () => membersByChannel()[key()] ?? null;
    const opCount = () => members()?.filter((m) => m.modes.includes("@")).length ?? 0;
    const totalCount = () => members()?.length ?? 0;
    // Non-empty member list as a derived value for use in <Show> + <For>.
    // Avoids non-null assertions by returning `undefined` (falsy) when
    // the list is null or empty, letting <Show> gate cleanly.
    const nonEmptyMembers = () => {
      const list = members();
      return list !== null && list.length > 0 ? list : undefined;
    };

    // Format a server-emitted ISO 8601 timestamp into the operator's
    // locale-default human form. Returns null when the input fails to
    // parse so the <Show> gate can hide the row entirely (rather than
    // rendering "Invalid Date"). Server contract: `created_at` from
    // 329 RPL_CREATIONTIME, `set_at` from 333 RPL_TOPICWHOTIME — both
    // are wire-projected via `DateTime.to_iso8601/1` so the parse path
    // here only fails on a malformed payload (which `narrowChannelEvent`
    // already drops, but the defensive null keeps the UI honest).
    const formatTs = (iso: string | null): string | null => {
      if (iso === null) return null;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return null;
      return d.toLocaleString();
    };

    const createdLine = () => formatTs(createdAt());
    const topicSetLine = () => {
      const t = topic();
      if (t === null || t.set_by === null || t.set_at === null) return null;
      const when = formatTs(t.set_at);
      if (when === null) return null;
      return `Topic set by ${t.set_by} on ${when}`;
    };

    return (
      <div class="join-banner" data-testid="join-banner">
        <div class="join-banner-heading">You joined {props.channelName}</div>
        <Show when={createdLine()}>
          {(when) => (
            <div class="join-banner-created" data-testid="join-banner-created">
              Channel was created on {when()}
            </div>
          )}
        </Show>
        <Show when={topic()?.text}>
          {(text) => <div class="join-banner-topic">Topic: {text()}</div>}
        </Show>
        <Show when={topicSetLine()}>
          {(line) => (
            <div class="join-banner-topic-set" data-testid="join-banner-topic-set">
              {line()}
            </div>
          )}
        </Show>
        <Show
          when={nonEmptyMembers()}
          fallback={<div class="join-banner-members-loading">(loading members…)</div>}
        >
          {(memberList) => (
            <>
              <div class="join-banner-names">
                <For each={memberList()}>
                  {(m) => (
                    <span class="join-banner-nick">
                      {memberSigil(m.modes)}
                      {m.nick}
                    </span>
                  )}
                </For>
              </div>
              <div class="join-banner-summary">
                {totalCount()} users, {opCount()} op{opCount() !== 1 ? "s" : ""}
              </div>
            </>
          )}
        </Show>
      </div>
    );
  };

  return (
    <div class="scrollback-pane">
      <Show when={bannerState() === "visible"}>
        <JoinBanner />
      </Show>
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
      <div ref={listRef} class="scrollback" onScroll={onScroll} data-testid="scrollback">
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
                  <div ref={markerRef} class="scrollback-unread-marker" data-testid="unread-marker">
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
          onPointerDown={keepKeyboardOnPointerDown}
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
