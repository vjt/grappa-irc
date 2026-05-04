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

  This shape was extracted per the 2026-04-27 architecture review
  (finding A6, CP10 D4) and mirrors `Grappa.IRC.AuthFSM` from D2 — the
  pure-classifier shape of the verb-keyed sub-context principle. Server
  owns the GenServer, transport, and effect flushing; this module owns
  IRC-message → scrollback-event mapping for all 10 kinds plus the
  4 informational numerics (001, 332, 333, 353/366) that derive
  `state.members` / `state.nick` without producing scrollback rows.

  ## State shape (subset of `Session.Server.state()`)

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

  alias Grappa.IRC.Message
  alias Grappa.Session

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
          | {:away_confirmed, :present | :away}

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
  def route(%Message{command: :privmsg, params: [channel, body]} = msg, state)
      when is_binary(channel) and is_binary(body) do
    kind = if ctcp_action?(body), do: :action, else: :privmsg
    {state, eff} = build_persist(state, kind, channel, Message.sender_nick(msg), body, %{})
    {:cont, state, [eff]}
  end

  def route(%Message{command: :notice, params: [channel, body]} = msg, state)
      when is_binary(channel) and is_binary(body) do
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

    {:cont, state, [eff]}
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

    {state, eff} =
      build_persist(
        %{
          state
          | members: members,
            topics: topics,
            channel_modes: channel_modes,
            userhost_cache: userhost_cache
        },
        :part,
        channel,
        sender,
        reason,
        %{}
      )

    {:cont, state, [eff]}
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

    # Q1: self-KICK (target == state.nick) drops the channel key entirely.
    # Symmetric with self-PART. Other-user KICK preserves the inner-nick
    # delete.
    # S2.3: self-KICK also drops topics + channel_modes cache entries.
    # S2.4: evict userhost_cache for the kicked nick (same channel-overlap
    # logic as PART).
    chan_key = normalize_channel(channel)

    {members, topics, channel_modes, userhost_cache} =
      cond do
        target == state.nick ->
          new_members = Map.delete(state.members, channel)
          cache = Map.get(state, :userhost_cache, %{})

          # Self-kicked: evict own entry (we're gone from this channel; if we
          # were only in this channel, nothing left to cache for ourselves).
          new_cache =
            if channels_with_member(new_members, target) == [] do
              Map.delete(cache, normalize_nick(target))
            else
              cache
            end

          {new_members, Map.delete(Map.get(state, :topics, %{}), chan_key),
           Map.delete(Map.get(state, :channel_modes, %{}), chan_key), new_cache}

        Map.has_key?(state.members, channel) ->
          new_members = Map.update!(state.members, channel, &Map.delete(&1, target))
          cache = Map.get(state, :userhost_cache, %{})

          new_cache =
            if channels_with_member(new_members, target) == [] do
              Map.delete(cache, normalize_nick(target))
            else
              cache
            end

          {new_members, Map.get(state, :topics, %{}), Map.get(state, :channel_modes, %{}), new_cache}

        true ->
          {state.members, Map.get(state, :topics, %{}), Map.get(state, :channel_modes, %{}),
           Map.get(state, :userhost_cache, %{})}
      end

    {state, eff} =
      build_persist(
        %{
          state
          | members: members,
            topics: topics,
            channel_modes: channel_modes,
            userhost_cache: userhost_cache
        },
        :kick,
        channel,
        sender,
        reason,
        %{target: target}
      )

    {:cont, state, [eff]}
  end

  # 353 RPL_NAMREPLY: `:server 353 nick = #channel :@op +voice plain`.
  # Trailing param is space-separated `[prefix]nick` tokens. Additive
  # merge into state.members[channel] — multiple 353 lines arrive for
  # big channels. 366 RPL_ENDOFNAMES marks end; we don't need an
  # explicit close because each 353 commits its delta immediately.
  def route(
        %Message{command: {:numeric, 353}, params: [_, _, channel, names_blob]},
        state
      )
      when is_binary(channel) and is_binary(names_blob) do
    new_entries =
      names_blob
      |> String.split(" ", trim: true)
      |> Map.new(&split_mode_prefix/1)

    members =
      Map.update(state.members, channel, new_entries, fn existing ->
        Map.merge(existing, new_entries)
      end)

    {:cont, %{state | members: members}, []}
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

  # 366 RPL_ENDOFNAMES is the end-of-NAMES marker; we don't need to react
  # (each 353 already committed its delta).
  def route(%Message{command: {:numeric, 366}}, state) do
    {:cont, state, []}
  end

  # 311 RPL_WHOISUSER: `:server 311 own_nick target user host * :realname`.
  # S2.4: upsert userhost_cache with the target nick's user+host. This is
  # the authoritative WHOIS data — always overwrites any JOIN-derived entry.
  # Keyed by lowercased nick (RFC 2812 §2.2 case-insensitive comparison).
  def route(
        %Message{command: {:numeric, 311}, params: [_, target, user, host | _]},
        state
      )
      when is_binary(target) and is_binary(user) and is_binary(host) do
    nick_key = normalize_nick(target)
    cache = Map.put(Map.get(state, :userhost_cache, %{}), nick_key, %{user: user, host: host})
    {:cont, %{state | userhost_cache: cache}, []}
  end

  # 352 RPL_WHOREPLY: `:server 352 own_nick #chan user host server target H/G :hop realname`.
  # S2.4: upsert userhost_cache with target nick's user+host (params are
  # positional: index 0=own_nick, 1=#chan, 2=user, 3=host, 4=server, 5=target).
  # Keyed by lowercased nick.
  def route(
        %Message{command: {:numeric, 352}, params: [_, _, user, host, _, target | _]},
        state
      )
      when is_binary(target) and is_binary(user) and is_binary(host) do
    nick_key = normalize_nick(target)
    cache = Map.put(Map.get(state, :userhost_cache, %{}), nick_key, %{user: user, host: host})
    {:cont, %{state | userhost_cache: cache}, []}
  end

  # 001 RPL_WELCOME: first param is the welcomed nick (what upstream
  # actually registered us as — may differ from requested due to
  # case-fold normalization, services rename, length truncation).
  # Reconcile state.nick to upstream's authority.
  def route(%Message{command: {:numeric, 1}, params: [welcomed_nick | _]}, state)
      when is_binary(welcomed_nick) do
    {:cont, %{state | nick: welcomed_nick}, []}
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

  def route(%Message{} = _, state), do: {:cont, state, []}

  # CTCP framing: \x01<verb> ...\x01 — CLAUDE.md preserves verbatim in
  # scrollback body. ACTION (CTCP /me) is the only verb that earns its
  # own scrollback kind today; other CTCP verbs (VERSION, PING, etc.)
  # produce :reply effects in Phase 5+.
  defp ctcp_action?(<<0x01, "ACTION ", _::binary>>), do: true
  defp ctcp_action?(_), do: false

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
          meta: meta
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
