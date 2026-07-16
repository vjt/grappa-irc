defmodule Grappa.Ecto.Like do
  @moduledoc """
  Builds a safe SQL `LIKE` substring pattern from arbitrary user input —
  the single source of truth for case-insensitive "contains" search across
  contexts (#257 admin subject-search; future search endpoints reuse it).

  ## Why this exists

  A raw `"%" <> input <> "%"` pattern is a footgun: `%` (any run) and `_`
  (any single char) are LIKE metacharacters, and an IRC nick legally
  contains `_` (`Grappa.IRC.Identifier.valid_nick?/1`). So an operator
  typing `foo_bar` in the subject autocomplete would silently match
  `fooXbar` too. `escape/1` neutralises the three metacharacters (`\\`
  first, so the escapes it inserts aren't themselves re-escaped) and
  callers pair it with an explicit `ESCAPE '\\'` clause in the query
  fragment.

  Extracted to a dependency-free leaf boundary (mirror of
  `Grappa.Wire.Time`) so both `Grappa.Accounts.search_users/2` and
  `Grappa.Networks.Credentials.search_visitor_credentials_by_nick/2` share
  one definition rather than copy-pasting the escape rule (CLAUDE.md
  "implement once, reuse everywhere").
  """

  use Boundary, top_level?: true, deps: []

  @doc """
  Escapes the LIKE metacharacters `%` and `_`, plus the `\\` escape
  character itself. Pair with an explicit `ESCAPE '\\'` clause in the
  query fragment.

  The `\\` → `\\\\` replacement runs FIRST so the backslashes inserted by
  the `%` / `_` replacements are not doubled a second time.
  """
  @spec escape(String.t()) :: String.t()
  def escape(input) when is_binary(input) do
    input
    |> String.replace("\\", "\\\\")
    |> String.replace("%", "\\%")
    |> String.replace("_", "\\_")
  end

  @doc """
  Wraps `escape/1` output in `%...%` for a substring ("contains") match.
  """
  @spec contains(String.t()) :: String.t()
  def contains(input) when is_binary(input), do: "%" <> escape(input) <> "%"
end
