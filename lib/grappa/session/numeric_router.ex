defmodule Grappa.Session.NumericRouter do
  @moduledoc """
  Pure routing matrix for IRC server numerics.

  Implements the numeric-to-window routing strategy documented in spec
  feature #21 ("User-action numeric replies route to originating/natural
  window"). Returns a routing decision that `Grappa.Session.Server` uses
  to determine which cicchetto window receives the `numeric_routed` event.

  ## Routing strategy (spec feature #21)

  Priority order (highest to lowest):

  1. **Label-based**: if the numeric carries an IRCv3 `label` message-tag
     AND that label is in `state.labels_pending`, the registered
     `origin_window` wins unconditionally. This is the perfect-correlation
     path when the upstream supports the `labeled-response` cap.

  2. **Param-derived** (by numeric class):
     - **Channel-param numerics** (404, 442, 471, 472, 473, 474, 475, 477,
       478, 482, 367, 368) — extract the channel name from params and route
       to `{:channel, "#chan"}`.
     - **Nick-param numerics** (401) — extract the nick from params; if a
       query window is open for that nick (case-insensitive), route to
       `{:query, nick}`; otherwise fall through to `:active`.
     - **No-useful-param numerics** (432, 433, 437, 421, 461, 305, 306) —
       go to `:active` resolution.

  3. **Active resolution**: `:active` resolves against `last_command_window`
     from Session.Server state. If `last_command_window` is set, the
     decision mirrors that window's `{kind, target}`. If nil, `{:active, nil}`
     is returned (cicchetto uses whatever window is currently focused).

  4. **Delegated numerics**: WHOIS (311–319), WHO (352/315), NAMES (353/366),
     LIST (321/322/323), LINKS (364/365), MOTD (375/372/376) are already
     handled by their dedicated features (#2, #14, #15, #16, #4) in
     `EventRouter`. This module returns `:delegated` for them; the caller
     must skip the routing matrix and let the existing handlers own these.

  ## Purity contract

  This module has NO side effects. It reads:
    - The `%Grappa.IRC.Message{}` struct (tags + params).
    - A state subset: `open_query_nicks`, `last_command_window`,
      `labels_pending`.

  Callers (Session.Server) extract the relevant state fields and pass them
  in. Never add Repo calls, Logger, or PubSub here.

  ## Types

  `routing_decision/0` is the closed set of outcomes. `window_kind/0`
  mirrors the `kind:` discriminator used in the `numeric_routed` channel event.

  See also: `Grappa.Session.Server` for `last_command_window` and
  `labels_pending` state fields; `Grappa.Session.EventRouter` for
  delegated numeric handling.
  """

  alias Grappa.IRC.Message

  @typedoc """
  The resolved routing destination for a numeric.

    * `{:channel, chan}` — route to the named channel's window.
    * `{:query, nick}` — route to the DM/query window for nick.
    * `{:server, nil}` — route to the server-messages pseudo-window.
    * `{:active, nil}` — route to whichever window is currently focused in
      cicchetto (or whichever `last_command_window` points to — see S4.3).
    * `:delegated` — numeric is owned by a dedicated handler; skip the matrix.
  """
  @type routing_decision ::
          {:channel, String.t()}
          | {:query, String.t()}
          | {:server, nil}
          | {:active, nil}
          | :delegated

  @typedoc """
  Window kind discriminator — mirrors the `kind:` atom in `window_ref()`.
  """
  @type window_kind :: :channel | :query | :server | :list | :mentions

  @typedoc """
  A window reference: the `kind:` discriminator + optional `target:` name.
  This mirrors the `last_command_window` shape in `Session.Server.state()`.
  """
  @type window_ref :: %{kind: window_kind(), target: String.t() | nil}

  @typedoc """
  The state subset this module reads. Session.Server extracts these fields
  and passes them in to keep NumericRouter pure (no GenServer calls, no Repo).

    * `open_query_nicks` — a `MapSet` of **lowercased** nick strings for
      which the user currently has an open DM window. Derived from
      `QueryWindows.list_for_user/1` at the call site.
    * `last_command_window` — the most-recently-used window for a
      cicchetto-originated command; `nil` when no command has been issued
      in this session yet. Set by Session.Server on every outbound command.
    * `labels_pending` — `%{label_string => window_ref}` tracking in-flight
      labeled-response correlations. Bounded to in-flight commands (typically
      <10); Session.Server cleans up on numeric arrival.
  """
  @type router_state :: %{
          required(:open_query_nicks) => MapSet.t(String.t()),
          required(:last_command_window) => window_ref() | nil,
          required(:labels_pending) => %{String.t() => window_ref()}
        }

  # ---------------------------------------------------------------------------
  # Numeric class lookup tables (compile-time)
  # ---------------------------------------------------------------------------

  # Channel-param numerics: the channel name appears in params (typically at
  # index 1 after own-nick, but pattern extraction handles both 2-param and
  # 3-param shapes).
  @channel_param_numerics MapSet.new([
                            # 404 ERR_CANNOTSENDTOCHAN — tried to speak in +m without voice
                            404,
                            # 442 ERR_NOTONCHANNEL — e.g. tried to PART a channel not in
                            442,
                            # 471 ERR_CHANNELISFULL — JOIN rejected, channel limit (+l)
                            471,
                            # 472 ERR_UNKNOWNMODE — unknown mode character for channel
                            472,
                            # 473 ERR_INVITEONLYCHAN — JOIN rejected, invite-only (+i)
                            473,
                            # 474 ERR_BANNEDFROMCHAN — JOIN rejected, user is banned
                            474,
                            # 475 ERR_BADCHANNELKEY — JOIN rejected, wrong key (+k)
                            475,
                            # 477 ERR_NOCHANMODES — channel doesn't support modes
                            477,
                            # 478 ERR_BANLISTFULL — ban list is full
                            478,
                            # 482 ERR_CHANOPRIVSNEEDED — need op to do this
                            482,
                            # 367 RPL_BANLIST — a ban list entry
                            367,
                            # 368 RPL_ENDOFBANLIST — end of ban list
                            368
                          ])

  # Nick-param numerics: the target nick appears in params at index 1.
  @nick_param_numerics MapSet.new([
                         # 401 ERR_NOSUCHNICK — nick or channel doesn't exist
                         401
                       ])

  # Active (param-less) numerics: no useful param for routing; use
  # last_command_window or focus heuristic.
  @active_numerics MapSet.new([
                     # 432 ERR_ERRONEUSNICKNAME — bad nick format in /nick
                     432,
                     # 433 ERR_NICKNAMEINUSE — nick taken in /nick
                     433,
                     # 437 ERR_UNAVAILRESOURCE — nick temporarily unavailable
                     437,
                     # 421 ERR_UNKNOWNCOMMAND — unknown IRC command issued
                     421,
                     # 461 ERR_NEEDMOREPARAMS — command missing required params
                     461,
                     # 305 RPL_UNAWAY — upstream confirmed away unset
                     305,
                     # 306 RPL_NOWAWAY — upstream confirmed away set
                     306
                   ])

  # Delegated numerics: already handled by dedicated EventRouter/Server handlers.
  # This router returns :delegated; the caller must skip the matrix for these.
  @delegated_numerics MapSet.new([
                        # WHOIS replies (311–319)
                        311,
                        312,
                        313,
                        317,
                        318,
                        319,
                        # WHO replies (352, 315)
                        352,
                        315,
                        # NAMES replies (353, 366)
                        353,
                        366,
                        # LIST replies (321, 322, 323)
                        321,
                        322,
                        323,
                        # LINKS replies (364, 365)
                        364,
                        365,
                        # MOTD replies (375, 372, 376)
                        375,
                        372,
                        376
                      ])

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  @doc """
  Routes one numeric `%Message{}` to a `routing_decision()`.

  Priority: labeled-response (S4.2) > param-derived > active fallback (S4.3).

  Delegated numerics return `:delegated` immediately — the caller must not
  broadcast a `numeric_routed` event for these; the dedicated handlers own them.

  `state` must satisfy `router_state()` — Session.Server builds this view
  from its own state before calling.
  """
  @spec route(Message.t(), router_state()) :: routing_decision()
  def route(%Message{command: {:numeric, code}} = msg, state) do
    # Step 1: label-based override (S4.2 labeled-response)
    case label_lookup(msg, state) do
      {:ok, window_ref} ->
        window_ref_to_decision(window_ref)

      :miss ->
        # Step 2: param-derived routing by numeric class
        param_derived_route(code, msg, state)
    end
  end

  @doc """
  Returns the severity class for a numeric code.

  `:error` for failure-class numerics (4xx, 5xx) — rendered in red in cicchetto.
  `:ok` for success/info numerics (2xx, 3xx, 1xx).
  """
  @spec severity(1..999) :: :ok | :error
  def severity(code) when is_integer(code) and code >= 400, do: :error
  def severity(code) when is_integer(code), do: :ok

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  # Step 1: check if the numeric has a @label tag that matches a pending label.
  @spec label_lookup(Message.t(), router_state()) :: {:ok, window_ref()} | :miss
  defp label_lookup(%Message{} = msg, state) do
    case Message.tag(msg, "label") do
      nil ->
        :miss

      label when is_binary(label) ->
        case Map.get(state.labels_pending, label) do
          nil -> :miss
          window_ref -> {:ok, window_ref}
        end
    end
  end

  # Step 2: param-derived routing.
  # MapSet.member?/2 cannot be used in guards, so we use cond instead.
  @spec param_derived_route(1..999, Message.t(), router_state()) :: routing_decision()
  defp param_derived_route(code, msg, state) do
    cond do
      MapSet.member?(@delegated_numerics, code) ->
        :delegated

      MapSet.member?(@channel_param_numerics, code) ->
        route_channel_param(msg, state)

      MapSet.member?(@nick_param_numerics, code) ->
        route_nick_param(msg, state)

      MapSet.member?(@active_numerics, code) ->
        resolve_active(state)

      # Unknown numeric → active (don't crash on vendor extensions)
      true ->
        resolve_active(state)
    end
  end

  # Channel-param: channel name is at params[1] (after own-nick at params[0]).
  @spec route_channel_param(Message.t(), router_state()) :: routing_decision()
  defp route_channel_param(%Message{params: [_, channel | _]}, _state)
       when is_binary(channel) do
    {:channel, channel}
  end

  # Malformed numeric with no channel param — fall back to active.
  defp route_channel_param(%Message{params: _}, state) do
    resolve_active(state)
  end

  # Nick-param: nick is at params[1]. Case-insensitive lookup against open query windows.
  @spec route_nick_param(Message.t(), router_state()) :: routing_decision()
  defp route_nick_param(%Message{params: [_, nick | _]}, state) when is_binary(nick) do
    if MapSet.member?(state.open_query_nicks, String.downcase(nick)) do
      {:query, nick}
    else
      resolve_active(state)
    end
  end

  defp route_nick_param(%Message{params: _}, state) do
    resolve_active(state)
  end

  # Active resolution: last_command_window > {:active, nil}.
  @spec resolve_active(router_state()) :: routing_decision()
  defp resolve_active(%{last_command_window: %{kind: kind, target: target}})
       when not is_nil(kind) do
    {kind, target}
  end

  defp resolve_active(_state), do: {:active, nil}

  # Convert a window_ref to a routing_decision tuple.
  @spec window_ref_to_decision(window_ref()) :: routing_decision()
  defp window_ref_to_decision(%{kind: kind, target: target}), do: {kind, target}
end
