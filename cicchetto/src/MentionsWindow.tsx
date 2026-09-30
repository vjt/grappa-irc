import { type Component, createMemo, For, type JSX, Show } from "solid-js";
import type { MentionsBundleMessage } from "./lib/api";
import { highlightPatterns } from "./lib/highlightList";
import { isMentionRow } from "./lib/mentionMatch";
import { formatTimestamp } from "./lib/timeFormat";
import { MircBody } from "./MircText";
import NickText from "./NickText";

// Mentions-while-away window (C8.1 / spec #19; restyled #188).
//
// Rendered by Shell when kind === "mentions". Consumes a `MentionsBundle`
// delivered via the `mentions_bundle` PubSub event on the user-level
// Phoenix Channel topic after a back-from-away transition.
//
// Layout (#188) mirrors the /list directory pane (DirectoryPane): a fixed
// header carrying the "/away" heading + count and a top-right close-x
// (reusing `.directory-close` + the `onClose` verb Shell wires to
// `closeToPreviousWindow`), over a SCROLLABLE list. Rows are grouped by
// channel under a muted channel label; each row is a lighter, less
// button-y clickable that still jumps to the source message.
//
// Row click: invokes `onMentionClicked` with the window the mention lives in
// and its message id, so Shell can switch to that window and land the pane on
// the message (issue 2333). The window is `dm_with` for an inbound DM — whose
// `channel` is our own nick — else `channel`; see `mentionWindow`.
//
// Styling reuses C7.7 `.scrollback-highlight` for matched body substrings.
// The window itself is channel-window-agnostic — no TopicBar, no ComposeBox.

export type MentionsRow = MentionsBundleMessage;

export type MentionsBundle = {
  network_slug: string;
  away_started_at: string;
  away_ended_at: string;
  away_reason: string | null;
  messages: MentionsRow[];
};

// `messageId` is `null` when the server predates protocol 35 and sent no id:
// the tap then only switches windows, as it did before issue 2333.
export type MentionClickedArgs = {
  networkSlug: string;
  window: string;
  kind: "channel" | "query";
  messageId: number | null;
};

export type MentionGroup = {
  window: string;
  rows: MentionsRow[];
};

// The window a mention is SHOWN in. An inbound DM is stored at `channel =
// <own nick>` with the peer in `dm_with`; filed under `channel` it would sit
// under our own nick and a tap would open the self window, where the row is
// not shown. Every other row names its window in `channel`.
export const mentionWindow = (row: MentionsRow): string => row.dm_with ?? row.channel;

type Props = {
  bundle: MentionsBundle;
  ownNick: string | null;
  onMentionClicked: (args: MentionClickedArgs) => void;
  onClose: () => void;
  /**
   * issue 2333 — the ☰ rail door, rendered in this header just before the ✕,
   * or `null`. On a phone Shell suppresses the floating `.shell-chrome` row for
   * this kind, as it does for admin: the float lands on the header's top-right
   * corner at z-index 41, i.e. on the ✕, and the tap meant to leave the window
   * opened the rail instead. The door moves INTO the header rather than going
   * away — bucket L keeps "settings reachable from every window kind" here,
   * unlike #1050's list window. Desktop passes `null`: its rail is permanent.
   * Required, not defaulted, by the same argument `PaneTopBar`'s slots make.
   */
  railOpener: JSX.Element;
};

// Cluster the mention rows under their window, preserving first-seen
// order (the server already returns messages `server_time ASC`, so the
// first window to appear leads). Pure — exported for unit reuse.
export const groupByWindow = (messages: MentionsRow[]): MentionGroup[] => {
  const order: string[] = [];
  const byWindow = new Map<string, MentionsRow[]>();
  for (const row of messages) {
    const window = mentionWindow(row);
    let bucket = byWindow.get(window);
    if (!bucket) {
      bucket = [];
      byWindow.set(window, bucket);
      order.push(window);
    }
    bucket.push(row);
  }
  return order.map((window) => ({ window, rows: byWindow.get(window) ?? [] }));
};

// "3" + "message" → "3 messages"; "1" + "channel" → "1 channel".
const pluralize = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

