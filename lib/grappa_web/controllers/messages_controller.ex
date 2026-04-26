defmodule GrappaWeb.MessagesController do
  @moduledoc """
  Read + write surface for `Grappa.Scrollback` messages.

  `index/2` paginates DESC by `(user_id, network_id, channel,
  server_time)` — the `user_id` partition is the load-bearing per-user
  iso boundary (Phase 2 sub-task 2e). The URL `:network_id` is a
  network slug; this controller resolves it to the integer FK via
  `Networks.get_network_by_slug/1` so the scrollback surface stays
  internally typed.

  `create/2` routes through `Grappa.Session.send_privmsg/4`, which
  persists the row, broadcasts on the per-channel PubSub topic, AND
  sends the PRIVMSG upstream — single source for both the scrollback
  row and the wire event. The lookup is keyed by
  `(conn.assigns.current_user_id, network.id)` end-to-end (sub-task
  2g) so two users on the same network land in different sessions.
  Unknown network slug → 404 `:not_found`; known slug but no session
  → 404 `:no_session`; both via `FallbackController`.

  Pagination params (`?before=`, `?limit=`) are validated at the
  boundary per CLAUDE.md: absent params fall back to defaults, but a
  param that is *present and unparseable* (e.g. `?limit=banana`)
  returns `{:error, :bad_request}` via `FallbackController`. Forgiving
  the typo would mask client bugs; that bar is set by the read-only
  nature of this endpoint, not relaxed by it.

  POST body must contain a non-empty string `"body"`. Anything else
  (missing key, empty string, non-string) falls through to the
  catch-all `create/2` clause and returns 400. The session's `nick`
  is the persisted sender.

  The `Scrollback` context owns the hard cap on page size; the
  controller's `@default_limit` is the unconfigured-client default,
  not a security boundary.
  """
  use GrappaWeb, :controller

  alias Grappa.{Networks, Repo, Scrollback, Session}

  @default_limit 50

  @doc """
  `GET /networks/:network_id/channels/:channel_id/messages` —
  paginated DESC scrollback fetch for the authenticated user.

  Optional query params:
    * `before` — `server_time` cursor; only rows strictly less than it
      are returned. Absent: latest page. Unparseable: 400.
    * `limit` — page size (default `#{@default_limit}`, hard cap in
      `Grappa.Scrollback.fetch/5`). Must be a positive integer when
      present. Absent: default. Non-positive or non-integer: 400.

  Unknown network slug: 404 (`{:error, :not_found}` via Networks).
  """
  @spec index(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :not_found}
  def index(conn, %{"network_id" => slug, "channel_id" => channel} = params) do
    user_id = conn.assigns.current_user_id

    with {:ok, cursor} <- parse_cursor(params["before"]),
         {:ok, limit} <- parse_limit(params["limit"]),
         {:ok, network} <- Networks.get_network_by_slug(slug) do
      messages =
        user_id
        |> Scrollback.fetch(network.id, channel, cursor, limit)
        |> preload_networks(network)

      render(conn, :index, messages: messages)
    end
  end

  @doc """
  `POST /networks/:network_id/channels/:channel_id/messages` —
  delegates to `Grappa.Session.send_privmsg/4` for the active session
  registered as `(current_user_id, network.id)`. The session persists
  the row with `sender = session.nick`, broadcasts the canonical wire
  event on the per-channel topic, and writes the PRIVMSG to the
  upstream socket. Returns 201 with the serialized message on success;
  404 if the network slug is unknown OR no session is registered for
  the (user, network) pair; 400 for malformed input.
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :bad_request | :not_found | :no_session}
          | {:error, Ecto.Changeset.t()}
  def create(conn, %{"network_id" => slug, "channel_id" => channel, "body" => body})
      when is_binary(body) and body != "" do
    user_id = conn.assigns.current_user_id

    with {:ok, network} <- Networks.get_network_by_slug(slug),
         {:ok, message} <- Session.send_privmsg(user_id, network.id, channel, body) do
      conn
      |> put_status(:created)
      |> render(:show, message: Repo.preload(message, :network))
    end
  end

  def create(_, %{"network_id" => _, "channel_id" => _}), do: {:error, :bad_request}

  # Single-network fetch — the network struct is known; preload
  # in-place rather than issuing N+1 SELECTs through Repo.preload.
  defp preload_networks(messages, network) do
    Enum.map(messages, &%{&1 | network: network})
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
