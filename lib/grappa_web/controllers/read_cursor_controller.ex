defmodule GrappaWeb.ReadCursorController do
  @moduledoc """
  Write surface for `Grappa.ReadCursor`.

  ## Single endpoint

  `POST /networks/:network_id/channels/:channel_id/read-cursor` with
  body `{"message_id": <int>}`. Returns 200
  `{"last_read_message_id": <int>}`.

  Last-write-wins; the controller is a thin parse + dispatch +
  broadcast layer over `Grappa.ReadCursor.set/4`.

  ## Cross-device broadcast — V4 visitor-parity (2026-05-15)

  After every successful set on EITHER subject kind, the cursor is
  broadcast on the per-channel topic via `ReadCursor.broadcast_set/4`
  so other live cic instances (different tabs / devices) update their
  cursor signal map. No batching, no throttle. Visitor topics use
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

  alias Grappa.ReadCursor
  alias GrappaWeb.Subject

  @doc """
  `POST /networks/:network_id/channels/:channel_id/read-cursor` — set
  the operator's cursor on `(subject, network.id, channel)` to
  `message_id`. Last-write-wins via `ReadCursor.set/4`.
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :invalid_message | Ecto.Changeset.t()}
  def create(conn, %{"channel_id" => channel, "message_id" => message_id})
      when is_integer(message_id) and message_id > 0 do
    subject = Subject.to_session(conn.assigns.current_subject)
    network = conn.assigns.network

    with :ok <- validate_target_name(channel),
         {:ok, cursor} <- ReadCursor.set(subject, network.id, channel, message_id) do
      _ =
        maybe_broadcast(
          conn.assigns.current_subject,
          network.slug,
          channel,
          cursor.last_read_message_id
        )

      json(conn, %{last_read_message_id: cursor.last_read_message_id})
    end
  end

  def create(_, _), do: {:error, :bad_request}

  # Resolves the user-name segment of the per-channel topic for the
  # cross-device broadcast. User subjects use `user.name`; visitors
  # use `"visitor:" <> visitor.id` — same shape `UserSocket` assigns
  # to `:user_name` so visitor cic instances subscribed to their
  # user-rooted topic see the broadcast (V4 visitor-parity,
  # 2026-05-15).
  @spec maybe_broadcast(
          {:user, Grappa.Accounts.User.t()} | {:visitor, Grappa.Visitors.Visitor.t()},
          String.t(),
          String.t(),
          integer()
        ) :: :ok | {:error, term()}
  defp maybe_broadcast({:user, user}, network_slug, channel, last_read_message_id) do
    ReadCursor.broadcast_set(user.name, network_slug, channel, last_read_message_id)
  end

  defp maybe_broadcast({:visitor, visitor}, network_slug, channel, last_read_message_id) do
    ReadCursor.broadcast_set(
      "visitor:" <> visitor.id,
      network_slug,
      channel,
      last_read_message_id
    )
  end
end