// Format an ISO-8601 timestamp string as a short local time (HH:MM:SS).
const formatIso = (iso: string): string => {
  try {
    const d = new Date(iso);
    const hh = d.getHours().toString().padStart(2, "0");
    const mm = d.getMinutes().toString().padStart(2, "0");
    const ss = d.getSeconds().toString().padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  } catch {
    return iso;
  }
};

// Message-row timestamp: shared with scrollback via lib/timeFormat so the
// operator's configured format (#217) applies uniformly to every message
// row. Was a local HH:MM:SS formatter — routed through the shared helper
// to end the scrollback-vs-mentions format drift (implement once, reuse
// everywhere).
const formatMs = (ms: number): string => formatTimestamp(ms);

const MentionsWindow: Component<Props> = (props) => {
  // Memoized so the single pass over the messages feeds both the header
  // count (`groups().length`) and the `<For>` render without recomputing.
  const groups = createMemo(() => groupByWindow(props.bundle.messages));
  // #188 item 1 — count makes the scope visible before scrolling:
  // "N messages in M channels".
  const summary = () =>
    `${pluralize(props.bundle.messages.length, "message")} in ${pluralize(groups().length, "channel")}`;
  const startTime = () => formatIso(props.bundle.away_started_at);
  const endTime = () => formatIso(props.bundle.away_ended_at);

  return (
    <div class="mentions-window" data-testid="mentions-window">
      <div class="mentions-header" data-testid="mentions-header">
        <div class="mentions-header-main">
          <span class="mentions-heading">while you were /away — {summary()}</span>
          {props.railOpener}
          {/* #188 item 5 — close-x top-right, reusing the /list pane's
              `.directory-close` affordance. Shell wires `onClose` to
              `closeToPreviousWindow` so it restores the prior window. */}
          <button
            type="button"
            class="directory-close"
            data-testid="mentions-close"
            aria-label="Close mentions"
            onClick={() => props.onClose()}
          >
            ✕
          </button>
        </div>
        {/* Away interval + reason kept as a muted sub-line. #142: the
            operator's own away reason is user-set free text — route it
            through the shared renderer so control bytes render, not leak raw. */}
        <Show when={props.bundle.away_started_at || props.bundle.away_reason}>
          <div class="mentions-header-meta muted">
            {startTime()} – {endTime()}
            <Show when={props.bundle.away_reason}>
              {" · "}
              <MircBody body={props.bundle.away_reason ?? ""} emphasis />
            </Show>
          </div>
        </Show>
      </div>

      <div class="mentions-list" data-testid="mentions-list">
        <For each={groups()}>
          {(group) => (
            <div class="mentions-group" data-testid="mentions-group">
              {/* #188 item 2 — muted per-channel label; rows cluster below it. */}
              <div class="mentions-group-channel muted" data-testid="mentions-group-channel">
                {group.window}
              </div>
              <For each={group.rows}>
                {(row) => {
                  // #370 — own nick ∪ custom /hilight patterns (shared source).
                  // issue 1481 — via the row-level rule, so a row the operator
                  // authored is not highlighted back at them here either.
                  const isHighlight = () => isMentionRow(row, props.ownNick, highlightPatterns());

                  return (
                    <button
                      type="button"
                      class="mentions-row"
                      classList={{ "scrollback-highlight": isHighlight() }}
                      data-testid="mentions-row"
                      onClick={() =>
                        props.onMentionClicked({
                          networkSlug: props.bundle.network_slug,
                          window: mentionWindow(row),
                          kind: row.dm_with ? "query" : "channel",
                          messageId: row.id ?? null,
                        })
                      }
                    >
                      <span class="mentions-row-time scrollback-time">
                        {formatMs(row.server_time)}
                      </span>
                      <span class="mentions-row-sender">
                        &lt;
                        <NickText nick={row.sender} />
                        &gt;
                      </span>
                      <span class="mentions-row-body">
                        {/* #220 — a link in the body just browses; it must
                            NOT jump to the source (the row's
                            onMentionClicked). Same "link-wins" policy as
                            the /list directory row: the anchor
                            stopPropagation so this row button never fires
                            on a link tap. */}
                        <MircBody body={row.body ?? ""} linkPolicy="link-wins" emphasis />
                      </span>
                    </button>
                  );
                }}
              </For>
            </div>
          )}
        </For>
      </div>
    </div>
  );
};

export default MentionsWindow;
