defmodule Grappa.Accounts.Passkey do
  @moduledoc "A WebAuthn credential registered to one durable account."
  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.Accounts.User

  @type t :: %__MODULE__{
          id: Ecto.UUID.t() | nil,
          user_id: Ecto.UUID.t() | nil,
          credential_id: binary() | nil,
          public_key: binary() | nil,
          sign_count: non_neg_integer(),
          name: String.t() | nil,
          transports: map(),
          last_used_at: DateTime.t() | nil
        }

  @primary_key {:id, :binary_id, autogenerate: true}
  schema "user_passkeys" do
    field :credential_id, :binary, redact: true
    field :public_key, :binary, redact: true
    field :sign_count, :integer, default: 0
    field :name, :string
    field :transports, :map, default: %{}
    field :last_used_at, :utc_datetime_usec
    belongs_to :user, User, type: :binary_id
    timestamps(type: :utc_datetime_usec)
  end

  @doc "Builds a changeset for a registered passkey."
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(passkey, attrs) do
    passkey
    |> cast(attrs, [:user_id, :credential_id, :public_key, :sign_count, :name, :transports, :last_used_at])
    |> validate_required([:user_id, :credential_id, :public_key, :name])
    |> validate_length(:name, min: 1, max: 80)
    |> validate_number(:sign_count, greater_than_or_equal_to: 0)
    |> unique_constraint(:credential_id)
    |> foreign_key_constraint(:user_id)
  end
end
