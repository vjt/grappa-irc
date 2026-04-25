defmodule GrappaWeb.MessagesController do
  @moduledoc """
  Read + write surface for `Grappa.Scrollback` messages.

  `index/2` paginates DESC by `(network_id, channel, server_time)`.
  `create/2` (Task 6) inserts a row, returns 201 with the serialized
  message, and broadcasts the new event over `Phoenix.PubSub` on
  `grappa:network:{net}/channel:{chan}` so subscribed Phoenix Channel
  clients (Task 7) and the Phase 6 IRCv3 listener facade see the same
  domain event the REST caller just produced.

  Pagination params (`?before=`, `?limit=`) are validated at the
  boundary per CLAUDE.md: absent params fall back to defaults, but a
  param that is *present and unparseable* (e.g. `?limit=banana`)
  returns `{:error, :bad_request}` via `FallbackController`. Forgiving
  the typo would mask client bugs; that bar is set by the read-only
  nature of this endpoint, not relaxed by it.

  POST body must contain a non-empty string `"body"`. Anything else
  (missing key, empty string, non-string) falls through to the
  catch-all `create/2` clause and returns 400. `sender` is hardcoded
  to `"<local>"` until Task 9 wires the upstream IRC session;
  authenticated client identity lands in Phase 2.

  The `Scrollback` context owns the hard cap on page size; the
  controller's `@default_limit` is the unconfigured-client default,
  not a security boundary.
  """
  use GrappaWeb, :controller

  alias Grappa.Scrollback
  alias Grappa.Scrollback.Message
  alias GrappaWeb.MessagesJSON

  @default_limit 50

  @doc """
  `GET /networks/:network_id/channels/:channel_id/messages` —
  paginated DESC scrollback fetch.

  Optional query params:
    * `before` — `server_time` cursor; only rows strictly less than it
      are returned. Absent: latest page. Unparseable: 400.
    * `limit` — page size (default `#{@default_limit}`, hard cap in
      `Grappa.Scrollback.fetch/4`). Must be a positive integer when
      present. Absent: default. Non-positive or non-integer: 400.
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :bad_request}
  def index(conn, %{"network_id" => network, "channel_id" => channel} = params) do
    with {:ok, cursor} <- parse_cursor(params["before"]),
         {:ok, limit} <- parse_limit(params["limit"]) do
      messages = Scrollback.fetch(network, channel, cursor, limit)
      render(conn, :index, messages: messages)
    end
  end

  @doc """
  `POST /networks/:network_id/channels/:channel_id/messages` —
  inserts a `:privmsg` row with `sender = "<local>"`, returns 201
  with the serialized message, and broadcasts
  `{:event, %{kind: :message, message: serialized, body: body}}` on
  the per-channel PubSub topic.

  The PubSub event carries the already-serialized map (not the
  `%Message{}` struct) so Channel handlers in Task 7 can `push/3` it
  verbatim without re-rendering — keeping wire shape single-sourced
  in `MessagesJSON.data/1`.
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | Ecto.Changeset.t()}
  def create(conn, %{"network_id" => network, "channel_id" => channel, "body" => body})
      when is_binary(body) and body != "" do
    attrs = %{
      network_id: network,
      channel: channel,
      server_time: System.system_time(:millisecond),
      kind: :privmsg,
      sender: "<local>",
      body: body
    }

    with {:ok, message} <- Scrollback.insert(attrs) do
      broadcast_message(network, channel, message)

      conn
      |> put_status(:created)
      |> render(:show, message: message)
    end
  end

  def create(_, _), do: {:error, :bad_request}

  defp broadcast_message(network, channel, %Message{} = message) do
    topic = "grappa:network:#{network}/channel:#{channel}"
    event = %{kind: :message, message: MessagesJSON.data(message), body: message.body}
    :ok = Phoenix.PubSub.broadcast(Grappa.PubSub, topic, {:event, event})
  end

  defp parse_cursor(nil), do: {:ok, nil}

  defp parse_cursor(s) when is_binary(s) do
    case Integer.parse(s) do
      {n, ""} -> {:ok, n}
      _ -> {:error, :bad_request}
    end
  end

  defp parse_limit(nil), do: {:ok, @default_limit}

  defp parse_limit(s) when is_binary(s) do
    case Integer.parse(s) do
      {n, ""} when n > 0 -> {:ok, n}
      _ -> {:error, :bad_request}
    end
  end
end
