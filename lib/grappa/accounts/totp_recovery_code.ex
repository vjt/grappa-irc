defmodule Grappa.Accounts.TOTPRecoveryCode do
  @moduledoc false
  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.Accounts.User

  @type t :: %__MODULE__{
          id: Ecto.UUID.t() | nil,
          code_hash: binary() | nil,
          user_id: Ecto.UUID.t() | nil,
          user: Ecto.Association.NotLoaded.t() | User.t(),
          inserted_at: DateTime.t() | nil
        }

  @primary_key {:id, :binary_id, autogenerate: true}
  # Historical module name retained for compatibility with the stacked TOTP
  # change; passkeys promote these rows to account-level recovery codes.
  schema "user_recovery_codes" do
    field :code_hash, :binary, redact: true
    belongs_to :user, User, type: :binary_id
    timestamps(type: :utc_datetime_usec, updated_at: false)
  end

  @doc "Builds a changeset for a TOTP recovery code."
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(code, attrs) do
    code
    |> cast(attrs, [:user_id, :code_hash])
    |> validate_required([:user_id, :code_hash])
    |> foreign_key_constraint(:user_id)
    |> unique_constraint([:user_id, :code_hash])
  end
end
