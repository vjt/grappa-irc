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
  3. Subscribe to the topic on `Grappa.PubSub` and accept the join.
  4. Kick off the after-join snapshot via `Process.send_after/3` with
     `:after_join` so the costly DB + session queries run after the
     join callback returns — `join/3` must be fast (Phoenix blocks the
     client until it returns).

  ## After-join snapshots

  ### User-level topic (`grappa:user:{user}`)

  Pushes:
  - `query_windows_list` — full current DM window list for the user.
    Skipped for visitor sockets (`user_name` starts with `"visitor:"`).
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

  - `"umode"` — user-mode change on own nick. Payload: `%{"network_id" => id,
    "modes" => modes}`.

  - `"mode"` — raw verbatim MODE line, no chunking. Payload: `%{"network_id" => id,
    "target" => target, "modes" => modes, "params" => [...]}`.

  - `"topic_set"` — set channel topic. Payload: `%{"network_id" => id, "channel" => chan,
    "text" => text}`. Persists a scrollback `:topic` row. Rejects CRLF injection.

  - `"topic_clear"` — clear channel topic (irssi `/topic -delete` convention).
    Payload: `%{"network_id" => id, "channel" => chan}`. Sends `TOPIC #chan :`.

  All ops verbs reject visitor sockets and return `{:error, %{reason: "visitor_not_allowed"}}`.

  ## Outbound event shapes

  All events pushed by this channel share the `kind:` discriminator (string
  for JSON-friendliness in cicchetto):

  - `"topic_changed"` — `%{kind: "topic_changed", network: slug, channel: chan, topic: entry}`
  - `"channel_modes_changed"` — `%{kind: "channel_modes_changed", network: slug, channel: chan, modes: entry}`
  - `"query_windows_list"` — `%{kind: "query_windows_list", windows: %{network_id => [%Window{}]}}`

  On `{:event, payload}` from PubSub, push it to the connected socket
  as an `"event"` push verbatim. The push payload shape is whatever
  the broadcaster sent — this module does NOT reshape events. The
  wire-shape contract lives at the broadcasting boundary
  (`Grappa.Session.Server` via `Grappa.Scrollback.Wire`).

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

  alias Grappa.{Accounts, Networks, QueryWindows, Session, WSPresence}
  alias Grappa.Networks.{Credentials, Network}
  alias Grappa.PubSub.Topic

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
  @type query_windows_list_payload :: %{
          kind: String.t(),
          windows: %{integer() => [QueryWindows.Window.t()]}
        }

  @impl Phoenix.Channel
  def join(topic, _, socket) do
    with {:ok, parsed} <- Topic.parse(topic),
         :ok <- authorize(parsed, socket) do
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)
      Process.send_after(self(), {:after_join, parsed}, 0)
      {:ok, socket}
    else
      :error -> {:error, %{reason: "unknown topic"}}
      {:error, :forbidden} -> {:error, %{reason: "forbidden"}}
    end
  end

  @impl Phoenix.Channel
  def handle_info({:event, payload}, socket) do
    push(socket, "event", payload)
    {:noreply, socket}
  end

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

    unless visitor?(user_name) do
      :ok = WSPresence.client_closing(user_name, socket.transport_pid)
    end

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
    dispatch_ops_verb(socket, fn user ->
      Session.send_op({:user, user.id}, network_id, channel, nicks)
    end)
  end

  # /deop alice bob carol  →  MODE #chan -ooo alice bob carol
  def handle_in(
        "deop",
        %{"network_id" => network_id, "channel" => channel, "nicks" => nicks},
        socket
      )
      when is_integer(network_id) and is_binary(channel) and is_list(nicks) do
    dispatch_ops_verb(socket, fn user ->
      Session.send_deop({:user, user.id}, network_id, channel, nicks)
    end)
  end

  # /voice alice  →  MODE #chan +v alice
  def handle_in(
        "voice",
        %{"network_id" => network_id, "channel" => channel, "nicks" => nicks},
        socket
      )
      when is_integer(network_id) and is_binary(channel) and is_list(nicks) do
    dispatch_ops_verb(socket, fn user ->
      Session.send_voice({:user, user.id}, network_id, channel, nicks)
    end)
  end

  # /devoice alice  →  MODE #chan -v alice
  def handle_in(
        "devoice",
        %{"network_id" => network_id, "channel" => channel, "nicks" => nicks},
        socket
      )
      when is_integer(network_id) and is_binary(channel) and is_list(nicks) do
    dispatch_ops_verb(socket, fn user ->
      Session.send_devoice({:user, user.id}, network_id, channel, nicks)
    end)
  end

  # /kick alice :bye  →  KICK #chan alice :bye
  def handle_in(
        "kick",
        %{"network_id" => network_id, "channel" => channel, "nick" => nick, "reason" => reason},
        socket
      )
      when is_integer(network_id) and is_binary(channel) and is_binary(nick) and
             is_binary(reason) do
    dispatch_ops_verb(socket, fn user ->
      Session.send_kick({:user, user.id}, network_id, channel, nick, reason)
    end)
  end

  # /ban *!*@evil.com or /ban alice (bare nick → mask derivation in Server)
  def handle_in(
        "ban",
        %{"network_id" => network_id, "channel" => channel, "mask" => mask},
        socket
      )
      when is_integer(network_id) and is_binary(channel) and is_binary(mask) do
    dispatch_ops_verb(socket, fn user ->
      Session.send_ban({:user, user.id}, network_id, channel, mask)
    end)
  end

  # /unban *!*@evil.com  →  MODE #chan -b *!*@evil.com
  def handle_in(
        "unban",
        %{"network_id" => network_id, "channel" => channel, "mask" => mask},
        socket
      )
      when is_integer(network_id) and is_binary(channel) and is_binary(mask) do
    dispatch_ops_verb(socket, fn user ->
      Session.send_unban({:user, user.id}, network_id, channel, mask)
    end)
  end

  # /invite alice  →  INVITE alice #chan (RFC 2812: nick first, channel second)
  def handle_in(
        "invite",
        %{"network_id" => network_id, "channel" => channel, "nick" => nick},
        socket
      )
      when is_integer(network_id) and is_binary(channel) and is_binary(nick) do
    dispatch_ops_verb(socket, fn user ->
      Session.send_invite({:user, user.id}, network_id, channel, nick)
    end)
  end

  # /banlist  →  MODE #chan b (query form, no sign)
  def handle_in(
        "banlist",
        %{"network_id" => network_id, "channel" => channel},
        socket
      )
      when is_integer(network_id) and is_binary(channel) do
    dispatch_ops_verb(socket, fn user ->
      Session.send_banlist({:user, user.id}, network_id, channel)
    end)
  end

  # /umode +i  →  MODE own_nick +i
  def handle_in(
        "umode",
        %{"network_id" => network_id, "modes" => modes},
        socket
      )
      when is_integer(network_id) and is_binary(modes) do
    dispatch_ops_verb(socket, fn user ->
      Session.send_umode({:user, user.id}, network_id, modes)
    end)
  end

  # /mode #chan +o-v alice bob  →  MODE #chan +o-v alice bob (verbatim, no chunking)
  def handle_in(
        "mode",
        %{"network_id" => network_id, "target" => target, "modes" => modes, "params" => params},
        socket
      )
      when is_integer(network_id) and is_binary(target) and is_binary(modes) and is_list(params) do
    dispatch_ops_verb(socket, fn user ->
      Session.send_mode({:user, user.id}, network_id, target, modes, params)
    end)
  end

  # /topic <text>  →  TOPIC #chan :<text>
  # send_topic returns {:ok, message} on success (persists scrollback row).
  # The visitor check and user lookup use the shared helper path directly.
  def handle_in(
        "topic_set",
        %{"network_id" => network_id, "channel" => channel, "text" => text},
        socket
      )
      when is_integer(network_id) and is_binary(channel) and is_binary(text) do
    user_name = socket.assigns.user_name

    with false <- visitor?(user_name),
         {:ok, user} <- safe_get_user(user_name),
         {:ok, _} <- Session.send_topic({:user, user.id}, network_id, channel, text) do
      {:reply, :ok, socket}
    else
      true -> {:reply, {:error, %{reason: "visitor_not_allowed"}}, socket}
      :error -> {:reply, {:error, %{reason: "user_not_found"}}, socket}
      {:error, :no_session} -> {:reply, {:error, %{reason: "no_session"}}, socket}
      {:error, :invalid_line} -> {:reply, {:error, %{reason: "invalid_line"}}, socket}
      {:error, _} -> {:reply, {:error, %{reason: "persist_failed"}}, socket}
    end
  end

  # /topic -delete  →  TOPIC #chan : (empty trailing — irssi convention, S5.4)
  def handle_in(
        "topic_clear",
        %{"network_id" => network_id, "channel" => channel},
        socket
      )
      when is_integer(network_id) and is_binary(channel) do
    dispatch_ops_verb(socket, fn user ->
      Session.send_topic_clear({:user, user.id}, network_id, channel)
    end)
  end

  # ---------------------------------------------------------------------------
  # After-join snapshot helpers
  # ---------------------------------------------------------------------------

  # Pushes the full user-level snapshot: query_windows_list + topic/modes
  # for every joined channel across all networks.
  @spec push_user_snapshot(String.t(), Phoenix.Socket.t()) :: :ok
  defp push_user_snapshot(user_name, socket) do
    if visitor?(user_name) do
      :ok
    else
      case safe_get_user(user_name) do
        {:ok, user} ->
          push_query_windows_list(user, socket)
          push_all_topics_and_modes(user, socket)

        :error ->
          :ok
      end
    end
  end

  # Pushes cached topic_changed + channel_modes_changed for a single channel.
  @spec push_channel_snapshot(String.t(), String.t(), String.t(), Phoenix.Socket.t()) :: :ok
  defp push_channel_snapshot(user_name, network_slug, channel, socket) do
    case safe_get_user(user_name) do
      {:ok, user} ->
        case Networks.get_network_by_slug(network_slug) do
          {:ok, %Network{} = network} ->
            subject = {:user, user.id}
            push_topic_if_cached(subject, network, channel, socket)
            push_modes_if_cached(subject, network, channel, socket)

          {:error, :not_found} ->
            :ok
        end

      :error ->
        :ok
    end
  end

  # Pushes query_windows_list for `user`.
  @spec push_query_windows_list(Accounts.User.t(), Phoenix.Socket.t()) :: :ok
  defp push_query_windows_list(%Accounts.User{} = user, socket) do
    windows = QueryWindows.list_for_user(user.id)
    push(socket, "event", %{kind: "query_windows_list", windows: windows})
  end

  # For every (network, channel) the user has an active session for, pushes
  # cached topic_changed + channel_modes_changed to the socket.
  @spec push_all_topics_and_modes(Accounts.User.t(), Phoenix.Socket.t()) :: :ok
  defp push_all_topics_and_modes(%Accounts.User{} = user, socket) do
    subject = {:user, user.id}
    credentials = Credentials.list_credentials_for_user(user)

    for %{network: %Network{} = network} <- credentials do
      push_network_snapshot(subject, network, socket)
    end

    :ok
  end

  @spec push_network_snapshot(Session.subject(), Network.t(), Phoenix.Socket.t()) :: :ok
  defp push_network_snapshot(subject, %Network{} = network, socket) do
    case Session.list_channels(subject, network.id) do
      {:ok, channels} ->
        for channel <- channels do
          push_topic_if_cached(subject, network, channel, socket)
          push_modes_if_cached(subject, network, channel, socket)
        end

        :ok

      {:error, :no_session} ->
        :ok
    end
  end

  @spec push_topic_if_cached(Session.subject(), Network.t(), String.t(), Phoenix.Socket.t()) :: :ok
  defp push_topic_if_cached(subject, %Network{} = network, channel, socket) do
    case Session.get_topic(subject, network.id, channel) do
      {:ok, entry} ->
        push(socket, "event", %{
          kind: "topic_changed",
          network: network.slug,
          channel: channel,
          topic: entry
        })

      {:error, _} ->
        :ok
    end
  end

  @spec push_modes_if_cached(Session.subject(), Network.t(), String.t(), Phoenix.Socket.t()) :: :ok
  defp push_modes_if_cached(subject, %Network{} = network, channel, socket) do
    case Session.get_channel_modes(subject, network.id, channel) do
      {:ok, entry} ->
        push(socket, "event", %{
          kind: "channel_modes_changed",
          network: network.slug,
          channel: channel,
          modes: entry
        })

      {:error, _} ->
        :ok
    end
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  @spec visitor?(String.t()) :: boolean()
  defp visitor?(user_name), do: String.starts_with?(user_name, "visitor:")

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

  # S5.3: shared dispatch path for all ops verbs.
  #
  # 1. Reject visitor sockets — they have no upstream IRC session with operator
  #    state.
  # 2. Resolve the authenticated user.
  # 3. Invoke the caller-supplied session thunk. The thunk returns
  #    `:ok | {:error, :no_session}` — `call_session` inside Session.*
  #    returns `{:error, :no_session}` when no session is registered for the
  #    (user, network_id) pair.
  #
  # Error mapping is kept flat and minimal — the cicchetto client needs a short
  # discriminator string, not a nested struct.
  @spec dispatch_ops_verb(Phoenix.Socket.t(), (Accounts.User.t() -> :ok | {:error, atom()})) ::
          {:reply, :ok | {:error, map()}, Phoenix.Socket.t()}
  defp dispatch_ops_verb(socket, thunk) do
    user_name = socket.assigns.user_name

    with false <- visitor?(user_name),
         {:ok, user} <- safe_get_user(user_name),
         :ok <- thunk.(user) do
      {:reply, :ok, socket}
    else
      true -> {:reply, {:error, %{reason: "visitor_not_allowed"}}, socket}
      :error -> {:reply, {:error, %{reason: "user_not_found"}}, socket}
      {:error, :no_session} -> {:reply, {:error, %{reason: "no_session"}}, socket}
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
