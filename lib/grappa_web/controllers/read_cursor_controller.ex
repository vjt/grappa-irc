defmodule GrappaWeb.ReadCursorController do
  @moduledoc """
  Write surface for `Grappa.ReadCursor`.

  ## Single endpoint

  `POST /networks/:network_id/channels/:channel_id/read-cursor` with
  body `{"message_id": <int>}`. Returns 200
  `{"last_read_message_id": <int>}`.

  Monotonic advance-only; the controller is a thin parse + dispatch +
  broadcast layer over `Grappa.ReadCursor.set/4`. A stale (lower) POST
  is clamped by the context and re-affirms the current (higher) cursor,
  so the broadcast below carries the correct id (see #233).

  ## Cross-device broadcast — V4 visitor-parity (2026-05-15)

  After every successful set on EITHER subject kind, the cursor is
  broadcast on the per-channel topic via `ReadCursor.broadcast_set/5`
  (carrying the post-set `badge_count` for the PWA icon badge, door #3)
  so other live cic instances (different tabs / devices) update their
  cursor signal map + icon badge. No batching, no throttle. Visitor topics use
  `"visitor:" <> visitor.id` as the user-name segment — same shape as
  `UserSocket`'s `:user_name` assignment so the broadcast routes to
  the visitor's own user-rooted topic tree.

  Pre-V4 the visitor branch short-circuited to `:ok` with no fan-out
  on the rationale that visitors were single-device (no token reuse
  across browsers). Same-NickServ-identity reuse + multi-tab visitor
  sessions made the no-fan-out a UX gap; the V4 lift restores parity.

  ## Validation

  At-the-boundary per CLAUDE.md:

    * Missing / non-integer / non-positive `message_id` → 400.
    * Channel target invalid (not channel-shaped, not nick-shaped, not
      `$server`) → 400.
    * `message_id` exists but does NOT belong to (subject, network,
      channel) → 422 (caught by `ReadCursor.set/4`'s
      `:invalid_message`). Distinguished from 400 because the request
      shape was valid; the data referenced a different scope.
  """
  use GrappaWeb, :controller

  import GrappaWeb.Validation, only: [validate_target_name: 1]

  alias Grappa.Push.BadgeCount
  alias Grappa.{ReadCursor, WindowCounts}
  alias GrappaWeb.Subject

  @doc """
  `POST /networks/:network_id/channels/:channel_id/read-cursor` — set
  the operator's cursor on `(subject, network.id, channel)` to
  `message_id`. Monotonic advance-only via `ReadCursor.set/4` (a lower
  id is clamped to the current cursor).
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :invalid_message | Ecto.Changeset.t()}
  def create(conn, %{"channel_id" => channel, "message_id" => message_id})
      when is_integer(message_id) and message_id > 0 do
    subject = Subject.to_session(conn.assigns.current_subject)
    current_subject = conn.assigns.current_subject
    network = conn.assigns.network

    with :ok <- validate_target_name(channel),
         {:ok, cursor} <- ReadCursor.set(subject, network.id, channel, message_id) do
      # #273 — only the cursor upsert is request-critical. Proven with
      # timing: `ReadCursor.set/4` ~69µs vs a ~10ms+ full
      # `BadgeCount.count/1` fold (EXPLAIN: no covering index for the
      # id-range unread count → the fold scans the network partition per
      # cursored window). Blocking the write on the fold dropped slow POSTs,
      # so cic scrolled back to the stale unread marker. The door-#3 badge
      # and the cross-device broadcast are eventually-consistent, so defer
      # BOTH off the request path to a supervised fire-and-forget Task
      # (reuses `Grappa.TaskSupervisor` — no NEW supervision child, so the
      # fix is hot-deployable). The response returns right after the
      # (monotonic, #233-clamped) upsert.
      last_read = cursor.last_read_message_id

      {:ok, _} =
        Task.Supervisor.start_child(Grappa.TaskSupervisor, fn ->
          fanout(subject, current_subject, network, channel, last_read)
        end)

      json(conn, %{last_read_message_id: last_read})
    end
  end

  def create(_, _), do: {:error, :bad_request}

  # Deferred, off-request-path fan-out for a successful cursor set (#273).
  # Runs in a supervised `Grappa.TaskSupervisor` task (NOT the request
  # process) so the expensive badge fold never blocks the POST. Emits a
  # `[:grappa, :read_cursor, :fanout]` telemetry event (badge total; fold
  # cost via handler wall-time) — emitted for FUTURE observability + as the
  # deterministic test seam; no prod handler is attached today.
  #
  # Door #3: `badge_count` is the notify-worthy unread total AFTER this
  # advance (reading drops it), computed here because the controller holds
  # the subject — keeping `ReadCursor` free of a `Push.BadgeCount` dep.
  #
  # `last_read_message_id` is the value `ReadCursor.set/4` RETURNED — the
  # #233-clamped, monotonic cursor captured on the request path and
  # threaded through, NEVER re-read. cic's `applyReadCursorSet` is
  # last-write-wins with no receive-side monotonic guard, so the server's
  # `set/4` clamp is the sole monotonicity authority. Passing the captured
  # clamped value preserves the exact broadcast semantics the synchronous
  # path had (a stale lower POST re-affirms the higher cursor); a re-read
  # here could observe a concurrent later write and emit an id inconsistent
  # with what this request advanced. Ordering caveat (honest): the async
  # move WIDENS an existing reorder class. The synchronous path fired the
  # broadcast BEFORE the 200, so a single client's sequential settle→settle
  # writes broadcast in order; the async path returns the 200 first, so a
  # fast fold for a later advance can overtake a slower fold for an earlier
  # one, and a PASSIVE PEER device (cic `applyReadCursorSet` is
  # last-write-wins, no receive-side monotonic guard) can transiently
  # regress. It stays benign: the ORIGINATING device advances its own
  # signal map forward-only before the POST (cic `setReadCursor`), so the
  # actor never regresses; the peer's in-pane divider is frozen (not
  # re-latched per cursor move), so there's no visible jump; it self-heals
  # on the next settle's re-broadcast; and the clamp guarantees no
  # broadcast ever carries a value BELOW the committed cursor.
  @spec fanout(
          Grappa.Session.subject(),
          Subject.t(),
          Grappa.Networks.Network.t(),
          String.t(),
          integer()
        ) :: :ok
  defp fanout(subject, current_subject, network, channel, last_read_message_id) do
    badge_count = BadgeCount.count(subject)

    _ = maybe_broadcast(current_subject, network.slug, channel, last_read_message_id, badge_count)

    # #267 — re-seed the fresh per-channel window_counts snapshot on cursor
    # advance so PEER devices (that didn't originate the read) drop the
    # channel's badge to server truth. read_cursor_set carries only the
    # cursor + global badge; the per-channel messages/mentions/events counts
    # need their own re-seed. Routed through the same PushSource seam as the
    # persist-arm push — gated on live WS presence, does its DB work in a
    # Task. own_nick resolves off-Session from the configured credential nick
    # (nil for an unbound-but-retained network), same stance as /me.
    own_nick = configured_own_nick(subject, network.slug)

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

  # Configured own-nick for `slug` (credential nick for users,
  # `visitor.nick` for visitors), or `nil` when the subject holds no
  # credential there — same off-Session resolver `/me` + `BadgeCount` use.
  @spec configured_own_nick(Grappa.Session.subject(), String.t()) :: String.t() | nil
  defp configured_own_nick(subject, slug) do
    case Map.fetch(BadgeCount.configured_nick_windows(subject), slug) do
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
  @spec maybe_broadcast(Subject.t(), String.t(), String.t(), integer(), non_neg_integer()) ::
          :ok | {:error, term()}
  defp maybe_broadcast(subject, network_slug, channel, last_read_message_id, badge_count) do
    ReadCursor.broadcast_set(
      Subject.topic_label(subject),
      network_slug,
      channel,
      last_read_message_id,
      badge_count
    )
  end
end
