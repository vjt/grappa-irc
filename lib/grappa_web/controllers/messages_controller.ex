defmodule GrappaWeb.MessagesController do
  @moduledoc """
  Read surface for `Grappa.Scrollback` messages. Phase 1 Task 5 lands
  `index/2` only; Task 6 adds `create/2` to the same nested path.

  Pagination params (`?before=`, `?limit=`) are validated at the
  boundary per CLAUDE.md: absent params fall back to defaults, but a
  param that is *present and unparseable* (e.g. `?limit=banana`)
  returns `{:error, :bad_request}` via `FallbackController`. Forgiving
  the typo would mask client bugs; that bar is set by the read-only
  nature of this endpoint, not relaxed by it.

  The `Scrollback` context owns the hard cap on page size; the
  controller's `@default_limit` is the unconfigured-client default,
  not a security boundary.
  """
  use GrappaWeb, :controller

  alias Grappa.Scrollback

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
