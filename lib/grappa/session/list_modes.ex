defmodule Grappa.Session.ListModes do
  @moduledoc """
  #1251 — the type-A (list) channel modes grappa can QUERY, and the numeric
  pair each one answers on.

  A type-A mode is a LIST, not a flag: `MODE #chan <letter>` with no argument
  asks the ircd to stream the list, one numeric per entry, terminated by a
  second numeric. WHICH letters are type A is per-network 005 data
  (`ISupport.chanmodes.a`, from `CHANMODES=`), not a constant — bahamut/Azzurra
  advertises `bz` and has no `+e`/`+I` at all, while solanum advertises `eIbq`.

  ## The pair table, measured in both ircds' sources

  | mode | list | end | ircd                                              |
  |------|------|-----|---------------------------------------------------|
  | `b`  | 367  | 368 | both (bahamut `src/s_err.c:414`, solanum `include/messages.h:129`) |
  | `e`  | 348  | 349 | solanum (`:114`) — bahamut has no `+e`            |
  | `I`  | 346  | 347 | solanum (`:112`) — bahamut has no `+I`            |
  | `z`  | 728  | 729 | bahamut restrict list (`src/s_err.c:812`)         |
  | `q`  | 728  | 729 | solanum quiet list (`include/messages.h:231`)     |

  **728/729 are shared by two different letters, and that is why the letter
  travels ON THE WIRE for that pair only.** Both ircds hardcode it into the
  format string as a literal middle param — bahamut
  `":%s 728 %s %s z %s %s %lu"`, solanum `":%s 728 %s %s q %s %s %lu"` — so
  the reply itself says which list it is, and `EventRouter` reads it from
  `params` instead of assuming. The 346/348/367 rows carry no letter (their
  numeric IS the letter). The issue text's `z → 728/729` was true only for
  bahamut; reading the param covers both networks with one clause.

  ## Silent degradation

  A network may advertise a type-A letter this table does not know (`a`, `X`,
  a future letter). `queryable/1` intersects the advertised set with the table,
  so an unknown letter is simply never offered — no command, no accumulator,
  no request that can never terminate (vjt's ruling on #1251).

  Pure module: a table plus two lookups. No process, no side effects.
  """

  alias Grappa.Session.ISupport

  @typedoc """
  A single-character channel list-mode letter (`"b"`, `"e"`, `"I"`, `"z"`,
  `"q"`). Case is significant — `I` (invite exception) and `i` (invite-only,
  a type-D flag) are different modes.
  """
  @type mode :: String.t()

  @typedoc "The `{list_numeric, end_numeric}` pair a mode's entries stream on."
  @type pair :: {pos_integer(), pos_integer()}

  @pairs %{
    "b" => {367, 368},
    "e" => {348, 349},
    "I" => {346, 347},
    "z" => {728, 729},
    "q" => {728, 729}
  }

  @doc """
  The full mode → `{list, end}` numeric table. Exposed so tests (and the
  `EventRouter` numeric clauses' coverage test) drive off the production
  table rather than restating it.
  """
  @spec pairs() :: %{mode() => pair()}
  def pairs, do: @pairs

  @doc """
  Whether grappa knows the numeric pair for `mode` — i.e. whether a
  `MODE #chan <mode>` query is guaranteed to terminate. Unknown letters are
  never queried.
  """
  @spec known?(mode()) :: boolean()
  def known?(mode) when is_binary(mode), do: Map.has_key?(@pairs, mode)

  @doc """
  The list modes this network both ADVERTISES (005 `CHANMODES=` type A) and
  grappa knows a numeric pair for, in the order the network advertised them.

  This is the set the client may offer and the set `Session.Server` accepts —
  one source of truth for both doors, so cic can never offer a query the
  server would refuse.
  """
  @spec queryable(ISupport.t()) :: [mode()]
  def queryable(%{chanmodes: %{a: type_a}}) when is_list(type_a) do
    Enum.filter(type_a, &known?/1)
  end
end
