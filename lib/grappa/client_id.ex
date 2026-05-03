defmodule Grappa.ClientId do
  @moduledoc """
  Custom Ecto type for `client_id` — UUID v4 canonical form.

  Storage: `:string` (sqlite TEXT). The format invariant is enforced
  at `cast/1` (incoming wire input via `Session.changeset/2`) AND at
  `load/1` (defense-in-depth on schema load — protects against any
  direct-SQL writes that bypass the changeset).

  ## Why a custom type, not a `validate_format/3`

  Single source of truth for the wire shape. The plug
  (`GrappaWeb.Plugs.ClientId`) reads `regex/0` so the boundary check
  AND the schema cast are both keyed off the same regex literal —
  drift between them is impossible.

  ## Decision E (cluster/t31-cleanup)

  Closes M-pers-1 (changeset format validation gap) and M-arch-4
  (single client_id contract). Cicchetto already emits UUID v4 only
  (S27 LANDED `clientId.ts` with `UUID_V4_REGEX` gate) — the tighter
  server-side contract just catches divergence at the boundary
  instead of trusting wire input.
  """

  use Boundary, top_level?: true, deps: []

  use Ecto.Type

  @typedoc """
  A UUID v4 string in canonical lower-case form
  (`xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx` where `y ∈ {8,9,a,b}`).
  Matched case-insensitively at cast/load — the regex carries the `i`
  flag.
  """
  @type t :: String.t()

  @uuid_v4_regex ~r/\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/i

  @impl Ecto.Type
  def type, do: :string

  @impl Ecto.Type
  def cast(nil), do: {:ok, nil}

  def cast(value) when is_binary(value) do
    if Regex.match?(@uuid_v4_regex, value), do: {:ok, value}, else: :error
  end

  def cast(_), do: :error

  @impl Ecto.Type
  def load(nil), do: {:ok, nil}

  def load(value) when is_binary(value) do
    if Regex.match?(@uuid_v4_regex, value), do: {:ok, value}, else: :error
  end

  @impl Ecto.Type
  def dump(nil), do: {:ok, nil}

  def dump(value) when is_binary(value) do
    if Regex.match?(@uuid_v4_regex, value), do: {:ok, value}, else: :error
  end

  def dump(_), do: :error

  @doc "Compile-time-accessible regex for the UUID v4 format. Used by `GrappaWeb.Plugs.ClientId`."
  @spec regex() :: Regex.t()
  def regex, do: @uuid_v4_regex
end
