import { type Component, For } from "solid-js";
import { matchesWatchlist } from "./lib/mentionMatch";

// Mentions-while-away window (C8.1 / spec #19).
//
// Rendered by Shell when kind === "mentions". Consumes a `MentionsBundle`
// delivered via the `mentions_bundle` PubSub event on the user-level
// Phoenix Channel topic after a back-from-away transition.
//
// Row click: invokes `onMentionClicked` with {networkSlug, channel,
// serverTime} so Shell can switch focus to the source channel window and
// request a scroll-to-timestamp (C8.2).
//
// Styling reuses C7.2 muted-event class for the header row and C7.7
// .scrollback-highlight for matched body substrings. The window itself
// is channel-window-agnostic — no TopicBar, no ComposeBox.

export type MentionsRow = {
  server_time: number;
  channel: string;
  sender_nick: string;
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

type Props = {
  bundle: MentionsBundle;
  ownNick: string | null;
  onMentionClicked: (args: MentionClickedArgs) => void;
};

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
  const count = () => props.bundle.messages.length;
  const startTime = () => formatIso(props.bundle.away_started_at);
  const endTime = () => formatIso(props.bundle.away_ended_at);

  return (
    <div class="mentions-window" data-testid="mentions-window">
      {/* C7.2-style muted header row */}
      <div class="mentions-header scrollback-muted" data-testid="mentions-header">
        <span class="mentions-header-text">
          {count()} mention{count() !== 1 ? "s" : ""} while away ({startTime()} – {endTime()}
          {props.bundle.away_reason ? ` · ${props.bundle.away_reason}` : ""})
        </span>
      </div>

      <div class="mentions-list" data-testid="mentions-list">
        <For each={props.bundle.messages}>
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
                <span class="mentions-row-time scrollback-time">{formatMs(row.server_time)}</span>
                <span class="mentions-row-channel">{row.channel}</span>
                <span class="mentions-row-sender">&lt;{row.sender_nick}&gt;</span>
                <span class="mentions-row-body">{row.body}</span>
              </button>
            );
          }}
        </For>
      </div>
    </div>
  );
};

export default MentionsWindow;
