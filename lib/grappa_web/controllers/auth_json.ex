defmodule GrappaWeb.AuthJSON do
  @moduledoc """
  Phoenix view layer for `GrappaWeb.AuthController`.

  `login/1` renders the success body for `POST /auth/login` per Q-E:

      %{token, subject: %{kind: "user" | "visitor", id, ...}}

  The user variant delegates to `Grappa.Accounts.Wire.user_to_credential_json/1`.
  The visitor variant delegates to
  `Grappa.Visitors.Wire.visitor_to_credential_json/2`; #211 phase 7 the
  visitor subject is `{id, registered}` (nick/ident/realname moved to the
  per-network `GET /networks` rows). `registered` is DERIVED from the
  credentials — resolved here via `Networks.Credentials.visitor_registered?/1`
  at render time (a single derivation point, no flag to drift).

  Login is a credential-exchange surface, not a profile lookup.
  Clients that want the full profile call `GET /me` after login.
  """
  alias Grappa.Accounts.{User, Wire}
  alias Grappa.Networks.Credentials
  alias Grappa.Visitors.Visitor
  alias Grappa.Visitors.Wire, as: VisitorsWire

  @type subject_wire ::
          %{kind: String.t(), id: Ecto.UUID.t(), name: String.t()}
          | %{
              kind: String.t(),
              id: Ecto.UUID.t(),
              registered: boolean()
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
      |> VisitorsWire.visitor_to_credential_json(Credentials.visitor_registered?(v.id))
      |> Map.put(:kind, "visitor")

    %{token: token, subject: subject}
  end
end
