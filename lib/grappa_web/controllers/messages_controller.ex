defmodule GrappaWeb.MessagesController do
  @moduledoc """
  Read + write surface for `Grappa.Scrollback` messages.

  `index/2` paginates DESC by `(user_id, network_id, channel,
  server_time)` — the `user_id` partition is the load-bearing per-user
  iso boundary (Phase 2 sub-task 2e). The URL `:network_id` slug →
  schema struct resolution + per-user credential check happens in
  `GrappaWeb.Plugs.ResolveNetwork`; this controller reads
  `conn.assigns.network` and never re-resolves.

  `create/2` routes through `Grappa.Session.send_privmsg/4`, which
  persists the row, broadcasts on the per-channel PubSub topic, AND
  sends the PRIVMSG upstream — single source for both the scrollback
  row and the wire event. The lookup is keyed by the
  `t:Grappa.Session.subject/0` ID-tuple resolved from
  `conn.assigns.current_subject` via `GrappaWeb.Subject.to_session/1`
  + `network.id` end-to-end (sub-task 2g) so two subjects on the same
  network land in different sessions.
  Unknown slug, not-your-network, and known-slug-but-no-session all
  surface as the same uniform 404 `{"error": "not_found"}` body via
  `FallbackController` (CP10 S14 oracle close). The internal
  `:no_session` tag is preserved in `Session` boundary @specs and
  operator log lines for tracing, but never reaches the wire.

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

  import GrappaWeb.Validation, only: [validate_target_name: 1]

  alias Grappa.{Scrollback, Session}
  alias GrappaWeb.Subject

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

  Unknown slug, no credential, or wrong-user network all collapse to
  404 `not_found` via `Plugs.ResolveNetwork` BEFORE this action runs;
  the action consumes `conn.assigns.network` (the resolved schema
  struct) without re-resolving (S14 oracle close).
  """
  @spec index(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request}
  def index(conn, %{"channel_id" => channel} = params) do
    subject = Subject.to_session(conn.assigns.current_subject)
    network = conn.assigns.network

    # Reject malformed target shape with 400. Accepts both channel-sigil
    # names (#chan, &local, etc.) and nick-shaped targets for DM scrollback
    # fetch. Without this, an invalid segment would fall through to
    # `Scrollback.fetch/5` and return 200 + empty list, hiding the typo.
    with :ok <- validate_target_name(channel),
         {:ok, cursor} <- parse_cursor(params["before"]),
         {:ok, limit} <- parse_limit(params["limit"]) do
      # `:network` is preloaded by `Scrollback.fetch/5` itself —
      # the boundary contract returns wire-shape-ready rows. No
      # post-fetch preload helper here; A26 collapsed the
      # controller's `preload_networks/2` into the Scrollback
      # boundary so the contract is single-sourced.
      messages = Scrollback.fetch(subject, network.id, channel, cursor, limit)

      render(conn, :index, messages: messages)
    end
  end

  @doc """
  `POST /networks/:network_id/channels/:channel_id/messages` —
  delegates to `Grappa.Session.send_privmsg/4` for the active session
  registered as `(subject, network.id)` where `subject` is the
  `t:Grappa.Session.subject/0` ID-tuple. The session persists
  the row with `sender = session.nick`, broadcasts the canonical wire
  event on the per-channel topic, and writes the PRIVMSG to the
  upstream socket. Returns 201 with the serialized message on success;
  404 `not_found` for unknown slug / no credential / no session (all
  collapsed by `Plugs.ResolveNetwork` + `FallbackController`'s
  `:no_session` clause); 400 for malformed input.
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :bad_request | :no_session | :invalid_line}
          | {:error, Ecto.Changeset.t()}
  def create(conn, %{"channel_id" => channel, "body" => body})
      when is_binary(body) and body != "" do
    subject = Subject.to_session(conn.assigns.current_subject)
    network = conn.assigns.network

    # Target shape check is :bad_request; accepts both channel-sigil and
    # nick targets so DM sends work (C4 fix-up). The body's CRLF/NUL check
    # happens inside Session.send_privmsg and surfaces as :invalid_line.
    # Two distinct error tags so client UX can branch.
    with :ok <- validate_target_name(channel),
         {:ok, message} <- Session.send_privmsg(subject, network.id, channel, body) do
      # `:network` is preloaded by `Scrollback.persist_event/1` —
      # the Session contract returns a wire-shape-ready row. Don't
      # re-preload here; reaching across to Repo from the controller
      # would re-introduce the cross-boundary dep that A4 closed.
      conn
      |> put_status(:created)
      |> render(:show, message: message)
    end
  end

  def create(_, %{"channel_id" => _}), do: {:error, :bad_request}

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
