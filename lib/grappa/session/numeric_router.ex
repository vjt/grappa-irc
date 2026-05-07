defmodule Grappa.Session.NumericRouter do
  @moduledoc """
  Pure routing matrix for IRC server numerics.

  Implements the numeric-to-window routing strategy from CP13 (server-window
  cluster). Returns a `routing_decision()` that `Grappa.Session.Server` uses
  to decide which window receives the persisted `:notice` row carrying the
  numeric's trailing text.

  ## Routing strategy (CP13)

  Priority order (highest → lowest):

  1. **Label-based** (IRCv3 `labeled-response` cap): if the numeric carries
     a `label` message-tag AND the label is registered in `labels_pending`,
     the recorded `origin_window` wins unconditionally — perfect-correlation
     path.

  2. **Delegated**: WHOIS (311–319), WHO (352/315), NAMES (353/366),
     LIST (321/322/323), LINKS (364/365), MOTD (375/372/376) — owned by
     dedicated handlers in `EventRouter`. We return `:delegated`; the caller
     skips the matrix.

  3. **Active deny list** (`@active_numerics`): a small set of numerics
     whose params look nick-shaped but the "nick" is not a routing
     destination — it's the rejected nick (433/432), the unknown command
     name (421), the offending command's argument list (461), or just an
     ack (305/306/437). These ALWAYS go to `{:server, nil}`. Without this
     deny list, the param-scan below would happily route 433's
     "BLEH-as-nick" to a query window.

  4. **Param scan** (the general case): walk `params`, skipping
     `params[0]` (own-nick echo) and the last element (trailing
     human-readable text). Take the first match in this priority:

     a. `^[#&!+]` → channel name → `{:channel, name}`.
     b. `valid_nick?/1` AND `!= own_nick` AND no `.` (excludes server
        hostnames whose syntax overlaps with nicks) → `{:query, nick}`.
     c. else → `{:server, nil}`.

  ## Design notes

  * The deny list is closed-set on purpose — adding a numeric to it is a
    deliberate "this looks routable but isn't" call. Unknown numerics fall
    through the param scan; if they have a channel-shaped param they go
    there, otherwise `$server`. This is the safe default — at worst a row
    lands on `$server` instead of a more specific window. No silent loss.
  * `last_command_window` resolution is gone from this module. It survives
    in `Server.ex` only for labeled-response correlation bookkeeping.
    Pre-CP13 the router used it as the `:active` fallback target, but the
    new design's "scan-then-server" fallback is cleaner — no dependency on
    command-send-time state.

  ## Purity contract

  No side effects. Reads:
    - The `%Grappa.IRC.Message{}` struct (tags + params).
    - A state subset: `own_nick`, `labels_pending`.

  See also: `Grappa.Session.Server` for the `labels_pending` map;
  `Grappa.Session.EventRouter` for delegated numeric handling.
  """

  alias Grappa.IRC.Identifier
  alias Grappa.IRC.Message

  @typedoc """
  The resolved routing destination for a numeric.

    * `{:channel, chan}` — route to the named channel's window.
    * `{:query, nick}` — route to the DM/query window for nick.
    * `{:server, nil}` — route to the `$server` synthetic window.
    * `:delegated` — numeric is owned by a dedicated handler; skip the matrix.
  """
  @type routing_decision ::
          {:channel, String.t()}
          | {:query, String.t()}
          | {:server, nil}
          | :delegated

  @typedoc """
  Window kind discriminator — mirrors the `kind:` atom in `window_ref()`.
  """
  @type window_kind :: :channel | :query | :server

  @typedoc """
  A window reference: the `kind:` discriminator + optional `target:` name.
  """
  @type window_ref :: %{kind: window_kind(), target: String.t() | nil}

  @typedoc """
  The state subset this module reads. Session.Server extracts these fields
  and passes them in to keep NumericRouter pure.

    * `own_nick` — the user's current IRC nick. Used to skip `params[0]`
      (which is always the own-nick echo) and to filter the param scan
      (a routed numeric's own-nick mention is never a destination).
    * `labels_pending` — `%{label_string => window_ref}` tracking
      labeled-response correlations. Bounded by in-flight commands.
  """
  @type router_state :: %{
          required(:own_nick) => String.t() | nil,
          required(:labels_pending) => %{String.t() => window_ref()}
        }

  # ---------------------------------------------------------------------------
  # Numeric class lookup tables (compile-time)
  # ---------------------------------------------------------------------------

  # Active deny list: numerics whose params look nick-shaped but the
  # token is NOT a routing destination — it's the rejected/offending
  # input. Always go to `{:server, nil}`. Closed set; expand deliberately.
  @active_numerics MapSet.new([
                     # 305 RPL_UNAWAY — upstream confirmed away unset
                     305,
                     # 306 RPL_NOWAWAY — upstream confirmed away set
                     306,
                     # 421 ERR_UNKNOWNCOMMAND — unknown IRC command issued
                     421,
                     # 432 ERR_ERRONEUSNICKNAME — bad nick format in /nick
                     432,
                     # 433 ERR_NICKNAMEINUSE — nick taken in /nick
                     433,
                     # 437 ERR_UNAVAILRESOURCE — nick temporarily unavailable
                     437,
                     # 461 ERR_NEEDMOREPARAMS — command missing required params
                     461
                   ])

  # Delegated numerics: already handled by dedicated EventRouter/Server
  # handlers. `:delegated` short-circuits the matrix; the caller defers.
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
  Builds a `router_state()` from its components.

  Callers (Session.Server) use this constructor rather than building the map
  literal directly — Dialyzer can verify the opaque types via the function's
  return spec, avoiding `call_without_opaque` false-positives at the
  `route/2` call site.
  """
  @spec new_router_state(String.t() | nil, %{String.t() => window_ref()}) ::
          router_state()
  def new_router_state(own_nick, labels_pending) do
    %{
      own_nick: own_nick,
      labels_pending: labels_pending
    }
  end

  @doc """
  Routes one numeric `%Message{}` to a `routing_decision()`.

  Priority: label-override > delegated > active-deny → `{:server, nil}` >
  param scan (channel-prefix → nick-shaped non-own non-host → fallback
  `{:server, nil}`).

  Delegated numerics return `:delegated` immediately — the caller must
  skip persistence; the dedicated handlers own them.

  `state` must satisfy `router_state()` — Session.Server builds this view
  from its own state before calling.
  """
  @spec route(Message.t(), router_state()) :: routing_decision()
  def route(%Message{command: {:numeric, code}} = msg, state) do
    case label_lookup(msg, state) do
      {:ok, window_ref} ->
        window_ref_to_decision(window_ref)

      :miss ->
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

  @spec param_derived_route(1..999, Message.t(), router_state()) :: routing_decision()
  defp param_derived_route(code, msg, state) do
    cond do
      MapSet.member?(@delegated_numerics, code) ->
        :delegated

      MapSet.member?(@active_numerics, code) ->
        {:server, nil}

      true ->
        scan_params(msg.params, state)
    end
  end

  # Walk the params skipping params[0] (own-nick echo) and the last element
  # (trailing human-readable text). The first channel-prefix param wins; if
  # none, the first nick-shaped non-own non-host param wins; else $server.
  @spec scan_params([term()], router_state()) :: routing_decision()
  defp scan_params(params, state) when is_list(params) do
    candidates = candidate_params(params)
    own_nick = state.own_nick

    case Enum.find(candidates, &channel_prefix?/1) do
      chan when is_binary(chan) ->
        {:channel, chan}

      nil ->
        case Enum.find(candidates, &query_candidate?(&1, own_nick)) do
          nick when is_binary(nick) -> {:query, nick}
          nil -> {:server, nil}
        end
    end
  end

  # params[0] = own-nick echo, last = trailing human-readable text. Drop both.
  # Empty / 1-elem / 2-elem param lists yield no candidates.
  @spec candidate_params([term()]) :: [term()]
  defp candidate_params([]), do: []
  defp candidate_params([_only]), do: []
  defp candidate_params([_first, _last]), do: []

  defp candidate_params([_first | rest]) do
    # rest still has the trailing element at its tail — drop it.
    Enum.drop(rest, -1)
  end

  @spec channel_prefix?(term()) :: boolean()
  defp channel_prefix?(<<c, _::binary>>) when c in [?#, ?&, ?!, ?+], do: true
  defp channel_prefix?(_), do: false

  # A token is a query-window candidate iff:
  #   * it's a syntactically valid IRC nick, AND
  #   * it isn't the own-nick echo (case-insensitive), AND
  #   * it doesn't contain a `.` (excludes server hostnames whose syntax
  #     overlaps with nicks via the [|]\\`_^{} chars but always carry dots).
  # The `.` exclusion is defensive belt-and-braces: `Identifier.valid_nick?`
  # already rejects dots via `\w` in the regex, but if the regex evolves to
  # accept dotted nicks (some IRCds allow them) this scan still excludes
  # server hostnames.
  @spec query_candidate?(term(), String.t() | nil) :: boolean()
  defp query_candidate?(token, own_nick) when is_binary(token) do
    Identifier.valid_nick?(token) and
      not String.contains?(token, ".") and
      not nick_eq?(token, own_nick)
  end

  defp query_candidate?(_, _), do: false

  @spec nick_eq?(String.t(), String.t() | nil) :: boolean()
  defp nick_eq?(_, nil), do: false
  defp nick_eq?(a, b) when is_binary(a) and is_binary(b), do: String.downcase(a) == String.downcase(b)

  @spec window_ref_to_decision(window_ref()) :: routing_decision()
  defp window_ref_to_decision(%{kind: :channel, target: target}) when is_binary(target),
    do: {:channel, target}

  defp window_ref_to_decision(%{kind: :query, target: target}) when is_binary(target),
    do: {:query, target}

  defp window_ref_to_decision(%{kind: :server, target: nil}),
    do: {:server, nil}
end
