defmodule GrappaWeb.AuthJSON do
  @moduledoc """
  Phoenix view layer for `GrappaWeb.AuthController`.

  `login/1` renders the success body for `POST /auth/login` per Q-E:

      %{token, subject: %{kind: "user" | "visitor", id, ...}}

  Both subject variants delegate to their Wire module — user via
  `Grappa.Accounts.Wire.user_to_credential_json/1`, visitor via
  `Grappa.Visitors.Wire.visitor_to_credential_json/1` — so the
  redact-protected field allowlists (`:password_hash` for User,
  `:password_encrypted` for Visitor) live in one place per context.

  Login is a credential-exchange surface, not a profile lookup.
  Clients that want the full profile call `GET /me` after login.
  """
  alias Grappa.Accounts.{User, Wire}
  alias Grappa.Visitors.Visitor
  alias Grappa.Visitors.Wire, as: VisitorsWire

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
    subject =
      v
      |> VisitorsWire.visitor_to_credential_json()
      |> Map.put(:kind, "visitor")

    %{token: token, subject: subject}
  end
end
