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
  is not a conversation). #1225: a POST carrying `"notice_target"` is an
  outbound NOTICE (`/notice`) on the same source-window shape, via
  `Grappa.Session.send_notice/5` — a NOTICE opens no window either, and
  the recipient may be a nick OR a channel. issue 2179: a POST carrying
  `"statusmsg_target"` is an ops-only channel PRIVMSG (`/msg @#chan`) via
  `Grappa.Session.send_statusmsg/4`, and it is the one relay arm whose
  recipient DECIDES the window rather than riding as payload — the echo is
  keyed to the channel behind the sigil, where the ingress router already
  files every other member's copy of the same wire line. The three relay
  keys are mutually exclusive; any two together is a 400. The lookup is keyed by the
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
  relaxed by it. `?before=` / `?after=` / `?around=` and the time cursors
  `?before_time=` / `?after_time=` / `?around_time=` (issue 2372) are ONE
  mutually exclusive set — supplying any two together returns 400.

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

  import GrappaWeb.Validation,
    only: [
      validate_target_name: 1,
      validate_post_target_name: 1,
      validate_wire_recipient_name: 2,
      validate_statusmsg_recipient: 4
    ]

  alias Grappa.IRC.Identifier
  alias Grappa.PresenceFilter.Resolver
  alias Grappa.RateLimit.TokenBucket
  alias Grappa.{Scrollback, Session}
  alias Grappa.Session.FloodAllowance
  alias GrappaWeb.{BodyLimit, ReadCursorAdvance, Subject}

  require Logger

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

  # #480 — the pair for a connection the upstream meters on its OPER path.
  # Same bucket, same key, wider numbers: a session that gains (or loses)
  # `+o` mid-burst simply has its stored level re-capped on the next take,
  # which is the honest reading of "the allowance changed".
  @send_throttle_oper_capacity Application.compile_env(
                                 :grappa,
                                 [:send_throttle, :oper_capacity],
                                 50
                               )
  @send_throttle_oper_refill_per_sec Application.compile_env(
                                       :grappa,
                                       [:send_throttle, :oper_refill_per_sec],
                                       5.0
                                     )
  @send_throttle_oper_retry_after_seconds max(1, ceil(1.0 / @send_throttle_oper_refill_per_sec))

  @doc """
  `GET /networks/:network_id/channels/:channel_id/messages` —
  paginated scrollback fetch for the authenticated subject.

  Optional query params (cursors are mutually exclusive — any two of
  `before` / `after` / `around` / `before_time` / `after_time` /
  `around_time` together returns 400):

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
    * `before_time` / `after_time` / `around_time` (issue 2372) — the same
      three shapes keyed on TIME: a decimal epoch-ms integer (`0` to int64
      max; anything else is 400), filtered STRICTLY on `server_time` and
      ordered by `(server_time, id)`. Rows sharing the bound millisecond are
      excluded by both `before_time` and `after_time`; page onward with the
      id cursors. See `Grappa.Scrollback.fetch_by_time/7`.
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

          {:time, cursor} ->
            Scrollback.fetch_by_time(subject, network.id, channel, cursor, limit, own_nick, hide_presence)
        end

      render(conn, :index, messages: messages)
    end
  end

  @doc """
  `GET /networks/:network_id/channels/:channel_id/messages/count?after=<id>`
  — the #693 gap probe. Returns `{"count": N, "messages": M, "events": E}`.

  `count` is how many rows this subject would be handed by `index/2`'s
  `?after=<id>` page if that page had no ceiling — the THRESHOLD's feed,
  unchanged. `messages` + `events` are the #2037 DISPLAY split: the same
  `@content_kinds` partition the sidebar pills carry, so the far-behind bar
  renders `messages` instead of a third opinion on a quantity that already
  has one.

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

  ## `cap` — the THRESHOLD-only mode (issue 2282)

  Optional, positive integer. Present, the response carries `count` ALONE,
  saturating at `cap`: `{"count": min(real, cap)}`, and `count == cap` reads
  "at least `cap`". The display split is not computed at all.

  It exists because the two questions have different costs and only one of
  them gates cic's paint. Measured on a 372,651-row synthetic corpus at a
  200,014-row gap: the pair costs 82 ms and 12,963,811 VM steps, of which the
  split is 57 ms; the same threshold answered with `cap = 201` costs 1 ms and
  4,304 steps. cic's branch `isFarBehind(gap) === gap > PAGE_LIMIT` needs only
  the boolean, so a capped probe decides it and the split follows AFTER the
  rows are on screen.

  The mode is a REQUEST param and not a new route precisely so the two sides
  land separately, in both directions:

    * a capped client against a server predating this — the unknown param is
      ignored, the old three-key body comes back, and `count` still answers
      the threshold correctly. Slower, never wrong.
    * an old client against this server — never sends `cap`, gets the
      byte-identical three-key body.

  Rejected: 400 for `cap=0` (a saturating count that can never saturate reads
  NEAR for every gap), for negatives, for non-integers, and for the
  list/map shapes `Plug.Conn.Query` decodes `?cap[]=1` into.
  """
  @spec count(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :bad_request}
  def count(conn, %{"channel_id" => channel} = params) do
    subject = Subject.to_session(conn.assigns.current_subject)
    network = conn.assigns.network

    with :ok <- validate_target_name(channel),
         {:ok, after_id} <- parse_after(params["after"]),
         {:ok, cap} <- parse_cap(params["cap"]) do
      # Same ingress fold as `index/2` (#537): the caller's spelling resolves
      # to the one window the Server keyed folded.
      channel = Identifier.canonical_target(channel, Session.casemapping(subject, network.id))

      own_nick =
        case Session.current_nick(subject, network.id) do
          {:ok, nick} -> nick
          {:error, :no_session} -> nil
        end

      # #2037 — resolved ONCE and threaded into BOTH doors. The two counts
      # used to be reached from different surfaces (this route for the bar,
      # `/me`'s `bulk_unread_split/3` for the pills), each resolving the
      # presence posture through its own `PresenceFilter.Resolver` door at
      # its own instant. Measured: one disagreement between those doors puts
      # the whole suppressed-presence population between the two numbers.
      # Within one request that cannot happen — there is one resolution and
      # both doors get it.
      hide_presence = resolve_hide_presence(subject, network, channel)

      count =
        Scrollback.count_after(subject, network.id, channel, after_id, own_nick, hide_presence, cap)

      # The DISPLAY split. `count` stays the threshold's raw feed (#693, and
      # out of scope per the #2037 ruling); `messages` is what the far-behind
      # bar renders, and it is the same partition the sidebar's bold pill
      # already shows.
      #
      # issue 2282 — SKIPPED entirely in the capped mode. Not "computed and
      # dropped": it is the 57 ms of the 82 ms, and the whole point of the cap
      # is that the caller asking the threshold has not asked this question
      # yet. A caller that wants both asks twice, the second time off the
      # paint path.
      split =
        if cap == nil do
          Scrollback.count_after_split(
            subject,
            network.id,
            channel,
            after_id,
            own_nick,
            hide_presence
          )
        end

      render(conn, :count, count: count, split: split)
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

  issue 2407 — a send that persisted a row (every arm but a services
  target) also advances the subject's read cursor on the window the row
  landed in, to that row, and fans it out like a `POST .../read-cursor`:
  replying in a window reads what came before it.
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :bad_request | :no_session | :invalid_line | {:rate_limited, pos_integer()}}
          | {:error, Ecto.Changeset.t()}
  # #1225 — two relay verbs in one POST is not a shape any client can mean.
  # Refuse it explicitly: leaving it to clause ORDER would make the winner an
  # accident of where the arms sit in this file.
  #
  # issue 2179 — written as a PAIRWISE guard over the relay keys rather than
  # one literal head per combination: with a third key the head-per-pair form
  # is three clauses, and the next key makes it six. `is_map_key/2` is
  # guard-safe, so the rule stays one clause and stays TOTAL — a fourth relay
  # key adds one disjunct per existing key instead of a combinatorial fan.
  def create(_, %{"channel_id" => _} = params)
      when (is_map_key(params, "ctcp_target") and is_map_key(params, "notice_target")) or
             (is_map_key(params, "ctcp_target") and is_map_key(params, "statusmsg_target")) or
             (is_map_key(params, "notice_target") and is_map_key(params, "statusmsg_target")),
      do: {:error, :bad_request}

  def create(conn, %{"channel_id" => channel, "body" => body, "ctcp_target" => ctcp_target})
      when is_binary(body) and body != "" and is_binary(ctcp_target) and ctcp_target != "" do
    subject = Subject.to_session(conn.assigns.current_subject)
    network = conn.assigns.network

    # #640 — a CTCP QUERY (/ctcp, /ping). `channel` (the URL) is the SOURCE
    # window the echo renders in — `validate_target_name` (NOT the post variant)
    # so `$server` is allowed (a /ping typed in the server window is legit).
    # `ctcp_target` is the wire recipient — `validate_wire_recipient_name` (a
    # real channel/nick, a channel at a membership level, never the read-only
    # `$server`). The session persists the echo to `source`, relays the frame
    # to `ctcp_target`, and NEVER opens a query window for it (the
    # phantom-window bug). One send-token as for a plain PRIVMSG. `send_ctcp`
    # always persists a row (no `:no_persist` arm).
    with :ok <- BodyLimit.check(body),
         :ok <- validate_target_name(channel),
         :ok <- validate_wire_recipient_name(ctcp_target, Session.statusmsg(subject, network.id)),
         :ok <- take_send_token(subject, network.id),
         {:ok, result} <- Session.send_ctcp(subject, network.id, channel, ctcp_target, body) do
      finish_send(conn, result, network.slug)
    end
  end

  def create(conn, %{"channel_id" => channel, "body" => body, "notice_target" => notice_target})
      when is_binary(body) and body != "" and is_binary(notice_target) and notice_target != "" do
    subject = Subject.to_session(conn.assigns.current_subject)
    network = conn.assigns.network

    # #1225 — `/notice <target> <text>`. Same door shape as the #640 CTCP arm
    # above: `channel` (the URL) is the SOURCE window the echo renders in, so it
    # takes `validate_target_name` (a `/notice` typed in `$server` is legit);
    # `notice_target` is the wire recipient, so it takes the recipient variant
    # (a real nick or channel, or a channel at a membership level per #1301,
    # never the read-only `$server`). One send-token, as for a plain PRIVMSG.
    # A *serv recipient answers `{:ok, :no_persist}` (W12), which
    # `finish_send/3` already renders as 202.
    with :ok <- BodyLimit.check(body),
         :ok <- validate_target_name(channel),
         :ok <-
           validate_wire_recipient_name(notice_target, Session.statusmsg(subject, network.id)),
         :ok <- take_send_token(subject, network.id),
         {:ok, result} <- Session.send_notice(subject, network.id, channel, notice_target, body) do
      finish_send(conn, result, network.slug)
    end
  end

  def create(conn, %{
        "channel_id" => channel,
        "body" => body,
        "statusmsg_target" => statusmsg_target
      })
      when is_binary(body) and body != "" and is_binary(statusmsg_target) and
             statusmsg_target != "" do
    subject = Subject.to_session(conn.assigns.current_subject)
    network = conn.assigns.network

    # issue 2179 — `/msg @#chan <text>`: a PRIVMSG to a channel at a membership
    # level. The #1301 NOTICE twin of this existed; the PRIVMSG one never did,
    # so an ops-only message had no door at all — `validate_post_target_name/1`
    # refuses `@#chan` on the plain arm (correctly: there the target IS the
    # persist key) and cic turned the refusal into a phantom `@#chan` query
    # window on top.
    #
    # It is NOT shaped like the notice/CTCP arms, and the difference is the
    # point: there the URL is the SOURCE window and the recipient is payload,
    # here the recipient DECIDES the window. `Session.send_statusmsg/4` peels
    # the sigil with the session's own 005 set and keys the echo to the channel
    # behind it — the same derivation `EventRouter` applies on ingress, which
    # is what puts every OTHER member's copy of this line in `#chan`. An echo
    # keyed anywhere else would split one conversation across two windows.
    #
    # So the URL `channel_id` is not passed on; it is VERIFIED against the
    # recipient (`validate_statusmsg_recipient/4`) so a client cannot address
    # `@#chan` from a URL that names a different window and get a row filed
    # where its own request denies. No `$server` guard is needed on top: the
    # comparison already forces the URL to be the peeled channel.
    with :ok <- BodyLimit.check(body),
         :ok <-
           validate_statusmsg_recipient(
             statusmsg_target,
             channel,
             Session.statusmsg(subject, network.id),
             Session.casemapping(subject, network.id)
           ),
         :ok <- take_send_token(subject, network.id),
         {:ok, result} <- Session.send_statusmsg(subject, network.id, statusmsg_target, body) do
      finish_send(conn, result, network.slug)
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
      finish_send(conn, result, network.slug)
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
  # #480 — WHICH numbers is asked of the session, because the throttle is a
  # mirror of the allowance the UPSTREAM applies to this connection and the
  # session is the only party holding that. `:exempt` skips the bucket (there
  # is nothing to mirror); the outer #630 request budget still meters the
  # door, so this is not an unmetered path. A session that is gone answers
  # `:no_session` and takes today's numbers — the send right behind this will
  # 404 anyway, and guessing generous on the way to a 404 would be the wrong
  # direction.
  #
  # Both this and `take_token/5` carry the `PresenceFilter` treatment for a
  # config-derived constant: the retry hints come from module attributes, so
  # Dialyzer narrows the success typing to those literals and reads the
  # honest `pos_integer()` as a supertype. The general spec is the contract
  # (the seconds are a tunable, not a promise of the number); the narrow one
  # would have to be rewritten every time an operator retunes the config.
  @dialyzer {:nowarn_function, take_send_token: 2}
  @spec take_send_token(Session.subject(), integer()) ::
          :ok | {:error, {:rate_limited, pos_integer()}}
  defp take_send_token(subject, network_id) do
    case flood_allowance(subject, network_id) do
      :exempt ->
        :ok

      :oper ->
        take_token(
          subject,
          network_id,
          @send_throttle_oper_capacity,
          @send_throttle_oper_refill_per_sec,
          @send_throttle_oper_retry_after_seconds
        )

      :ordinary ->
        take_token(
          subject,
          network_id,
          @send_throttle_capacity,
          @send_throttle_refill_per_sec,
          @send_throttle_retry_after_seconds
        )
    end
  end

  @spec flood_allowance(Session.subject(), integer()) :: FloodAllowance.t()
  defp flood_allowance(subject, network_id) do
    case Session.get_flood_allowance(subject, network_id) do
      {:ok, allowance} -> allowance
      {:error, :no_session} -> :ordinary
    end
  end

  @dialyzer {:nowarn_function, take_token: 5}
  @spec take_token(Session.subject(), integer(), pos_integer(), number(), pos_integer()) ::
          :ok | {:error, {:rate_limited, pos_integer()}}
  defp take_token(subject, network_id, capacity, refill_per_sec, retry_after_seconds) do
    case TokenBucket.take(
           @send_throttle_bucket,
           {subject, network_id},
           capacity,
           refill_per_sec
         ) do
      :ok -> :ok
      {:error, :rate_limited} -> {:error, {:rate_limited, retry_after_seconds}}
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
  #
  # `network_slug` is passed rather than read off the row: since #1657b the
  # persist boundary no longer preloads `:network` (it was a second pool
  # checkout per row on the hot write path), and this controller already
  # resolved the network from the URL.
  #
  # issue 2407 — every arm that persisted a row lands here, so this is the
  # ONE place the subject's own send also reads the window it was typed in.
  # Replying is a read signal, and for a client that cannot send read markers
  # (an IRC client behind a bridge) it is the only one grappa ever gets.
  # A `:no_persist` services send has no row and no window, so it reads
  # nothing.
  defp finish_send(conn, %Scrollback.Message{} = message, network_slug) do
    :ok = advance_own_read_cursor(conn, message)

    conn
    |> put_status(:created)
    |> render(:show, message: message, network_slug: network_slug)
  end

  defp finish_send(conn, :no_persist, _) do
    conn
    |> put_status(:accepted)
    |> json(%{ok: true})
  end

  # issue 2407 — moves the cursor of the window the sent row landed in
  # (`message.channel`: the folded key the Session wrote under, so the channel
  # for a channel message, the peer for a DM, the SOURCE window for a CTCP or
  # NOTICE echo, the channel behind the sigil for an ops-only one) to that
  # row, through the same verb `ReadCursorController` uses. Multi-fragment
  # sends reach here with the LAST fragment, so the cursor covers them all.
  #
  # The whole advance runs in a detached task, set included, because the send
  # has already happened: the cursor write is a second SQLite write, and under
  # write-lock contention its busy-retry would hold the 201 of a message that
  # is already on the wire. A failure is therefore not the request's, and is
  # logged instead of returned: the row stays unread, which is the state
  # before this change, and the operator sees why.
  #
  # Placed at the web door and NOT in `Session.Server`'s persist path on
  # purpose: this door is the subject typing, while the session also sends on
  # its own (the perform list, services sub-machines), and those must never
  # mark a window read.
  @spec advance_own_read_cursor(Plug.Conn.t(), Scrollback.Message.t()) :: :ok
  defp advance_own_read_cursor(conn, %Scrollback.Message{id: id, channel: channel}) do
    current_subject = conn.assigns.current_subject
    network = conn.assigns.network

    {:ok, _} =
      Task.Supervisor.start_child(Grappa.TaskSupervisor, fn ->
        case ReadCursorAdvance.advance(current_subject, network, channel, id) do
          {:ok, _} ->
            :ok

          {:error, reason} ->
            Logger.warning("read cursor not advanced after own send",
              network: network.slug,
              channel: channel,
              reason: inspect(reason)
            )
        end
      end)

    :ok
  end

  # #458 — "should the history reads omit presence for this channel?",
  # resolved from the server-owned tri-state pref (#449) + live member count.
  # The server evaluates the tri-state itself (issue paletto: never a client
  # boolean) so every device converges on one decision.
  #
  # #505 lifted the resolution out of this controller into
  # `Grappa.PresenceFilter.Resolver`: the unread seed needs the identical
  # answer from three more doors (`join_reply`, the per-message push, the
  # `/me` cold-load), and two of them are not web modules. Four copies of
  # the same tri-state is how a tri-state becomes four tri-states.
  defp resolve_hide_presence(subject, network, channel),
    do: Resolver.hidden?(subject, network.slug, network.id, channel)

  # Cursor mutex: at most one of the six cursors — `before` / `after` /
  # `around` (ids) and, since issue 2372, `before_time` / `after_time` /
  # `around_time` (epoch ms). Two or more present together silently picking
  # one would mask client bugs; 400 is the right answer (consistent with the
  # rest of this controller's "present-and-unparseable = 400" rule).
  @cursor_params [
    {"before", :before},
    {"after", :after},
    {"around", :around},
    {"before_time", {:time, :before}},
    {"after_time", {:time, :after}},
    {"around_time", {:time, :around}}
  ]

  defp parse_direction(params) do
    cursors = for {key, tag} <- @cursor_params, not is_nil(params[key]), do: {tag, params[key]}

    case cursors do
      [] -> {:ok, {:before, nil}}
      [{{:time, dir}, raw}] -> with {:ok, t} <- parse_epoch_ms(raw), do: {:ok, {:time, {dir, t}}}
      [{tag, raw}] -> with {:ok, n} <- parse_int(raw), do: {:ok, {tag, n}}
      _ -> {:error, :bad_request}
    end
  end

  # issue 2372 — ONE value format, decimal epoch milliseconds: the unit every
  # row's `server_time` already carries on this wire, so a client re-sends a
  # row's own value unconverted. Non-negative, and capped at the int64 the
  # column is: past it the bind would fail inside exqlite, a 500 for what is
  # a malformed request.
  @max_epoch_ms 9_223_372_036_854_775_807

  defp parse_epoch_ms(raw) do
    case parse_int(raw) do
      {:ok, t} when t >= 0 and t <= @max_epoch_ms -> {:ok, t}
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

  # Absent, or any non-string shape Plug can hand us (`?after[]=1` parses to a
  # LIST): 400, per this controller's documented "present and unparseable"
  # contract. Without the catch-all the list case is a FunctionClauseError —
  # a 500 with a stacktrace for what is plainly a malformed request.
  defp parse_after(_), do: {:error, :bad_request}

  # issue 2282 — `?cap=`, and the ABSENT case is the only one that differs
  # from `parse_after/1`: no cap is the #693 behaviour, so `nil` is a success
  # and not a 400.
  #
  # Strictly positive. `cap=0` is refused rather than normalised because a
  # saturating count capped at zero answers 0 for every gap — a threshold
  # that reads NEAR on a channel a million rows behind. Silently promoting it
  # to 1 would answer a question nobody asked; refusing says so.
  @spec parse_cap(term()) :: {:ok, pos_integer() | nil} | {:error, :bad_request}
  defp parse_cap(nil), do: {:ok, nil}

  defp parse_cap(s) when is_binary(s) do
    case parse_int(s) do
      {:ok, n} when n > 0 -> {:ok, n}
      _ -> {:error, :bad_request}
    end
  end

  # Same catch-all, same reason as `parse_after/1`'s: `?cap[]=1` decodes to a
  # LIST and must be a 400, not a FunctionClauseError past the fallback.
  defp parse_cap(_), do: {:error, :bad_request}

  defp parse_int(s) when is_binary(s) do
    case Integer.parse(s) do
      {n, ""} -> {:ok, n}
      _ -> {:error, :bad_request}
    end
  end

  # #1338 W-S1 — same catch-all, same reason as `parse_after/1` above: the
  # three cursors reach here straight off `Plug.Conn.Query`, which decodes
  # `?before[]=1` to a LIST and `?before[k]=1` to a MAP. Without it those are
  # a FunctionClauseError — a 500 with a stacktrace, past the
  # FallbackController, for a plainly malformed request.
  defp parse_int(_), do: {:error, :bad_request}

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

  # #1338 W-S1 — `?limit[]=1` is the list-shaped twin of the cursor case
  # above. `nil` (absent) has its own clause and keeps the default.
  defp parse_limit(_), do: {:error, :bad_request}
end
