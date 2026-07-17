defmodule Grappa.Themes.Theme do
  @moduledoc """
  A theme row — one independent full copy (KISS, #75). See
  `Grappa.Repo.Migrations.CreateThemes` for the data-model rationale.

  The `payload` is always run through `Grappa.Themes.TokenModel.sanitize/1` at
  the changeset boundary, so a persisted theme can ONLY contain closed-vocabulary
  tokens — the DB never holds attacker-controlled CSS.
  """
  use Ecto.Schema

  import Ecto.Changeset

  alias Grappa.Accounts.User
  alias Grappa.Themes.TokenModel

  @type t :: %__MODULE__{
          id: integer() | nil,
          name: String.t() | nil,
          owner_id: Ecto.UUID.t() | nil,
          owner: User.t() | Ecto.Association.NotLoaded.t() | nil,
          payload: map() | nil,
          published: boolean() | nil,
          apply_count: integer() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  schema "themes" do
    field :name, :string
    field :payload, :map
    field :published, :boolean, default: false
    field :apply_count, :integer, default: 0
    belongs_to :owner, User, type: :binary_id
    timestamps(type: :utc_datetime_usec)
  end

  @spec changeset(t() | %__MODULE__{}, map()) :: Ecto.Changeset.t()
  def changeset(theme, attrs) do
    theme
    |> cast(attrs, [:name, :owner_id, :payload, :published])
    |> validate_required([:name, :owner_id, :payload])
    |> validate_length(:name, min: 1, max: 60)
    |> validate_payload()
    |> assoc_constraint(:owner)
    |> unique_constraint([:owner_id, :name], name: :themes_owner_id_name_index)
  end

  # Sanitize-in-place: the sanitized closed-token map replaces whatever the
  # producer sent, so unknown keys/invalid values never persist. An unsanitizable
  # payload becomes a `:payload` changeset error (surfaced as validation_failed).
  defp validate_payload(changeset) do
    case get_change(changeset, :payload) do
      nil ->
        changeset

      payload ->
        case TokenModel.sanitize(payload) do
          {:ok, clean} -> put_change(changeset, :payload, clean)
          {:error, :invalid_theme} -> add_error(changeset, :payload, "is not a valid theme")
        end
    end
  end
end
