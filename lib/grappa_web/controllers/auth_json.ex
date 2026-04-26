defmodule GrappaWeb.AuthJSON do
  @moduledoc """
  Phoenix view layer for `GrappaWeb.AuthController`.

  `login/1` renders the success body for `POST /auth/login` —
  `{token, user: {id, name}}`. The user payload deliberately does
  NOT include `inserted_at` or any other field — login is a
  credential-exchange surface, not a profile lookup. Clients that
  want the full profile call `GET /me` after login.
  """
  alias Grappa.Accounts.User

  @doc "Renders the `:login` action — `{token, user: {id, name}}`."
  @spec login(%{token: String.t(), user: User.t()}) :: %{token: String.t(), user: map()}
  def login(%{token: token, user: %User{} = user}) do
    %{token: token, user: %{id: user.id, name: user.name}}
  end
end
