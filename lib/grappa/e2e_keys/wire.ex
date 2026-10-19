defmodule Grappa.E2eKeys.Wire do
  @moduledoc """
  The wire shape of a subject's key bundle on a network (issue 2430), as
  the three `/networks/:network_id/e2e/keys` routes answer it: how many
  one-time keys grappa still holds to hand out, and whether it holds a
  fallback key. A client replenishes when the count runs low; the keys
  themselves never come back out over the client wire.
  """

  use Boundary, top_level?: true, deps: []

  alias Grappa.E2eKeys

  @typedoc """
  `one_time_keys`: one-time keys left to hand out. `fallback`: whether a
  fallback key is held, handed out once the one-time keys run out.
  """
  @type status :: %{one_time_keys: non_neg_integer(), fallback: boolean()}

  @doc "Projects `Grappa.E2eKeys.status/2` onto the wire."
  @spec status(E2eKeys.status()) :: status()
  def status(%{one_time_keys: count, fallback: fallback?}) when is_integer(count) and is_boolean(fallback?),
    do: %{one_time_keys: count, fallback: fallback?}
end
