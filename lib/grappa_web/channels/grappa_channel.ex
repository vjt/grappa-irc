defmodule GrappaWeb.GrappaChannel do
  @moduledoc """
  Single channel module for all Grappa real-time topics.

  ## Join behavior

  1. Parse the topic via `Grappa.PubSub.Topic.parse/1`. Unknown
     shapes (including the Phase 1 `grappa:network:...` shape, which
     sub-task 2h removed) get `{:error, %{reason: "unknown topic"}}`.
  2. Cross-user authz: every Grappa topic is rooted in a user_name.
     If `socket.assigns.user_name` does not match the topic's
     embedded user, return `{:error, %{reason: "forbidden"}}`. This
     is the LOAD-BEARING check — `Phoenix.PubSub` topics are a
     global namespace, so without this any authn'd socket could
     subscribe to any other user's topic by string-typing it.
  3. Accept the join. **The framework auto-installs a fastlane
     subscription** on the channel topic when the join completes —
     DO NOT call `Phoenix.PubSub.subscribe/2` manually here. Doing so
     registers a SECOND subscriber (no metadata) on the same topic,
     and any subsequent `Grappa.PubSub.broadcast_event/2` (sent as a
     `%Phoenix.Socket.Broadcast{}` via the framework's channel-server
     dispatcher) fans out to BOTH the manual subscriber (delivered as
     a struct to `handle_info/2` → `push/3` → 1 WS frame) AND the
     fastlane (encoded once and written directly to the transport →
     another WS frame). Net effect: 1 broadcast → 2 frames per
     message. This was BUG 6 — the sidebar unread badge bumped by 2
     on every PRIVMSG.
  4. Kick off the after-join snapshot via `Process.send_after/3` with
     `:after_join` so the costly DB + session queries run after the
     join callback returns — `join/3` must be fast (Phoenix blocks the
     client until it returns).

  ## After-join snapshots

  ### User-level topic (`grappa:user:{user}`)

  Pushes:
  - `query_windows_list` — full current DM window list for the subject
    (user or visitor — V2 visitor parity, 2026-05-15).
  - One `topic_changed` per (network, channel) where the session has a
    cached topic.
  - One `channel_modes_changed` per (network, channel) where the session
    has cached modes.

  All snapshots are best-effort: missing sessions (parked, failed,
  never started) are silently skipped per channel.

  ### Channel-level topic (`grappa:user:{user}/network:{net}/channel:{chan}`)

  Pushes:
  - `topic_changed` for the specific channel, if cached.
  - `channel_modes_changed` for the specific channel, if cached.

  ### Network-level topic (`grappa:user:{user}/network:{net}`)

  No snapshot — the network-level topic carries connection-state events
  only; topic+modes are delivered per-channel.

  ## Inbound events

  - `"client_closing"` — pagehide / beforeunload hint from cicchetto.
    Calls `Grappa.WSPresence.client_closing/2` so the auto-away debounce
    fires immediately (no 30s wait) if this is the last socket for the
    user. Visitors are excluded (no auto-away for visitor sessions).
    Fire-and-forget; no reply.

  - `"away"` — set or unset explicit away. Payload: `%{"action" => "set"|"unset",
    "network" => slug, "reason" => reason}`. Optional `"origin_window"` for
    305/306 numeric routing (S4.3). Visitors rejected.

  - `"op"` / `"deop"` / `"voice"` / `"devoice"` — channel mode change on a list
    of nicks. Payload: `%{"network_id" => id, "channel" => chan, "nicks" => [...]}`.
    Fans out to N `MODE` lines if nicks exceed the ISUPPORT MODES= limit.

  - `"kick"` — eject a nick. Payload: `%{"network_id" => id, "channel" => chan,
    "nick" => nick, "reason" => reason}`.

  - `"ban"` / `"unban"` — add/remove a ban mask. Payload: `%{"network_id" => id,
    "channel" => chan, "mask" => mask_or_nick}`. Bare nicks undergo WHOIS-cache
    mask derivation in `Session.Server`.

  - `"invite"` — invite a nick. Payload: `%{"network_id" => id, "channel" => chan,
    "nick" => nick}`.

  - `"banlist"` — query the channel ban list. Payload: `%{"network_id" => id,
    "channel" => chan}`. Issues `MODE #chan b` (no sign); server replies with 367/368.

  - `"whois"` — issue WHOIS on a nick. Payload: `%{"network_id" => id, "nick" => nick}`.
    Server primes the per-target accumulator and emits `WHOIS nick`; EventRouter
    folds 311/312/313/317/319 into a bundle and broadcasts it on `Topic.user/1`
    when 318 RPL_ENDOFWHOIS arrives. Per spec #2: bundle is ephemeral — NOT
    persisted in scrollback. cic renders inline via the `whois_bundle` event.

  - `"umode"` — user-mode change on own nick. Payload: `%{"network_id" => id,
    "modes" => modes}`.

  - `"mode"` — raw verbatim MODE line, no chunking. Payload: `%{"network_id" => id,
    "target" => target, "modes" => modes, "params" => [...]}`.

  - `"topic_set"` — set channel topic. Payload: `%{"network_id" => id, "channel" => chan,
    "text" => text}`. Persists a scrollback `:topic` row. Rejects CRLF injection.

  - `"topic_clear"` — clear channel topic (irssi `/topic -delete` convention).
    Payload: `%{"network_id" => id, "channel" => chan}`. Sends `TOPIC #chan :`.

  - `"open_query_window"` — open a DM (query) window. Payload: `%{"network_id" => id,
    "target_nick" => nick}`. Upserts a `query_windows` row (idempotent via unique idx)
    and broadcasts the updated `query_windows_list` on the user topic. Subject-scoped
    per V2 (visitor and user sockets share the path).

  - `"close_query_window"` — close a DM (query) window. Payload: `%{"network_id" => id,
    "target_nick" => nick}`. Deletes the `query_windows` row (idempotent — no-op if
    missing) and broadcasts the updated `query_windows_list` on the user topic.
    Subject-scoped per V2.

  All ops verbs reject visitor sockets and return `{:error, %{reason: "visitor_not_allowed"}}`.

  ## Outbound event shapes

  All events pushed by this channel share the `kind:` discriminator (string
  for JSON-friendliness in cicchetto):

  - `"topic_changed"` — `%{kind: "topic_changed", network: slug, channel: chan, topic: entry}`
  - `"channel_modes_changed"` — `%{kind: "channel_modes_changed", network: slug, channel: chan, modes: entry}`
  - `"query_windows_list"` — `%{kind: "query_windows_list", windows: %{network_id => [%Window{}]}}`

  Server-side broadcasters call `Grappa.PubSub.broadcast_event(topic,
  payload)`, which goes through the framework's channel-server
  dispatcher and the per-socket fastlane — a single WS frame per
  connected socket on the topic. The wire-shape contract lives at the
  broadcasting boundary (`Grappa.Session.Server` via
  `Grappa.Scrollback.Wire.message_payload/1`). This module does NOT
  define `handle_info({:event, _}, _)` — there is no manual subscribe
  and the fastlane bypasses `handle_info/2` entirely.

  Accepted topic shapes (single source of truth in `Grappa.PubSub.Topic`):

    - `"grappa:user:{user}"`
    - `"grappa:user:{user}/network:{net}"`
    - `"grappa:user:{user}/network:{net}/channel:{chan}"`

  Phase 1 still hardcodes the socket's `user_name` as `"vjt"` in
  `UserSocket.connect/3`; a later Phase 2 sub-task switches it to a
  token-derived value and the authz check below starts rejecting
  cross-user joins for real.
  """
  use GrappaWeb, :channel

  alias Grappa.{Accounts, Networks, QueryWindows, ReadCursor, Session, UserSettings, WSPresence}
  alias Grappa.Cic.Bundle, as: CicBundle
  alias Grappa.Cic.Wire, as: CicWire
  alias Grappa.IRC.Identifier
  alias Grappa.Networks.Network
  alias Grappa.PubSub.Topic
  alias Grappa.Scrollback.Wire, as: ScrollbackWire
  alias Grappa.ServerSettings
  alias Grappa.ServerSettings.Wire, as: ServerSettingsWire
  alias Grappa.Session.Wire, as: SessionWire
  alias GrappaWeb.BodyLimit

  @typedoc "Wire payload for `topic_changed` events pushed by this channel."
  @type topic_changed_payload :: %{
          kind: String.t(),
          network: String.t(),
          channel: String.t(),
          topic: map()
        }

  @typedoc "Wire payload for `channel_modes_changed` events pushed by this channel."
  @type channel_modes_changed_payload :: %{
          kind: String.t(),
          network: String.t(),
          channel: String.t(),
          modes: map()
        }

  @typedoc "Wire payload for `query_windows_list` events pushed by this channel."
  @type query_windows_list_payload :: QueryWindows.Wire.windows_list_payload()

  @typedoc """
  Wire payload for the `members_seeded` cold-WS-subscribe snapshot
  push (see `push_members_if_seeded/4`). Byte-identical to the
  event-time broadcast emitted on `366 RPL_ENDOFNAMES`; the canonical
  shape is owned by `Grappa.Session.Wire.members_seeded/3`.
  """
  @type members_seeded_payload :: SessionWire.members_seeded_payload()

  @typedoc """
  Wire payload for the `window_state` cold-WS-subscribe snapshot push
  (see `push_window_state_if_known/4`). Byte-identical to the
  event-time broadcast for the same `joined | window_pending |
  join_failed | kicked` transition; the canonical union is owned by
  `t:Grappa.Session.window_state_snapshot/0`.
  """
  @type window_state_snapshot_payload :: Session.window_state_snapshot()

  @impl Phoenix.Channel
  def join(topic, _, socket) do
    with {:ok, parsed} <- Topic.parse(topic),
         parsed <- canonicalize_topic(parsed),
         :ok <- authorize(parsed, socket) do
      # NO manual `Phoenix.PubSub.subscribe/2` here — the framework's
      # fastlane subscription (installed by Phoenix.Channel.Server.init/1)
      # is the ONLY subscriber needed. See moduledoc + BUG 6.
      Process.send_after(self(), {:after_join, parsed}, 0)
      {:ok, join_reply(parsed), socket}
    else
      :error -> {:error, %{reason: "unknown topic"}}
      {:error, :forbidden} -> {:error, %{reason: "forbidden"}}
    end
  end

  # UX-4 bucket A — canonicalise the channel segment of a per-channel
  # topic so subscribers join the SAME topic string the broadcasters
  # emit on. `Topic.channel/3` canonicalises at build time; this
  # mirrors it at parse time so a cic-side `socket.channel("grappa:
  # user:vjt/network:az/channel:#Chan")` falls onto the canonical
  # `#chan` topic regardless of input casing. User + network topics
  # carry no channel segment and pass through unchanged. Admin events
  # likewise.
  defp canonicalize_topic({:channel, user_name, network_slug, channel}) do
    {:channel, user_name, network_slug, Grappa.IRC.Identifier.canonical_channel(channel)}
  end

  defp canonicalize_topic(other), do: other

  # CP29 R-3: per-channel topic joins return the current read cursor in
  # the join reply so cic doesn't need a per-window REST round-trip on
  # subscribe. `nil` for channels with no cursor yet (fresh subject) or
  # for cases the server can't resolve cleanly (deleted user, missing
  # network) — cic treats both as "no cursor" and falls back to the
  # bulk envelope from `/me`. User + network topics get an empty map
  # (no per-channel cursor concept; bulk fetch lives at `/me`).
  @spec join_reply(Topic.parsed()) :: %{optional(:read_cursor) => integer() | nil}
  defp join_reply({:channel, user_name, network_slug, channel}) do
    cursor =
      with {:ok, subject} <- resolve_subject(user_name),
           {:ok, %Network{} = network} <- Networks.get_network_by_slug(network_slug),
           %ReadCursor.Cursor{last_read_message_id: id} <-
             ReadCursor.get(subject, network.id, channel) do
        id
      else
        _ -> nil
      end

    %{read_cursor: cursor}
  end

  defp join_reply(_), do: %{}

  @impl Phoenix.Channel
  def handle_info({:after_join, {:user, user_name}}, socket) do
    push_user_snapshot(user_name, socket)
    {:noreply, socket}
  end

  def handle_info({:after_join, {:channel, user_name, network_slug, channel}}, socket) do
    push_channel_snapshot(user_name, network_slug, channel, socket)
    {:noreply, socket}
  end

  def handle_info({:after_join, {:network, _, _}}, socket) do
    # No snapshot for network-level topics — they carry connection-state
    # events only; topic+modes are delivered per-channel.
    {:noreply, socket}
  end

  # S3.3 — pagehide immediate-away hint.
  #
  # Cicchetto fires `client_closing` on `pagehide` / `beforeunload` via the
  # user-level channel so WSPresence can fire `:ws_all_disconnected`
  # immediately rather than waiting for the 30s debounce. The transport_pid
  # is the WS process that UserSocket.connect/3 registered with WSPresence
  # at connect time (WSPresence tracks the transport process, not the channel
  # process). Visitors are excluded — visitor disconnect = bouncer disconnect
  # (ephemeral credential, no upstream session to mark away).
  @impl Phoenix.Channel
  def handle_in("client_closing", _, socket) do
    user_name = socket.assigns.user_name
    # CP24 bucket E web/S5: forward client_closing for visitors too —
    # the WSPresence registry now tracks both subjects (visitor session
    # registration is a no-op on the auto-away path because visitor
    # `Session.Server` does not subscribe to `Topic.ws_presence/1`,
    # but registering keeps `list_user_names/0` complete for the
    # cic-bundle-changed broadcast). client_closing on a non-tracked
    # pid is idempotent (the MapSet membership check inside
    # `WSPresence.handle_call({:client_closing, ...}, ...)` no-ops
    # if the pid was never registered).
    :ok = WSPresence.client_closing(user_name, socket.transport_pid)

    {:noreply, socket}
  end

  # S3.4 — /away slash-command: set explicit away.
  #
  # Resolves the network slug to a network_id via `Networks.get_network_by_slug/1`,
  # then delegates to `Session.set_explicit_away/3`. Returns `{:ok, _}` on success.
  # Visitors are rejected — visitor sessions have no auto-away state and the
  # `set_explicit_away/3` facade only routes to user sessions.
  #
  # S4.3: reads `origin_window` from the payload (if present) and passes it to
  # Session.set_explicit_away/4 so 305/306 reply numerics route back to the
  # originating cicchetto window.
  def handle_in(
        "away",
        %{"action" => "set", "network" => slug, "reason" => reason} = payload,
        socket
      )
      when is_binary(slug) and is_binary(reason) do
    user_name = socket.assigns.user_name

    if visitor?(user_name) do
      {:reply, {:error, %{reason: "visitor_no_away"}}, socket}
    else
      origin_window = Map.get(payload, "origin_window")
      with_body_check(socket, reason, fn -> away_set_dispatch(socket, user_name, slug, reason, origin_window) end)
    end
  end

  # S3.4 — /away slash-command: unset explicit away.
  #
  # Visitors are rejected with `visitor_no_away`. Returns `{:error,
  # %{reason: "not_explicit"}}` if the session is not in `:away_explicit` state
  # (mirrors `Session.unset_explicit_away/2`'s `{:error, :not_explicit}` return).
  #
  # S4.3: reads `origin_window` from payload and passes to Session facade.
  def handle_in("away", %{"action" => "unset", "network" => slug} = payload, socket)
      when is_binary(slug) do
    user_name = socket.assigns.user_name

    if visitor?(user_name) do
      {:reply, {:error, %{reason: "visitor_no_away"}}, socket}
    else
      origin_window = Map.get(payload, "origin_window")

      with {:ok, user} <- safe_get_user(user_name),
           {:ok, %Network{} = network} <- Networks.get_network_by_slug(slug),
           :ok <- dispatch_unset_away(user, network, origin_window) do
        {:reply, :ok, socket}
      else
        :error -> {:reply, {:error, %{reason: "user_not_found"}}, socket}
        {:error, :not_found} -> {:reply, {:error, %{reason: "network_not_found"}}, socket}
        {:error, :no_session} -> {:reply, {:error, %{reason: "no_session"}}, socket}
        {:error, :not_explicit} -> {:reply, {:error, %{reason: "not_explicit"}}, socket}
      end
    end
  end

  # ---------------------------------------------------------------------------
  # S5.3 — ops verb inbound events
  #
  # Each handle_in dispatches to the corresponding Session facade function.
  # Visitors are rejected — they have no upstream IRC session with operator
  # state. The `origin_window` field is accepted from the payload (consistency
  # with the S4.3 contract) but is not threaded to the Session facade: MODE /
  # KICK / INVITE do not produce correlated numeric replies that need routing
  # back to the originating window — the server's inbound MODE events come
  # through EventRouter on their own path.
  #
  # Auth path: user_name → safe_get_user → verify network_id belongs to the
  # user by resolving the session (call_session returns {:error, :no_session}
  # if no session is running for that (user, network_id) pair).
  # ---------------------------------------------------------------------------

  # /op alice bob carol  →  MODE #chan +ooo alice bob carol
  def handle_in(
        "op",
        %{"network_id" => network_id, "channel" => channel, "nicks" => nicks},
        socket
      )
      when is_integer(network_id) and is_binary(channel) and is_list(nicks) do
    dispatch_ops_verb(
      socket,
      fn -> validate_args(channel: channel, nicks: nicks) end,
      fn user -> Session.send_op({:user, user.id}, network_id, channel, nicks) end
    )
  end

  # /deop alice bob carol  →  MODE #chan -ooo alice bob carol
  def handle_in(
        "deop",
        %{"network_id" => network_id, "channel" => channel, "nicks" => nicks},
        socket
      )
      when is_integer(network_id) and is_binary(channel) and is_list(nicks) do
    dispatch_ops_verb(
      socket,
      fn -> validate_args(channel: channel, nicks: nicks) end,
      fn user -> Session.send_deop({:user, user.id}, network_id, channel, nicks) end
    )
  end

  # /voice alice  →  MODE #chan +v alice
  def handle_in(
        "voice",
        %{"network_id" => network_id, "channel" => channel, "nicks" => nicks},
        socket
      )
      when is_integer(network_id) and is_binary(channel) and is_list(nicks) do
    dispatch_ops_verb(
      socket,
      fn -> validate_args(channel: channel, nicks: nicks) end,
      fn user -> Session.send_voice({:user, user.id}, network_id, channel, nicks) end
    )
  end

  # /devoice alice  →  MODE #chan -v alice
  def handle_in(
        "devoice",
        %{"network_id" => network_id, "channel" => channel, "nicks" => nicks},
        socket
      )
      when is_integer(network_id) and is_binary(channel) and is_list(nicks) do
    dispatch_ops_verb(
      socket,
      fn -> validate_args(channel: channel, nicks: nicks) end,
      fn user -> Session.send_devoice({:user, user.id}, network_id, channel, nicks) end
    )
  end

  # /kick alice :bye  →  KICK #chan alice :bye
  def handle_in(
        "kick",
        %{"network_id" => network_id, "channel" => channel, "nick" => nick, "reason" => reason},
        socket
      )
      when is_integer(network_id) and is_binary(channel) and is_binary(nick) and
             is_binary(reason) do
    with_body_check(socket, reason, fn ->
      dispatch_ops_verb(
        socket,
        fn -> validate_args(channel: channel, nick: nick, line: reason) end,
        fn user -> Session.send_kick({:user, user.id}, network_id, channel, nick, reason) end
      )
    end)
  end

  # /ban *!*@evil.com or /ban alice (bare nick → mask derivation in Server)
  def handle_in(
        "ban",
        %{"network_id" => network_id, "channel" => channel, "mask" => mask},
        socket
      )
      when is_integer(network_id) and is_binary(channel) and is_binary(mask) do
    dispatch_ops_verb(
      socket,
      fn -> validate_args(channel: channel, mask: mask) end,
      fn user -> Session.send_ban({:user, user.id}, network_id, channel, mask) end
    )
  end

  # /unban *!*@evil.com  →  MODE #chan -b *!*@evil.com
  def handle_in(
        "unban",
        %{"network_id" => network_id, "channel" => channel, "mask" => mask},
        socket
      )
      when is_integer(network_id) and is_binary(channel) and is_binary(mask) do
    dispatch_ops_verb(
      socket,
      fn -> validate_args(channel: channel, mask: mask) end,
      fn user -> Session.send_unban({:user, user.id}, network_id, channel, mask) end
    )
  end

  # /invite alice  →  INVITE alice #chan (RFC 2812: nick first, channel second)
  def handle_in(
        "invite",
        %{"network_id" => network_id, "channel" => channel, "nick" => nick},
        socket
      )
      when is_integer(network_id) and is_binary(channel) and is_binary(nick) do
    dispatch_ops_verb(
      socket,
      fn -> validate_args(channel: channel, nick: nick) end,
      fn user -> Session.send_invite({:user, user.id}, network_id, channel, nick) end
    )
  end

  # /banlist  →  MODE #chan b (query form, no sign)
  #
  # CP24 bucket B reviewer add-on: read-only verb — visitors are
  # entitled to issue it. The 367/368 numerics broadcast on the
  # subject's own subject_label topic (mirror of WHOIS post-C3),
  # so the visitor's cic surface is the only consumer.
  def handle_in(
        "banlist",
        %{"network_id" => network_id, "channel" => channel},
        socket
      )
      when is_integer(network_id) and is_binary(channel) do
    dispatch_subject_verb(
      socket,
      fn -> validate_args(channel: channel) end,
      fn subject -> Session.send_banlist(subject, network_id, channel) end
    )
  end

  # C2 — /whois <nick>. Server primes the per-target accumulator and
  # emits `WHOIS nick`; EventRouter folds 311/312/313/317/319 and 318
  # broadcasts the bundle on `Topic.user/1`. Per spec #2: visitors not
  # rejected here (WHOIS is a read-only query and the visitor session
  # is allowed to issue it; the bundle's broadcast topic uses the
  # visitor's `subject_label` so the visitor's own cic surface is the
  # only consumer). C3 (CRITICAL — 2026-05-12 codebase review): pre-fix
  # this clause routed through `dispatch_ops_verb/2`, which short-circuits
  # visitors with `visitor_not_allowed` before the verb dispatches —
  # contradicting the carve-out the comment described. Fix uses
  # `dispatch_subject_verb/2`, which accepts BOTH `{:user, _}` and
  # `{:visitor, _}` subjects and rejects only on `:no_session`.
  def handle_in(
        "whois",
        %{"network_id" => network_id, "nick" => nick},
        socket
      )
      when is_integer(network_id) and is_binary(nick) do
    dispatch_subject_verb(
      socket,
      fn -> validate_args(nick: nick) end,
      fn subject -> Session.send_whois(subject, network_id, nick) end
    )
  end

  # P-0c — /whowas <nick>. Read-only verb; visitors entitled to issue
  # it (mirrors WHOIS post-C3). Server primes whowas_pending and emits
  # WHOWAS upstream; EventRouter folds 314/312/369/406 and 369 (or 406)
  # broadcasts the bundle on `Topic.user/1` so the visitor's own cic
  # surface is the only consumer.
  def handle_in(
        "whowas",
        %{"network_id" => network_id, "nick" => nick},
        socket
      )
      when is_integer(network_id) and is_binary(nick) do
    dispatch_subject_verb(
      socket,
      fn -> validate_args(nick: nick) end,
      fn subject -> Session.send_whowas(subject, network_id, nick) end
    )
  end

  # P-0d — /lusers. No args, read-only network query. Visitors are
  # entitled to issue it (mirrors WHOIS post-C3); the LUSERS bundle's
  # broadcast topic uses the issuing subject's `subject_label` so the
  # visitor's own cic surface is the only consumer.
  def handle_in(
        "lusers",
        %{"network_id" => network_id},
        socket
      )
      when is_integer(network_id) do
    dispatch_subject_verb(
      socket,
      fn -> {:ok, :ok} end,
      fn subject -> Session.send_lusers(subject, network_id) end
    )
  end

  # CP22 cluster B (channel-client-polish #14) — /who <#channel>. cic
  # pushes after the operator types `/who #chan`; the channel relays to
  # Session.send_who/3 which primes who_pending + emits WHO upstream.
  # The 352/315 burst then folds into N+1 :persist :notice rows routed
  # to the target channel (if joined) or $server (otherwise) — all
  # downstream of this bridge, no extra wiring needed here.
  #
  # CP24 bucket B reviewer add-on: read-only verb — visitors are
  # entitled to issue it. Routes via `dispatch_subject_verb/2` (mirror
  # of WHOIS post-C3); the WHO bundle's broadcast topic uses the
  # subject's `subject_label` so the visitor's own cic surface is the
  # only consumer.
  def handle_in(
        "who",
        %{"network_id" => network_id, "channel" => channel},
        socket
      )
      when is_integer(network_id) and is_binary(channel) do
    dispatch_subject_verb(
      socket,
      fn -> validate_args(channel: channel) end,
      fn subject -> Session.send_who(subject, network_id, channel) end
    )
  end

  # CP22 cluster B (channel-client-polish #14) — /names <#channel>.
  # cic pushes after the operator types `/names #chan`; the channel
  # relays to Session.send_names/4 which primes names_pending + emits
  # NAMES upstream. The 353/366 burst lands as 2 :notice scrollback
  # rows ALWAYS (silence is the bug — /names UX cluster N-1+N-2),
  # routed to the originating window when payload carries
  # `origin_window` (cic's focused window when /names was typed),
  # else target if joined, else `$server`.
  #
  # CP24 bucket B reviewer add-on: read-only verb — visitors are
  # entitled to issue it. Routes via `dispatch_subject_verb/2`.
  def handle_in(
        "names",
        %{"network_id" => network_id, "channel" => channel} = payload,
        socket
      )
      when is_integer(network_id) and is_binary(channel) do
    origin_window = Map.get(payload, "origin_window")

    dispatch_subject_verb(
      socket,
      fn -> validate_args(channel: channel) end,
      fn subject -> Session.send_names(subject, network_id, channel, origin_window) end
    )
  end

  # /umode +i  →  MODE own_nick +i
  def handle_in(
        "umode",
        %{"network_id" => network_id, "modes" => modes},
        socket
      )
      when is_integer(network_id) and is_binary(modes) do
    with_body_check(socket, modes, fn ->
      dispatch_ops_verb(
        socket,
        fn -> validate_args(line: modes) end,
        fn user -> Session.send_umode({:user, user.id}, network_id, modes) end
      )
    end)
  end

  # /mode #chan +o-v alice bob  →  MODE #chan +o-v alice bob (verbatim, no chunking)
  def handle_in(
        "mode",
        %{"network_id" => network_id, "target" => target, "modes" => modes, "params" => params},
        socket
      )
      when is_integer(network_id) and is_binary(target) and is_binary(modes) and is_list(params) do
    with_body_check(socket, modes, fn ->
      dispatch_ops_verb(
        socket,
        fn -> validate_args(line: target, line: modes, params: params) end,
        fn user -> Session.send_mode({:user, user.id}, network_id, target, modes, params) end
      )
    end)
  end

  # /topic <text>  →  TOPIC #chan :<text>
  # send_topic returns {:ok, message} on success (persists scrollback row).
  # The visitor check and user lookup use the shared helper path directly.
  #
  # W5: CRLF/NUL guard fires at the channel boundary BEFORE the cross-process
  # GenServer hop. The Session facade + IRC.Client both also gate via
  # `Identifier.safe_line_token?/1` (defense in depth — the channel boundary
  # is the OUTER untrusted-input surface).
  #
  # CP24 bucket E web/S6: `with`/`else` matches by tagged tuple per
  # CLAUDE.md "Atoms or `@type t :: literal | literal` — never untyped
  # strings". The pre-fix shape matched `with true <- ..., false <- ...`
  # and `else false ->`/`true ->` mapped raw boolean values — adding
  # any new boolean check above either site silently flipped the error
  # message because both branches reduce to the same `false`/`true`.
  # Tagged tuples make each `else` arm map to a single source.
  def handle_in(
        "topic_set",
        %{"network_id" => network_id, "channel" => channel, "text" => text},
        socket
      )
      when is_integer(network_id) and is_binary(channel) and is_binary(text) do
    user_name = socket.assigns.user_name
    with_body_check(socket, text, fn -> topic_set_dispatch(socket, user_name, network_id, channel, text) end)
  end

  # /topic -delete  →  TOPIC #chan : (empty trailing — irssi convention, S5.4)
  def handle_in(
        "topic_clear",
        %{"network_id" => network_id, "channel" => channel},
        socket
      )
      when is_integer(network_id) and is_binary(channel) do
    dispatch_ops_verb(
      socket,
      fn -> validate_args(channel: channel) end,
      fn user -> Session.send_topic_clear({:user, user.id}, network_id, channel) end
    )
  end

  # C1.4 — open a DM (query) window.
  #
  # Payload: `%{"network_id" => integer, "target_nick" => string}`.
  # Delegates to `QueryWindows.open/4` (idempotent via unique idx).
  # After the DB upsert, QueryWindows.open/4 broadcasts the updated
  # `query_windows_list` on Topic.user/1 — all connected tabs of this
  # subject (user OR visitor) receive the push and update their window
  # list. Visitor parity (V2 cluster, 2026-05-15) — visitor sockets get
  # the same path; row lands under `query_windows.visitor_id` per V1's
  # XOR FK shape.
  def handle_in(
        "open_query_window",
        %{"network_id" => network_id, "target_nick" => target_nick},
        socket
      )
      when is_integer(network_id) and is_binary(target_nick) do
    user_name = socket.assigns.user_name

    with {:ok, _} <- validate_args(nick: target_nick),
         {:ok, subject} <- resolve_subject(user_name),
         {:ok, _} <- QueryWindows.open(subject, network_id, target_nick, user_name) do
      {:reply, :ok, socket}
    else
      {:error, :invalid_nick} -> {:reply, {:error, %{reason: "invalid_nick"}}, socket}
      :error -> {:reply, {:error, %{reason: "user_not_found"}}, socket}
      {:error, _} -> {:reply, {:error, %{reason: "open_failed"}}, socket}
    end
  end

  # C1.2 — close a DM (query) window.
  #
  # Payload: `%{"network_id" => integer, "target_nick" => string}`.
  # Delegates to `QueryWindows.close/4` (idempotent — returns :ok
  # whether or not the row existed). After the DB delete, broadcasts
  # the updated `query_windows_list` on Topic.user/1. Visitor parity
  # per V2 — visitor sockets close visitor-FK rows.
  def handle_in(
        "close_query_window",
        %{"network_id" => network_id, "target_nick" => target_nick},
        socket
      )
      when is_integer(network_id) and is_binary(target_nick) do
    user_name = socket.assigns.user_name

    with {:ok, _} <- validate_args(nick: target_nick),
         {:ok, subject} <- resolve_subject(user_name) do
      :ok = QueryWindows.close(subject, network_id, target_nick, user_name)

      # UX-3 Z2 (2026-05-18): closing a query window makes its
      # scrollback (any peer DM rows) archive-eligible — list_archive/3
      # excludes open query targets via the `active_keyset`. Without
      # this broadcast, connected cic tabs only learn about the new
      # archive entry on next page reload. Best-effort slug lookup;
      # silent-skip on unknown network (extremely defensive — caller
      # already verified network_id implicitly via the close path).
      case Networks.get_network(network_id) do
        %Network{slug: slug} ->
          :ok =
            Grappa.PubSub.broadcast_event(
              Topic.user(user_name),
              ScrollbackWire.archive_changed_payload(slug)
            )

        nil ->
          :ok
      end

      {:reply, :ok, socket}
    else
      {:error, :invalid_nick} -> {:reply, {:error, %{reason: "invalid_nick"}}, socket}
      :error -> {:reply, {:error, %{reason: "user_not_found"}}, socket}
    end
  end

  # ---------------------------------------------------------------------------
  # C8 — /watch /highlight watchlist verbs
  #
  # Three action heads (add / del / list) for managing the per-subject
  # highlight watchlist stored in `user_settings`. Visitors lifted to
  # first-class subjects (V4 visitor-parity, 2026-05-15) — the bare-id
  # `Grappa.Subject.t()` tuple lives on the socket as
  # `:current_subject` so each arm dispatches straight to
  # `UserSettings.{get,set}_highlight_patterns/2`. All heads reply with
  # `{:ok, %{patterns: [...]}}` on success or `{:error, %{reason: ...}}` on
  # failure, matching the `away` handler's reply-shape convention.
  #
  # Forward-only per spec #19: changing the watchlist does NOT re-aggregate
  # past mentions. New patterns apply to incoming traffic and the NEXT
  # back-from-away aggregation only.
  # ---------------------------------------------------------------------------

  # /watch list  →  return current watchlist patterns for the subject.
  def handle_in("watchlist", %{"action" => "list"}, socket) do
    subject = socket.assigns.current_subject
    patterns = UserSettings.get_highlight_patterns(subject)
    {:reply, {:ok, %{patterns: patterns}}, socket}
  end

  # /watch add <pattern>  →  add pattern to watchlist (idempotent — dup is no-op success).
  def handle_in("watchlist", %{"action" => "add", "pattern" => pattern}, socket)
      when is_binary(pattern) do
    watchlist_add(socket.assigns.current_subject, pattern, socket)
  end

  # /watch del <pattern>  →  remove pattern from watchlist.
  # Returns {:error, :not_found} when the pattern is not in the list.
  def handle_in("watchlist", %{"action" => "del", "pattern" => pattern}, socket)
      when is_binary(pattern) do
    watchlist_del(socket.assigns.current_subject, pattern, socket)
  end

  # Watchlist add helper — extracted to keep handle_in nesting ≤ 2 levels.
  @spec watchlist_add(Grappa.Subject.t(), String.t(), Phoenix.Socket.t()) ::
          {:reply, {:ok, map()} | {:error, map()}, Phoenix.Socket.t()}
  defp watchlist_add(subject, pattern, socket) do
    existing = UserSettings.get_highlight_patterns(subject)
    new_patterns = if pattern in existing, do: existing, else: [pattern | existing]

    case UserSettings.set_highlight_patterns(subject, new_patterns) do
      {:ok, _} -> {:reply, {:ok, %{patterns: new_patterns}}, socket}
      {:error, _} -> {:reply, {:error, %{reason: "save_failed"}}, socket}
    end
  end

  # Watchlist del helper — extracted to keep handle_in nesting ≤ 2 levels.
  @spec watchlist_del(Grappa.Subject.t(), String.t(), Phoenix.Socket.t()) ::
          {:reply, {:ok, map()} | {:error, map()}, Phoenix.Socket.t()}
  defp watchlist_del(subject, pattern, socket) do
    existing = UserSettings.get_highlight_patterns(subject)

    if pattern in existing do
      new_patterns = List.delete(existing, pattern)

      case UserSettings.set_highlight_patterns(subject, new_patterns) do
        {:ok, _} -> {:reply, {:ok, %{patterns: new_patterns}}, socket}
        {:error, _} -> {:reply, {:error, %{reason: "save_failed"}}, socket}
      end
    else
      {:reply, {:error, %{reason: "not_found"}}, socket}
    end
  end

  # Pushes the user-level snapshot: query_windows_list (per-user state
  # not covered by any channel-topic snapshot).
  #
  # Pre-CP22 also pushed `push_all_topics_and_modes/2` (topic + modes
  # for every joined channel) on the user socket. That was legacy
  # backfill from when cic polled REST for those fields. cic now joins
  # each per-channel topic and `push_channel_snapshot/4` (the
  # `:after_join` clause for `{:channel, ...}`) covers topic + modes +
  # members + window_state for that channel — the user-topic backfill
  # was producing duplicate events that cic dropped as malformed
  # (`[userTopic] dropped malformed payload {kind: 'topic_changed', …}`)
  # because `WireUserEvent` doesn't list per-channel kinds. Removed.
  @spec push_user_snapshot(String.t(), Phoenix.Socket.t()) :: :ok
  defp push_user_snapshot(user_name, socket) do
    push_bundle_hash(socket)
    push_server_settings(socket)

    case resolve_subject(user_name) do
      {:ok, subject} -> push_query_windows_list(subject, socket)
      :error -> :ok
    end
  end

  # CP23 S4 B4 — push the deployed cic bundle hash on user-topic join so
  # cic can compare against `bootBundleHash` (the hash baked into the
  # html the browser loaded) and surface a refresh banner on mismatch.
  # `nil` (no bundle on disk yet — dev without a cic build, prod before
  # the first cicchetto-build oneshot) is silently skipped: cic has
  # nothing to compare against.
  @spec push_bundle_hash(Phoenix.Socket.t()) :: :ok
  defp push_bundle_hash(socket) do
    case CicBundle.current_hash() do
      nil -> :ok
      hash -> push(socket, "event", CicWire.bundle_hash(hash))
    end
  end

  # UX-6-B2 (2026-05-21) — push the current operator-visible server
  # settings on user-topic join so cic's reactive
  # `serverSettings()` signal is populated before the first
  # ComposeBox render reads `activeHost()`. Parity with
  # `push_bundle_hash/1`: same after-join slot, same wire-module-
  # owned payload shape, same fan-out target (per-user topic).
  # Cold-WS-subscribe parity with the put-time fan-out from
  # `Admin.SettingsController.update/2`.
  @spec push_server_settings(Phoenix.Socket.t()) :: :ok
  defp push_server_settings(socket) do
    payload = ServerSettingsWire.server_settings_changed(ServerSettings.public_view())
    push(socket, "event", payload)
    :ok
  end

  # Pushes cached topic_changed + channel_modes_changed for a single channel.
  # CP15 B3: also pushes cached members_seeded + window_state to close the
  # deploy-reconnect race — cic reconnects to a session whose original
  # broadcasts already fired before the WS subscribe, so without these
  # the members pane stays empty and the window stays in :pending.
  @spec push_channel_snapshot(String.t(), String.t(), String.t(), Phoenix.Socket.t()) :: :ok
  defp push_channel_snapshot(user_name, network_slug, channel, socket) do
    case safe_get_user(user_name) do
      {:ok, user} ->
        case Networks.get_network_by_slug(network_slug) do
          {:ok, %Network{} = network} ->
            subject = {:user, user.id}
            push_topic_if_cached(subject, network, channel, socket)
            push_modes_if_cached(subject, network, channel, socket)
            push_members_if_seeded(subject, network, channel, socket)
            push_window_state_if_known(subject, network, channel, socket)

          {:error, :not_found} ->
            :ok
        end

      :error ->
        :ok
    end
  end

  # Pushes query_windows_list for `subject`. Wire-rendering AND envelope-
  # construction delegated to `Grappa.QueryWindows.Wire` so the after_join
  # push and the per-mutation `broadcast_windows_list` (fired from
  # `QueryWindows.open/4` / `.close/4`) share one shape — and crucially
  # one Jason-encodable form. A struct-shaped payload crashes the channel
  # during fan-out (`%Window{}` doesn't derive Jason.Encoder), which in
  # turn loses any subsequent push on the same channel ref.
  @spec push_query_windows_list(Session.subject(), Phoenix.Socket.t()) :: :ok
  defp push_query_windows_list(subject, socket) do
    payload =
      subject
      |> QueryWindows.list_for_subject()
      |> QueryWindows.Wire.render_grouped()
      |> QueryWindows.Wire.windows_list_payload()

    push(socket, "event", payload)
  end

  @spec push_topic_if_cached(Session.subject(), Network.t(), String.t(), Phoenix.Socket.t()) :: :ok
  defp push_topic_if_cached(subject, %Network{} = network, channel, socket) do
    case Session.get_topic(subject, network.id, channel) do
      {:ok, entry} ->
        push(socket, "event", SessionWire.topic_changed(network.slug, channel, entry))

      {:error, _} ->
        :ok
    end
  end

  @spec push_modes_if_cached(Session.subject(), Network.t(), String.t(), Phoenix.Socket.t()) :: :ok
  defp push_modes_if_cached(subject, %Network{} = network, channel, socket) do
    case Session.get_channel_modes(subject, network.id, channel) do
      {:ok, entry} ->
        push(socket, "event", SessionWire.channel_modes_changed(network.slug, channel, entry))

      {:error, _} ->
        :ok
    end
  end

  # CP15 B3: pushes the cached members list for the channel as a
  # `members_seeded` event, mirroring the broadcast emitted by the 366
  # RPL_ENDOFNAMES apply_effects arm. Closes the deploy-reconnect race
  # where cic subscribes after the original broadcast fired.
  #
  # CP24 bucket E web/S8: skip the cold-snapshot push when the
  # server reports `:uninitialized` (joined but pre-NAMES, OR not
  # joined). cic's MembersPane spinner stays visible — the
  # canonical 366-driven `members_seeded` broadcast lands later.
  # An empty list (`{:ok, []}` post-S8) is a real "NAMES emitted
  # zero members" signal and IS pushed so cic flips from
  # "loading…" to "no members".
  @spec push_members_if_seeded(Session.subject(), Network.t(), String.t(), Phoenix.Socket.t()) ::
          :ok
  defp push_members_if_seeded(subject, %Network{} = network, channel, socket) do
    case Session.list_members(subject, network.id, channel) do
      {:ok, :uninitialized} ->
        :ok

      {:ok, members} when is_list(members) ->
        push(socket, "event", SessionWire.members_seeded(network.slug, channel, members))

      {:error, _} ->
        :ok
    end
  end

  # CP15 B3: pushes the snapshot-ready window-state payload assembled by
  # `Session.get_window_state/3`. Payload is byte-identical to the
  # event-time broadcast for the same kind so cic's renderer doesn't
  # branch on snapshot-vs-event origin. Closes the deploy-reconnect race
  # where cic stays in :pending after subscribing to a session whose
  # :joined / :failed / :kicked broadcast already fired.
  @spec push_window_state_if_known(
          Session.subject(),
          Network.t(),
          String.t(),
          Phoenix.Socket.t()
        ) :: :ok
  defp push_window_state_if_known(subject, %Network{} = network, channel, socket) do
    case Session.get_window_state(subject, network.id, channel) do
      {:ok, payload} ->
        push(socket, "event", payload)

      {:error, _} ->
        :ok
    end
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  @spec visitor?(String.t()) :: boolean()
  defp visitor?(user_name), do: String.starts_with?(user_name, "visitor:")

  # CP24 bucket E web/S6 + S7: tagged-tuple gate helpers used by Channel
  # `handle_in/3` clauses. Each predicate the `with` chain consults
  # returns `{:ok, _}` on success or `{:error, :tag}` on failure so the
  # `else` arms match by tag (single source) rather than by raw boolean
  # value (ambiguous between two checks). CLAUDE.md "Atoms or `@type t
  # :: literal | literal` — never untyped strings" applies to control
  # flow too: an `else true ->` arm is structurally identical to an
  # `else false ->` arm and the second `with true <- ...` clause silently
  # remaps the error message of the first.

  @spec check_not_visitor(String.t()) ::
          {:ok, :user} | {:error, :visitor_not_allowed}
  defp check_not_visitor(user_name) do
    if visitor?(user_name),
      do: {:error, :visitor_not_allowed},
      else: {:ok, :user}
  end

  # CP24 bucket E web/S7: per-arg IRC-shape validator used by every
  # `handle_in/3` clause that accepts `channel`, `nick`, `nicks`, or
  # `mask` payload fields. Reject the FIRST malformed token with a
  # tagged tuple — `else` arms in `dispatch_*_verb/3` map by tag.
  #
  # Why a list-of-pairs and not separate predicates: every Channel
  # `handle_in/3` clause already carries a small fixed set of
  # IRC-shape args. A single validator gates the whole set with one
  # function call (`validate_args(channel: chan, nicks: nicks)`)
  # instead of a per-arg `with` chain. Order is the caller's order
  # — first failure wins. For `nicks: [...]` the FIRST malformed
  # nick wins.
  #
  # Tags chosen for stability over the cic surface:
  # `:invalid_channel` → bad channel name; `:invalid_nick` → bad
  # nickname; `:invalid_mask` → CRLF/NUL in a mask token (RFC 2812
  # `mask` syntax is permissive — the only inviolable property is
  # line-safety); `:invalid_line` → CRLF/NUL in a free-form text
  # token (kick reason, topic body).
  @typep validate_arg ::
           {:channel, String.t()}
           | {:nick, String.t()}
           | {:nicks, [String.t()]}
           | {:mask, String.t()}
           | {:line, String.t()}
           | {:params, [String.t()]}

  @spec validate_args([validate_arg()]) ::
          {:ok, :ok}
          | {:error, :invalid_channel | :invalid_nick | :invalid_mask | :invalid_line}
  defp validate_args([]), do: {:ok, :ok}

  defp validate_args([{:channel, value} | rest]) do
    if Identifier.valid_channel?(value),
      do: validate_args(rest),
      else: {:error, :invalid_channel}
  end

  defp validate_args([{:nick, value} | rest]) do
    if Identifier.valid_nick?(value),
      do: validate_args(rest),
      else: {:error, :invalid_nick}
  end

  defp validate_args([{:nicks, []} | _]), do: {:error, :invalid_nick}

  defp validate_args([{:nicks, list} | rest]) when is_list(list) do
    if Enum.all?(list, &Identifier.valid_nick?/1),
      do: validate_args(rest),
      else: {:error, :invalid_nick}
  end

  defp validate_args([{:mask, value} | rest]) do
    if Identifier.safe_line_token?(value) and value != "",
      do: validate_args(rest),
      else: {:error, :invalid_mask}
  end

  defp validate_args([{:line, value} | rest]) do
    if Identifier.safe_line_token?(value),
      do: validate_args(rest),
      else: {:error, :invalid_line}
  end

  defp validate_args([{:params, list} | rest]) when is_list(list) do
    if Enum.all?(list, &Identifier.safe_line_token?/1),
      do: validate_args(rest),
      else: {:error, :invalid_line}
  end

  @spec safe_get_user(String.t()) :: {:ok, Accounts.User.t()} | :error
  defp safe_get_user(user_name) do
    user = Accounts.get_user_by_name!(user_name)
    {:ok, user}
  rescue
    Ecto.NoResultsError -> :error
  end

  @spec authorize(Topic.parsed(), Phoenix.Socket.t()) :: :ok | {:error, :forbidden}
  defp authorize(parsed, socket) do
    if Topic.user_of(parsed) == socket.assigns.user_name do
      :ok
    else
      {:error, :forbidden}
    end
  end

  # S5.3: shared dispatch path for visitor-rejecting (write) ops verbs.
  # CP24 bucket B reviewer add-on: read-only verbs (whois/who/names/banlist)
  # split off to `dispatch_subject_verb/2` below — visitors are entitled
  # to issue those.
  #
  # 1. Reject visitor sockets — they have no upstream IRC session with operator
  #    state, AND the verbs that route here mutate channel/server state
  #    (op/deop/voice/devoice/kick/ban/unban/invite/umode/mode/topic_set/
  #    topic_clear) which the visitor's `subject_label` topic isn't
  #    entitled to drive.
  # 2. Resolve the authenticated user.
  # 3. Invoke the caller-supplied session thunk. The thunk returns
  #    `:ok | {:error, :no_session}` — `call_session` inside Session.*
  #    returns `{:error, :no_session}` when no session is registered for the
  #    (user, network_id) pair.
  #
  # Error mapping is kept flat and minimal — the cicchetto client needs a short
  # discriminator string, not a nested struct.
  # CP24 bucket E web/S7: arity-3 dispatch that runs an inbound IRC-shape
  # validator BEFORE visitor + user resolution + session dispatch. The
  # `validate_thunk` returns `{:ok, _} | {:error, :invalid_*}`. Defense in
  # depth at the outer untrusted boundary — the REST surface gates via
  # `GrappaWeb.Validation.validate_*` (`{:error, :bad_request}` → 400);
  # the Channel surface uses tagged-tuple atoms (`:invalid_channel` /
  # `:invalid_nick` / `:invalid_mask` / `:invalid_line`) that the
  # `else` arms map to a stable cicchetto-facing reason string. A
  # hostile cic instance (or compromised user) cannot inject
  # malformed/CRLF/NUL bytes via WS even if the upstream Identifier
  # gate ever loosens.
  @spec dispatch_ops_verb(
          Phoenix.Socket.t(),
          (-> {:ok, term()} | {:error, atom()}),
          (Accounts.User.t() -> :ok | {:error, atom()})
        ) :: {:reply, :ok | {:error, map()}, Phoenix.Socket.t()}
  defp dispatch_ops_verb(socket, validate_thunk, thunk) do
    user_name = socket.assigns.user_name

    with {:ok, _} <- validate_thunk.(),
         {:ok, _} <- check_not_visitor(user_name),
         {:ok, user} <- safe_get_user(user_name),
         :ok <- thunk.(user) do
      {:reply, :ok, socket}
    else
      {:error, :invalid_channel} -> {:reply, {:error, %{reason: "invalid_channel"}}, socket}
      {:error, :invalid_nick} -> {:reply, {:error, %{reason: "invalid_nick"}}, socket}
      {:error, :invalid_mask} -> {:reply, {:error, %{reason: "invalid_mask"}}, socket}
      {:error, :invalid_line} -> {:reply, {:error, %{reason: "invalid_line"}}, socket}
      {:error, :visitor_not_allowed} -> {:reply, {:error, %{reason: "visitor_not_allowed"}}, socket}
      :error -> {:reply, {:error, %{reason: "user_not_found"}}, socket}
      {:error, :no_session} -> {:reply, {:error, %{reason: "no_session"}}, socket}
    end
  end

  # HIGH-19 (no-silent-drops B6.9a 2026-05-14): inline body cap wrapper
  # for ops verbs that thread free-form text upstream (kick reason,
  # umode/mode modes string). Pre-checks `BodyLimit.check/1` before
  # `dispatch_ops_verb/3`; oversize input replies `body_too_large`
  # without ever entering the with chain. Dialyzer's success-typing
  # narrows the with-chain `else` arms based on actual reachable
  # validator outputs, so adding a `:body_too_large` arm to
  # `dispatch_ops_verb`'s `else` triggers `pattern_match never matches`
  # — the explicit pre-check side-steps that and keeps the with chain
  # focused on identifier-shape validation.
  @spec with_body_check(
          Phoenix.Socket.t(),
          binary(),
          (-> {:reply, term(), Phoenix.Socket.t()})
        ) :: {:reply, term(), Phoenix.Socket.t()}
  defp with_body_check(socket, body, dispatch_thunk) when is_binary(body) do
    case BodyLimit.check(body) do
      :ok -> dispatch_thunk.()
      {:error, :body_too_large} -> {:reply, {:error, %{reason: "body_too_large"}}, socket}
    end
  end

  # Extracted from `handle_in("topic_set", ...)` to keep that clause
  # below Credo's nesting depth gate after the `with_body_check`
  # wrapper landed (HIGH-19).
  @spec topic_set_dispatch(
          Phoenix.Socket.t(),
          String.t(),
          integer(),
          String.t(),
          String.t()
        ) :: {:reply, term(), Phoenix.Socket.t()}
  defp topic_set_dispatch(socket, user_name, network_id, channel, text) do
    with {:ok, _} <- validate_args(channel: channel, line: text),
         {:ok, _} <- check_not_visitor(user_name),
         {:ok, user} <- safe_get_user(user_name),
         {:ok, _} <- Session.send_topic({:user, user.id}, network_id, channel, text) do
      {:reply, :ok, socket}
    else
      {:error, :invalid_channel} -> {:reply, {:error, %{reason: "invalid_channel"}}, socket}
      {:error, :invalid_line} -> {:reply, {:error, %{reason: "invalid_line"}}, socket}
      {:error, :visitor_not_allowed} -> {:reply, {:error, %{reason: "visitor_not_allowed"}}, socket}
      :error -> {:reply, {:error, %{reason: "user_not_found"}}, socket}
      {:error, :no_session} -> {:reply, {:error, %{reason: "no_session"}}, socket}
      {:error, _} -> {:reply, {:error, %{reason: "persist_failed"}}, socket}
    end
  end

  # Extracted from `handle_in("away", action: "set", ...)` to keep
  # that clause below Credo's nesting depth gate after the
  # `with_body_check` wrapper landed (HIGH-19).
  @spec away_set_dispatch(
          Phoenix.Socket.t(),
          String.t(),
          String.t(),
          String.t(),
          String.t() | nil
        ) :: {:reply, term(), Phoenix.Socket.t()}
  defp away_set_dispatch(socket, user_name, slug, reason, origin_window) do
    with {:ok, user} <- safe_get_user(user_name),
         {:ok, %Network{} = network} <- Networks.get_network_by_slug(slug),
         :ok <- dispatch_set_away(user, network, reason, origin_window) do
      {:reply, :ok, socket}
    else
      :error -> {:reply, {:error, %{reason: "user_not_found"}}, socket}
      {:error, :not_found} -> {:reply, {:error, %{reason: "network_not_found"}}, socket}
      {:error, :no_session} -> {:reply, {:error, %{reason: "no_session"}}, socket}
      {:error, :invalid_line} -> {:reply, {:error, %{reason: "invalid_reason"}}, socket}
    end
  end

  # C3 (CRITICAL — 2026-05-12 codebase review): subject-aware dispatch for
  # read-only verbs that visitors are explicitly allowed to issue (WHOIS,
  # WHO, NAMES, BANLIST as of CP24 bucket B reviewer add-on; future
  # visitor-eligible read verbs land here too). Mirrors
  # `dispatch_ops_verb/2` but resolves the socket's identity into a
  # `t:Grappa.Session.subject/0` tagged tuple — `{:user, id}` for an
  # authenticated user (loaded via `safe_get_user/1`), `{:visitor, id}`
  # for a visitor (id extracted from the `"visitor:<uuid>"` `user_name`
  # assigned by `UserSocket.connect/3`). The thunk receives the subject
  # and dispatches to a `Session.send_*` facade that already accepts
  # `subject()`. Reject-only path is `{:error, :no_session}` — visitors
  # without a live `Session.Server` get the same surface user-side
  # callers do, NOT the `visitor_not_allowed` carve-out.
  # CP24 bucket E web/S7: arity-3 subject-verb dispatch with inbound
  # IRC-shape validation. Mirror of `dispatch_ops_verb/3` for the
  # read-only verbs (whois/who/names/banlist) that visitors are allowed
  # to issue. Same defense-in-depth rationale: hostile cic should not be
  # able to inject CRLF/NUL or malformed IRC tokens into a channel send,
  # even if the upstream Identifier gate ever loosens.
  @spec dispatch_subject_verb(
          Phoenix.Socket.t(),
          (-> {:ok, term()} | {:error, atom()}),
          (Session.subject() -> :ok | {:error, atom()})
        ) :: {:reply, :ok | {:error, map()}, Phoenix.Socket.t()}
  defp dispatch_subject_verb(socket, validate_thunk, thunk) do
    user_name = socket.assigns.user_name

    with {:ok, _} <- validate_thunk.(),
         {:ok, subject} <- resolve_subject(user_name),
         :ok <- thunk.(subject) do
      {:reply, :ok, socket}
    else
      {:error, :invalid_channel} -> {:reply, {:error, %{reason: "invalid_channel"}}, socket}
      {:error, :invalid_nick} -> {:reply, {:error, %{reason: "invalid_nick"}}, socket}
      {:error, :invalid_mask} -> {:reply, {:error, %{reason: "invalid_mask"}}, socket}
      {:error, :invalid_line} -> {:reply, {:error, %{reason: "invalid_line"}}, socket}
      :error -> {:reply, {:error, %{reason: "user_not_found"}}, socket}
      {:error, :no_session} -> {:reply, {:error, %{reason: "no_session"}}, socket}
    end
  end

  # `user_name` carries `"visitor:" <> visitor.id` for visitor sockets
  # (assigned by `UserSocket.connect/3`) and `user.name` for authenticated
  # user sockets. Strip the prefix on visitor decode; user-side decode
  # delegates to `safe_get_user/1` so a deleted-row race surfaces as
  # `{:error, :not_found}` → `user_not_found` reply.
  @spec resolve_subject(String.t()) :: {:ok, Session.subject()} | :error
  defp resolve_subject("visitor:" <> visitor_id), do: {:ok, {:visitor, visitor_id}}

  defp resolve_subject(user_name) do
    case safe_get_user(user_name) do
      {:ok, user} -> {:ok, {:user, user.id}}
      :error -> :error
    end
  end

  # S4.3: dispatch set_away with or without origin_window. When origin_window
  # is nil (cicchetto didn't send it — pre-C-bucket clients), falls back to
  # the 3-arg variant that doesn't track last_command_window.
  @spec dispatch_set_away(Accounts.User.t(), Network.t(), String.t(), map() | nil) ::
          :ok | {:error, :no_session | :invalid_line}
  defp dispatch_set_away(%Accounts.User{} = user, %Network{} = network, reason, nil) do
    Session.set_explicit_away({:user, user.id}, network.id, reason)
  end

  defp dispatch_set_away(%Accounts.User{} = user, %Network{} = network, reason, origin_window)
       when is_map(origin_window) do
    Session.set_explicit_away({:user, user.id}, network.id, reason, origin_window)
  end

  # S4.3: dispatch unset_away with or without origin_window.
  @spec dispatch_unset_away(Accounts.User.t(), Network.t(), map() | nil) ::
          :ok | {:error, :no_session | :not_explicit}
  defp dispatch_unset_away(%Accounts.User{} = user, %Network{} = network, nil) do
    Session.unset_explicit_away({:user, user.id}, network.id)
  end

  defp dispatch_unset_away(%Accounts.User{} = user, %Network{} = network, origin_window)
       when is_map(origin_window) do
    Session.unset_explicit_away({:user, user.id}, network.id, origin_window)
  end
end
