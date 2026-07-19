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

  Pagination params (`?before=`, `?after=`, `?around=`, `?limit=`) are
  validated at the boundary per CLAUDE.md: absent params fall back to
  defaults, but a param that is *present and unparseable* (e.g.
  `?limit=banana`) returns `{:error, :bad_request}` via
  `FallbackController`. Forgiving the typo would mask client bugs;
  that bar is set by the read-only nature of this endpoint, not
  relaxed by it. `?before=` / `?after=` / `?around=` are mutually
  exclusive — supplying any two together returns 400.

  Cursor semantics (post-CP29 R-2): all three cursors are integer
  `messages.id` values. `?before=<id>` was previously `server_time`
  ms; the flip eliminated same-millisecond ties straddling page
  boundaries. Display order is unchanged (DESC by `(server_time,
  id)`); only the cursor key flipped.

  POST body must contain a non-empty string `"body"`. Anything else
  (missing key, empty string, non-string) falls through to the
  catch-all `create/2` clause and returns 400. The session's `nick`
  is the persisted sender.

  The `Scrollback` context owns the hard cap on page size; the
  controller's `@default_limit` is the unconfigured-client default,
  not a security boundary.
  """
  use GrappaWeb, :controller

  import GrappaWeb.Validation, only: [validate_target_name: 1, validate_post_target_name: 1]

  alias Grappa.RateLimit.TokenBucket
  alias Grappa.{Scrollback, Session}
  alias GrappaWeb.{BodyLimit, Subject}

  @default_limit 50
  @max_http_limit 200

  # #340 — inbound send-throttle. Each POST consumes one token from a
  # per-`(subject, network)` bucket; an empty bucket is a 429 BEFORE the
  # send reaches upstream, so cic gets "slow down" before bahamut k-lines
  # the user for flooding. Capacity/refill sit at or below the upstream
  # flood allowance (see `config :grappa, :send_throttle`). Boot-time
  # config per CLAUDE.md (`Application.get_env` at runtime is banned).
  @send_throttle_bucket :message_send
  @send_throttle_capacity Application.compile_env(:grappa, [:send_throttle, :capacity], 10)
  @send_throttle_refill_per_sec Application.compile_env(
                                  :grappa,
                                  [:send_throttle, :refill_per_sec],
                                  2
                                )

  @doc """
  `GET /networks/:network_id/channels/:channel_id/messages` —
  paginated scrollback fetch for the authenticated subject.

  Optional query params (cursors are mutually exclusive — any two of
  `before` / `after` / `around` together returns 400):

    * `before` — `id` cursor; returns rows whose `id` is strictly
      LESS than the value, in DESCENDING `(server_time, id)` order
      (newest first). Used by cic's loadMore (scroll-up) flow.
    * `after` — `id` cursor; returns rows whose `id` is strictly
      GREATER than the value, in ASCENDING `id` order (newest at the
      bottom). Used by cic's reconnect-backfill flow + R-5
      refresh-on-WS-join-ok.
    * `around` — `id` cursor; returns up to `floor(limit/2)` rows
      with `id <= around` plus up to `ceil(limit/2)` rows with `id >
      around`, merged DESC. Used by R-4's "open window centered on
      cursor" flow when the user opens a channel with an existing
      read cursor.
    * Absent: latest page (DESC, no cursor).
    * `limit` — page size (default `#{@default_limit}`, HTTP ceiling
      `#{@max_http_limit}` enforced at the boundary; `Grappa.Scrollback`
      caps internally at 500 as a backstop). Must be a positive
      integer when present. Absent: default. Non-positive,
      non-integer, or > `#{@max_http_limit}`: 400.

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

    with :ok <- validate_target_name(channel),
         {:ok, direction} <- parse_direction(params),
         {:ok, limit} <- parse_limit(params["limit"]) do
      own_nick =
        case Session.current_nick(subject, network.id) do
          {:ok, nick} -> nick
          {:error, :no_session} -> nil
        end

      messages =
        case direction do
          {:before, cursor} ->
            Scrollback.fetch(subject, network.id, channel, cursor, limit, own_nick)

          {:after, after_id} ->
            Scrollback.fetch_after(subject, network.id, channel, after_id, limit, own_nick)

          {:around, around_id} ->
            Scrollback.fetch_around(subject, network.id, channel, around_id, limit, own_nick)
        end

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
          | {:error, :bad_request | :no_session | :invalid_line | :rate_limited}
          | {:error, Ecto.Changeset.t()}
  def create(conn, %{"channel_id" => channel, "body" => body})
      when is_binary(body) and body != "" do
    subject = Subject.to_session(conn.assigns.current_subject)
    network = conn.assigns.network

    # Target shape check is :bad_request; accepts both channel-sigil and
    # nick targets so DM sends work (C4 fix-up). Rejects `$server`
    # synthetic — that's read-only (codebase review 2026-05-08 W1).
    # The body's CRLF/NUL check happens inside Session.send_privmsg
    # and surfaces as :invalid_line. Two distinct error tags so client
    # UX can branch.
    #
    # #340 — the send-throttle is checked AFTER shape validation (a
    # malformed request can't cause an upstream flood so it shouldn't burn
    # a token) but BEFORE `send_privmsg` (the throttle's whole job is to
    # gate the send before it hits the wire). An empty bucket short-circuits
    # to `{:error, :rate_limited}` → FallbackController renders 429.
    with :ok <- BodyLimit.check(body),
         :ok <- validate_post_target_name(channel),
         :ok <- take_send_token(subject, network.id),
         {:ok, result} <- Session.send_privmsg(subject, network.id, channel, body) do
      render_send_result(conn, result)
    end
  end

  def create(_, %{"channel_id" => _}), do: {:error, :bad_request}

  # #340 — consume one send-token for `(subject, network)`. `:ok` rides
  # through the `with`; `{:error, :rate_limited}` short-circuits it to the
  # FallbackController 429 clause.
  @spec take_send_token(Session.subject(), integer()) :: :ok | {:error, :rate_limited}
  defp take_send_token(subject, network_id) do
    TokenBucket.take(
      @send_throttle_bucket,
      {subject, network_id},
      @send_throttle_capacity,
      @send_throttle_refill_per_sec
    )
  end

  # `Session.send_privmsg/4`'s contract returns either:
  #   * `{:ok, %Scrollback.Message{}}` — channel- or user-targeted PRIVMSG
  #     with a persisted scrollback row + per-channel PubSub broadcast.
  #   * `{:ok, :no_persist}` — *serv-targeted PRIVMSG (NickServ IDENTIFY,
  #     ChanServ REGISTER, etc.) — wire-only, no scrollback row, no
  #     PubSub broadcast (W12 credential leak avoidance, codified in
  #     `Grappa.IRC.Identifier.services_sender?/1`).
  #
  # UX-4 bucket G: pre-fix the controller's `with {:ok, message} <- ...`
  # silently fell through on `{:ok, :no_persist}` — the `with` returned
  # the no-persist tag verbatim, FallbackController has no `{:ok, _}`
  # clause, and Phoenix raised on the unsent conn → 500. Split into
  # two arms here so the type contract is honored without a discriminator
  # leak into the `with` chain.
  defp render_send_result(conn, %Scrollback.Message{} = message) do
    conn
    |> put_status(:created)
    |> render(:show, message: message)
  end

  defp render_send_result(conn, :no_persist) do
    conn
    |> put_status(:accepted)
    |> json(%{ok: true})
  end

  # Cursor mutex: at most one of `before` / `after` / `around`. Two or
  # more present together silently picking one would mask client bugs;
  # 400 is the right answer (consistent with the rest of this
  # controller's "present-and-unparseable = 400" rule).
  defp parse_direction(params) do
    cursors =
      Enum.reject(
        [{:before, params["before"]}, {:after, params["after"]}, {:around, params["around"]}],
        fn {_, v} -> is_nil(v) end
      )

    case cursors do
      [] -> {:ok, {:before, nil}}
      [{tag, raw}] -> with {:ok, n} <- parse_int(raw), do: {:ok, {tag, n}}
      _ -> {:error, :bad_request}
    end
  end

  defp parse_int(s) when is_binary(s) do
    case Integer.parse(s) do
      {n, ""} -> {:ok, n}
      _ -> {:error, :bad_request}
    end
  end

  defp parse_limit(nil), do: {:ok, @default_limit}

  # HTTP-boundary ceiling per CLAUDE.md "Validate at the boundary". The
  # underlying `Grappa.Scrollback` cap (500) stays as an internal
  # backstop; an HTTP request that asks for 5000 rows is a client bug,
  # not something to silently clamp.
  defp parse_limit(s) when is_binary(s) do
    case Integer.parse(s) do
      {n, ""} when n > 0 and n <= @max_http_limit -> {:ok, n}
      _ -> {:error, :bad_request}
    end
  end
end
