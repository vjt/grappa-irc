import { type Component, createEffect, createSignal, For, type JSX, on, Show } from "solid-js";
import type { ScrollbackMessage } from "./lib/api";
import { channelKey, scrollbackByChannel, sendMessage } from "./lib/networks";

// Right-pane component: renders the per-channel scrollback list and a
// compose form. Mounted by `Shell.tsx` only when `selectedChannel()` is
// non-null; the parent passes the (slug, name) tuple as props so this
// component is a pure projection of the store signals plus a local
// compose textarea state.
//
// Auto-scroll: stick to the bottom when a new message arrives ONLY if
// the user is already near the bottom (within 50px). If they've
// scrolled up to read history, we leave the scroll position alone so
// reading isn't yanked away. The "near bottom" check runs BEFORE
// rendering the new message (in the createEffect cleanup phase
// equivalent — Solid runs effects after DOM updates, so we capture the
// pre-update state via an `atBottom` signal updated on scroll).
//
// Compose: single-line textarea (Enter = send, Shift+Enter inserts
// newline). The walking-skeleton omits multi-line UX polish; sending
// blanks the textarea and surfaces errors via a small status message.

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
// The non-message kinds carry their event-specific fields in `meta`
// (mirror of `Grappa.Scrollback.Meta` allowlist: `target`, `new_nick`,
// `modes`, `args`, `reason`); `meta` is typed `Record<string, unknown>`
// on the wire so each access narrows defensively.
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
    case "part":
      return (
        <span class="scrollback-body">
          * {msg.sender} has left {msg.channel}
          {msg.body ? ` (${msg.body})` : ""}
        </span>
      );
    case "quit":
      return (
        <span class="scrollback-body">
          * {msg.sender} has quit{msg.body ? ` (${msg.body})` : ""}
        </span>
      );
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
      return (
        <span class="scrollback-body">
          * {msg.sender} kicked {target} from {msg.channel}
          {msg.body ? ` (${msg.body})` : ""}
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

const ScrollbackLine: Component<{ msg: ScrollbackMessage }> = (props) => {
  return (
    <div
      class="scrollback-line"
      classList={{
        "scrollback-action": props.msg.kind === "action",
        "scrollback-notice": props.msg.kind === "notice",
        "scrollback-presence": PRESENCE_KINDS.has(props.msg.kind),
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
  const [draft, setDraft] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [sending, setSending] = createSignal(false);
  const [atBottom, setAtBottom] = createSignal(true);

  const messages = () => scrollbackByChannel()[channelKey(props.networkSlug, props.channelName)];

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

  const onSubmit = async (e: Event) => {
    e.preventDefault();
    const body = draft().trim();
    if (body === "" || sending()) return;
    setSending(true);
    setError(null);
    try {
      await sendMessage(props.networkSlug, props.channelName, body);
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "send failed");
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void onSubmit(e);
    }
  };

  return (
    <div class="scrollback-pane">
      <div ref={listRef} class="scrollback" onScroll={onScroll} data-testid="scrollback">
        <Show
          when={(messages()?.length ?? 0) > 0}
          fallback={<p class="muted scrollback-empty">no messages yet</p>}
        >
          <For each={messages()}>{(msg) => <ScrollbackLine msg={msg} />}</For>
        </Show>
      </div>
      <form class="compose" onSubmit={onSubmit}>
        <textarea
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          placeholder={`message ${props.channelName}`}
          rows={1}
          disabled={sending()}
          aria-label="compose message"
        />
        <button type="submit" disabled={sending() || draft().trim() === ""}>
          send
        </button>
      </form>
      <Show when={error()}>
        {(msg) => (
          <p class="compose-error" role="alert">
            {msg()}
          </p>
        )}
      </Show>
    </div>
  );
};

export default ScrollbackPane;
