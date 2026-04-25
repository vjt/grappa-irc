defmodule GrappaWeb.MessagesController do
  @moduledoc """
  Read + write surface for `Grappa.Scrollback` messages.

  `index/2` paginates DESC by `(network_id, channel, server_time)`.
  `create/2` routes through `Grappa.Session.send_privmsg/4`, which
  persists the row, broadcasts on the per-channel PubSub topic, AND
  sends the PRIVMSG upstream — single source for both the scrollback
  row and the wire event. Without an active session for the network,
  `:no_session` surfaces as a 404 via `FallbackController`.

  Pagination params (`?before=`, `?limit=`) are validated at the
  boundary per CLAUDE.md: absent params fall back to defaults, but a
  param that is *present and unparseable* (e.g. `?limit=banana`)
  returns `{:error, :bad_request}` via `FallbackController`. Forgiving
  the typo would mask client bugs; that bar is set by the read-only
  nature of this endpoint, not relaxed by it.

  POST body must contain a non-empty string `"body"`. Anything else
  (missing key, empty string, non-string) falls through to the
  catch-all `create/2` clause and returns 400. The session's `nick`
  is the persisted sender; Phase 1 hardcodes the user lookup key to
  `"vjt"`, replaced by the authenticated client identity in Phase 2.

  The `Scrollback` context owns the hard cap on page size; the
  controller's `@default_limit` is the unconfigured-client default,
  not a security boundary.
  """
  use GrappaWeb, :controller

  alias Grappa.{Scrollback, Session}

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
  delegates to `Grappa.Session.send_privmsg/4` for the active session
  registered as `("vjt", network)`. The session persists the row with
  `sender = session.nick`, broadcasts the canonical wire event on
  `grappa:network:{net}/channel:{chan}`, and writes the PRIVMSG to the
  upstream socket. Returns 201 with the serialized message on success;
  404 if no session is registered for the network; 400 for malformed
  input.
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :bad_request | :no_session}
          | {:error, Ecto.Changeset.t()}
  def create(conn, %{"network_id" => network, "channel_id" => channel, "body" => body})
      when is_binary(body) and body != "" do
    with {:ok, message} <- Session.send_privmsg(Session.placeholder_user(), network, channel, body) do
      conn
      |> put_status(:created)
      |> render(:show, message: message)
    end
  end

  def create(_, %{"network_id" => _, "channel_id" => _}), do: {:error, :bad_request}

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
