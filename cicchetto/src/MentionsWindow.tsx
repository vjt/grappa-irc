import { type Component, createMemo, For, Show } from "solid-js";
import { matchesWatchlist } from "./lib/mentionMatch";
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
// Row click: invokes `onMentionClicked` with {networkSlug, channel,
// serverTime} so Shell can switch focus to the source channel window and
// request a scroll-to-timestamp (C8.2).
//
// Styling reuses C7.7 `.scrollback-highlight` for matched body substrings.
// The window itself is channel-window-agnostic — no TopicBar, no ComposeBox.

export type MentionsRow = {
  server_time: number;
  channel: string;
  sender: string;
  body: string | null;
  kind: string;
};

export type MentionsBundle = {
  network_slug: string;
  away_started_at: string;
  away_ended_at: string;
  away_reason: string | null;
  messages: MentionsRow[];
};

export type MentionClickedArgs = {
  networkSlug: string;
  channel: string;
  serverTime: number;
};

export type MentionGroup = {
  channel: string;
  rows: MentionsRow[];
};

type Props = {
  bundle: MentionsBundle;
  ownNick: string | null;
  onMentionClicked: (args: MentionClickedArgs) => void;
  onClose: () => void;
};

// Cluster the mention rows under their channel, preserving first-seen
// order (the server already returns messages `server_time ASC`, so the
// first channel to appear leads). Pure — exported for unit reuse.
export const groupByChannel = (messages: MentionsRow[]): MentionGroup[] => {
  const order: string[] = [];
  const byChannel = new Map<string, MentionsRow[]>();
  for (const row of messages) {
    let bucket = byChannel.get(row.channel);
    if (!bucket) {
      bucket = [];
      byChannel.set(row.channel, bucket);
      order.push(row.channel);
    }
    bucket.push(row);
  }
  return order.map((channel) => ({ channel, rows: byChannel.get(channel) ?? [] }));
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

// Format epoch-ms as local HH:MM:SS.
const formatMs = (ms: number): string => {
  const d = new Date(ms);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
};

const MentionsWindow: Component<Props> = (props) => {
  // Memoized so the single pass over the messages feeds both the header
  // count (`groups().length`) and the `<For>` render without recomputing.
  const groups = createMemo(() => groupByChannel(props.bundle.messages));
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
              <MircBody body={props.bundle.away_reason ?? ""} />
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
                {group.channel}
              </div>
              <For each={group.rows}>
                {(row) => {
                  const isHighlight = () => matchesWatchlist(row.body, props.ownNick);

                  return (
                    <button
                      type="button"
                      class="mentions-row"
                      classList={{ "scrollback-highlight": isHighlight() }}
                      data-testid="mentions-row"
                      onClick={() =>
                        props.onMentionClicked({
                          networkSlug: props.bundle.network_slug,
                          channel: row.channel,
                          serverTime: row.server_time,
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
                        <MircBody body={row.body ?? ""} />
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
