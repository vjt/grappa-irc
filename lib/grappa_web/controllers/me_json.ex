defmodule GrappaWeb.MeJSON do
  @moduledoc """
  Phoenix view layer for `GrappaWeb.MeController`. Delegates the
  user → JSON shape to `Grappa.Accounts.Wire.user_to_json/1` so the
  serializer rules (allowlist excluding `:password_hash` + virtual
  `:password`) live in one module — see that module's moduledoc.
  """
  alias Grappa.Accounts.{User, Wire}

  @doc "Renders the `:show` action — full profile shape from `Accounts.Wire`."
  @spec show(%{user: User.t()}) :: Wire.user_json()
  def show(%{user: %User{} = user}), do: Wire.user_to_json(user)
end
