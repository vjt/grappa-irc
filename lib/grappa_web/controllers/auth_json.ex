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

  @typedoc """
  The user arm of the login subject. The discriminator is the atom `:user`,
  which Jason encodes as the string `"user"` — byte-identical on the wire to
  the string literal it replaces, but a closed set the codegen can see.
  """
  @type user_subject_wire :: %{
          kind: :user,
          id: Ecto.UUID.t(),
          name: String.t()
        }

  @typedoc """
  The visitor arm of the login subject. `incognito` is declared here because
  `VisitorsWire.visitor_to_credential_json/2` has always emitted it (#363)
  while no typespec named it — as a codegen SOURCE the omission would
  generate a type that denies a field the server sends.
  """
  @type visitor_subject_wire :: %{
          kind: :visitor,
          id: Ecto.UUID.t(),
          registered: boolean(),
          incognito: boolean()
        }

  # Named arms, not an inline object union: the committed `wireTypes.ts` has
  # zero `} | {` unions, and `A | B` of aliases is a shape the generator
  # already emits (see the sibling note in `GrappaWeb.MeJSON`).
  @type subject_wire :: user_subject_wire() | visitor_subject_wire()

  @typedoc "A minted bearer and its subject — every `render(:login, …)` site in `AuthController`."
  @type login_response :: %{token: String.t(), subject: subject_wire()}

  @doc "Renders the `:login` action — `{token, subject}`."
  @spec login(%{
          token: String.t(),
          subject: {:user, User.t()} | {:visitor, Visitor.t()}
        }) :: login_response()
  def login(%{token: token, subject: {:user, %User{} = user}}) do
    %{id: id, name: name} = Wire.user_to_credential_json(user)
    %{token: token, subject: %{kind: :user, id: id, name: name}}
  end

  def login(%{token: token, subject: {:visitor, %Visitor{} = v}}) do
    subject =
      v
      |> VisitorsWire.visitor_to_credential_json(Credentials.visitor_registered?(v.id))
      |> Map.put(:kind, :visitor)

    %{token: token, subject: subject}
  end
end
