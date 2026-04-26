defmodule GrappaWeb.MeJSON do
  @moduledoc """
  Phoenix view layer for `GrappaWeb.MeController`.

  `show/1` returns `{id, name, inserted_at}`. `password_hash` and the
  virtual `password` field are explicitly omitted — never serialise
  credential material on the wire. `inserted_at` is an ISO8601 string;
  Phoenix's default Jason encoder formats `DateTime` that way.
  """
  alias Grappa.Accounts.User

  @doc "Renders the `:show` action — `{id, name, inserted_at}`."
  @spec show(%{user: User.t()}) :: %{id: String.t(), name: String.t(), inserted_at: DateTime.t()}
  def show(%{user: %User{} = user}) do
    %{id: user.id, name: user.name, inserted_at: user.inserted_at}
  end
end
