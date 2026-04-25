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
  `{:event, %{kind: :message, message: serialized}}` on the
  per-channel PubSub topic.

  The event wrapper (`kind` + nested `message`) is what Task 7's
  Channel handler will `push/3` verbatim — no re-rendering. The
  serialized message map is single-sourced through
  `Grappa.Scrollback.Message.to_wire/1` so REST and the WS push
  surface emit the same wire shape per CLAUDE.md "every door."

  The catch-all clause requires the path params to still be present
  — a route-config drift that drops `:network_id` or `:channel_id`
  hits `FunctionClauseError` and surfaces as a loud 500 instead of
  silently 400ing. Bad client input (missing/empty/non-string body)
  matches the second clause and returns `{:error, :bad_request}`.
  """
  @spec create(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :bad_request}
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

    {:ok, message} = Scrollback.insert(attrs)
    broadcast_message(network, channel, message)

    conn
    |> put_status(:created)
    |> render(:show, message: message)
  end

  def create(_, %{"network_id" => _, "channel_id" => _}), do: {:error, :bad_request}

  defp broadcast_message(network, channel, %Message{} = message) do
    topic = "grappa:network:#{network}/channel:#{channel}"
    event = %{kind: :message, message: Message.to_wire(message)}
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
