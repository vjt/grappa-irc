defmodule Grappa.Auth.Oidc.Identity do
  @moduledoc """
  One link between a local account and a subject at the configured OIDC
  provider: `(issuer, subject)` → `users.id`.

  `subject` is the `sub` claim, opaque and guaranteed by the provider to
  be stable per account — never the `email` (reassignable at any
  provider), never the `preferred_username` (the user can change it in
  the provider's UI, which would silently re-point the door at whoever
  takes the name next). Matching is on `sub` alone; everything else the
  provider sends is either verified and thrown away or stored as
  display-only.

  `label` is that display-only residue — the name the human recognises
  in the settings page. It is never read back by any decision, so a
  stale or empty label can confuse nobody but its owner.

  `issuer` is stored per row even though exactly one provider is
  configured (`Grappa.Auth.Oidc.Config`): it is half the uniqueness key,
  and the cheap insurance that a future second provider cannot silently
  collide with this one's subjects. A user may hold several rows across
  issuers but never two for the same (issuer, subject) — enforced here
  as a unique index, not in code, because a duplicate would be two
  local accounts answering for one remote identity.
  """

  @moduledoc since: "1.6.0"

  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.Accounts.User

  @type t :: %__MODULE__{
          id: Ecto.UUID.t() | nil,
          user_id: Ecto.UUID.t() | nil,
          issuer: String.t() | nil,
          subject: String.t() | nil,
          label: String.t() | nil,
          user: User.t() | Ecto.Association.NotLoaded.t() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  @primary_key {:id, :binary_id, autogenerate: true}
  schema "oidc_identities" do
    field :issuer, :string
    field :subject, :string
    field :label, :string
    belongs_to :user, User, type: :binary_id
    timestamps(type: :utc_datetime_usec)
  end

  @doc """
  Builds a changeset for a link about to be written. `subject` is
  required and length-bounded — it comes from a verified `sub` claim,
  but the claim is still provider-supplied text bound for a column
  indexed for lookup, not a licence for a 10 MB blob.
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(identity, attrs) do
    identity
    |> cast(attrs, [:user_id, :issuer, :subject, :label])
    |> validate_required([:user_id, :issuer, :subject])
    |> validate_length(:issuer, max: 255)
    |> validate_length(:subject, max: 255)
    |> validate_length(:label, max: 255)
    |> unique_constraint([:issuer, :subject])
    |> foreign_key_constraint(:user_id)
  end
end
