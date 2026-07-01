defmodule GrappaWeb.GrappaChannel do
  @moduledoc """
  Single channel module for all Grappa real-time topics.

  ## Join behavior

  1. Parse the topic via `Grappa.PubSub.Topic.parse/1`. Unknown
     shapes (including the Phase 1 `grappa:network:...` shape, which
     sub-task 2h removed) get `{:error, %{error: "unknown topic"}}`.
  2. Cross-user authz: every Grappa topic is rooted in a user_name.
     If `socket.assigns.user_name` does not match the topic's
     embedded user, return `{:error, %{error: "forbidden"}}`. This
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

  Visitor sockets may issue EVERY verb — the state-mutating channel ops
  (op/deop/voice/devoice/kick/ban/unban/umode/mode/topic_set/topic_clear),
  the read-only queries (whois/whowas/who/names/banlist/lusers), `/away`
  (#62), `/invite` (#31), `/oper` (#148), and the `/raw` escape hatch
  (#153). Every verb resolves the socket to a `t:Grappa.Session.subject/0`
  via `resolve_subject/1` (`{:visitor, id}` or `{:user, id}`) and
  dispatches through `dispatch_subject_verb/3`: each visitor owns a
  private `Session.Server` + upstream connection, and the upstream IRC
  server (O:lines, channel-op status, services) is the authority on
  whether a given verb is permitted — the bouncer only enforces
  IRC-shape validation (identifier/CRLF/NUL) + body-size caps, never an
  identity gate. See the per-clause comments.

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

  alias Grappa.{Accounts, Networks, QueryWindows, ReadCursor, Scrollback, Session, UserSettings, WSPresence}
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

  require Logger

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
      :error -> {:error, %{error: "unknown topic"}}
      {:error, :forbidden} -> {:error, %{error: "forbidden"}}
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
  #
  # 2026-06-01 (unread-badges-from-cursor cluster, bucket B1): the
  # reply ALSO carries `:unread_count` — the integer count of rows
  # strictly after the cursor under the same predicate `fetch_after/6`
  # uses (`Grappa.Scrollback.count_after/5`). cic seeds its
  # `serverSeedCounts` store from this value and falls back to it for
  # channels whose scrollback hasn't been hydrated yet; when local
  # scrollback IS hydrated, cic derives the count from it directly so
  # the badge tracks the cursor as it advances (read_cursor_set
  # broadcasts) without a server round-trip.
  #
  # `:unread_count = 0` for the unresolvable-context fall-through
  # (deleted user, missing network, no session at all) so cic can
  # render a zero badge instead of branching on null. The cursor
  # remains `nil` in that same fall-through; cic uses that as the
  # "no cursor yet" signal, not the count.
  @spec join_reply(Topic.parsed()) :: %{
          optional(:read_cursor) => integer() | nil,
          optional(:unread_count) => non_neg_integer()
        }
  defp join_reply({:channel, user_name, network_slug, channel}) do
    with {:ok, subject} <- resolve_subject(user_name),
         {:ok, %Network{} = network} <- Networks.get_network_by_slug(network_slug) do
      cursor =
        case ReadCursor.get(subject, network.id, channel) do
          %ReadCursor.Cursor{last_read_message_id: id} -> id
          _ -> nil
        end

      own_nick =
        case Session.current_nick(subject, network.id) do
          {:ok, nick} -> nick
          {:error, :no_session} -> nil
        end

      # cursor == nil → after_id = 0 → count_after returns every row
      # in the (subject, network, channel) partition (all unread). cic
      # treats `:read_cursor = nil` as "no cursor yet" + uses
      # `:unread_count` to render the full-channel badge until the user
      # focuses the window and the cursor lands.
      unread = Scrollback.count_after(subject, network.id, channel, cursor || 0, own_nick)

      %{read_cursor: cursor, unread_count: unread}
    else
      _ -> %{read_cursor: nil, unread_count: 0}
    end
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
  # Resolves the socket identity to a `t:Grappa.Session.subject/0` via
  # `resolve_subject/1` and the network slug to a network_id via
  # `Networks.get_network_by_slug/1`, then delegates to
  # `Session.set_explicit_away/3,4`. Returns `{:ok, _}` on success.
  #
  # Issue #62: visitors ARE allowed — each visitor owns a private, isolated
  # `Session.Server` + upstream IRC connection, and the `set_explicit_away`
  # facade already accepts any `subject()`. Explicit `/away` is a
  # per-connection user action; this is distinct from the WSPresence-driven
  # AUTO-away, which stays user-only because visitor sessions don't subscribe
  # to `WSPresence` (see DESIGN_NOTES, auto-away). Mirrors the C3 WHOIS
  # carve-out: subject-aware dispatch, not a `visitor?` short-circuit.
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
    origin_window = Map.get(payload, "origin_window")
    with_body_check(socket, reason, fn -> away_set_dispatch(socket, slug, reason, origin_window) end)
  end

  # S3.4 — /away slash-command: unset explicit away.
  #
  # Issue #62: subject-aware (visitors allowed, see the `set` arm above).
  # Returns `{:error, %{error: "not_explicit"}}` if the session is not in
  # `:away_explicit` state (mirrors `Session.unset_explicit_away/2`'s
  # `{:error, :not_explicit}` return).
  #
  # S4.3: reads `origin_window` from payload and passes to Session facade.
  def handle_in("away", %{"action" => "unset", "network" => slug} = payload, socket)
      when is_binary(slug) do
    origin_window = Map.get(payload, "origin_window")

    with {:ok, subject} <- resolve_subject(socket.assigns.user_name),
         {:ok, %Network{} = network} <- Networks.get_network_by_slug(slug),
         :ok <- dispatch_unset_away(subject, network, origin_window) do
      {:reply, :ok, socket}
    else
      :error -> {:reply, {:error, %{error: "user_not_found"}}, socket}
      {:error, :not_found} -> {:reply, {:error, %{error: "network_not_found"}}, socket}
      {:error, :no_session} -> {:reply, {:error, %{error: "no_session"}}, socket}
      {:error, :not_explicit} -> {:reply, {:error, %{error: "not_explicit"}}, socket}
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
    dispatch_subject_verb(
      socket,
      fn -> validate_args(channel: channel, nicks: nicks) end,
      fn subject -> Session.send_op(subject, network_id, channel, nicks) end
    )
  end

  # /deop alice bob carol  →  MODE #chan -ooo alice bob carol
  def handle_in(
        "deop",
        %{"network_id" => network_id, "channel" => channel, "nicks" => nicks},
        socket
      )
      when is_integer(network_id) and is_binary(channel) and is_list(nicks) do
    dispatch_subject_verb(
      socket,
      fn -> validate_args(channel: channel, nicks: nicks) end,
      fn subject -> Session.send_deop(subject, network_id, channel, nicks) end
    )
  end

  # /voice alice  →  MODE #chan +v alice
  def handle_in(
        "voice",
        %{"network_id" => network_id, "channel" => channel, "nicks" => nicks},
        socket
      )
      when is_integer(network_id) and is_binary(channel) and is_list(nicks) do
    dispatch_subject_verb(
      socket,
      fn -> validate_args(channel: channel, nicks: nicks) end,
      fn subject -> Session.send_voice(subject, network_id, channel, nicks) end
    )
  end

  # /devoice alice  →  MODE #chan -v alice
  def handle_in(
        "devoice",
        %{"network_id" => network_id, "channel" => channel, "nicks" => nicks},
        socket
      )
      when is_integer(network_id) and is_binary(channel) and is_list(nicks) do
    dispatch_subject_verb(
      socket,
      fn -> validate_args(channel: channel, nicks: nicks) end,
      fn subject -> Session.send_devoice(subject, network_id, channel, nicks) end
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
      dispatch_subject_verb(
        socket,
        fn -> validate_args(channel: channel, nick: nick, line: reason) end,
        fn subject -> Session.send_kick(subject, network_id, channel, nick, reason) end
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
    dispatch_subject_verb(
      socket,
      fn -> validate_args(channel: channel, mask: mask) end,
      fn subject -> Session.send_ban(subject, network_id, channel, mask) end
    )
  end

  # /unban *!*@evil.com  →  MODE #chan -b *!*@evil.com
  def handle_in(
        "unban",
        %{"network_id" => network_id, "channel" => channel, "mask" => mask},
        socket
      )
      when is_integer(network_id) and is_binary(channel) and is_binary(mask) do
    dispatch_subject_verb(
      socket,
      fn -> validate_args(channel: channel, mask: mask) end,
      fn subject -> Session.send_unban(subject, network_id, channel, mask) end
    )
  end

  # /invite alice  →  INVITE alice #chan (RFC 2812: nick first, channel second)
  #
  # Issue #31: routes via `dispatch_subject_verb/3` (as every verb does
  # post-#153). INVITE is a write verb, but visitors are entitled to issue
  # it — each visitor owns a private, isolated `Session.Server` + upstream
  # IRC connection, `Session.send_invite/4` already accepts
  # `t:Session.subject/0` (guarded on `is_subject/1` + routed via
  # `call_session/3`), and the upstream IRC server is the real authority on
  # whether the invite is permitted (issuer must be on the channel; op for
  # +i). A visitor without a live session gets `no_session`, never an
  # identity rejection.
  def handle_in(
        "invite",
        %{"network_id" => network_id, "channel" => channel, "nick" => nick},
        socket
      )
      when is_integer(network_id) and is_binary(channel) and is_binary(nick) do
    dispatch_subject_verb(
      socket,
      fn -> validate_args(channel: channel, nick: nick) end,
      fn subject -> Session.send_invite(subject, network_id, channel, nick) end
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
  # only consumer). Routes via `dispatch_subject_verb/3`, which accepts
  # BOTH `{:user, _}` and `{:visitor, _}` subjects and rejects only on
  # `:no_session`.
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

  # #140 — /names <#channel>. cic pushes after the operator types
  # `/names #chan`; the channel relays to Session.send_names/3 which
  # primes names_pending + emits NAMES upstream. The 353/366 burst
  # drains into ONE ephemeral `names_reply` event on the user topic
  # (cic renders a grouped, dismissable modal) — NOT persisted. The
  # modal is network-scoped (last-write-wins), so no origin_window.
  #
  # CP24 bucket B reviewer add-on: read-only verb — visitors are
  # entitled to issue it. Routes via `dispatch_subject_verb/2`.
  def handle_in(
        "names",
        %{"network_id" => network_id, "channel" => channel},
        socket
      )
      when is_integer(network_id) and is_binary(channel) do
    dispatch_subject_verb(
      socket,
      fn -> validate_args(channel: channel) end,
      fn subject -> Session.send_names(subject, network_id, channel) end
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
      dispatch_subject_verb(
        socket,
        fn -> validate_args(line: modes) end,
        fn subject -> Session.send_umode(subject, network_id, modes) end
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
      dispatch_subject_verb(
        socket,
        fn -> validate_args(line: target, line: modes, params: params) end,
        fn subject -> Session.send_mode(subject, network_id, target, modes, params) end
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
    dispatch_subject_verb(
      socket,
      fn -> validate_args(channel: channel) end,
      fn subject -> Session.send_topic_clear(subject, network_id, channel) end
    )
  end

  # Bundle C (#20 follow-up) — /oper <name> <password> upstream.
  #
  # Issue #148: visitor-ELIGIBLE (routes via `dispatch_subject_verb/3`,
  # like every verb post-#153). A visitor opering is safe: the session
  # registry key includes the full `{:visitor, id}` subject tag
  # (`Session.Server.registry_key/2`), so a visitor has its OWN
  # `Session.Server` and opers ONLY its own upstream IRC link — no
  # shared/pooled session to leak across. The ircd O:line is the real
  # authority (the visitor becomes oper only if the upstream accepts the
  # creds); the bouncer gate was belt-and-suspenders. #153 dropped that
  # identity gate for EVERY verb, not just `oper`.
  #
  # The password travels over the WS frame and is REDACTED in any
  # server-side log line (see `Session.Server.handle_call({:send_oper,
  # ...})`). Field validation uses the stricter `:oper_token` predicate
  # so a hand-crafted push with name/password containing spaces or empty
  # strings fails at this boundary — `OPER  \\r\\n` (empty) and
  # `OPER name extra pw\\r\\n` (space-leak) are both rejected here.
  def handle_in(
        "oper",
        %{"network_id" => network_id, "name" => name, "password" => password},
        socket
      )
      when is_integer(network_id) and is_binary(name) and is_binary(password) do
    dispatch_subject_verb(
      socket,
      fn -> validate_args(oper_token: name, oper_token: password) end,
      fn subject -> Session.send_oper(subject, network_id, name, password) end
    )
  end

  # Bundle C (#20 follow-up) — /quote <raw IRC line>. Visitor-eligible
  # (#153): routes via `dispatch_subject_verb/3` like every other verb.
  # /quote is the unrestricted escape hatch — de-gating it means a
  # visitor (like a user) can send EVERYTHING, including
  # adminserv/as/stats/rehash. That is INTENDED: the ircd O:line +
  # services are the real authority, the bouncer only enforces the same
  # CRLF/NUL line-safety it applies to every other outbound verb.
  def handle_in(
        "raw",
        %{"network_id" => network_id, "line" => line},
        socket
      )
      when is_integer(network_id) and is_binary(line) do
    dispatch_subject_verb(
      socket,
      fn -> validate_args(line: line) end,
      fn subject -> Session.send_raw(subject, network_id, line) end
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
      {:error, :invalid_nick} -> {:reply, {:error, %{error: "invalid_nick"}}, socket}
      :error -> {:reply, {:error, %{error: "user_not_found"}}, socket}
      {:error, _} -> {:reply, {:error, %{error: "open_failed"}}, socket}
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
      {:error, :invalid_nick} -> {:reply, {:error, %{error: "invalid_nick"}}, socket}
      :error -> {:reply, {:error, %{error: "user_not_found"}}, socket}
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
  # `{:ok, %{patterns: [...]}}` on success or `{:error, %{error: ...}}` on
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
      {:error, _} -> {:reply, {:error, %{error: "save_failed"}}, socket}
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
        {:error, _} -> {:reply, {:error, %{error: "save_failed"}}, socket}
      end
    else
      {:reply, {:error, %{error: "not_found"}}, socket}
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
  #
  # Visitor parity (2026-05-27): `user_name` carries `"visitor:" <> id`
  # for visitor sockets — delegate to `resolve_subject/1` so both
  # subject kinds replay the cold snapshot. Pre-fix only the user
  # branch ran (`safe_get_user/1` raised `Ecto.NoResultsError` on the
  # `"visitor:"` prefix and was rescued to `:error`), so visitors who
  # WS-subscribed after the upstream JOIN's NAMES landed never saw the
  # members list — the broadcast had already fired with no subscribers.
  @spec push_channel_snapshot(String.t(), String.t(), String.t(), Phoenix.Socket.t()) :: :ok
  defp push_channel_snapshot(user_name, network_slug, channel, socket) do
    with {:ok, subject} <- resolve_subject(user_name),
         {:ok, %Network{} = network} <- Networks.get_network_by_slug(network_slug) do
      push_topic_if_cached(subject, network, channel, socket)
      push_modes_if_cached(subject, network, channel, socket)
      push_members_if_seeded(subject, network, channel, socket)
      push_window_state_if_known(subject, network, channel, socket)
    else
      _ -> :ok
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
           | {:oper_token, String.t()}
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

  defp validate_args([{:oper_token, value} | rest]) do
    if Identifier.safe_oper_token?(value),
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

  # HIGH-19 (no-silent-drops B6.9a 2026-05-14): inline body cap wrapper
  # for ops verbs that thread free-form text upstream (kick reason,
  # umode/mode modes string). Pre-checks `BodyLimit.check/1` before
  # `dispatch_subject_verb/3`; oversize input replies `body_too_large`
  # without ever entering the with chain. Dialyzer's success-typing
  # narrows the with-chain `else` arms based on actual reachable
  # validator outputs, so adding a `:body_too_large` arm to
  # `dispatch_subject_verb`'s `else` triggers `pattern_match never matches`
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
      {:error, :body_too_large} -> {:reply, {:error, %{error: "body_too_large"}}, socket}
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
         {:ok, subject} <- resolve_subject(user_name),
         :ok <- Session.send_topic(subject, network_id, channel, text) do
      {:reply, :ok, socket}
    else
      {:error, :invalid_channel} -> {:reply, {:error, %{error: "invalid_channel"}}, socket}
      {:error, :invalid_line} -> {:reply, {:error, %{error: "invalid_line"}}, socket}
      :error -> {:reply, {:error, %{error: "user_not_found"}}, socket}
      {:error, :no_session} -> {:reply, {:error, %{error: "no_session"}}, socket}
      {:error, _} -> {:reply, {:error, %{error: "persist_failed"}}, socket}
    end
  end

  # Extracted from `handle_in("away", action: "set", ...)` to keep
  # that clause below Credo's nesting depth gate after the
  # `with_body_check` wrapper landed (HIGH-19).
  @spec away_set_dispatch(
          Phoenix.Socket.t(),
          String.t(),
          String.t(),
          String.t() | nil
        ) :: {:reply, term(), Phoenix.Socket.t()}
  defp away_set_dispatch(socket, slug, reason, origin_window) do
    with {:ok, subject} <- resolve_subject(socket.assigns.user_name),
         {:ok, %Network{} = network} <- Networks.get_network_by_slug(slug),
         :ok <- dispatch_set_away(subject, network, reason, origin_window) do
      {:reply, :ok, socket}
    else
      :error -> {:reply, {:error, %{error: "user_not_found"}}, socket}
      {:error, :not_found} -> {:reply, {:error, %{error: "network_not_found"}}, socket}
      {:error, :no_session} -> {:reply, {:error, %{error: "no_session"}}, socket}
      {:error, :invalid_line} -> {:reply, {:error, %{error: "invalid_reason"}}, socket}
    end
  end

  # The SOLE dispatch path for every `handle_in/3` verb — read queries
  # (whois/who/names/banlist/lusers/whowas), the state-mutating channel
  # ops (op/deop/voice/devoice/kick/ban/unban/umode/mode/topic_set/
  # topic_clear), `/invite`, `/oper`, and the `/raw` escape hatch. It
  # resolves the socket's identity into a `t:Grappa.Session.subject/0`
  # tagged tuple via `resolve_subject/1` — `{:user, id}` for an
  # authenticated user (loaded via `safe_get_user/1`), `{:visitor, id}`
  # for a visitor (id extracted from the `"visitor:<uuid>"` `user_name`
  # assigned by `UserSocket.connect/3`). The thunk receives the subject
  # and dispatches to a `Session.send_*` facade that already accepts
  # `subject()`. There is NO identity gate: visitors and users route
  # identically (#153) — the upstream IRC server (O:lines, channel-op
  # status, services) is the real authority. The only reject-on-identity
  # path is `:error` → `user_not_found` (a deleted-user-row race), and
  # `{:error, :no_session}` when no live `Session.Server` owns the
  # subject.
  #
  # CP24 bucket E web/S7: the arity-3 shape runs an inbound IRC-shape
  # validator BEFORE resolution + dispatch. Defense in depth at the
  # outer untrusted boundary — a hostile cic instance (or compromised
  # user) cannot inject malformed/CRLF/NUL IRC tokens into a channel
  # send via WS, even if the upstream `Identifier` gate ever loosens.
  # The tagged-tuple atoms (`:invalid_channel` / `:invalid_nick` /
  # `:invalid_mask` / `:invalid_line`) map in the `else` arms to a
  # stable cicchetto-facing reason string.
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
      {:error, :invalid_channel} ->
        {:reply, {:error, %{error: "invalid_channel"}}, socket}

      {:error, :invalid_nick} ->
        {:reply, {:error, %{error: "invalid_nick"}}, socket}

      {:error, :invalid_mask} ->
        {:reply, {:error, %{error: "invalid_mask"}}, socket}

      {:error, :invalid_line} ->
        {:reply, {:error, %{error: "invalid_line"}}, socket}

      :error ->
        {:reply, {:error, %{error: "user_not_found"}}, socket}

      {:error, :no_session} ->
        {:reply, {:error, %{error: "no_session"}}, socket}

      # REV-F (H10, originally REV-E HIGH-1): `Session.send_*` post-U-
      # cluster CAN return `{:error, :no_socket | :closed |
      # :inet.posix()}` once a dead-socket SEND fires (the
      # `Session.send_transport_error/0` typedoc'd union). Without this
      # arm those would raise WithClauseError in the channel pid; the
      # catch-all maps any uncategorised upstream-write failure to a
      # single typed cic surface (the operator's /whois etc. gets a
      # structured reply instead of the channel dying).
      {:error, reason} ->
        Logger.warning("subject verb: upstream send failed",
          reason: inspect(reason)
        )

        {:reply, {:error, %{error: "upstream_unavailable"}}, socket}
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
  #
  # Issue #62: `subject` is the resolved `{:user, id} | {:visitor, id}` tuple
  # from `resolve_subject/1` — the facade routes to whichever session owns it.
  @spec dispatch_set_away(Session.subject(), Network.t(), String.t(), map() | nil) ::
          :ok | {:error, :no_session | :invalid_line}
  defp dispatch_set_away(subject, %Network{} = network, reason, nil) when is_tuple(subject) do
    Session.set_explicit_away(subject, network.id, reason)
  end

  defp dispatch_set_away(subject, %Network{} = network, reason, origin_window)
       when is_tuple(subject) and is_map(origin_window) do
    Session.set_explicit_away(subject, network.id, reason, origin_window)
  end

  # S4.3: dispatch unset_away with or without origin_window.
  @spec dispatch_unset_away(Session.subject(), Network.t(), map() | nil) ::
          :ok | {:error, :no_session | :not_explicit}
  defp dispatch_unset_away(subject, %Network{} = network, nil) when is_tuple(subject) do
    Session.unset_explicit_away(subject, network.id)
  end

  defp dispatch_unset_away(subject, %Network{} = network, origin_window)
       when is_tuple(subject) and is_map(origin_window) do
    Session.unset_explicit_away(subject, network.id, origin_window)
  end
end
