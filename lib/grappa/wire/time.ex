defmodule Grappa.Wire.Time do
  @moduledoc """
  Cross-context shared helper for the canonical
  `DateTime.t() | nil → ISO-8601 String.t() | nil` projection used on
  every `*.Wire` module's timestamp fields.

  ## Why this lives outside the per-context `*.Wire` boundary

  Pre-bucket-G `iso8601_or_nil/1` lived as a private fn inside
  `Grappa.Networks.Wire`. Other Wire modules
  (`Grappa.Scrollback.Wire`, `Grappa.QueryWindows.Wire`,
  `Grappa.Session.Wire`, `Grappa.Visitors.Wire`, `Grappa.Accounts.Wire`)
  inlined `DateTime.to_iso8601/1` directly because the `nil` cases
  there were rare or absent — but every fresh nullable timestamp on
  the wire needed the same `nil`-aware shim re-implemented from
  scratch, and the per-Wire copy of the rule could drift (different
  callsites might pick `Calendar.strftime` or omit the `nil` guard).

  Bucket G U1 (codebase-review-2026-05-12) extracts the shape so the
  `nil`-aware rule is one definition with one set of contract tests.
  This is the FIRST cross-context helper inside `lib/grappa/wire/` —
  the precedent is "shared wire-shape primitives that aren't
  context-specific go here, not into a per-context Wire module."
  Future siblings might be `Grappa.Wire.Numeric` (integer<->string
  coercion at the JSON boundary) or `Grappa.Wire.Bool` (the cic
  side already enforces booleans, but new wire fields could land in
  the same shape).

  ## Why ISO-8601 strings on the wire (Architecture audit bnd-A11)

  Wire timestamps land as ISO-8601 strings, NOT raw `%DateTime{}`
  structs. Jason encodes both shapes to the same byte string, but
  the wire-shape typespec must match the post-Jason value so cic's
  TS contract (`api.ts` declares `inserted_at: string`) is honored
  at the Elixir boundary too. `nil` is preserved verbatim — only
  nullable timestamp fields (e.g.
  `connection_state_changed_at`) ever pass `nil` here.
  """

  use Boundary, top_level?: true, deps: []

  @doc """
  Renders `DateTime.t() | nil` to its canonical wire shape.

  Returns the ISO-8601 string for any `%DateTime{}`, preserving the
  precision of the input (sec or usec — driven by the schema field
  type). Returns `nil` for `nil` so callers in `*.Wire` modules can
  pass nullable schema fields straight through without a per-site
  case.

  ## Examples

      iex> Grappa.Wire.Time.iso8601_or_nil(nil)
      nil

      iex> {:ok, dt, 0} = DateTime.from_iso8601("2026-05-12T18:30:45.123456Z")
      iex> Grappa.Wire.Time.iso8601_or_nil(dt)
      "2026-05-12T18:30:45.123456Z"
  """
  @spec iso8601_or_nil(DateTime.t() | nil) :: String.t() | nil
  def iso8601_or_nil(nil), do: nil
  def iso8601_or_nil(%DateTime{} = dt), do: DateTime.to_iso8601(dt)
end
