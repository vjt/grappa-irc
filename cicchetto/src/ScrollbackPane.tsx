import { type Component, createEffect, createSignal, For, type JSX, on, Show } from "solid-js";
import type { ScrollbackMessage } from "./lib/api";
import { channelKey } from "./lib/channelKey";
import { mentionsUser } from "./lib/mentionMatch";
import { user } from "./lib/networks";
import { scrollbackByChannel } from "./lib/scrollback";

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

export type Props = {
  networkSlug: string;
  channelName: string;
};

const SCROLL_BOTTOM_THRESHOLD_PX = 50;

const formatTime = (epochMs: number): string => {
  const d = new Date(epochMs);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
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

  return (
    <div
      class="scrollback-line"
      classList={{
        "scrollback-action": props.msg.kind === "action",
        "scrollback-notice": props.msg.kind === "notice",
        "scrollback-presence": PRESENCE_KINDS.has(props.msg.kind),
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

const ScrollbackPane: Component<Props> = (props) => {
  let listRef!: HTMLDivElement;
  const [atBottom, setAtBottom] = createSignal(true);

  const messages = () => scrollbackByChannel()[channelKey(props.networkSlug, props.channelName)];
  const userNick = (): string | null => user()?.name ?? null;

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

  return (
    <div class="scrollback-pane">
      <div ref={listRef} class="scrollback" onScroll={onScroll} data-testid="scrollback">
        <Show
          when={(messages()?.length ?? 0) > 0}
          fallback={<p class="muted scrollback-empty">no messages yet</p>}
        >
          <For each={messages()}>{(msg) => <ScrollbackLine msg={msg} userNick={userNick()} />}</For>
        </Show>
      </div>
    </div>
  );
};

export default ScrollbackPane;
