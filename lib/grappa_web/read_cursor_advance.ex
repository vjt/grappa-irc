defmodule GrappaWeb.ReadCursorAdvance do
  @moduledoc """
  The ONE web-side verb that moves a read cursor and tells every device.

  Two doors call it, and they must say the same thing to the other devices:

    * `GrappaWeb.ReadCursorController` — `POST .../read-cursor`, cic's settle
      events (focus-leave, blur, scroll-settle, scroll-to-bottom);
    * `GrappaWeb.MessagesController` — the subject's own send (issue 2407).
      Replying in a window is a read signal, and for a client that cannot
      send read markers (an IRC client behind a bridge) it is the ONLY one,
      so everything read from such a client used to stay unread on every
      other device, the icon badge included.

  `advance/4` writes the cursor through `Grappa.ReadCursor.set/4` — monotonic,
  so a cursor already past `message_id` stays where it is and is re-affirmed —
  then hands the fan-out to a supervised task. The fan-out is the expensive
  half (`BadgeCount.count/1` folds every cursored window, #273) and it is
  eventually consistent, so neither door waits for it.

  It lives in the web layer, not in `Grappa.ReadCursor`, because the fan-out
  needs `Grappa.Push.BadgeCount`, which sits ABOVE `ReadCursor` (it reads the
  cursors) — a context-side home would close that cycle.
  """

  alias Grappa.Networks.Network
  alias Grappa.Push.BadgeCount
  alias Grappa.{ReadCursor, WindowCounts}
  alias GrappaWeb.Subject

  @doc """
  Advances `current_subject`'s cursor on `(network, channel)` to `message_id`
  and fans the result out to every device.

  `channel` must already be the folded window key: the caller is the ingress
  that knows the network's CASEMAPPING (#537). Returns the post-set cursor —
  on a stale lower id that is the current, higher one — or `ReadCursor.set/4`'s
  error, in which case nothing is fanned out.
  """
  @spec advance(Subject.t(), Network.t(), String.t(), pos_integer()) ::
          {:ok, ReadCursor.Cursor.t()}
          | {:error, :invalid_message | :db_unavailable | Ecto.Changeset.t()}
  def advance(current_subject, %Network{} = network, channel, message_id) do
    subject = Subject.to_session(current_subject)

    with {:ok, cursor} <- ReadCursor.set(subject, network.id, channel, message_id) do
      last_read = cursor.last_read_message_id

      {:ok, _} =
        Task.Supervisor.start_child(Grappa.TaskSupervisor, fn ->
          fanout(subject, current_subject, network, channel, last_read)
        end)

      {:ok, cursor}
    end
  end

  # Deferred, off-request-path fan-out for a successful cursor set (#273).
  # Runs in a supervised `Grappa.TaskSupervisor` task (NOT the request
  # process) so the expensive badge fold never blocks the caller. Emits a
  # `[:grappa, :read_cursor, :fanout]` telemetry event (badge total; fold
  # cost via handler wall-time) — emitted for FUTURE observability + as the
  # deterministic test seam; no prod handler is attached today.
  #
  # Door #3: `badge_count` is the notify-worthy unread total AFTER this
  # advance (reading drops it), computed here because this layer holds the
  # subject — keeping `ReadCursor` free of a `Push.BadgeCount` dep.
  #
  # `last_read_message_id` is the value `ReadCursor.set/4` RETURNED — the
  # #233-clamped, monotonic cursor captured by the caller and threaded
  # through, NEVER re-read. cic's `applyReadCursorSet` is last-write-wins
  # with no receive-side monotonic guard, so the server's `set/4` clamp is
  # the sole monotonicity authority. Passing the captured clamped value
  # preserves the exact broadcast semantics the synchronous path had (a
  # stale lower POST re-affirms the higher cursor); a re-read here could
  # observe a concurrent later write and emit an id inconsistent with what
  # this request advanced. Ordering caveat (honest): the async move WIDENS
  # an existing reorder class. The synchronous path fired the broadcast
  # BEFORE the 200, so a single client's sequential settle→settle writes
  # broadcast in order; the async path returns the 200 first, so a fast fold
  # for a later advance can overtake a slower fold for an earlier one, and a
  # PASSIVE PEER device (cic `applyReadCursorSet` is last-write-wins, no
  # receive-side monotonic guard) can transiently regress. It stays benign:
  # the ORIGINATING device advances its own signal map forward-only before
  # the POST (cic `setReadCursor`), so the actor never regresses; the peer's
  # in-pane divider is frozen (not re-latched per cursor move), so there's
  # no visible jump; it self-heals on the next settle's re-broadcast; and
  # the clamp guarantees no broadcast ever carries a value BELOW the
  # committed cursor.
  @spec fanout(
          Grappa.Session.subject(),
          Subject.t(),
          Network.t(),
          String.t(),
          integer()
        ) :: :ok
  defp fanout(subject, current_subject, network, channel, last_read_message_id) do
    badge_count = BadgeCount.count(subject)

    _ = broadcast_set(current_subject, network.slug, channel, last_read_message_id, badge_count)

    # #267 — re-seed the fresh per-channel window_counts snapshot on cursor
    # advance so PEER devices (that didn't originate the read) drop the
    # channel's badge to server truth. read_cursor_set carries only the
    # cursor + global badge; the per-channel messages/mentions/events counts
    # need their own re-seed. Routed through the same PushSource seam as the
    # persist-arm push — gated on live WS presence, does its DB work in a
    # Task. own_nick resolves off-Session from the configured credential nick
    # (nil for an unbound-but-retained network), same stance as /me.
    own_nick = live_own_nick(subject, network.slug)

    :ok =
      WindowCounts.PushSource.push(%{
        subject: subject,
        network_id: network.id,
        network_slug: network.slug,
        subject_label: Subject.topic_label(current_subject),
        channel: channel,
        own_nick: own_nick
      })

    :telemetry.execute(
      [:grappa, :read_cursor, :fanout],
      %{badge_count: badge_count},
      %{network_slug: network.slug, channel: channel}
    )

    :ok
  end

  # Live own-nick for `slug` (live session nick, falling back to the
  # credential nick when no session is up), or `nil` when the subject holds
  # no credential there — the same live-nick resolver `/me` + `BadgeCount`
  # use (#498; cheap `Registry` lookup, no per-network GenServer round-trip).
  @spec live_own_nick(Grappa.Session.subject(), String.t()) :: String.t() | nil
  defp live_own_nick(subject, slug) do
    case Map.fetch(BadgeCount.live_nick_windows(subject), slug) do
      {:ok, {_, own_nick}} -> own_nick
      :error -> nil
    end
  end

  # Resolves the user-name segment of the per-channel topic for the
  # cross-device broadcast via `Subject.topic_label/1` — the single
  # source of the "user → `user.name`, visitor → `"visitor:" <> id`"
  # invariant (bucket I web/S7), matching the `:user_name` `UserSocket`
  # assigns so visitor cic instances subscribed to their user-rooted
  # topic see the broadcast (V4 visitor-parity, 2026-05-15).
  @spec broadcast_set(Subject.t(), String.t(), String.t(), integer(), non_neg_integer()) ::
          :ok | {:error, term()}
  defp broadcast_set(subject, network_slug, channel, last_read_message_id, badge_count) do
    ReadCursor.broadcast_set(
      Subject.topic_label(subject),
      network_slug,
      channel,
      last_read_message_id,
      badge_count
    )
  end
end
