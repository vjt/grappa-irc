defmodule Grappa.Themes.Theme do
  @moduledoc """
  A theme row — one independent full copy (KISS, #75). See
  `Grappa.Repo.Migrations.CreateThemes` for the data-model rationale and
  `Grappa.Repo.Migrations.XorFkThemes` (#299) for the subject-XOR FK shape.

  ## Subject XOR (#299)

  A theme belongs to EITHER a user OR a visitor — never both, never
  neither. Same shape as `user_settings` / `network_credentials`:
  `user_id` XOR `visitor_id`, enforced at the changeset (`validate_subject_xor/1`)
  AND at the DB (the `themes_subject_xor` CHECK). Built-in themes are
  user-owned by the reserved "system" user.

  The `payload` is always run through `Grappa.Themes.TokenModel.sanitize/1` at
  the changeset boundary, so a persisted theme can ONLY contain closed-vocabulary
  tokens — the DB never holds attacker-controlled CSS.
  """
  use Ecto.Schema

  import Ecto.Changeset

  alias Grappa.Accounts.User
  alias Grappa.Themes.TokenModel
  alias Grappa.Visitors.Visitor

  @type t :: %__MODULE__{
          id: integer() | nil,
          name: String.t() | nil,
          user_id: Ecto.UUID.t() | nil,
          user: User.t() | Ecto.Association.NotLoaded.t() | nil,
          visitor_id: Ecto.UUID.t() | nil,
          visitor: Visitor.t() | Ecto.Association.NotLoaded.t() | nil,
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
    belongs_to :user, User, type: :binary_id
    belongs_to :visitor, Visitor, type: :binary_id
    timestamps(type: :utc_datetime_usec)
  end

  @doc """
  Build a theme changeset. Casts `name`/`user_id`/`visitor_id`/`payload`/
  `published`, requires `name` + `payload`, enforces the subject XOR
  (exactly one of `user_id`/`visitor_id`), bounds the name to 1..60 chars,
  and runs `payload` through `TokenModel.sanitize/1` — an unsanitizable
  payload becomes a `:payload` error, and a valid one is REPLACED in-place
  by its canonical form.
  """
  @spec changeset(t() | %__MODULE__{}, map()) :: Ecto.Changeset.t()
  def changeset(theme, attrs) do
    theme
    |> cast(attrs, [:name, :user_id, :visitor_id, :payload, :published])
    |> validate_required([:name, :payload])
    |> validate_subject_xor()
    |> validate_length(:name, min: 1, max: 60)
    |> validate_payload()
    |> assoc_constraint(:user)
    |> assoc_constraint(:visitor)
    |> unique_constraint([:user_id, :name], name: :themes_user_id_name_index)
    |> unique_constraint([:visitor_id, :name], name: :themes_visitor_id_name_index)
    |> check_constraint(:subject,
      name: :themes_subject_xor,
      message: "user_id and visitor_id are mutually exclusive"
    )
  end

  # Mirror of `Grappa.UserSettings.Settings.validate_subject_xor/1`: exactly
  # one subject FK must be set (the DB CHECK is the substrate; this is the
  # call-site guard).
  @spec validate_subject_xor(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp validate_subject_xor(changeset) do
    user_id = get_field(changeset, :user_id)
    visitor_id = get_field(changeset, :visitor_id)

    case {user_id, visitor_id} do
      {nil, nil} -> add_error(changeset, :subject, "must set user_id or visitor_id")
      {_, nil} -> changeset
      {nil, _} -> changeset
      {_, _} -> add_error(changeset, :subject, "user_id and visitor_id are mutually exclusive")
    end
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
