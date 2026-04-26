import { type Component, createEffect, createSignal, For, on, Show } from "solid-js";
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

const ScrollbackLine: Component<{ msg: ScrollbackMessage }> = (props) => {
  return (
    <div
      class="scrollback-line"
      classList={{
        "scrollback-action": props.msg.kind === "action",
        "scrollback-notice": props.msg.kind === "notice",
      }}
      data-testid="scrollback-line"
      data-kind={props.msg.kind}
    >
      <span class="scrollback-time">{formatTime(props.msg.server_time)}</span>{" "}
      <Show
        when={props.msg.kind === "action"}
        fallback={
          <>
            <span class="scrollback-sender">
              {props.msg.kind === "notice" ? `-${props.msg.sender}-` : `<${props.msg.sender}>`}
            </span>{" "}
            <span class="scrollback-body">{props.msg.body}</span>
          </>
        }
      >
        <span class="scrollback-body">
          * {props.msg.sender} {props.msg.body}
        </span>
      </Show>
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
