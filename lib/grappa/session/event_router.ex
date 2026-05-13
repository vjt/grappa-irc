defmodule Grappa.Session.EventRouter do
  @moduledoc """
  Pure inbound-IRC event classifier for `Grappa.Session.Server`.

  No process, no socket, no Repo, no Logger. Inputs are a parsed
  `Grappa.IRC.Message` struct + the Server's `state` map. Outputs are
  the next `state` (with `members` / `nick` derived) plus a list of
  side-effects the caller must flush:

      @type effect ::
              {:persist, kind, persist_attrs}    -- write a Scrollback row
              | {:reply, iodata()}                -- send a line upstream
              | {:topic_changed, channel, topic_entry()}
              | {:channel_modes_changed, channel, channel_mode_entry()}
              | {:members_seeded, channel, members} -- 366 RPL_ENDOFNAMES landed; carries snapshot

  This shape was extracted per the 2026-04-27 architecture review
  (finding A6, CP10 D4) and mirrors `Grappa.IRC.AuthFSM` from D2 — the
  pure-classifier shape of the verb-keyed sub-context principle. Server
  owns the GenServer, transport, and effect flushing; this module owns
  IRC-message → scrollback-event mapping for all 10 kinds plus the
  4 informational numerics (001, 332, 333, 353/366) that derive
  `state.members` / `state.nick` without producing scrollback rows.

  ## State shape (subset of `Session.Server.t()`)

      @type state :: %{
              required(:subject) => Grappa.Session.subject(),
              required(:network_id) => integer(),
              required(:nick) => String.t(),
              required(:members) => members(),
              optional(_) => _
            }

      @type members :: %{
              channel :: String.t() => %{
                nick :: String.t() => modes :: [String.t()]
              }
            }

  Q3-pinned: nick → modes_list mapping (NOT MapSet) so mIRC sort can
  re-derive at `Session.list_members/3` query time.

  ## Per-kind shape table

      | Kind          | Body           | Meta                                    | members delta              |
      |---------------|----------------|-----------------------------------------|----------------------------|
      | :privmsg      | required text  | %{}                                     | (none)                     |
      | :notice       | required text  | %{}                                     | (none)                     |
      | :action       | required text  | %{}                                     | (none)                     |
      | :join         | nil            | %{}                                     | add (or reset+add if self) |
      | :part         | reason \\| nil | %{}                                     | remove                     |
      | :quit         | reason \\| nil | %{}                                     | remove (fan-out)           |
      | :nick_change  | nil            | %{new_nick: String.t()}                 | rename (fan-out)           |
      | :mode         | nil            | %{modes: String.t(), args: [String.t()]} | per-arg add/remove modes   |
      | :topic        | required text  | %{}                                     | (none)                     |
      | :kick         | reason \\| nil | %{target: String.t()}                   | remove                     |

  Q2-pinned: NICK + QUIT are server-level events that fan out to one
  scrollback row per channel where the nick was in `state.members`.

  ## Mode prefix table (Q-non-blocking)

  Hard-coded `(ov)@+` default per RFC 2812 + most networks. PREFIX
  ISUPPORT-driven negotiation deferred to Phase 5; the table is a
  compile-time constant in this module. When Phase 5 lands per-network
  PREFIX, this constant migrates to per-Session-state config; the
  in-memory shape (`[String.t()]` list of mode chars) does not change.

  ## Topic numerics (Q-non-blocking)

  `332 RPL_TOPIC` + `333 RPL_TOPICWHOTIME` are JOIN-time backfill
  delivered by the upstream after a JOIN. They DO NOT produce scrollback
  rows — `:topic` rows come ONLY from the `TOPIC` command (someone just
  changed the topic). The topic-bar in P4-1 reads live state, not
  scrollback; numerics 332/333 are `{:cont, state, []}` here.

  ## `:reply` effect (forward-compat in E1)

  Type-level forward-compat for CTCP replies (Phase 5+). No E1 route
  emits this effect. PING (transport keepalive, not CTCP) stays inline
  in `Session.Server.handle_info` — out of this router's scope.
  """

  alias Grappa.IRC.{Identifier, Message}
  alias Grappa.{Scrollback, Session}

  @typedoc """
  The Session.Server state subset this module reads + mutates. The
  full Session.Server state has additional fields (`subject_label`,
  `network_slug`, `autojoin`, `client`, etc.) — this typespec uses
  `optional(any()) => any()` to admit them without enforcing them.
  """
  @type state :: %{
          required(:subject) => Session.subject(),
          required(:network_id) => integer(),
          required(:nick) => String.t(),
          required(:members) => members(),
          optional(any()) => any()
        }

  @type members :: %{
          String.t() => %{String.t() => [String.t()]}
        }

  @typedoc """
  Persist-effect attrs map. Exactly one of `:user_id` / `:visitor_id`
  is set per `Grappa.Scrollback.Message` XOR check (Task 4 migration);
  the choice is derived from `state.subject` via
  `Grappa.Session.put_subject_id/2`.
  """
  @type persist_attrs :: %{
          optional(:user_id) => Ecto.UUID.t(),
          optional(:visitor_id) => Ecto.UUID.t(),
          required(:network_id) => integer(),
          required(:channel) => String.t(),
          required(:server_time) => integer(),
          required(:sender) => String.t(),
          required(:body) => String.t() | nil,
          required(:meta) => map()
        }

  @typedoc """
  Topic cache entry. `text: nil` means no topic set (RPL_NOTOPIC) or the
  333-before-332 out-of-order case (332 hasn't arrived yet). Stored case-
  preserved as delivered by the server; lookup normalises to downcase.
  """
  @type topic_entry :: %{
          text: String.t() | nil,
          set_by: String.t() | nil,
          set_at: DateTime.t() | nil
        }

  @typedoc """
  Channel-mode cache entry. `modes` is a list of single-char mode keys
  (e.g. `["n", "t"]`); `params` maps mode char to its argument string for
  modes that carry args (e.g. `%{"k" => "secret", "l" => "42"}`).
  Modes without args are absent from `params`. Stored case-preserved;
  lookup normalises to downcase.
  """
  @type channel_mode_entry :: %{
          modes: [String.t()],
          params: %{String.t() => String.t() | nil}
        }

  @typedoc """
  WHOIS-userhost cache entry. Populated from JOIN's `nick!user@host` prefix,
  311 RPL_WHOISUSER, and 352 RPL_WHOREPLY. Used by S5 ban-mask derivation
  to produce `*!*@host` from a bare nick. Not broadcast over PubSub — purely
  internal to Session.Server; S5's `/ban` is the only consumer.
  """
  @type userhost_entry :: %{user: String.t(), host: String.t()}

  @typedoc """
  Network-wide WHOIS-userhost cache. Keyed by **lowercased** nick (RFC 2812
  §2.2 nick comparisons are case-insensitive). Updated on JOIN/311/352
  (population) and evicted on QUIT/PART/KICK/NICK (lifecycle events). Cache
  is bounded by unique nicks across currently-joined channels — typically
  <500 entries for normal usage. No LRU or cap in this version.
  """
  @type userhost_cache :: %{(nick :: String.t()) => userhost_entry()}

  @type effect ::
          {:persist, Grappa.Scrollback.Message.kind(), persist_attrs()}
          | {:reply, iodata()}
          | {:visitor_r_observed, String.t()}
          | {:topic_changed, String.t(), topic_entry()}
          | {:channel_modes_changed, String.t(), channel_mode_entry()}
          | {:channel_created, String.t(), DateTime.t()}
          | {:away_confirmed, :present | :away}
          | {:members_seeded, String.t(), %{(nick :: String.t()) => modes :: [String.t()]}}
          | {:joined, String.t()}
          | {:join_failed, channel :: String.t(), reason :: String.t(), numeric :: pos_integer()}
          | {:parted, String.t()}
          | {:kicked, channel :: String.t(), by :: String.t(), reason :: String.t() | nil}
          | {:whois_bundle, target :: String.t(), accum :: map()}
          | {:peer_away, peer :: String.t(), away_message :: String.t()}
          | {:invite_ack, channel :: String.t(), peer :: String.t()}

  @doc """
  Classifies one inbound `Grappa.IRC.Message` against the current
  Session state. Returns the next state (with `members` / `nick`
  derived) plus a list of side-effects the caller must flush.

  An unrecognised command (CAP echo, vendor numerics, etc.) returns
  `{:cont, state, []}` — no mutation, no effects. The caller's
  `handle_info` clause already drops on the wildcard `{:irc, _}`
  match; this match is the equivalent here.
  """
  @spec route(Message.t(), state()) :: {:cont, state(), [effect()]}
  # CTCP VERSION query — body is `\x01VERSION\x01` or `\x01VERSION ...\x01`
  # (some clients append trailing args/space). Per RFC 2812 + CTCP spec,
  # responses MUST go via NOTICE (not PRIVMSG) to the SENDER's nick to
  # prevent reply loops between two responsive bots.
  #
  # Two effects:
  #   1. {:reply, line}    — outbound NOTICE response. Client.send_line
  #      guarantees CRLF at the transport boundary (see ensure_crlf/1
  #      in irc/client.ex), so callers don't need to remember.
  #   2. {:persist, :notice, attrs} — visible scrollback row in the DM
  #      window for the sender, so cic shows "alice queried grappa for
  #      VERSION" instead of silently consuming the CTCP. CTCP framing
  #      stripped from body for readability; the notice kind matches the
  #      outbound reply (also a NOTICE), pairing query + answer visually.
  def route(%Message{command: :privmsg, params: [target, body]} = msg, state)
      when is_binary(target) and is_binary(body) and
             binary_part(body, 0, 1) == <<0x01>> do
    case ctcp_verb(body) do
      "VERSION" ->
        sender = Message.sender_nick(msg)
        version = Grappa.Version.current()
        reply = "NOTICE #{sender} :\x01VERSION grappa #{version}\x01"

        # Persist the inbound query so cic surfaces it. Routing rule
        # mirrors how a real inbound PRIVMSG/NOTICE would land:
        # private CTCP query (target == own_nick) persists on the
        # own-nick topic — that's where cic's dm-listener handler
        # observes inbound DM-shaped traffic, re-keys it onto the
        # sender's window, and (per CP23 NOTICE auto-open arm) opens
        # the sender's query window with an unread badge. Persisting
        # at channel = sender bypasses the dm-listener entirely;
        # the broadcast lands on a topic cic isn't subscribed to
        # until that window already exists, defeating auto-open.
        # Channel-targeted CTCP keeps target as channel (no re-key).
        dm_channel = if target == state.nick, do: state.nick, else: target
        notice_body = "CTCP VERSION query → grappa #{version}"
        {state2, persist_eff} = build_persist(state, :notice, dm_channel, sender, notice_body, %{})

        {:cont, state2, [{:reply, reply}, persist_eff]}

      _ ->
        # Non-VERSION CTCP (ACTION handled below; PING / TIME / SOURCE
        # / FINGER not implemented yet) — delegate to the generic
        # PRIVMSG arm so ACTION still persists, others fall through
        # as plain :privmsg rows for now.
        privmsg_default(msg, state, body)
    end
  end

  def route(%Message{command: :privmsg, params: [channel, body]} = msg, state)
      when is_binary(channel) and is_binary(body) do
    privmsg_default(msg, state, body)
  end

  def route(%Message{command: :notice, params: [channel, body]} = msg, state)
      when is_binary(channel) and is_binary(body) and
             byte_size(channel) > 0 and
             binary_part(channel, 0, 1) in ["#", "&", "!", "+"] do
    {state, eff} = build_persist(state, :notice, channel, Message.sender_nick(msg), body, %{})
    {:cont, state, [eff]}
  end

  def route(%Message{command: :join, params: [channel | _]} = msg, state)
      when is_binary(channel) do
    sender = Message.sender_nick(msg)

    members =
      if sender == state.nick do
        # Self-JOIN: wipe stale state for this channel (reconnect path);
        # 353 RPL_NAMREPLY immediately following will re-populate. Keep
        # self in the set so an outbound PRIVMSG before NAMES arrives is
        # still attributed to a known member.
        Map.put(state.members, channel, %{sender => []})
      else
        Map.update(state.members, channel, %{sender => []}, &Map.put(&1, sender, []))
      end

    # S2.4: populate userhost_cache from JOIN prefix when user+host both present.
    # If the server omits either (e.g. +x cloaking strips host), skip — don't
    # half-populate. Self-JOIN is included so our own entry is tracked.
    userhost_cache =
      case msg.prefix do
        {:nick, nick, user, host} when is_binary(user) and is_binary(host) ->
          nick_key = normalize_nick(nick)
          Map.put(Map.get(state, :userhost_cache, %{}), nick_key, %{user: user, host: host})

        _ ->
          Map.get(state, :userhost_cache, %{})
      end

    {state, eff} =
      build_persist(
        %{state | members: members, userhost_cache: userhost_cache},
        :join,
        channel,
        sender,
        nil,
        %{}
      )

    # CP15 B1: self-JOIN echo promotes the per-channel window to :joined.
    # Other-user JOINs land as scrollback rows only — no window-state
    # transition (the operator may already be in this channel observing).
    effects =
      if sender == state.nick do
        [eff, {:joined, channel}]
      else
        [eff]
      end

    {:cont, state, effects}
  end

  def route(%Message{command: :part, params: [channel | rest]} = msg, state)
      when is_binary(channel) do
    sender = Message.sender_nick(msg)

    reason =
      case rest do
        [r | _] when is_binary(r) -> r
        _ -> nil
      end

    # Q1: self-PART drops the channel key entirely so `Map.keys(state.members)`
    # remains a faithful "currently-joined channels" set. Symmetric with
    # self-JOIN (which wipes-and-reseeds). Other-user PART preserves the
    # existing inner-nick-only semantics.
    #
    # S2.3: self-PART also drops topics + channel_modes cache entries — these
    # caches are scoped to channels the session is currently in.
    #
    # S2.4: evict userhost_cache entries for nicks that no longer share any
    # channel with us after the PART. For self-PART: look at who was in the
    # parted channel, then after removing the channel from members, evict any
    # nick that appears in no remaining channel. For other-user PART: the
    # parting nick is removed from this channel; evict if they appear in no
    # other channel in the (post-PART) members map.
    {members, topics, channel_modes, userhost_cache} =
      cond do
        sender == state.nick ->
          # Collect who was in the parted channel before we drop it
          parted_members = Map.keys(Map.get(state.members, channel, %{}))
          new_members = Map.delete(state.members, channel)

          # Evict nicks from the parted channel that no longer appear in any
          # remaining channel. We include self (state.nick) so our own entry
          # is evicted when appropriate.
          cache = Map.get(state, :userhost_cache, %{})
          new_cache = evict_if_no_overlap(parted_members, new_members, cache)

          {new_members, Map.delete(Map.get(state, :topics, %{}), normalize_channel(channel)),
           Map.delete(Map.get(state, :channel_modes, %{}), normalize_channel(channel)), new_cache}

        Map.has_key?(state.members, channel) ->
          new_members = Map.update!(state.members, channel, &Map.delete(&1, sender))
          cache = Map.get(state, :userhost_cache, %{})

          new_cache =
            if channels_with_member(new_members, sender) == [] do
              Map.delete(cache, normalize_nick(sender))
            else
              cache
            end

          {new_members, Map.get(state, :topics, %{}), Map.get(state, :channel_modes, %{}), new_cache}

        true ->
          # Defensive: persist the audit row even for an unknown channel
          # (member-state untouched). Lets a renderer recover the PART
          # event if upstream re-orders relative to a JOIN we haven't
          # seen yet.
          {state.members, Map.get(state, :topics, %{}), Map.get(state, :channel_modes, %{}),
           Map.get(state, :userhost_cache, %{})}
      end

    # Channel-creation cache lifecycle mirrors topics: drop on self-PART
    # only. Other-user PART leaves the cache untouched (we're still in
    # the channel; the entry is still relevant). Done out-of-band from
    # the cond above to keep the existing tuple shape narrow.
    channels_created =
      if sender == state.nick do
        Map.delete(Map.get(state, :channels_created, %{}), normalize_channel(channel))
      else
        Map.get(state, :channels_created, %{})
      end

    {state, eff} =
      build_persist(
        %{
          state
          | members: members,
            topics: topics,
            channel_modes: channel_modes,
            channels_created: channels_created,
            userhost_cache: userhost_cache
        },
        :part,
        channel,
        sender,
        reason,
        %{}
      )

    # CP15 B3: self-PART emits a :parted effect so Session.Server's
    # apply_effects arm can drop the per-channel window_states entry.
    # Cic projects "no window_states key + scrollback present" as
    # `:archived`. Other-user PART is just a scrollback row — the
    # sidebar membership is unchanged.
    effects =
      if sender == state.nick do
        [eff, {:parted, channel}]
      else
        [eff]
      end

    {:cont, state, effects}
  end

  def route(%Message{command: :quit, params: rest} = msg, state) do
    sender = Message.sender_nick(msg)

    reason =
      case rest do
        [r | _] when is_binary(r) -> r
        _ -> nil
      end

    # S2.4: QUIT means the nick is gone from the network — always evict from
    # userhost_cache, even when sender has no channel overlap in members
    # (e.g. WHOIS populated the cache before a JOIN was seen, or the members
    # map race). Eviction is unconditional: gone = gone.
    userhost_cache = Map.delete(Map.get(state, :userhost_cache, %{}), normalize_nick(sender))

    case channels_with_member(state.members, sender) do
      [] ->
        {:cont, %{state | userhost_cache: userhost_cache}, []}

      channels ->
        members = remove_member_everywhere(state.members, channels, sender)
        new_state = %{state | members: members, userhost_cache: userhost_cache}

        effects =
          for ch <- channels do
            {_, eff} = build_persist(new_state, :quit, ch, sender, reason, %{})
            eff
          end

        {:cont, new_state, effects}
    end
  end

  # User-MODE-on-self short-circuit (Task 15). Distinct from the
  # channel-MODE clause that follows: user-modes on the session's own
  # nick are not channel events — no scrollback row, no member-map
  # mutation. The +r case is special: when NickServ-as-IDP confirms a
  # visitor's IDENTIFY it sets +r on the nick. If `pending_auth` is
  # staged (from the outbound IDENTIFY captured by NSInterceptor),
  # +r is the cryptographic-proof signal that the password was
  # accepted; emit `:visitor_r_observed` carrying the captured
  # password so `Session.Server.apply_effects/2` can commit it
  # atomically into the visitors row.
  def route(%Message{command: :mode, params: [target, modes | _]}, state)
      when is_binary(target) and is_binary(modes) and target == state.nick do
    # `pending_auth` is set on `Session.Server` state but is optional
    # from the pure router's POV (the typespec admits `optional(any())
    # => any()`); pure unit tests on user sessions skip it.
    effects =
      case {set_r_mode?(modes), Map.get(state, :pending_auth)} do
        {true, {pwd, _}} -> [{:visitor_r_observed, pwd}]
        _ -> []
      end

    {:cont, state, effects}
  end

  def route(%Message{command: :mode, params: [channel, modes | args]} = msg, state)
      when is_binary(channel) and is_binary(modes) do
    sender = Message.sender_nick(msg)
    members = apply_mode_string(state.members, channel, modes, args)

    # S2.3: split the mode string — per-user modes (matching @user_mode_prefixes)
    # update state.members (above); channel-level modes update channel_modes cache.
    # Walk once, produce two effects: members delta (done above) + channel_modes
    # delta (done here). One channel_modes_changed broadcast per MODE event if the
    # cache actually changed.
    chan_key = normalize_channel(channel)
    existing_entry = Map.get(Map.get(state, :channel_modes, %{}), chan_key, empty_mode_entry())
    new_entry = apply_channel_mode_string(existing_entry, modes, args)

    channel_modes =
      Map.put(Map.get(state, :channel_modes, %{}), chan_key, new_entry)

    mode_effects =
      if new_entry != existing_entry do
        [{:channel_modes_changed, channel, new_entry}]
      else
        []
      end

    {state, eff} =
      build_persist(
        %{state | members: members, channel_modes: channel_modes},
        :mode,
        channel,
        sender,
        nil,
        %{modes: modes, args: args}
      )

    {:cont, state, [eff | mode_effects]}
  end

  def route(%Message{command: :nick, params: [new_nick | _]} = msg, state)
      when is_binary(new_nick) do
    old_nick = Message.sender_nick(msg)
    channels = channels_with_member(state.members, old_nick)

    members = rename_member_everywhere(state.members, channels, old_nick, new_nick)

    # S2.4: NICK rename migrates the userhost entry from old_nick to new_nick.
    # user+host don't change with a nick change — only the key moves.
    userhost_cache = rename_userhost_entry(Map.get(state, :userhost_cache, %{}), old_nick, new_nick)

    new_state =
      if old_nick == state.nick do
        %{state | nick: new_nick, members: members, userhost_cache: userhost_cache}
      else
        %{state | members: members, userhost_cache: userhost_cache}
      end

    effects =
      for ch <- channels do
        {_, eff} =
          build_persist(new_state, :nick_change, ch, old_nick, nil, %{new_nick: new_nick})

        eff
      end

    {:cont, new_state, effects}
  end

  # Unsolicited TOPIC: a channel operator changed the topic mid-session.
  # S2.3: update topics cache with new text + set_by (nick from prefix) +
  # set_at (server-side wall-clock — no numeric available for this path).
  # Also produces a :topic scrollback row (unchanged from pre-S2.3).
  def route(%Message{command: :topic, params: [channel, body]} = msg, state)
      when is_binary(channel) and is_binary(body) do
    sender = Message.sender_nick(msg)
    chan_key = normalize_channel(channel)

    entry = %{
      text: body,
      set_by: sender,
      set_at: DateTime.utc_now()
    }

    topics = Map.put(Map.get(state, :topics, %{}), chan_key, entry)
    state1 = %{state | topics: topics}

    {state2, eff} = build_persist(state1, :topic, channel, sender, body, %{})
    {:cont, state2, [eff, {:topic_changed, channel, entry}]}
  end

  def route(%Message{command: :kick, params: [channel, target | rest]} = msg, state)
      when is_binary(channel) and is_binary(target) do
    sender = Message.sender_nick(msg)

    reason =
      case rest do
        [r | _] when is_binary(r) -> r
        _ -> nil
      end

    {members, topics, channel_modes, userhost_cache} =
      kick_state_update(state, channel, target)

    # Channel-creation cache lifecycle mirrors topics: drop on self-KICK
    # only. Done out-of-band from kick_state_update to keep the existing
    # tuple shape narrow (mirrors the PART path above).
    channels_created =
      if target == state.nick do
        Map.delete(Map.get(state, :channels_created, %{}), normalize_channel(channel))
      else
        Map.get(state, :channels_created, %{})
      end

    {state, eff} =
      build_persist(
        %{
          state
          | members: members,
            topics: topics,
            channel_modes: channel_modes,
            channels_created: channels_created,
            userhost_cache: userhost_cache
        },
        :kick,
        channel,
        sender,
        reason,
        %{target: target}
      )

    # CP15 B3: self-target KICK emits a :kicked effect carrying by + reason
    # so Session.Server's apply_effects arm can flip
    # window_states[channel] = :kicked AND broadcast on the per-channel
    # topic. Other-target KICK is a scrollback row only — the operator
    # is still in the channel, no window-state transition.
    effects =
      if target == state.nick do
        [eff, {:kicked, channel, sender, reason}]
      else
        [eff]
      end

    {:cont, state, effects}
  end

  # 353 RPL_NAMREPLY: `:server 353 nick = #channel :@op +voice plain`.
  # Trailing param is space-separated `[prefix]nick` tokens. Additive
  # merge into state.members[channel] ONLY when the channel is already
  # tracked (i.e. self-JOIN created the entry) — multiple 353 lines
  # arrive for big channels. 366 RPL_ENDOFNAMES marks end; we don't
  # need an explicit close because each 353 commits its delta
  # immediately.
  #
  # CP22 cluster B (channel-client-polish #14) — /names against a
  # channel the operator is NOT joined to also triggers 353/366 from
  # upstream. The merge into state.members MUST be gated on the entry
  # already existing — otherwise a /names #other-chan would create a
  # phantom membership entry and confuse every downstream consumer
  # (sidebar, MembersPane, member-set leaks). When state.members has
  # no entry for the channel, skip the merge entirely; the
  # names_fold/3 call below still feeds the per-target accumulator,
  # and the 366 drain emits the scrollback rows for non-joined targets.
  def route(
        %Message{command: {:numeric, 353}, params: [_, _, channel, names_blob]},
        state
      )
      when is_binary(channel) and is_binary(names_blob) do
    tokens = String.split(names_blob, " ", trim: true)

    members =
      case Map.fetch(state.members, channel) do
        {:ok, existing} ->
          new_entries = Map.new(tokens, &split_mode_prefix/1)
          Map.put(state.members, channel, Map.merge(existing, new_entries))

        :error ->
          state.members
      end

    state_with_members = %{state | members: members}

    {:cont, names_fold(state_with_members, channel, tokens), []}
  end

  # 332 RPL_TOPIC: JOIN-time backfill — stores topic text in the topics cache.
  # Does NOT produce a scrollback row (spec: :topic rows come ONLY from the
  # TOPIC command, i.e. someone changing the topic mid-session). The set_by /
  # set_at fields may arrive in the 333 that follows; partial entry is fine.
  def route(
        %Message{command: {:numeric, 332}, params: [_, channel, topic_text]},
        state
      )
      when is_binary(channel) and is_binary(topic_text) do
    chan_key = normalize_channel(channel)
    existing = Map.get(Map.get(state, :topics, %{}), chan_key, %{text: nil, set_by: nil, set_at: nil})
    entry = %{existing | text: topic_text}
    topics = Map.put(Map.get(state, :topics, %{}), chan_key, entry)
    {:cont, %{state | topics: topics}, [{:topic_changed, channel, entry}]}
  end

  # 333 RPL_TOPICWHOTIME: JOIN-time backfill — stores setter + timestamp.
  # The 332 may not have arrived yet (out-of-order); create the entry with
  # text: nil if so — 332 will fill it in when it arrives.
  # Unix timestamp param is always the last positional.
  def route(
        %Message{command: {:numeric, 333}, params: [_, channel, setter, unix_ts_str]},
        state
      )
      when is_binary(channel) and is_binary(setter) and is_binary(unix_ts_str) do
    chan_key = normalize_channel(channel)
    existing = Map.get(Map.get(state, :topics, %{}), chan_key, %{text: nil, set_by: nil, set_at: nil})
    ts = parse_unix_ts(unix_ts_str)
    entry = %{existing | set_by: setter, set_at: ts}
    topics = Map.put(Map.get(state, :topics, %{}), chan_key, entry)
    {:cont, %{state | topics: topics}, [{:topic_changed, channel, entry}]}
  end

  # 331 RPL_NOTOPIC: explicit "no topic set" — store an explicit-empty entry
  # so cicchetto can render a "(no topic set)" placeholder (spec #20).
  def route(
        %Message{command: {:numeric, 331}, params: [_, channel | _]},
        state
      )
      when is_binary(channel) do
    chan_key = normalize_channel(channel)
    entry = %{text: nil, set_by: nil, set_at: nil}
    topics = Map.put(Map.get(state, :topics, %{}), chan_key, entry)
    {:cont, %{state | topics: topics}, [{:topic_changed, channel, entry}]}
  end

  # 329 RPL_CREATIONTIME: channel creation unix timestamp (Bahamut + most
  # modern ircds emit on JOIN; Azzurra/Bahamut historically didn't, hence
  # no presence in pre-cluster DB samples — but the handler must be ready
  # for non-Bahamut networks). Caches a parsed `DateTime.t()` into
  # `state.channels_created` and emits `{:channel_created, channel, dt}`
  # so Server's apply_effects can broadcast `channel_created` on the
  # per-channel topic. cic's `channelCreated` store seeds from the event
  # and JoinBanner renders an irssi-style "Channel was created on …" line.
  #
  # Malformed timestamps (non-integer trailing param) are silently dropped
  # — no cache write, no effect, no scrollback row. The numeric is in
  # NumericRouter `@delegated_numerics` so Server skips its dual-persist
  # path; without that, a malformed 329 would still leak the bogus
  # trailing as a `:notice` body.
  def route(
        %Message{command: {:numeric, 329}, params: [_, channel, unix_ts_str]},
        state
      )
      when is_binary(channel) and is_binary(unix_ts_str) do
    case Integer.parse(unix_ts_str) do
      {ts, ""} when ts > 0 ->
        chan_key = normalize_channel(channel)
        dt = DateTime.from_unix!(ts)
        channels_created = Map.put(Map.get(state, :channels_created, %{}), chan_key, dt)
        {:cont, %{state | channels_created: channels_created}, [{:channel_created, channel, dt}]}

      _ ->
        {:cont, state, []}
    end
  end

  # 324 RPL_CHANNELMODEIS: initial mode snapshot after JOIN. Replaces the
  # channel_modes entry entirely with the parsed +modes [params] shape.
  # Mode string starts with '+'; args follow as separate params.
  def route(
        %Message{command: {:numeric, 324}, params: [_, channel, mode_str | mode_args]},
        state
      )
      when is_binary(channel) and is_binary(mode_str) do
    chan_key = normalize_channel(channel)
    entry = parse_mode_snapshot(mode_str, mode_args)
    channel_modes = Map.put(Map.get(state, :channel_modes, %{}), chan_key, entry)
    {:cont, %{state | channel_modes: channel_modes}, [{:channel_modes_changed, channel, entry}]}
  end

  # 366 RPL_ENDOFNAMES is the end-of-NAMES marker. Each preceding 353
  # already committed its delta, but the cicchetto client's GET /members
  # races against the 353 arrival window — a fresh JOIN can land in the
  # client sidebar BEFORE state.members is populated, leaving the
  # MembersPane stuck at "no members yet" until the next page reload.
  #
  # Emit a :members_seeded effect here so server.ex can broadcast it on
  # the channel topic; subscribe.ts invalidates its loadedChannels Set
  # and re-fetches GET /members, which now sees the fully-populated
  # state.members[channel].
  #
  # CP22 cluster B (channel-client-polish #14) — additionally drain the
  # /names accumulator if `state.names_pending[channel_lower]` exists.
  # The drain emits 2 :persist :notice effects (nick list row + EOF
  # terminator) routed to `$server` ONLY when the operator is NOT in
  # state.members[target] — joined targets defer to the members_seeded
  # refresh path above (no scrollback rows). The accumulator is dropped
  # in both cases.
  def route(
        %Message{command: {:numeric, 366}, params: [_, channel, _ | _]},
        state
      )
      when is_binary(channel) do
    members = Map.get(state.members, channel, %{})
    members_seeded = {:members_seeded, channel, members}

    {state_after_names, names_effects} = drain_names_pending(state, channel)

    {:cont, state_after_names, [members_seeded | names_effects]}
  end

  # 311 RPL_WHOISUSER: `:server 311 own_nick target user host * :realname`.
  # Two effects: (1) S2.4 upsert userhost_cache with target's user+host
  # (authoritative — always overwrites JOIN-derived entry); (2) C2 fold
  # into whois_pending[target_lower] accumulator if the bundle is in flight.
  # The userhost_cache update happens unconditionally — even unsolicited 311s
  # (some IRCds emit them on connection registration) refresh the cache.
  # The whois_pending fold is gated on a pre-existing entry — only operator-
  # issued WHOIS commands set up the accumulator (see Server's
  # `:send_whois` handler).
  def route(
        %Message{command: {:numeric, 311}, params: [_, target, user, host | rest]},
        state
      )
      when is_binary(target) and is_binary(user) and is_binary(host) do
    nick_key = normalize_nick(target)
    cache = Map.put(Map.get(state, :userhost_cache, %{}), nick_key, %{user: user, host: host})
    realname = whois_trailing(rest)

    state =
      state
      |> Map.put(:userhost_cache, cache)
      |> whois_fold(target, %{user: user, host: host, realname: realname})

    {:cont, state, []}
  end

  # 312 RPL_WHOISSERVER: `:server 312 own_nick target serverhost :serverinfo`.
  # Folds `server` + `server_info` into whois_pending[target_lower].
  def route(
        %Message{command: {:numeric, 312}, params: [_, target, server | rest]},
        state
      )
      when is_binary(target) and is_binary(server) do
    server_info = whois_trailing(rest)
    {:cont, whois_fold(state, target, %{server: server, server_info: server_info}), []}
  end

  # 313 RPL_WHOISOPERATOR: `:server 313 own_nick target :is an IRC operator`.
  # Folds `is_operator: true`.
  def route(
        %Message{command: {:numeric, 313}, params: [_, target | _]},
        state
      )
      when is_binary(target) do
    {:cont, whois_fold(state, target, %{is_operator: true}), []}
  end

  # 317 RPL_WHOISIDLE: `:server 317 own_nick target idle_seconds [signon] :seconds idle`.
  # Some servers omit signon (only emit `idle_seconds`). We tolerate both
  # shapes — the trailing text is human-readable and ignored.
  def route(
        %Message{command: {:numeric, 317}, params: [_, target, idle_str | rest]},
        state
      )
      when is_binary(target) and is_binary(idle_str) do
    base_fold = %{idle_seconds: parse_int_or_nil(idle_str)}

    fold =
      case rest do
        [signon_str | _] when is_binary(signon_str) ->
          case parse_int_or_nil(signon_str) do
            nil -> base_fold
            n -> Map.put(base_fold, :signon, n)
          end

        _ ->
          base_fold
      end

    {:cont, whois_fold(state, target, fold), []}
  end

  # 319 RPL_WHOISCHANNELS: `:server 319 own_nick target :@#italia +#grappa #lobby`.
  # The trailing param is a space-separated list of channels with mode prefixes.
  # Multiple 319s may arrive for one target (large channel lists chunk over
  # multiple lines) — accumulate into a single list, preserving prefixes.
  def route(
        %Message{command: {:numeric, 319}, params: [_, target | rest]},
        state
      )
      when is_binary(target) do
    chans =
      case whois_trailing(rest) do
        nil -> []
        text -> String.split(text, ~r/\s+/, trim: true)
      end

    {:cont, whois_fold(state, target, %{channels_chunk: chans}), []}
  end

  # 318 RPL_ENDOFWHOIS: `:server 318 own_nick target :End of /WHOIS list`.
  # Emit the bundle effect with the accumulated fields and drop the entry.
  # If no accumulator exists (target never set up via /whois), drop silently —
  # an unsolicited 318 (services bouncing back, race with disconnect) is
  # not actionable.
  def route(
        %Message{command: {:numeric, 318}, params: [_, target | _]},
        state
      )
      when is_binary(target) do
    pending = Map.get(state, :whois_pending, %{})
    nick_key = normalize_nick(target)

    case Map.fetch(pending, nick_key) do
      {:ok, accum} ->
        next_state = %{state | whois_pending: Map.delete(pending, nick_key)}
        {:cont, next_state, [{:whois_bundle, Map.get(accum, :target_display, target), accum}]}

      :error ->
        {:cont, state, []}
    end
  end

  # P-0a — Cluster `numeric-delegation-p0` 2026-05-13: 11 additional WHOIS-leg
  # numerics fold into `whois_pending[target_lower]` per the same shape as
  # 311/312/313/317/319 above. Per `feedback_no_localized_strings_server_side`
  # the server emits typed booleans / strings / integers; cic owns the
  # human-readable strings ("Services Agent" / "is using SSL" / etc).
  #
  # The 11 numerics fold simple boolean flags (`is_*: true`) except for:
  #   * 301 — dual-purpose (WHOIS-bundle vs standalone-PRIVMSG); gated on
  #     `whois_pending[target_lower]` presence. P-0b will replace the
  #     no-pending-entry fallback with a typed `:peer_away` event.
  #   * 326 — trailing carries `"is using modes <modes>"`; we extract
  #     `<modes>` via `parse_whois_modes_trailing/1`.
  #   * 378 — trailing carries `"is connecting from <host> [<ip>]"`; we
  #     extract host + ip via `parse_whois_actually_trailing/1`.

  # 275 RPL_USINGSSL: `:server 275 own_nick target :is using a secure connection (SSL)`.
  def route(
        %Message{command: {:numeric, 275}, params: [_, target | _]},
        state
      )
      when is_binary(target) do
    {:cont, whois_fold(state, target, %{using_ssl: true}), []}
  end

  # 301 RPL_AWAY: `:server 301 own_nick target :away message`. Dual-purpose:
  #
  #   * WHOIS-bundle case (whois_pending entry exists for target) — fold
  #     `away_message` into the bundle accumulator. Bundle emits at 318.
  #
  #   * Standalone case (no whois_pending entry) — operator just /msg'd an
  #     away peer and upstream replied with the away note. Emit a typed
  #     `{:peer_away, target, msg}` effect; `Server.apply_effects` broadcasts
  #     a `peer_away` wire event on the user-level topic, cic dm-listener
  #     renders an inline ephemeral row in the peer's DM window. cic owns
  #     localization (no human-readable string baked into the wire payload).
  def route(
        %Message{command: {:numeric, 301}, params: [_, target | rest]},
        state
      )
      when is_binary(target) do
    nick_key = normalize_nick(target)
    pending = Map.get(state, :whois_pending, %{})
    msg = whois_trailing(rest)

    case Map.has_key?(pending, nick_key) do
      true ->
        {:cont, whois_fold(state, target, %{away_message: msg}), []}

      false ->
        {:cont, state, [{:peer_away, target, msg}]}
    end
  end

  # 307 RPL_WHOISREGNICK: `:server 307 own_nick target :has identified for this nick`.
  def route(
        %Message{command: {:numeric, 307}, params: [_, target | _]},
        state
      )
      when is_binary(target) do
    {:cont, whois_fold(state, target, %{is_registered: true}), []}
  end

  # 308 RPL_WHOISADMIN: `:server 308 own_nick target :is an IRC Server Administrator`.
  def route(
        %Message{command: {:numeric, 308}, params: [_, target | _]},
        state
      )
      when is_binary(target) do
    {:cont, whois_fold(state, target, %{is_admin: true}), []}
  end

  # 309 RPL_WHOISSADMIN: `:server 309 own_nick target :is a Services Administrator`.
  def route(
        %Message{command: {:numeric, 309}, params: [_, target | _]},
        state
      )
      when is_binary(target) do
    {:cont, whois_fold(state, target, %{is_services_admin: true}), []}
  end

  # 310 RPL_WHOISHELPER: `:server 310 own_nick target :is a Help Operator`.
  def route(
        %Message{command: {:numeric, 310}, params: [_, target | _]},
        state
      )
      when is_binary(target) do
    {:cont, whois_fold(state, target, %{is_helper: true}), []}
  end

  # 316 RPL_WHOISCHANOP: `:server 316 own_nick target :<text>` (RFC1459-compat,
  # NULL in current Bahamut but defined for legacy ircds).
  def route(
        %Message{command: {:numeric, 316}, params: [_, target | _]},
        state
      )
      when is_binary(target) do
    {:cont, whois_fold(state, target, %{is_chanop: true}), []}
  end

  # 325 RPL_WHOISAGENT (Azzurra): `:server 325 own_nick target :is a Services Agent`.
  def route(
        %Message{command: {:numeric, 325}, params: [_, target | _]},
        state
      )
      when is_binary(target) do
    {:cont, whois_fold(state, target, %{is_agent: true}), []}
  end

  # 326 RPL_WHOISMODES (Azzurra): `:server 326 own_nick target :is using modes +iZ`.
  # Extract the mode string from the localized trailing prefix; on parse
  # failure (unexpected template, server emits a non-Bahamut variant) fold
  # nothing — the bundle still emits, just without `umodes`.
  def route(
        %Message{command: {:numeric, 326}, params: [_, target | rest]},
        state
      )
      when is_binary(target) do
    case parse_whois_modes_trailing(whois_trailing(rest)) do
      nil -> {:cont, state, []}
      modes -> {:cont, whois_fold(state, target, %{umodes: modes}), []}
    end
  end

  # 339 RPL_WHOISJAVA (Azzurra): `:server 339 own_nick target :is a Java User`.
  def route(
        %Message{command: {:numeric, 339}, params: [_, target | _]},
        state
      )
      when is_binary(target) do
    {:cont, whois_fold(state, target, %{is_java: true}), []}
  end

  # 378 RPL_WHOISACTUALLY (Azzurra, oper-visible): `:server 378 own_nick
  # target :is connecting from <host> [<ip>]`. Extracts host + ip from the
  # localized trailing template; on parse failure folds nothing.
  def route(
        %Message{command: {:numeric, 378}, params: [_, target | rest]},
        state
      )
      when is_binary(target) do
    case parse_whois_actually_trailing(whois_trailing(rest)) do
      nil ->
        {:cont, state, []}

      {host, ip} ->
        {:cont, whois_fold(state, target, %{actually_host: host, actually_ip: ip}), []}
    end
  end

  # CP22 cluster B (channel-client-polish #14) — 315 RPL_ENDOFWHO:
  # `:server 315 own_nick target :End of /WHO list`. Drains the per-target
  # accumulator into N+1 :notice :persist effects: one row per 352
  # RPL_WHOREPLY in arrival order + one terminator row carrying the EOF
  # text. Routing rule:
  #   - target channel in state.members → persist in target channel
  #   - else → persist in $server (the synthetic server-window slug)
  # If no accumulator exists (target never set up via /who, or unsolicited
  # reply), drop silently — mirror of the 318 RPL_ENDOFWHOIS handling.
  #
  # Each :notice row carries meta=%{numeric: 352|315, who: %{...}|nil} so
  # cic renders structured tabular without re-parsing IRC. body is an
  # irssi-shape compact string — defensive payload so scrollback replay
  # remains readable even if a future cic version drops the structured
  # render or a raw API consumer reads the rows directly.
  def route(
        %Message{command: {:numeric, 315}, params: [_, target | _]},
        state
      )
      when is_binary(target) do
    pending = Map.get(state, :who_pending, %{})
    chan_key = String.downcase(target)

    case Map.fetch(pending, chan_key) do
      {:ok, accum} ->
        next_state = %{state | who_pending: Map.delete(pending, chan_key)}
        target_display = Map.get(accum, :target_display, target)

        # Replies prepended in arrival order (LIFO for O(1) fold) — reverse
        # to restore server wire order before persisting.
        replies = Enum.reverse(Map.get(accum, :replies, []))

        target_channel =
          if Map.has_key?(state.members, target_display),
            do: target_display,
            else: "$server"

        sender = state.network_slug

        # Build N row persists + 1 EOF persist. Each call returns
        # {state, effect}; we only care about the effects (state is
        # threaded through but build_persist does not mutate routing
        # state in this path).
        {state_after_rows, row_effects} =
          Enum.reduce(replies, {next_state, []}, fn reply, {acc_state, acc_effects} ->
            body = format_who_reply(target_channel, reply)
            meta = %{numeric: 352, who: reply}
            {acc_state2, eff} = build_persist(acc_state, :notice, target_channel, sender, body, meta)
            {acc_state2, [eff | acc_effects]}
          end)

        {final_state, eof_effect} =
          build_persist(
            state_after_rows,
            :notice,
            target_channel,
            sender,
            "*** End of /WHO list for #{target_display}",
            %{numeric: 315, who_target: target_display}
          )

        # Order: row_effects accumulated head-prepend (LIFO), reverse to
        # restore wire order. Append the EOF row last by building head-up
        # and reversing once at the end (Credo F-perf — single Enum.reverse,
        # no `++` of single-element list).
        {:cont, final_state, Enum.reverse([eof_effect | row_effects])}

      :error ->
        {:cont, state, []}
    end
  end

  # 352 RPL_WHOREPLY: `:server 352 own_nick #chan user host server target H/G :hop realname`.
  # S2.4: upsert userhost_cache with target nick's user+host (params are
  # positional: index 0=own_nick, 1=#chan, 2=user, 3=host, 4=server, 5=target).
  # Keyed by lowercased nick.
  #
  # CP22 cluster B (channel-client-polish #14): if a /who command primed
  # state.who_pending[channel_lower], also fold this row into the
  # accumulator's :replies list. The trailing param holds `<hops> <realname>`
  # — split on the first whitespace to extract both. The `flags` param at
  # index 6 (H=here/G=gone, plus optional ops/voice glyphs) is preserved as
  # `:modes`. Both effects coexist: userhost_cache is for nick-targeted
  # WHOIS-cache reuse, who_pending is the operator-facing /who bundle.
  def route(
        %Message{
          command: {:numeric, 352},
          params: [_, channel, user, host, server, target, flags | rest]
        },
        state
      )
      when is_binary(target) and is_binary(user) and is_binary(host) and
             is_binary(channel) and is_binary(server) and is_binary(flags) do
    nick_key = normalize_nick(target)
    cache = Map.put(Map.get(state, :userhost_cache, %{}), nick_key, %{user: user, host: host})

    state_with_cache = %{state | userhost_cache: cache}

    {hops, realname} = parse_who_trailing(rest)

    reply = %{
      nick: target,
      user: user,
      host: host,
      server: server,
      modes: flags,
      hops: hops,
      realname: realname
    }

    {:cont, who_fold(state_with_cache, channel, reply), []}
  end

  # 001 RPL_WELCOME: first param is the welcomed nick (what upstream
  # actually registered us as — may differ from requested due to
  # case-fold normalization, services rename, length truncation).
  # Reconcile state.nick to upstream's authority.
  def route(%Message{command: {:numeric, 1}, params: [welcomed_nick | _]}, state)
      when is_binary(welcomed_nick) do
    {:cont, %{state | nick: welcomed_nick}, []}
  end

  # CP15 B2 — JOIN failure numerics. Six codes carry the same shape:
  #   :server <code> <own_nick_echo> <channel> :<reason>
  # When the channel matches an in-flight JOIN (case-insensitive RFC 2812
  # §2.2 lookup against state.in_flight_joins), emit {:join_failed, ch,
  # reason, numeric} and strip the entry from state. NumericRouter marks
  # these codes :delegated so the existing scan-based persist path doesn't
  # double-process — the apply_effects arm in Session.Server is the
  # canonical persist + broadcast surface.
  #
  # No-match (server emits an unsolicited 471/473/etc., or the in-flight
  # entry was already swept by TTL): fall through with no effect — the
  # caller's NumericRouter $server route persists it as a server message.
  @join_failure_numerics [471, 473, 474, 475, 403, 405]

  def route(
        %Message{command: {:numeric, code}, params: [_, channel, reason | _]},
        state
      )
      when code in @join_failure_numerics and is_binary(channel) and is_binary(reason) do
    key = String.downcase(channel)
    in_flight = Map.get(state, :in_flight_joins, %{})

    case Map.fetch(in_flight, key) do
      {:ok, _} ->
        next_state = %{state | in_flight_joins: Map.delete(in_flight, key)}
        {:cont, next_state, [{:join_failed, channel, reason, code}]}

      :error ->
        {:cont, state, []}
    end
  end

  # 305 RPL_UNAWAY: upstream confirmed away status cleared ("You are no longer
  # marked as being away"). Fire an `away_confirmed` effect so Session.Server
  # can broadcast the state transition to cicchetto on the user-level topic.
  #
  # The numeric fires in response to an upstream AWAY (unset) command — either
  # from explicit `/away` (bare) or from the auto-away path. The :present atom
  # mirrors the away_state closed set.
  def route(%Message{command: {:numeric, 305}}, state) do
    {:cont, state, [{:away_confirmed, :present}]}
  end

  # 306 RPL_NOWAWAY: upstream confirmed away status set ("You have been marked
  # as being away"). Fire an `away_confirmed` effect so Session.Server can
  # broadcast the state transition to cicchetto.
  #
  # The :away atom is intentionally generic — the numeric doesn't distinguish
  # explicit from auto-away; Session.Server's state carries that distinction
  # and cicchetto derives the display from away_state, not this numeric.
  def route(%Message{command: {:numeric, 306}}, state) do
    {:cont, state, [{:away_confirmed, :away}]}
  end

  # 341 RPL_INVITING: `:server 341 own_nick target_nick channel`. Sent
  # to the inviter as confirmation that `/invite target_nick channel` was
  # relayed upstream. P-0e: emit a typed `{:invite_ack, channel, target}`
  # effect; `Server.apply_effects` broadcasts an `invite_ack` wire event
  # on the channel's per-channel topic. cic synthesizes an ephemeral
  # inline row in the channel scrollback (NOT persisted — invite-ack is
  # immediate-feedback, not audit log). Server emits no human-readable
  # string per `feedback_no_localized_strings_server_side`.
  #
  # Bahamut sends params as [own_nick, target_nick, channel]; some
  # variants carry a trailing description (": invitation sent") which is
  # ignored — cic owns the rendering.
  def route(
        %Message{command: {:numeric, 341}, params: [_, target, channel | _]},
        state
      )
      when is_binary(target) and is_binary(channel) do
    {:cont, state, [{:invite_ack, channel, target}]}
  end

  # BUG2: MOTD numerics (375 RPL_MOTDSTART, 372 RPL_MOTD, 376 RPL_ENDOFMOTD)
  # persist to the synthetic "$server" channel so the server-messages window
  # has content. Previously these hit the catch-all and were silently dropped.
  # NumericRouter marks them as :delegated so no numeric_routed event fires —
  # this persist path is the canonical surface for MOTD text.
  #
  # BUG2 fix-up: sender was hardcoded to "" which fails Identifier.valid_sender?
  # and caused every changeset to be rejected. Use Message.sender_nick/1 instead
  # — for numerics with a server prefix it returns the server hostname, for
  # prefix-less lines it returns the anonymous_sender sentinel ("*"). Both are
  # accepted by valid_sender?.
  def route(
        %Message{command: {:numeric, motd_numeric}, params: [_ | rest]} = msg,
        state
      )
      when motd_numeric in [375, 372, 376] do
    body = List.last(rest)
    sender = Message.sender_nick(msg)

    if is_binary(body) do
      {state, eff} = build_persist(state, :notice, "$server", sender, body, %{})
      {:cont, state, [eff]}
    else
      {:cont, state, []}
    end
  end

  # CP13 server-window cluster: NOTICE addressed to a non-channel target
  # (server sends `NOTICE <ourNick> :text` or `NOTICE <ourNick> :[ #chan ] msg`)
  # gets sorted into one of three windows via a priority chain:
  #
  #   1. **ChanServ-bracketed** — Anope/Atheme/InspIRCd ChanServ wraps
  #      access-channel messages as `[ #chan ]: text`. We persist them on
  #      the bracketed channel with the prefix stripped so they appear
  #      inline with the channel's scrollback. Falls through to the next
  #      clause if the body doesn't parse — empirical brittleness, but
  #      no graceful upstream IRC standard exists.
  #   2. **Services sender** (`~r/Serv$/i`) — NickServ, ChanServ
  #      (when not bracketed), MemoServ, BotServ, OperServ, HostServ,
  #      etc. → `$server` synthetic window.
  #   3. **Server hostname sender** (`.` in sender) — connection
  #      banners, /MOTD-style numerics, k-line warnings → `$server`.
  #   4. **Regular user nick** — peer sent us a non-CTCP NOTICE; persist
  #      on `channel = sender_nick` so it lands in the same query window
  #      a PRIVMSG-to-own-nick would.
  #
  # Pre-CP13 this single matcher greedy-routed everything to `$server` —
  # the new chain preserves NickServ/MOTD behavior while restoring
  # ChanServ inline + per-user notices.
  @chanserv_bracket_regex ~r/^\[\s*(#\S+)\s*\]\s*:?\s*(.*)$/s
  @services_sender_regex ~r/Serv$/i

  def route(
        %Message{command: :notice, params: [target, body]} = msg,
        state
      )
      when is_binary(target) and is_binary(body) and
             byte_size(target) > 0 and
             binary_part(target, 0, 1) not in ["#", "&", "!", "+"] do
    sender = Message.sender_nick(msg)
    {channel, body_to_persist} = route_non_channel_notice(sender, body)
    {state, eff} = build_persist(state, :notice, channel, sender, body_to_persist, %{})
    {:cont, state, [eff]}
  end

  def route(%Message{} = _, state), do: {:cont, state, []}

  # Q1: self-KICK (target == state.nick) drops the channel key entirely —
  # symmetric with self-PART. Other-user KICK preserves the inner-nick
  # delete. S2.3: self-KICK also drops topics + channel_modes cache
  # entries. S2.4: evict userhost_cache for the kicked nick (same
  # channel-overlap logic as PART). Extracted from the route clause to
  # keep cyclomatic complexity below the Credo gate.
  @spec kick_state_update(state(), String.t(), String.t()) ::
          {%{String.t() => %{String.t() => [String.t()]}}, %{String.t() => topic_entry()},
           %{String.t() => channel_mode_entry()}, userhost_cache()}
  defp kick_state_update(state, channel, target) do
    chan_key = normalize_channel(channel)
    cache = Map.get(state, :userhost_cache, %{})

    cond do
      target == state.nick ->
        new_members = Map.delete(state.members, channel)
        new_cache = evict_cache_if_no_overlap(cache, new_members, target)

        {new_members, Map.delete(Map.get(state, :topics, %{}), chan_key),
         Map.delete(Map.get(state, :channel_modes, %{}), chan_key), new_cache}

      Map.has_key?(state.members, channel) ->
        new_members = Map.update!(state.members, channel, &Map.delete(&1, target))
        new_cache = evict_cache_if_no_overlap(cache, new_members, target)

        {new_members, Map.get(state, :topics, %{}), Map.get(state, :channel_modes, %{}), new_cache}

      true ->
        {state.members, Map.get(state, :topics, %{}), Map.get(state, :channel_modes, %{}), cache}
    end
  end

  @spec evict_cache_if_no_overlap(
          userhost_cache(),
          %{String.t() => %{String.t() => [String.t()]}},
          String.t()
        ) :: userhost_cache()
  defp evict_cache_if_no_overlap(cache, members_after, nick) do
    if channels_with_member(members_after, nick) == [] do
      Map.delete(cache, normalize_nick(nick))
    else
      cache
    end
  end

  # Decide which window a non-channel NOTICE lands in + the body to persist.
  # Pure: takes sender + body, returns {channel, body}. The ChanServ branch
  # rewrites body to drop the `[ #chan ]:` prefix; other branches return
  # body unchanged.
  @spec route_non_channel_notice(String.t(), String.t()) :: {String.t(), String.t()}
  defp route_non_channel_notice(sender, body) do
    case chanserv_bracket_match(sender, body) do
      {_, _} = bracket -> bracket
      nil -> route_non_channel_notice_non_chanserv(sender, body)
    end
  end

  @spec route_non_channel_notice_non_chanserv(String.t(), String.t()) ::
          {String.t(), String.t()}
  defp route_non_channel_notice_non_chanserv(sender, body) do
    cond do
      Regex.match?(@services_sender_regex, sender) ->
        {"$server", body}

      String.contains?(sender, ".") ->
        {"$server", body}

      Identifier.valid_nick?(sender) ->
        # Regular user nick → me; persist on channel = sender_nick so it
        # lands in the same query window a PRIVMSG-to-own-nick would.
        {sender, body}

      true ->
        # Anonymous-sender sentinel ("*") or other non-nick senders we
        # can't attribute. Fall back to $server so the row still lands
        # somewhere — losing it would mask connection-time diagnostics.
        {"$server", body}
    end
  end

  @spec chanserv_bracket_match(String.t(), String.t()) :: {String.t(), String.t()} | nil
  defp chanserv_bracket_match(sender, body) do
    if String.downcase(sender) == "chanserv" do
      case Regex.run(@chanserv_bracket_regex, body) do
        [_, channel, stripped_body] -> {channel, stripped_body}
        _ -> nil
      end
    else
      nil
    end
  end

  # CTCP framing: \x01<verb> ...\x01 — CLAUDE.md preserves verbatim in
  # scrollback body. ACTION (CTCP /me) is the only verb that earns its
  # own scrollback kind today; other CTCP verbs (VERSION, PING, etc.)
  # produce :reply effects in Phase 5+.
  defp ctcp_action?(<<0x01, "ACTION ", _::binary>>), do: true
  defp ctcp_action?(_), do: false

  # Extracts the CTCP verb from a `\x01VERB ...\x01` (or `\x01VERB\x01`)
  # body. Returns nil if the body doesn't start with \x01 or has no
  # parseable verb. Used by the CTCP-aware PRIVMSG arm to dispatch on
  # verb name (VERSION today; PING / TIME / SOURCE / FINGER candidates).
  @spec ctcp_verb(binary()) :: String.t() | nil
  defp ctcp_verb(<<0x01, rest::binary>>) do
    case :binary.split(rest, [" ", <<0x01>>]) do
      ["" | _] -> nil
      [verb | _] -> verb
    end
  end

  defp ctcp_verb(_), do: nil

  # Shared default PRIVMSG handler — used by both the generic arm and
  # the CTCP-aware arm's fallthrough for unknown verbs. Pulls out the
  # action/privmsg classification + persist-effect emission so the two
  # arms don't drift on body handling.
  @spec privmsg_default(Message.t(), state(), binary()) :: {:cont, state(), [effect()]}
  defp privmsg_default(%Message{params: [channel, _]} = msg, state, body) do
    kind = if ctcp_action?(body), do: :action, else: :privmsg
    {state, eff} = build_persist(state, kind, channel, Message.sender_nick(msg), body, %{})
    {:cont, state, [eff]}
  end

  @spec channels_with_member(members(), String.t()) :: [String.t()]
  defp channels_with_member(members, nick) do
    members
    |> Enum.filter(fn {_, ch_members} -> Map.has_key?(ch_members, nick) end)
    |> Enum.map(fn {ch, _} -> ch end)
    |> Enum.sort()
  end

  @spec remove_member_everywhere(members(), [String.t()], String.t()) :: members()
  defp remove_member_everywhere(members, channels, nick) do
    Enum.reduce(channels, members, fn ch, acc ->
      Map.update!(acc, ch, &Map.delete(&1, nick))
    end)
  end

  @spec rename_member_everywhere(members(), [String.t()], String.t(), String.t()) :: members()
  defp rename_member_everywhere(members, channels, old, new) do
    Enum.reduce(channels, members, fn ch, acc ->
      Map.update!(acc, ch, fn ch_members ->
        modes = Map.fetch!(ch_members, old)

        ch_members
        |> Map.delete(old)
        |> Map.put(new, modes)
      end)
    end)
  end

  # User-mode prefix table (Q-non-blocking pin): hard-coded `(ov)@+`
  # default per RFC 2812 + most networks. PREFIX ISUPPORT-driven
  # negotiation deferred to Phase 5; the table is a compile-time
  # constant here.
  @user_mode_prefixes %{"o" => "@", "v" => "+"}

  # Channel modes that consume a parameter when being set (+).
  # RFC 2811 type A (list: b/e/I), type B (always-param: k) and type C
  # (+param-only: l). Type D flag modes (n, t, m, s, i, p, r, …) take
  # no argument. CHANMODES ISUPPORT-driven table deferred to Phase 5;
  # until then this compile-time MapSet covers the common case.
  @channel_modes_with_param MapSet.new(["b", "e", "I", "k", "l"])

  @spec apply_mode_string(members(), String.t(), String.t(), [String.t()]) :: members()
  defp apply_mode_string(members, channel, mode_string, args) do
    case Map.get(members, channel) do
      nil ->
        members

      ch_members ->
        ch_members = walk_modes(ch_members, mode_string, args, :add)
        Map.put(members, channel, ch_members)
    end
  end

  defp walk_modes(ch_members, "", _, _), do: ch_members
  defp walk_modes(ch_members, "+" <> rest, args, _), do: walk_modes(ch_members, rest, args, :add)

  defp walk_modes(ch_members, "-" <> rest, args, _),
    do: walk_modes(ch_members, rest, args, :remove)

  defp walk_modes(ch_members, <<mode::binary-size(1), rest::binary>>, args, direction) do
    case Map.fetch(@user_mode_prefixes, mode) do
      {:ok, prefix} ->
        {target, remaining_args} = pop_arg(args)
        ch_members = update_member_mode(ch_members, target, prefix, direction)
        walk_modes(ch_members, rest, remaining_args, direction)

      :error ->
        # Channel-level mode (e.g. `+b ban_mask`); consumes one arg if it
        # takes one, none otherwise. Without a per-mode arg-taking table
        # we conservatively consume one arg if any remain — matches
        # Bahamut/InspIRCd behaviour for the most common channel modes
        # (k, l, b, e, I); the over-consume case is rare and only loses
        # us one inferred arg in a multi-mode line, never affects member
        # state.
        {_, remaining_args} = pop_arg(args)
        walk_modes(ch_members, rest, remaining_args, direction)
    end
  end

  defp pop_arg([h | t]), do: {h, t}
  defp pop_arg([]), do: {nil, []}

  # Sign-walking +r detector for user-MODE strings. IRC mode blocks
  # have sticky-sign semantics: `"+ir"` means "set i AND set r" in
  # one block, `"+i-r"` means "set i, unset r". `String.contains?` is
  # semantically wrong on both shapes (the second would even false-
  # positive on naive `"+r"` substring search). Mirrors the
  # `walk_modes/4` recursive-pattern-match shape (CLAUDE.md
  # "Recursive pattern match over `Enum.reduce_while/3`").
  @spec set_r_mode?(String.t()) :: boolean()
  defp set_r_mode?(modes), do: walk_for_set_r(modes, :add)

  defp walk_for_set_r("", _), do: false
  defp walk_for_set_r("+" <> rest, _), do: walk_for_set_r(rest, :add)
  defp walk_for_set_r("-" <> rest, _), do: walk_for_set_r(rest, :remove)
  defp walk_for_set_r("r" <> _, :add), do: true

  defp walk_for_set_r(<<_::utf8, rest::binary>>, dir),
    do: walk_for_set_r(rest, dir)

  defp update_member_mode(ch_members, nil, _, _), do: ch_members

  defp update_member_mode(ch_members, target, prefix, direction) when is_binary(target) do
    case Map.fetch(ch_members, target) do
      {:ok, modes} ->
        Map.put(ch_members, target, toggle_mode(modes, prefix, direction))

      :error ->
        # Target isn't in our members map (race with NAMES, or non-member
        # channel-mode arg); leave the map untouched. The persist row
        # still records the raw MODE line — audit trail intact.
        ch_members
    end
  end

  # `[prefix | modes]` prepend keeps the helper O(1); the canonical
  # mIRC sort happens at `Session.list_members/3` query time, so list
  # order in the in-memory map is irrelevant.
  defp toggle_mode(modes, prefix, :add) do
    if prefix in modes, do: modes, else: [prefix | modes]
  end

  defp toggle_mode(modes, prefix, :remove), do: List.delete(modes, prefix)

  @spec split_mode_prefix(String.t()) :: {String.t(), [String.t()]}
  defp split_mode_prefix(<<prefix, rest::binary>>) when prefix in [?@, ?+] do
    {rest, [<<prefix>>]}
  end

  defp split_mode_prefix(nick), do: {nick, []}

  @spec build_persist(
          state(),
          Grappa.Scrollback.Message.kind(),
          String.t(),
          String.t(),
          String.t() | nil,
          map()
        ) ::
          {state(), effect()}
  defp build_persist(state, kind, channel, sender, body, meta) do
    attrs =
      Session.put_subject_id(
        %{
          network_id: state.network_id,
          channel: channel,
          server_time: System.system_time(:millisecond),
          sender: sender,
          body: body,
          meta: meta,
          # CP14 B3 — populate the normalized "DM peer" column at
          # persist time so DM (query) windows can fetch BOTH sides of
          # the conversation in a single query, and so own-nick
          # rotation doesn't shard inbound history. `Scrollback.dm_peer/4`
          # is the single source of the rule; nil for non-DM rows
          # (channel messages, presence events, NOTICE-from-services,
          # etc.) — the schema accepts nil for the column.
          dm_with: Scrollback.dm_peer(kind, channel, sender, state.nick)
        },
        state.subject
      )

    {state, {:persist, kind, attrs}}
  end

  # ---------------------------------------------------------------------------
  # S2.3 helpers — topic + channel-mode cache
  # ---------------------------------------------------------------------------

  # IRC channel names are case-insensitive (RFC 2812 §2.2). Normalise to
  # downcase for cache keys — same direction as members map convention (keys
  # are stored case-preserved as-received from server; we normalise here at
  # write AND read time so lookups are always case-insensitive).
  @spec normalize_channel(String.t()) :: String.t()
  defp normalize_channel(channel) when is_binary(channel), do: String.downcase(channel)

  # Empty baseline entry returned when a channel_modes entry doesn't exist yet
  # (e.g. when a MODE arrives before 324 RPL_CHANNELMODEIS).
  @spec empty_mode_entry() :: channel_mode_entry()
  defp empty_mode_entry, do: %{modes: [], params: %{}}

  # Parse a full mode snapshot string (e.g. "+nt" or "+ntk") plus arg list
  # into a channel_mode_entry. Replaces any existing entry entirely (used by
  # 324 RPL_CHANNELMODEIS — the server-authoritative snapshot).
  # The sign must be '+' for a snapshot; we skip any leading '+'.
  @spec parse_mode_snapshot(String.t(), [String.t()]) :: channel_mode_entry()
  defp parse_mode_snapshot(mode_str, args) do
    # Strip leading '+' if present; snapshot is always additive
    stripped = String.trim_leading(mode_str, "+")
    walk_channel_modes(empty_mode_entry(), "+" <> stripped, args, :add)
  end

  # Apply a +/- delta mode string to an existing channel_mode_entry.
  # Reuses the same sticky-sign recursive pattern as walk_modes/4 for members.
  # Per-user modes (matching @user_mode_prefixes) are skipped — they update
  # state.members, not channel_modes. A per-user mode still consumes its arg.
  @spec apply_channel_mode_string(channel_mode_entry(), String.t(), [String.t()]) ::
          channel_mode_entry()
  defp apply_channel_mode_string(entry, mode_string, args) do
    walk_channel_modes(entry, mode_string, args, :add)
  end

  # walk_channel_modes: same sticky-sign recursive pattern as walk_modes/4,
  # but operates on a channel_mode_entry() instead of a members map.
  # Per-user modes (o, v) consume their arg but are NOT added to the entry.
  defp walk_channel_modes(entry, "", _, _), do: entry

  defp walk_channel_modes(entry, "+" <> rest, args, _),
    do: walk_channel_modes(entry, rest, args, :add)

  defp walk_channel_modes(entry, "-" <> rest, args, _),
    do: walk_channel_modes(entry, rest, args, :remove)

  defp walk_channel_modes(entry, <<mode::binary-size(1), rest::binary>>, args, direction) do
    case Map.fetch(@user_mode_prefixes, mode) do
      {:ok, _} ->
        # Per-user mode: consumes one arg (the target nick) but does NOT
        # update channel_modes — it updates state.members (done in walk_modes/4).
        {_, remaining} = pop_arg(args)
        walk_channel_modes(entry, rest, remaining, direction)

      :error ->
        # Channel-level mode. Only consume an arg if the mode is in the
        # @channel_modes_with_param table. Flag modes (n, t, m, s, …) have
        # no arg — consuming one would misalign the arg list for subsequent
        # param-modes like k or l.
        takes_param = MapSet.member?(@channel_modes_with_param, mode)
        {arg, remaining} = if takes_param, do: pop_arg(args), else: {nil, args}
        entry = toggle_channel_mode(entry, mode, arg, direction)
        walk_channel_modes(entry, rest, remaining, direction)
    end
  end

  @spec toggle_channel_mode(channel_mode_entry(), String.t(), String.t() | nil, :add | :remove) ::
          channel_mode_entry()
  defp toggle_channel_mode(entry, mode, arg, :add) do
    modes = if mode in entry.modes, do: entry.modes, else: [mode | entry.modes]

    params =
      if arg != nil do
        Map.put(entry.params, mode, arg)
      else
        entry.params
      end

    %{entry | modes: modes, params: params}
  end

  defp toggle_channel_mode(entry, mode, _, :remove) do
    %{entry | modes: List.delete(entry.modes, mode), params: Map.delete(entry.params, mode)}
  end

  # Parse a Unix timestamp string; let it crash on non-integer input (bad
  # upstream → supervisor restart per CLAUDE.md "let it crash").
  @spec parse_unix_ts(String.t()) :: DateTime.t()
  defp parse_unix_ts(ts_str) when is_binary(ts_str) do
    DateTime.from_unix!(String.to_integer(ts_str))
  end

  # ---------------------------------------------------------------------------
  # S2.4 helpers — WHOIS-userhost cache
  # ---------------------------------------------------------------------------

  # IRC nicks are case-insensitive (RFC 2812 §2.2). Normalise to downcase for
  # userhost_cache keys — mirrors normalize_channel/1 above. Applied at BOTH
  # write (JOIN/311/352/NICK) and read (lookup_userhost/3) time so lookup is
  # always case-insensitive regardless of how the upstream sends the nick.
  @spec normalize_nick(String.t()) :: String.t()
  defp normalize_nick(nick) when is_binary(nick), do: String.downcase(nick)

  # C2 — fold one set of WHOIS-numeric fields into the per-target accumulator
  # at `state.whois_pending[target_lower]`. Skips folding when no entry
  # exists (the operator never issued a /whois for this target — an
  # unsolicited WHOIS reply is not actionable). The `:channels_chunk`
  # special-case appends to the existing `:channels` list rather than
  # overwriting (319 may chunk over multiple lines).
  @spec whois_fold(state(), String.t(), map()) :: state()
  defp whois_fold(state, target, fold) when is_binary(target) and is_map(fold) do
    pending = Map.get(state, :whois_pending, %{})
    nick_key = normalize_nick(target)

    case Map.fetch(pending, nick_key) do
      :error ->
        state

      {:ok, accum} ->
        merged = whois_merge(accum, fold)
        %{state | whois_pending: Map.put(pending, nick_key, merged)}
    end
  end

  # Most fields overwrite. `:channels_chunk` (319 partial list) appends
  # into `:channels` instead of replacing — accumulating across multi-line
  # responses for users in many channels.
  @spec whois_merge(map(), map()) :: map()
  defp whois_merge(accum, fold) do
    Enum.reduce(fold, accum, fn
      {:channels_chunk, chans}, acc ->
        existing = Map.get(acc, :channels, [])
        Map.put(acc, :channels, existing ++ chans)

      {k, v}, acc ->
        Map.put(acc, k, v)
    end)
  end

  # Returns the trailing param (last element) when present, else nil.
  # Used to extract realname / server_info / channels-chunk text from
  # WHOIS numerics where the trailing param is the human-readable payload.
  @spec whois_trailing([term()]) :: String.t() | nil
  defp whois_trailing([]), do: nil

  defp whois_trailing(rest) when is_list(rest) do
    case List.last(rest) do
      s when is_binary(s) -> s
      _ -> nil
    end
  end

  # P-0a — Cluster `numeric-delegation-p0`: 326 RPL_WHOISMODES trailing
  # parser. Bahamut emits `"is using modes <modes>"` (s_err.c:369). We
  # extract `<modes>` so the wire shape carries a structured umode string
  # rather than the localized English template — per
  # `feedback_no_localized_strings_server_side`. Returns nil on
  # unexpected template (defensive — unknown ircds may emit a different
  # shape; folding nothing keeps the bundle consistent).
  @spec parse_whois_modes_trailing(String.t() | nil) :: String.t() | nil
  defp parse_whois_modes_trailing(nil), do: nil

  defp parse_whois_modes_trailing(text) when is_binary(text) do
    case String.split(text, "is using modes ", parts: 2) do
      ["", modes] when modes != "" -> modes
      _ -> nil
    end
  end

  # P-0a — 378 RPL_WHOISACTUALLY trailing parser. Bahamut emits
  # `"is connecting from <host> [<ip>]"` (s_err.c:425). Extracts both
  # tokens. Returns nil when the template doesn't match — an unknown
  # ircd may format differently and we'd rather skip the fold than
  # surface garbled fields.
  @spec parse_whois_actually_trailing(String.t() | nil) :: {String.t(), String.t()} | nil
  defp parse_whois_actually_trailing(nil), do: nil

  defp parse_whois_actually_trailing(text) when is_binary(text) do
    case Regex.run(~r/^is connecting from (\S+) \[([^\]]+)\]$/, text) do
      [_, host, ip] -> {host, ip}
      _ -> nil
    end
  end

  @spec parse_int_or_nil(String.t()) :: integer() | nil
  defp parse_int_or_nil(s) when is_binary(s) do
    case Integer.parse(s) do
      {n, ""} -> n
      _ -> nil
    end
  end

  # CP22 cluster B — fold one 352 RPL_WHOREPLY row into the per-target WHO
  # accumulator at `state.who_pending[channel_lower].replies`. Skips folding
  # when no entry exists (the operator never issued a /who for this channel
  # — an unsolicited 352 is not actionable for the bundle, though the
  # userhost_cache update in the 352 route still fires upstream of this).
  # Prepends to :replies for O(1) fold — the 315 RPL_ENDOFWHO route reverses
  # before emitting so consumers see server wire order (ops first, voices,
  # then plain users).
  @spec who_fold(state(), String.t(), map()) :: state()
  defp who_fold(state, channel, reply) when is_binary(channel) and is_map(reply) do
    pending = Map.get(state, :who_pending, %{})
    chan_key = String.downcase(channel)

    case Map.fetch(pending, chan_key) do
      :error ->
        state

      {:ok, accum} ->
        replies = Map.get(accum, :replies, [])
        merged = Map.put(accum, :replies, [reply | replies])
        %{state | who_pending: Map.put(pending, chan_key, merged)}
    end
  end

  # CP22 cluster B — RPL_WHOREPLY trailing field is `<hops> <realname>`
  # joined by a single space (RFC 2812 §5.1). Returns `{hops, realname}`
  # with hops as integer (nil if unparseable) and realname as the rest of
  # the trailing string. If the trailing param is absent (RFC-violating
  # server), both fields are nil.
  @spec parse_who_trailing([term()]) :: {integer() | nil, String.t() | nil}
  defp parse_who_trailing([]), do: {nil, nil}

  defp parse_who_trailing(rest) when is_list(rest) do
    case List.last(rest) do
      s when is_binary(s) ->
        case String.split(s, " ", parts: 2) do
          [hops_str, realname] -> {parse_int_or_nil(hops_str), realname}
          [hops_str] -> {parse_int_or_nil(hops_str), nil}
        end

      _ ->
        {nil, nil}
    end
  end

  # CP22 cluster B — irssi-shape compact body for a single 352 row.
  # Defensive readable payload: cic prefers meta.who structured render,
  # but if scrollback replays without structured handling (older cic,
  # raw API consumer) the body is still meaningful. Stable single-line
  # format: `*** [#chan] nick modes user@host (server) :realname`.
  @spec format_who_reply(String.t(), map()) :: String.t()
  defp format_who_reply(channel, reply) do
    "*** [#{channel}] #{reply.nick} #{reply.modes} #{reply.user}@#{reply.host} (#{reply.server}) :#{reply.realname || ""}"
  end

  # CP22 cluster B (channel-client-polish #14) — append the raw
  # `[prefix]nick` tokens from a 353 RPL_NAMREPLY into the per-target
  # /names accumulator at `state.names_pending[channel_lower].names`.
  # Skips when no entry exists (the operator never issued a /names for
  # this channel — the JOIN-time 353 still merges into state.members
  # via the route's primary effect, this fold is purely additive).
  # Multiple 353 lines arrive for big channels; tokens are appended in
  # arrival order (single Enum.concat per call — small N, no LIFO needed
  # since the 366 drain consumes the list as a single atom).
  @spec names_fold(state(), String.t(), [String.t()]) :: state()
  defp names_fold(state, channel, tokens)
       when is_binary(channel) and is_list(tokens) do
    pending = Map.get(state, :names_pending, %{})
    chan_key = String.downcase(channel)

    case Map.fetch(pending, chan_key) do
      :error ->
        state

      {:ok, accum} ->
        existing = Map.get(accum, :names, [])
        merged = Map.put(accum, :names, existing ++ tokens)
        %{state | names_pending: Map.put(pending, chan_key, merged)}
    end
  end

  # CP22 cluster B — drain the /names accumulator on 366 RPL_ENDOFNAMES.
  # Returns `{state_with_entry_removed, effects}`. Effects shape:
  #   - no entry: `[]` (route's members_seeded effect still fires).
  #   - entry exists: `[nick_list_row, eof_row]` ALWAYS emitted (silence
  #     is the bug — /names UX cluster N-1+N-2). Route channel order:
  #     `accum.origin_window` (cic focused window when /names was typed)
  #     → target if joined → `$server`. The nick list row carries the
  #     full `[prefix]nick` tokens in `meta.names`; the EOF row carries
  #     `meta.names_target` for cic to scope rendering.
  @spec drain_names_pending(state(), String.t()) ::
          {state(), [effect()]}
  defp drain_names_pending(state, channel) when is_binary(channel) do
    pending = Map.get(state, :names_pending, %{})
    chan_key = String.downcase(channel)

    case Map.fetch(pending, chan_key) do
      :error ->
        {state, []}

      {:ok, accum} ->
        next_state = %{state | names_pending: Map.delete(pending, chan_key)}
        target_display = Map.get(accum, :target_display, channel)
        names = Map.get(accum, :names, [])
        sender = state.network_slug
        route_channel = pick_names_route(accum, target_display, state.members)

        {state_after_row, row_effect} =
          build_persist(
            next_state,
            :notice,
            route_channel,
            sender,
            format_names_row(target_display, names),
            %{numeric: 353, names_target: target_display, names: names}
          )

        {final_state, eof_effect} =
          build_persist(
            state_after_row,
            :notice,
            route_channel,
            sender,
            "*** End of /NAMES list for #{target_display}",
            %{numeric: 366, names_target: target_display}
          )

        {final_state, [row_effect, eof_effect]}
    end
  end

  # /names UX cluster N-1+N-2 — pick the route channel for the 2 :notice
  # rows. Preference order: explicit `origin_window` from the accumulator
  # (set by `Session.send_names/4` carrying cic's focused window) → the
  # target itself if the operator is joined → `$server` (legacy fallback
  # for non-joined targets without an origin_window — preserves shape for
  # callers that don't carry origin_window yet).
  @spec pick_names_route(map(), String.t(), members()) :: String.t()
  defp pick_names_route(accum, target_display, members) do
    case Map.get(accum, :origin_window) do
      origin when is_binary(origin) and origin != "" ->
        origin

      _ ->
        if Map.has_key?(members, target_display), do: target_display, else: "$server"
    end
  end

  # CP22 cluster B — irssi-shape compact body for the /names nick-list
  # row. Defensive readable payload: cic prefers `meta.names` structured
  # render, but if scrollback replays without structured handling the
  # body is still meaningful. Stable single-line format:
  # `*** [#chan] nick1 nick2 nick3 ...`. Empty list (server returned
  # nothing — RFC-violating or empty channel) renders as the bare prefix.
  @spec format_names_row(String.t(), [String.t()]) :: String.t()
  defp format_names_row(channel, []), do: "*** [#{channel}] (no names)"

  defp format_names_row(channel, names) when is_list(names) do
    "*** [#{channel}] #{Enum.join(names, " ")}"
  end

  # Evict userhost_cache entries for nicks that appear in no channel of
  # `members_map` after the PART. Called for self-PART where every nick
  # in the departed channel must be checked against the updated members.
  @spec evict_if_no_overlap([String.t()], members(), userhost_cache()) :: userhost_cache()
  defp evict_if_no_overlap(nicks, members_map, cache) do
    Enum.reduce(nicks, cache, fn nick, acc ->
      maybe_evict(acc, nick, channels_with_member(members_map, nick))
    end)
  end

  @spec maybe_evict(userhost_cache(), String.t(), [String.t()]) :: userhost_cache()
  defp maybe_evict(cache, nick, []), do: Map.delete(cache, normalize_nick(nick))
  defp maybe_evict(cache, _, _), do: cache

  # Migrate a userhost_cache entry from old_nick to new_nick on a NICK rename.
  # If old_nick is not in the cache (never seen via JOIN/WHOIS/WHO), no-op.
  # The user+host fields are preserved — they don't change with a nick change.
  @spec rename_userhost_entry(userhost_cache(), String.t(), String.t()) :: userhost_cache()
  defp rename_userhost_entry(cache, old_nick, new_nick) do
    old_key = normalize_nick(old_nick)
    new_key = normalize_nick(new_nick)

    case Map.fetch(cache, old_key) do
      {:ok, entry} -> cache |> Map.delete(old_key) |> Map.put(new_key, entry)
      :error -> cache
    end
  end
end
