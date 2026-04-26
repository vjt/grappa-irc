defmodule GrappaWeb.AuthJSON do
  @moduledoc """
  Phoenix view layer for `GrappaWeb.AuthController`.

  `login/1` renders the success body for `POST /auth/login` —
  `{token, user: {id, name}}`. The user payload deliberately uses
  the minimal credential-exchange shape (no `inserted_at`, no
  other profile fields) — login is a credential-exchange surface,
  not a profile lookup. Clients that want the full profile call
  `GET /me` after login. The `User` → JSON conversion delegates to
  `Grappa.Accounts.Wire.user_to_credential_json/1` so the allowlist
  (excluding `:password_hash` + virtual `:password`) lives in one
  place — see that module's moduledoc.
  """
  alias Grappa.Accounts.{User, Wire}

  @doc "Renders the `:login` action — `{token, user: {id, name}}`."
  @spec login(%{token: String.t(), user: User.t()}) ::
          %{token: String.t(), user: Wire.credential_json()}
  def login(%{token: token, user: %User{} = user}) do
    %{token: token, user: Wire.user_to_credential_json(user)}
  end
end
