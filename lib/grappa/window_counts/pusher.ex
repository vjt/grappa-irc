defmodule Grappa.WindowCounts.Pusher do
  @moduledoc """
  Default `Grappa.WindowCounts.PushSource` implementation (#267) — the
  concrete per-message `window_counts` push.

  ## Own boundary ABOVE the caller (BadgeCount pattern)

  Lives in its OWN `top_level?: true` boundary because it deps
  `ReadCursor` (→ `Networks` → `Session`); folding it into any boundary
  `Session` deps would close a cycle. `Session` reaches it ONLY through
  the `PushSource` config seam, so nothing below statically references
  this module — the same inversion `Grappa.Push.BadgeCount` uses.

  ## What it does

  `push/1` gates on live WS presence (`WSPresence.ws_count/1` > 0): if
  no socket is connected for the subject, it skips — the next
  `join_reply` / `/me` re-seeds the absolute snapshot on reconnect, so a
  disconnected subject costs nothing. When connected, it spawns an
  unlinked `Task` (like `Push.Triggers`) so the Session hot path never
  blocks on the snapshot's DB work, then `emit/1` computes the fresh
  `WindowCounts.snapshot/6` (cursor from `ReadCursor`, highlight patterns
  from `UserSettings`) and broadcasts the `window_counts` event on the
  per-channel topic. cic replaces its stored snapshot verbatim.
  """

  @behaviour Grappa.WindowCounts.PushSource

  use Boundary,
    top_level?: true,
    deps: [
      Grappa.PubSub,
      Grappa.ReadCursor,
      Grappa.Subject,
      Grappa.UserSettings,
      Grappa.WindowCounts,
      Grappa.WSPresence
    ]

  alias Grappa.PubSub.Topic
  alias Grappa.{ReadCursor, UserSettings, WindowCounts, WSPresence}
  alias Grappa.WindowCounts.{PushSource, Wire}

  @impl PushSource
  @spec push(PushSource.ctx()) :: :ok
  def push(%{subject_label: subject_label} = ctx) do
    # `_ =` — the `if` is evaluated for its side effect (spawning the
    # emit Task); its `{:ok, pid} | nil` value is intentionally discarded
    # (dialyzer `:unmatched_returns`).
    _ =
      if WSPresence.ws_count(subject_label) > 0 do
        # Fire-and-forget — the snapshot DB work stays off the Session hot
        # path. A dead Task just means the live-render optimization is
        # skipped for this row; the next seed re-bases the count.
        {:ok, _} = Task.start(fn -> emit(ctx) end)
      end

    :ok
  end

  @doc """
  Computes the fresh snapshot and broadcasts the `window_counts` event.
  Public (not private) so it is unit-testable synchronously without the
  `Task` + WS-presence gate `push/1` wraps it in.
  """
  @spec emit(PushSource.ctx()) :: :ok
  def emit(%{
        subject: subject,
        network_id: network_id,
        network_slug: network_slug,
        subject_label: subject_label,
        channel: channel,
        own_nick: own_nick
      }) do
    patterns = UserSettings.get_highlight_patterns(subject)

    cursor =
      case ReadCursor.get(subject, network_id, channel) do
        %ReadCursor.Cursor{last_read_message_id: id} -> id
        _ -> nil
      end

    counts = WindowCounts.snapshot(subject, network_id, channel, cursor, own_nick, patterns)

    _ =
      Grappa.PubSub.broadcast_event(
        Topic.channel(subject_label, network_slug, channel),
        Wire.window_counts_payload(channel, counts)
      )

    :ok
  end
end
