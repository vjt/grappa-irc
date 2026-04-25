defmodule GrappaWeb.MessagesController do
  @moduledoc """
  Read+write surface for `Grappa.Scrollback` messages.

  Phase 1 Task 5 lands `index/2` only (paginated DESC fetch); Task 6
  adds `create/2`. Pagination params (`?before=`, `?limit=`) parse
  silently — bad input falls back to defaults rather than 422 because
  this is a read-only resource whose cursor shape will be revisited in
  Phase 6 (IRCv3 CHATHISTORY). The `Scrollback` context owns the hard
  cap on page size; the controller's `@default_limit` is the
  unconfigured-client default, not a security boundary.
  """
  use GrappaWeb, :controller

  alias Grappa.Scrollback

  @default_limit 50

  @doc """
  `GET /networks/:network_id/channels/:channel_id/messages` —
  paginated DESC scrollback fetch.

  Optional query params:
    * `before` — `server_time` cursor; only rows strictly less than it
      are returned. Omit for the latest page.
    * `limit` — page size (default `#{@default_limit}`, hard cap in
      `Grappa.Scrollback.fetch/4`). Non-positive or non-integer values
      fall back to the default.
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, %{"network_id" => network, "channel_id" => channel} = params) do
    before = parse_cursor(params["before"])
    limit = parse_limit(params["limit"])
    messages = Scrollback.fetch(network, channel, before, limit)
    render(conn, :index, messages: messages)
  end

  defp parse_cursor(nil), do: nil

  defp parse_cursor(s) when is_binary(s) do
    case Integer.parse(s) do
      {n, ""} -> n
      _ -> nil
    end
  end

  defp parse_limit(nil), do: @default_limit

  defp parse_limit(s) when is_binary(s) do
    case Integer.parse(s) do
      {n, ""} when n > 0 -> n
      _ -> @default_limit
    end
  end
end
