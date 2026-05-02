defmodule GrappaWeb.AuthJSON do
  @moduledoc """
  Phoenix view layer for `GrappaWeb.AuthController`.

  `login/1` renders the success body for `POST /auth/login` per Q-E:

      %{token, subject: %{kind: "user" | "visitor", id, ...}}

  The user variant delegates to
  `Grappa.Accounts.Wire.user_to_credential_json/1` so the User → JSON
  allowlist (excluding `:password_hash` + virtual `:password`) lives in
  one place. The visitor variant emits the inline shape directly —
  `Grappa.Visitors.Visitor` is fully internal to the
  `cluster/visitor-auth` work and has no separate Wire module yet.

  Login is a credential-exchange surface, not a profile lookup. Clients
  that want the full profile call `GET /me` after login.
  """
  alias Grappa.Accounts.{User, Wire}
  alias Grappa.Visitors.Visitor

  @type subject_wire ::
          %{kind: String.t(), id: Ecto.UUID.t(), name: String.t()}
          | %{
              kind: String.t(),
              id: Ecto.UUID.t(),
              nick: String.t(),
              network_slug: String.t()
            }

  @doc "Renders the `:login` action — `{token, subject}`."
  @spec login(%{
          token: String.t(),
          subject: {:user, User.t()} | {:visitor, Visitor.t()}
        }) :: %{token: String.t(), subject: subject_wire()}
  def login(%{token: token, subject: {:user, %User{} = user}}) do
    %{id: id, name: name} = Wire.user_to_credential_json(user)
    %{token: token, subject: %{kind: "user", id: id, name: name}}
  end

  def login(%{token: token, subject: {:visitor, %Visitor{} = v}}) do
    %{
      token: token,
      subject: %{
        kind: "visitor",
        id: v.id,
        nick: v.nick,
        network_slug: v.network_slug
      }
    }
  end
end
