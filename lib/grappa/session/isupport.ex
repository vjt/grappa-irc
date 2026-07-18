defmodule Grappa.Session.ISupport do
  @moduledoc """
  Per-network channel-mode capability table, parsed from the upstream's
  005 RPL_ISUPPORT `CHANMODES=`, `PREFIX=`, and `STATUSMSG=` tokens.

  ## Why this exists

  Two facts about a channel mode letter are network-specific and MUST come
  from the server, not a hardcoded guess:

    1. **Does it consume an argument?** `+k secret` and `+l 42` carry a
       param; `+n`/`+t`/`+s` do not. Getting this wrong misaligns the
       argument list for every mode after it in a multi-mode line.
    2. **Is it a membership (per-user) mode?** `+o alice` / `+v bob`
       decorate a *member* (→ `@`/`+` sigils), while `+b mask` /
       `+k key` decorate the *channel*. The set of membership modes and
       their rendered sigils comes from `PREFIX=`.

  Before #216 both facts were hardcoded compile-time constants in
  `Grappa.Session.EventRouter` (`@user_mode_prefixes`,
  `@channel_modes_with_param`), flagged "deferred to Phase 5". This module
  is that Phase-5 lift: the server parses CHANMODES + PREFIX at 005 and
  every consumer — the member-map walker, the channel_modes-cache walker,
  and the cic `/mode` modal (via a broadcast) — reads ONE capability
  table. `default/0` carries the exact values the old constants held, so a
  session that never sees a 005 (or a server that omits the tokens)
  behaves identically to before.

  ## CHANMODES classes (RFC 2811 §4.3, ISUPPORT `CHANMODES=A,B,C,D`)

    * **Type A** (list modes: `b`,`e`,`I`) — always take a param (add
      AND remove).
    * **Type B** (always-param: `k`) — take a param on both `+` and `-`.
    * **Type C** (set-only-param: `l`) — take a param on `+`, none on `-`.
    * **Type D** (flag modes: `n`,`t`,`m`,`s`,`i`,`p`,…) — never take a
      param.

  Membership modes (from `PREFIX`) are handled separately: they always
  consume a param (the target nick) regardless of sign, and are excluded
  from the CHANMODES classes.

  This is a pure, stateless module — no GenServer, no Repo, no side
  effects. `Grappa.Session.Server` holds one `t()` per session on its
  state and threads it into `EventRouter` at route time.
  """

  @type chanmodes :: %{
          a: [String.t()],
          b: [String.t()],
          c: [String.t()],
          d: [String.t()]
        }

  @type prefix :: %{String.t() => String.t()}

  @typedoc """
  Advertised limit of a presence-watch mechanism (#247). `:unlimited`
  when the token carries no parseable numeric value (`MONITOR`,
  `MONITOR=`, `WATCH=abc`) — the mechanism is armed, just without a
  known cap.
  """
  @type presence_limit :: pos_integer() | :unlimited

  @typedoc """
  The presence-watch mechanism this network advertises for `/notify`
  (#247): IRCv3 `MONITOR` (solanum/Libera, OFTC), legacy `WATCH`
  (bahamut/Azzurra), or `:none`. MONITOR wins when both are advertised.
  ISON polling (the no-mechanism fallback) is out of v1 scope — a
  `:none` network simply gets no live presence.
  """
  @type presence_mechanism :: {:monitor, presence_limit()} | {:watch, presence_limit()} | :none

  @type t :: %{
          chanmodes: chanmodes(),
          prefix: prefix(),
          statusmsg: [String.t()],
          monitor: presence_limit() | nil,
          watch: presence_limit() | nil
        }

  # Pre-005 seed = the exact values the old EventRouter constants held.
  #
  # PREFIX=(ohv)@%+  — bahamut/Azzurra membership modes (o→@ op, h→%
  # halfop, v→+ voice). Matches the former @user_mode_prefixes.
  #
  # CHANMODES: the former @channel_modes_with_param MapSet was
  # `["b","e","I","k","l"]` — b/e/I list modes (type A), k always-param
  # (type B), l set-only-param (type C). Type D (flag modes) was the
  # implicit "everything else". We seed the four classes explicitly with
  # the common bahamut flag modes so `default/0` classifies a full mode
  # line correctly even before a 005 arrives.
  #
  # Classes are plain lists (not MapSets): they hold <20 single-char
  # letters, `mode in class` is trivially cheap, the shape is directly
  # JSON-encodable for the wire (no MapSet→list projection), and it stays
  # dialyzer-transparent (MapSet is opaque — a composite type embedding it
  # trips `contract_with_opaque` on the literal `default/0` return).
  @default_prefix %{"o" => "@", "h" => "%", "v" => "+"}
  @default_chanmodes %{
    a: ["b", "e", "I"],
    b: ["k"],
    c: ["l"],
    d: ["i", "m", "n", "p", "s", "t", "r", "R", "c", "C", "D", "d"]
  }

  # #218 — STATUSMSG advertises which membership PREFIX sigils may prefix a
  # message TARGET (`NOTICE @#chan` ops-only, `PRIVMSG +#chan` voice), so a
  # message can reach only members at-or-above a status level. bahamut/
  # Azzurra advertises `@+` (op + voice). Seeded so a session strips the
  # common cases before the first 005 arrives, mirroring how the prefix +
  # chanmodes seeds carry the pre-005 bahamut values.
  @default_statusmsg ["@", "+"]

  @doc """
  The pre-005 default capability table (bahamut/Azzurra values). Used as
  the initial `Session.Server` state field and as the fallback whenever a
  session state lacks an `:isupport` key (pure EventRouter unit tests).
  """
  @spec default() :: t()
  def default do
    %{
      chanmodes: @default_chanmodes,
      prefix: @default_prefix,
      statusmsg: @default_statusmsg,
      # #247 — no presence mechanism assumed pre-005: MONITOR/WATCH are
      # armed only on an explicit advertisement, never a seed guess
      # (arming WATCH against a server without it earns an ERR_UNKNOWNCOMMAND
      # per reconnect for zero signal).
      monitor: nil,
      watch: nil
    }
  end

  @doc """
  Folds the `CHANMODES=` and `PREFIX=` tokens out of a 005 RPL_ISUPPORT
  param list into `current`, returning the merged table. Tokens that are
  absent leave the corresponding part of `current` unchanged; malformed
  tokens (a CHANMODES without four comma-classes, an unbalanced PREFIX)
  are ignored so a misbehaving server can never corrupt param-arity
  classification.

  Only the first occurrence of each token is honoured (an ircd emits at
  most one per 005 line; if it repeats, the first wins).
  """
  @spec merge_isupport([String.t()], t()) :: t()
  def merge_isupport(params, current) when is_list(params) do
    Enum.reduce(params, current, &merge_token/2)
  end

  @doc """
  Whether channel mode `mode` consumes an argument when applied with
  `sign` (`:add` for `+`, `:remove` for `-`). Type A/B always; type C on
  `:add` only; type D never. Membership modes (in `PREFIX`) are NOT
  classified here — the walkers test `user_prefix/2` first and consume
  the nick param themselves.
  """
  @spec takes_param?(t(), String.t(), :add | :remove) :: boolean()
  def takes_param?(%{chanmodes: cm}, mode, sign) when is_binary(mode) do
    cond do
      mode in cm.a -> true
      mode in cm.b -> true
      mode in cm.c -> sign == :add
      true -> false
    end
  end

  @doc """
  Resolves a membership mode letter to its rendered sigil, or `:error`
  when `mode` is not a membership (per-user) mode for this network.
  Mirrors the old `Map.fetch(@user_mode_prefixes, mode)` call the walkers
  used, so the recursive parser needs no structural change beyond the
  table source.
  """
  @spec user_prefix(t(), String.t()) :: {:ok, String.t()} | :error
  def user_prefix(%{prefix: prefix}, mode) when is_binary(mode) do
    Map.fetch(prefix, mode)
  end

  @doc """
  The advertised STATUSMSG membership sigils for this network — the set a
  message target may be prefixed with to reach only members at-or-above
  that status (`@#chan` ops, `+#chan` voice). Read via `Map.get` (not
  `map.statusmsg`) so a capability table that predates the `:statusmsg`
  field — a live `Session.Server` state seeded before #218 and read after
  a hot code-reload — defaults to the bahamut set instead of raising a
  KeyError. Mirrors `Session.Server`'s
  `Map.get(state, :isupport, ISupport.default())` hot-safety; a cold
  restart reseeds the full `default/0`.
  """
  @spec statusmsg(t()) :: [String.t()]
  def statusmsg(isupport) when is_map(isupport),
    do: Map.get(isupport, :statusmsg, @default_statusmsg)

  @doc """
  The pre-005 default STATUSMSG sigils (bahamut/Azzurra `@+`). Exposed so
  callers and tests reference the seed through production code rather than
  duplicating the literal.
  """
  @spec default_statusmsg() :: [String.t()]
  def default_statusmsg, do: @default_statusmsg

  @doc """
  The presence-watch mechanism to arm for `/notify` (#247), decided
  from the captured `MONITOR=`/`WATCH=` tokens. MONITOR (the IRCv3
  push mechanism with typed numerics) wins over legacy WATCH when a
  network advertises both. `:none` when neither was advertised —
  the session arms nothing (ISON fallback is out of v1 scope).

  Reads via `Map.get` (not pattern match on the keys) for the same
  hot-reload safety as `statusmsg/1`: a live isupport table seeded
  before #247 has no `:monitor`/`:watch` keys and must not KeyError.
  """
  @spec presence_mechanism(t()) :: presence_mechanism()
  def presence_mechanism(isupport) when is_map(isupport) do
    cond do
      limit = Map.get(isupport, :monitor) -> {:monitor, limit}
      limit = Map.get(isupport, :watch) -> {:watch, limit}
      true -> :none
    end
  end

  # ---------------------------------------------------------------------------
  # Token parsing
  # ---------------------------------------------------------------------------

  @spec merge_token(String.t(), t()) :: t()
  defp merge_token("CHANMODES=" <> rest, acc) do
    case parse_chanmodes(rest) do
      {:ok, chanmodes} -> %{acc | chanmodes: chanmodes}
      :error -> acc
    end
  end

  defp merge_token("PREFIX=" <> rest, acc) do
    case parse_prefix(rest) do
      {:ok, prefix} -> %{acc | prefix: prefix}
      :error -> acc
    end
  end

  # #218 — STATUSMSG=@+ : a raw run of membership sigils that may prefix a
  # message target. `Map.put` (not `%{acc | statusmsg: ...}`) because `acc`
  # may be a table that predates the `:statusmsg` field during a hot-reload
  # window; the update-syntax would KeyError on the absent key. Mirrors
  # Session.Server's `Map.put(state, :isupport, ...)` write for the same
  # reason.
  defp merge_token("STATUSMSG=" <> rest, acc) do
    case parse_statusmsg(rest) do
      {:ok, sigils} -> Map.put(acc, :statusmsg, sigils)
      :error -> acc
    end
  end

  # #247 — MONITOR/WATCH presence-mechanism advertisements. Exact-token
  # or `=`-suffixed forms only (`WATCHFOO=1` is a different token).
  # `Map.put` (not update-syntax) for the same hot-reload-window reason
  # as STATUSMSG above.
  defp merge_token("MONITOR=" <> rest, acc), do: Map.put(acc, :monitor, parse_limit(rest))
  defp merge_token("MONITOR", acc), do: Map.put(acc, :monitor, :unlimited)
  defp merge_token("WATCH=" <> rest, acc), do: Map.put(acc, :watch, parse_limit(rest))
  defp merge_token("WATCH", acc), do: Map.put(acc, :watch, :unlimited)

  defp merge_token(_, acc), do: acc

  # A presence-mechanism limit value. Non-numeric / empty / non-positive
  # values advertise the mechanism without a usable cap → :unlimited
  # (arm it, don't reject it).
  @spec parse_limit(String.t()) :: presence_limit()
  defp parse_limit(rest) do
    case Integer.parse(rest) do
      {n, ""} when n > 0 -> n
      _ -> :unlimited
    end
  end

  # CHANMODES=A,B,C,D — four comma-separated classes of mode letters.
  # Anything other than exactly four classes is malformed (some ircds
  # advertise a 5th vendor class; we clamp to the RFC-2811 four and
  # ignore extras rather than reject, but fewer than four is a hard
  # reject — we can't know which class the missing ones belong to).
  @spec parse_chanmodes(String.t()) :: {:ok, chanmodes()} | :error
  defp parse_chanmodes(rest) do
    case String.split(rest, ",") do
      [a, b, c, d | _] ->
        {:ok,
         %{
           a: String.graphemes(a),
           b: String.graphemes(b),
           c: String.graphemes(c),
           d: String.graphemes(d)
         }}

      _ ->
        :error
    end
  end

  # PREFIX=(modes)sigils — parenthesised mode letters paired positionally
  # with the sigils that follow. `(ohv)@%+` → %{"o"=>"@","h"=>"%","v"=>"+"}.
  # The two runs MUST be equal length or the token is malformed.
  @spec parse_prefix(String.t()) :: {:ok, prefix()} | :error
  defp parse_prefix(rest) do
    with ["", tail] <- String.split(rest, "(", parts: 2),
         [modes, sigils] <- String.split(tail, ")", parts: 2),
         mode_list = String.graphemes(modes),
         sigil_list = String.graphemes(sigils),
         true <- mode_list != [] and length(mode_list) == length(sigil_list) do
      {:ok, mode_list |> Enum.zip(sigil_list) |> Map.new()}
    else
      _ -> :error
    end
  end

  # STATUSMSG=<sigils> — a bare run of membership prefix chars (`@+`,
  # `@%+`). An empty value (`STATUSMSG=`) is malformed: keep the prior set
  # rather than blanking the strip capability.
  @spec parse_statusmsg(String.t()) :: {:ok, [String.t()]} | :error
  defp parse_statusmsg(rest) do
    case String.graphemes(rest) do
      [] -> :error
      sigils -> {:ok, sigils}
    end
  end
end
