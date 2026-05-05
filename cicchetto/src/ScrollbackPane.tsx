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
import { mentionsUser } from "./lib/mentionMatch";
import { user } from "./lib/networks";
import { numericsByWindow } from "./lib/numericInline";
import { scrollbackByChannel } from "./lib/scrollback";
import { setSelectedChannel } from "./lib/selection";
import type { WindowKind } from "./lib/windowKinds";

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
// C7.4: Scroll-to-bottom floating button — appears when scrolled more than
// SCROLL_BOTTOM_THRESHOLD_PX from the tail. Click → smooth-scroll to bottom
// and resume auto-follow (resets atBottom to true).

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

const renderBody = (msg: ScrollbackMessage): JSX.Element => {
  switch (msg.kind) {
    case "privmsg":
      return (
        <>
          <span class="scrollback-sender">{`<${msg.sender}>`}</span>{" "}
          <span class="scrollback-body">{msg.body}</span>
        </>
      );
    case "notice":
      return (
        <>
          <span class="scrollback-sender">{`-${msg.sender}-`}</span>{" "}
          <span class="scrollback-body">{msg.body}</span>
        </>
      );
    case "action":
      return (
        <span class="scrollback-body">
          * {msg.sender} {msg.body}
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

const ScrollbackLine: Component<{ msg: ScrollbackMessage; userNick: string | null }> = (props) => {
  const isMention = () =>
    props.msg.kind === "privmsg" && mentionsUser(props.msg.body, props.userNick);

  // C7.2: muted — presence/event kinds are visually de-emphasized.
  const isMuted = () => PRESENCE_KINDS.has(props.msg.kind);

  return (
    <div
      class="scrollback-line"
      classList={{
        "scrollback-action": props.msg.kind === "action",
        "scrollback-notice": props.msg.kind === "notice",
        "scrollback-presence": PRESENCE_KINDS.has(props.msg.kind),
        "scrollback-muted": isMuted(),
        "scrollback-mention": isMention(),
      }}
      data-testid="scrollback-line"
      data-kind={props.msg.kind}
    >
      <span class="scrollback-time">{formatTime(props.msg.server_time)}</span>{" "}
      {renderBody(props.msg)}
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
type MessageRow = { type: "message"; msg: ScrollbackMessage };
type Row = SeparatorRow | MessageRow;

const ScrollbackPane: Component<Props> = (props) => {
  let listRef!: HTMLDivElement;
  const [atBottom, setAtBottom] = createSignal(true);
  const [bannerState, setBannerState] = createSignal<BannerState>("hidden");

  const key = () => channelKey(props.networkSlug, props.channelName);
  const messages = () => scrollbackByChannel()[key()];
  const userNick = (): string | null => {
    const me = user();
    return me ? displayNick(me) : null;
  };

  // C7.1: Build a mixed list of (day-separator | message) rows for rendering.
  // Separator injected BETWEEN consecutive rows that cross a local-TZ
  // day boundary. The first message never gets a separator before it.
  const rows = createMemo((): Row[] => {
    const msgs = messages();
    if (!msgs || msgs.length === 0) return [];
    const result: Row[] = [];
    let prevTime: number | null = null;
    for (const msg of msgs) {
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
  createEffect(
    on(
      key,
      () => {
        setBannerState("hidden");
      },
      { defer: true },
    ),
  );

  // After Solid commits new DOM nodes, scroll to the tail iff the user
  // was at the bottom before the update. The effect tracks
  // `messages().length` so it re-runs on every append, not on signal
  // identity (the whole record changes every WS event by design).
  createEffect(
    on(
      () => messages()?.length ?? 0,
      () => {
        if (!listRef) return;
        if (atBottom()) {
          listRef.scrollTop = listRef.scrollHeight;
        }
      },
    ),
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
          {/* C7.1: render mixed rows (separator + message). */}
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
              return <ScrollbackLine msg={row.msg} userNick={userNick()} />;
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
    </div>
  );
};

export default ScrollbackPane;
