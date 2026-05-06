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
import { displayNick, type ScrollbackMessage } from "./lib/api";
import { channelKey } from "./lib/channelKey";
import { topicByChannel } from "./lib/channelTopic";
import { membersByChannel } from "./lib/members";
import { matchesWatchlist, mentionsUser } from "./lib/mentionMatch";
import { networks, user } from "./lib/networks";
import { numericsByWindow } from "./lib/numericInline";
import { openQueryWindowState } from "./lib/queryWindows";
import { getReadCursor, setReadCursor } from "./lib/readCursor";
import { scrollbackByChannel } from "./lib/scrollback";
import { setSelectedChannel } from "./lib/selection";
import type { WindowKind } from "./lib/windowKinds";
import UserContextMenu from "./UserContextMenu";

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

type NickHandlers = {
  onNickClick: (nick: string) => void;
  onNickContextMenu: (nick: string, e: MouseEvent) => void;
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
          <span class="scrollback-body">{msg.body}</span>
        </>
      );
    case "notice":
      return (
        <>
          {senderSpan(`-${msg.sender}-`, msg.sender)}{" "}
          <span class="scrollback-body">{msg.body}</span>
        </>
      );
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
          {msg.body}
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
]);

const ScrollbackLine: Component<{
  msg: ScrollbackMessage;
  userNick: string | null;
  onNickClick: (nick: string) => void;
  onNickContextMenu: (nick: string, e: MouseEvent) => void;
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
  };

  return (
    <div
      class="scrollback-line"
      classList={{
        "scrollback-action": props.msg.kind === "action",
        "scrollback-notice": props.msg.kind === "notice",
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

// Returns the PREFIX sigil for a member: "@" for op, "+" for voiced, "" for plain.
// Mirrors the MembersPane rendering convention and the IRC RFC PREFIX ISUPPORT.
const memberSigil = (modes: string[]): string => {
  if (modes.includes("@")) return "@";
  if (modes.includes("+")) return "+";
  return "";
};

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

  // C7.6: context menu state — null when closed.
  type ContextMenuState = { targetNick: string; x: number; y: number };
  const [contextMenu, setContextMenu] = createSignal<ContextMenuState | null>(null);

  const key = () => channelKey(props.networkSlug, props.channelName);
  const messages = () => scrollbackByChannel()[key()];
  // BUG1-fix carry-forward: `user.name` is the operator account name,
  // which can diverge from the live IRC nick after a NickServ ghost
  // recovery (e.g. account "vjt", IRC nick "vjt-grappa"). The
  // per-network credential's `nick` (returned by GET /networks and
  // updated live via the `own_nick_changed` user-topic event) is the
  // canonical IRC nick to compare scrollback senders against.
  // subscribe.ts already does this for BUG4/BUG5; the JOIN-banner +
  // mention-highlight + ownModes paths here need the same overlay or
  // they silently drop on every credential where account != nick.
  const userNick = (): string | null => {
    const net = networks()?.find((n) => n.slug === props.networkSlug);
    if (net?.nick) return net.nick;
    const me = user();
    return me ? displayNick(me) : null;
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
    return members.find((m) => m.nick === nick)?.modes ?? [];
  };

  // C7.6: left-click a nick → open query window + switch focus.
  const handleNickClick = (nick: string): void => {
    const nid = networkId();
    if (nid === undefined) return;
    openQueryWindowState(nid, nick, new Date().toISOString());
    setSelectedChannel({ networkSlug: props.networkSlug, channelName: nick, kind: "query" });
  };

  // C7.6: right-click a nick → show UserContextMenu at cursor.
  const handleNickContextMenu = (nick: string, e: MouseEvent): void => {
    e.preventDefault();
    setContextMenu({ targetNick: nick, x: e.clientX, y: e.clientY });
  };

  // C7.1 + C7.3: Build a mixed list of (day-separator | unread-marker | message)
  // rows for rendering. Day-separator injected BETWEEN consecutive rows that
  // cross a local-TZ day boundary. Unread-marker injected between the last
  // read message and the first unread message when a read cursor exists.
  // The first message never gets a day-separator before it.
  //
  // Unread computation (C7.3 / CLAUDE.md "derive, don't duplicate"):
  //   cursor = getReadCursor(networkSlug, channelName) — localStorage, sync.
  //   unread count = messages.filter(m => m.server_time > cursor).length
  //   No signal needed for cursor — it's read once per channel mount.
  //   The cursor is a stable value for the lifetime of this channel view;
  //   it only advances when the user reads to the bottom (setReadCursor call).
  const rows = createMemo((): Row[] => {
    const msgs = messages();
    if (!msgs || msgs.length === 0) return [];
    const cursor = getReadCursor(props.networkSlug, props.channelName);
    // How many messages have server_time strictly after the cursor?
    const unreadCount = cursor !== null ? msgs.filter((m) => m.server_time > cursor).length : 0;
    // Only inject the marker if there are unread messages AND some read messages
    // to show as context above it. When all messages are unread, put the marker
    // at the very top (before index 0). When none are unread, skip the marker.
    const injectMarker = cursor !== null && unreadCount > 0;
    const result: Row[] = [];
    let prevTime: number | null = null;
    let markerInjected = false;
    for (const msg of msgs) {
      // C7.3: inject unread-marker BEFORE the first message with server_time > cursor.
      if (injectMarker && !markerInjected && cursor !== null && msg.server_time > cursor) {
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
    return msgs.some((m) => m.kind === "join" && m.sender === nick);
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
  createEffect(
    on(
      key,
      () => {
        setBannerState("hidden");
        setMarkerScrolled(false);
      },
      { defer: true },
    ),
  );

  // After Solid commits new DOM nodes, scroll to the tail iff the user
  // was at the bottom before the update. The effect tracks
  // `messages().length` so it re-runs on every append, not on signal
  // identity (the whole record changes every WS event by design).
  //
  // C7.3: On the FIRST render of a channel with unread messages, scroll to
  // the unread-marker instead of the tail. `markerScrolled` latches after
  // the first scroll so subsequent appends follow the normal auto-scroll
  // logic (tail-follow when atBottom, preserve position otherwise).
  createEffect(
    on(
      () => messages()?.length ?? 0,
      () => {
        if (!listRef) return;
        // C7.3: first mount with unread — scroll to marker, not tail.
        if (!markerScrolled() && markerRef) {
          // scrollIntoView is not implemented in jsdom (test environment).
          // Optional-chain so tests don't throw; real browsers have it.
          markerRef.scrollIntoView?.({ block: "start" });
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

  // C7.3: Cursor advancement — when the user has scrolled to the bottom
  // (atBottom = true), advance the read cursor to the latest message's
  // server_time. This is the natural "I've seen everything" signal.
  // Fires when atBottom transitions to true (e.g. user scrolls to bottom,
  // or clicks the scroll-to-bottom button). Does NOT fire on focus-switch
  // alone — user may switch in then immediately switch out without reading.
  createEffect(
    on(atBottom, (bottom) => {
      if (!bottom) return;
      const msgs = messages();
      if (!msgs || msgs.length === 0) return;
      const last = msgs[msgs.length - 1];
      if (last === undefined) return;
      setReadCursor(props.networkSlug, props.channelName, last.server_time);
    }),
  );

  const onScroll = () => {
    if (!listRef) return;
    const distance = listRef.scrollHeight - listRef.scrollTop - listRef.clientHeight;
    setAtBottom(distance <= SCROLL_BOTTOM_THRESHOLD_PX);
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

    return (
      <div class="join-banner" data-testid="join-banner">
        <div class="join-banner-heading">You joined {props.channelName}</div>
        <Show when={topic()?.text}>
          {(text) => <div class="join-banner-topic">Topic: {text()}</div>}
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
      {/* C5.2: Ephemeral inline numeric feedback lines. */}
      <Show when={(numericsByWindow()[key()] ?? []).length > 0}>
        <div class="numeric-inline-pane" data-testid="numeric-inline-pane">
          <For each={numericsByWindow()[key()] ?? []}>
            {(line) => (
              <div
                class="numeric-inline-line"
                classList={{ "numeric-error": line.severity === "error" }}
                data-testid="numeric-inline-line"
                data-severity={line.severity}
              >
                * {line.text}
              </div>
            )}
          </For>
        </div>
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
