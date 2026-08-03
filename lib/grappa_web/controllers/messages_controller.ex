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
  row and the wire event. #640: a POST carrying `"ctcp_target"` is a
  CTCP QUERY (`/ctcp`, `/ping`) instead — it routes through
  `Grappa.Session.send_ctcp/5`, where the URL `channel_id` is the SOURCE
  window the echo renders in and `ctcp_target` is the wire recipient; no
  query window is ever opened for the recipient (a control-surface probe
  is not a conversation). The lookup is keyed by the
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

  alias Grappa.IRC.Identifier
  alias Grappa.{PresenceFilter, Scrollback, Session, UserSettings}
  alias Grappa.RateLimit.TokenBucket
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
  @send_throttle_capacity Application.compile_env(:grappa, [:send_throttle, :capacity], 5)
  @send_throttle_refill_per_sec Application.compile_env(
                                  :grappa,
                                  [:send_throttle, :refill_per_sec],
                                  0.5
                                )

  # #666 — seconds until one token refills; the client-facing retry hint on a
  # send-door 429. Derived from THIS bucket's refill — NOT
  # `RequestBudget.retry_after_ms/0`, which reads the coarse #630 budget's much
  # faster refill and would pace cic against the wrong bucket (re-429ing every
  # line of a paste). `ceil` so cic never under-waits and re-trips instantly;
  # `max(1, _)` guards a sub-second config from flooring to 0. HTTP Retry-After
  # is integer seconds (RFC 7231 §7.1.3) — coarse but honest for this bucket.
  @send_throttle_retry_after_seconds max(1, ceil(1.0 / @send_throttle_refill_per_sec))

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
      # #537 INC-2.3 — normalise the USER-TYPED key to the network's
      # CASEMAPPING at this ingress so an rfc1459 `#Foo[1]` resolves to the one
      # window the Server keyed folded (`#foo{1}`). `:ascii` (no live session,
      # or an ascii network) is byte-identical to the pure-ASCII fold Scrollback
      # applies internally, so prod is unchanged. Every downstream read
      # (Scrollback, hide_presence, presence_channel_key) now sees the folded
      # key — the stateless controller's twin of the Server's `fold_key/2`.
      channel = Identifier.canonical_target(channel, Session.casemapping(subject, network.id))

      own_nick =
        case Session.current_nick(subject, network.id) do
          {:ok, nick} -> nick
          {:error, :no_session} -> nil
        end

      hide_presence = resolve_hide_presence(subject, network, channel)

      messages =
        case direction do
          {:before, cursor} ->
            Scrollback.fetch(subject, network.id, channel, cursor, limit, own_nick, hide_presence)

          {:after, after_id} ->
            Scrollback.fetch_after(subject, network.id, channel, after_id, limit, own_nick, hide_presence)

          {:around, around_id} ->
            Scrollback.fetch_around(subject, network.id, channel, around_id, limit, own_nick, hide_presence)
        end

      render(conn, :index, messages: messages)
    end
  end

  @doc """
  `GET /networks/:network_id/channels/:channel_id/messages/count?after=<id>`
  — the #693 gap probe. Returns `{"count": N}`: how many rows this subject
  would be handed by `index/2`'s `?after=<id>` page if that page had no
  ceiling.

  Exists because a full page is not a measurement. cic's resume paths
  fetch `?after=<anchor>&limit=#{@max_http_limit}`; a full page proves
  only "at least #{@max_http_limit} more", which cannot distinguish a gap
  that one more fetch drains from one running to thousands of rows — and
  the two want opposite recoveries (drain forward vs abandon the anchor
  and land at the tail). `Grappa.Scrollback.count_after/6` is deliberately
  uncapped, and applies the same subject / channel-or-DM / presence
  predicates `index/2` applies, so the number describes the rows cic would
  actually render.

  `after` is REQUIRED and must be a non-negative integer — 400 otherwise.
  There is no "count everything" default: every caller is asking about a
  specific anchor it holds, and a silent `after=0` would answer a
  question nobody asked.
  """
  @spec count(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :bad_request}
  def count(conn, %{"channel_id" => channel} = params) do
    subject = Subject.to_session(conn.assigns.current_subject)
    network = conn.assigns.network

    with :ok <- validate_target_name(channel),
         {:ok, after_id} <- parse_after(params["after"]) do
      # Same ingress fold as `index/2` (#537): the caller's spelling resolves
      # to the one window the Server keyed folded.
      channel = Identifier.canonical_target(channel, Session.casemapping(subject, network.id))

      own_nick =
        case Session.current_nick(subject, network.id) do
          {:ok, nick} -> nick
          {:error, :no_session} -> nil
        end

      count =
        Scrollback.count_after(
          subject,
          network.id,
          channel,
          after_id,
          own_nick,
          resolve_hide_presence(subject, network, channel)
        )

      render(conn, :count, count: count)
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
          | {:error, :bad_request | :no_session | :invalid_line | {:rate_limited, pos_integer()}}
          | {:error, Ecto.Changeset.t()}
  def create(conn, %{"channel_id" => channel, "body" => body, "ctcp_target" => ctcp_target})
      when is_binary(body) and body != "" and is_binary(ctcp_target) and ctcp_target != "" do
    subject = Subject.to_session(conn.assigns.current_subject)
    network = conn.assigns.network

    # #640 — a CTCP QUERY (/ctcp, /ping). `channel` (the URL) is the SOURCE
    # window the echo renders in — `validate_target_name` (NOT the post variant)
    # so `$server` is allowed (a /ping typed in the server window is legit).
    # `ctcp_target` is the wire recipient — `validate_post_target_name` (a real
    # channel/nick, never the read-only `$server`). The session persists the
    # echo to `source`, relays the frame to `ctcp_target`, and NEVER opens a
    # query window for it (the phantom-window bug). One send-token as for a
    # plain PRIVMSG. `send_ctcp` always persists a row (no `:no_persist` arm).
    with :ok <- BodyLimit.check(body),
         :ok <- validate_target_name(channel),
         :ok <- validate_post_target_name(ctcp_target),
         :ok <- take_send_token(subject, network.id),
         {:ok, result} <- Session.send_ctcp(subject, network.id, channel, ctcp_target, body) do
      render_send_result(conn, result)
    end
  end

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
  # through the `with`; a refusal short-circuits it to the FallbackController
  # 429 clause.
  #
  # #666 — a refused take is tagged `{:rate_limited, retry_after_seconds}`
  # (the tuple shape `FallbackController` renders with a `retry-after` header),
  # carrying THIS bucket's own refill interval so cic paces the remaining
  # lines of a multi-line paste against the bucket that actually refused —
  # NOT the coarse #630 budget. The bare `:rate_limited` atom stays reserved
  # for the #75 themes daily quota (no meaningful seconds hint).
  @spec take_send_token(Session.subject(), integer()) ::
          :ok | {:error, {:rate_limited, pos_integer()}}
  defp take_send_token(subject, network_id) do
    case TokenBucket.take(
           @send_throttle_bucket,
           {subject, network_id},
           @send_throttle_capacity,
           @send_throttle_refill_per_sec
         ) do
      :ok -> :ok
      {:error, :rate_limited} -> {:error, {:rate_limited, @send_throttle_retry_after_seconds}}
    end
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

  # #458 — resolve "should the history reads omit presence for this channel?"
  # from the server-owned tri-state pref (#449) + live member count. The
  # server evaluates the tri-state itself (issue paletto: never a client
  # boolean) so every device converges on one decision. `Session.list_members/3`
  # is called ONLY when the pref is unset — an explicit show/hide needs no
  # count, so the common case skips the GenServer round-trip.
  defp resolve_hide_presence(subject, network, channel) do
    prefs = UserSettings.get_display_prefs(subject)
    pref = Map.get(prefs.presence_filter, presence_channel_key(network, channel))
    PresenceFilter.hidden?(pref, member_count_for_unset(pref, subject, network.id, channel))
  end

  # Rebuild cic's opaque ChannelKey (`cicchetto/src/lib/channelKey.ts`):
  # "<slug> <canonical_channel>" — so a request in any casing resolves to the
  # same stored pin. #537 — `index/2` already network-folded `channel` to the
  # CASEMAPPING at the ingress, so on rfc1459 this matches cic's ChannelKey
  # (built from the server's folded key); the fold here is the idempotent
  # ASCII backstop (bahamut/ascii: byte-identical, prod unchanged).
  defp presence_channel_key(network, channel),
    do: "#{network.slug} #{Identifier.canonical_target(channel)}"

  defp member_count_for_unset(nil, subject, network_id, channel) do
    case Session.list_members(subject, network_id, channel) do
      {:ok, members} when is_list(members) -> length(members)
      # :uninitialized (names not yet seeded) or :no_session — count unknowable
      # → decision D: PresenceFilter.hidden?/2 treats nil as SHOW.
      _ -> nil
    end
  end

  # Explicit show/hide: the count is irrelevant, skip the Session call.
  defp member_count_for_unset(_, _, _, _), do: nil

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

  # #693 — `?after=` for the count probe: required, and non-negative because
  # an anchor is a row id (or 0 for "from the beginning"). A negative anchor
  # is a client bug, not a request to count everything.
  defp parse_after(s) when is_binary(s) do
    case parse_int(s) do
      {:ok, n} when n >= 0 -> {:ok, n}
      _ -> {:error, :bad_request}
    end
  end

  defp parse_after(nil), do: {:error, :bad_request}

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
