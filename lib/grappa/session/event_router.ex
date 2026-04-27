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
                                                     (forward-compat;
                                                      no E1 route emits this)

  This shape was extracted per the 2026-04-27 architecture review
  (finding A6, CP10 D4) and mirrors `Grappa.IRC.AuthFSM` from D2 — the
  pure-classifier shape of the verb-keyed sub-context principle. Server
  owns the GenServer, transport, and effect flushing; this module owns
  IRC-message → scrollback-event mapping for all 10 kinds plus the
  4 informational numerics (001, 332, 333, 353/366) that derive
  `state.members` / `state.nick` without producing scrollback rows.

  ## State shape (subset of `Session.Server.state()`)

      @type state :: %{
              required(:user_id) => Ecto.UUID.t(),
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

  @typedoc """
  The Session.Server state subset this module reads + mutates. The
  full Session.Server state has additional fields (`user_name`,
  `network_slug`, `autojoin`, `client`, etc.) — this typespec uses
  `optional(any()) => any()` to admit them without enforcing them.
  """
  @type state :: %{
          required(:user_id) => Ecto.UUID.t(),
          required(:network_id) => integer(),
          required(:nick) => String.t(),
          required(:members) => members(),
          optional(any()) => any()
        }

  @type members :: %{
          String.t() => %{String.t() => [String.t()]}
        }

  @type persist_attrs :: %{
          required(:user_id) => Ecto.UUID.t(),
          required(:network_id) => integer(),
          required(:channel) => String.t(),
          required(:server_time) => integer(),
          required(:sender) => String.t(),
          required(:body) => String.t() | nil,
          required(:meta) => map()
        }

  @type effect ::
          {:persist, Grappa.Scrollback.Message.kind(), persist_attrs()}
          | {:reply, iodata()}

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

    {state, eff} = build_persist(%{state | members: members}, :join, channel, sender, nil, %{})
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
    members =
      cond do
        sender == state.nick ->
          Map.delete(state.members, channel)

        Map.has_key?(state.members, channel) ->
          Map.update!(state.members, channel, &Map.delete(&1, sender))

        true ->
          # Defensive: persist the audit row even for an unknown channel
          # (member-state untouched). Lets a renderer recover the PART
          # event if upstream re-orders relative to a JOIN we haven't
          # seen yet.
          state.members
      end

    {state, eff} = build_persist(%{state | members: members}, :part, channel, sender, reason, %{})
    {:cont, state, [eff]}
  end

  def route(%Message{command: :quit, params: rest} = msg, state) do
    sender = Message.sender_nick(msg)

    reason =
      case rest do
        [r | _] when is_binary(r) -> r
        _ -> nil
      end

    case channels_with_member(state.members, sender) do
      [] ->
        {:cont, state, []}

      channels ->
        members = remove_member_everywhere(state.members, channels, sender)
        new_state = %{state | members: members}

        effects =
          for ch <- channels do
            {_, eff} = build_persist(new_state, :quit, ch, sender, reason, %{})
            eff
          end

        {:cont, new_state, effects}
    end
  end

  def route(%Message{command: :mode, params: [channel, modes | args]} = msg, state)
      when is_binary(channel) and is_binary(modes) do
    sender = Message.sender_nick(msg)
    members = apply_mode_string(state.members, channel, modes, args)

    {state, eff} =
      build_persist(
        %{state | members: members},
        :mode,
        channel,
        sender,
        nil,
        %{modes: modes, args: args}
      )

    {:cont, state, [eff]}
  end

  def route(%Message{command: :nick, params: [new_nick | _]} = msg, state)
      when is_binary(new_nick) do
    old_nick = Message.sender_nick(msg)
    channels = channels_with_member(state.members, old_nick)

    members = rename_member_everywhere(state.members, channels, old_nick, new_nick)

    new_state =
      if old_nick == state.nick do
        %{state | nick: new_nick, members: members}
      else
        %{state | members: members}
      end

    effects =
      for ch <- channels do
        {_, eff} =
          build_persist(new_state, :nick_change, ch, old_nick, nil, %{new_nick: new_nick})

        eff
      end

    {:cont, new_state, effects}
  end

  def route(%Message{command: :topic, params: [channel, body]} = msg, state)
      when is_binary(channel) and is_binary(body) do
    {state, eff} = build_persist(state, :topic, channel, Message.sender_nick(msg), body, %{})
    {:cont, state, [eff]}
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
    members =
      cond do
        target == state.nick ->
          Map.delete(state.members, channel)

        Map.has_key?(state.members, channel) ->
          Map.update!(state.members, channel, &Map.delete(&1, target))

        true ->
          state.members
      end

    {state, eff} =
      build_persist(
        %{state | members: members},
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

  # 332 RPL_TOPIC + 333 RPL_TOPICWHOTIME arrive as JOIN-time backfill;
  # the topic-bar in P4-1 reads live state, not scrollback rows. Pin as
  # explicit no-ops so a future "let's persist topic backfill" idea
  # stays out of E1 scope. 366 RPL_ENDOFNAMES is the end-of-NAMES
  # marker; we don't need to react (each 353 already committed its
  # delta).
  def route(%Message{command: {:numeric, code}}, state) when code in [332, 333, 366] do
    {:cont, state, []}
  end

  # 001 RPL_WELCOME: first param is the welcomed nick (what upstream
  # actually registered us as — may differ from requested due to
  # case-fold normalization, services rename, length truncation).
  # Reconcile state.nick to upstream's authority.
  def route(%Message{command: {:numeric, 1}, params: [welcomed_nick | _]}, state)
      when is_binary(welcomed_nick) do
    {:cont, %{state | nick: welcomed_nick}, []}
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
    attrs = %{
      user_id: state.user_id,
      network_id: state.network_id,
      channel: channel,
      server_time: System.system_time(:millisecond),
      sender: sender,
      body: body,
      meta: meta
    }

    {state, {:persist, kind, attrs}}
  end
end
