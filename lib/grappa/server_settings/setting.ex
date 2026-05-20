defmodule Grappa.ServerSettings.Setting do
  @moduledoc """
  Schema for the `server_settings` table — one row per admin-managed
  config key.

  ## Why a k/v table

  Admin-tunable server-wide settings are small, orthogonal, additive.
  An EAV column-per-setting model would mean a migration per knob;
  a typed-columns model would mean a migration per setting. The
  `(key, value :: text JSON)` shape matches the
  `Grappa.UserSettings.Settings.data` pattern (per-subject JSON blob)
  but inverted — here every key is its own row so admin-edit hits a
  single row, and missing keys collapse to typed defaults via
  `Grappa.ServerSettings` accessors.

  ## Value encoding

  `value` is stored as `:text` carrying a JSON-encoded scalar / map.
  Decode happens in the typed accessor on read. Atom-keyed Elixir
  maps round-trip via Jason: atom keys become string keys on decode,
  same invariant as UserSettings.

  ## Per-key shape validation

  NOT enforced at the schema layer (`value` is just text). Typed
  accessors on `Grappa.ServerSettings` validate per-key shape on
  PUT before encoding.
  """

  use Ecto.Schema
  import Ecto.Changeset

  @type t :: %__MODULE__{
          id: Ecto.UUID.t() | nil,
          key: String.t() | nil,
          value: String.t() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  @primary_key {:id, :binary_id, autogenerate: true}

  schema "server_settings" do
    field :key, :string
    field :value, :string

    timestamps(type: :utc_datetime_usec)
  end

  @doc """
  Insert / upsert changeset.
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(setting, attrs) do
    setting
    |> cast(attrs, [:key, :value])
    |> validate_required([:key, :value])
    |> unique_constraint(:key)
  end
end
