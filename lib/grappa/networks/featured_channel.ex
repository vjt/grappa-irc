defmodule Grappa.Networks.FeaturedChannel do
  @moduledoc """
  Operator-curated featured channel for a network (GH #85). One row =
  one one-click-join link shown read-only in cic's HomePane + as a
  `featured` label on `/list` directory rows.

  `(network_id, name)` is unique; re-adding surfaces
  `{:error, :already_exists}` via `Grappa.Networks.FeaturedChannels`.
  `name` is stored **lowercased** per the channel case-fold invariant —
  every channel-keyed table downcases (`Identifier.canonical_channel/1`),
  and the directory-label match downcases the directory entry name
  before comparing, so `#Chan`/`#chan`/`#CHAN` collapse to one row and
  match one directory entry. `enabled: false` parks a row without
  deletion (audit + history). `position` (asc) is the display-order hint.

  Mirrors `Grappa.Networks.Server` (the sibling per-network sub-resource).
  """
  use Ecto.Schema

  import Ecto.Changeset

  alias Grappa.IRC.Identifier
  alias Grappa.Networks.Network

  @type t :: %__MODULE__{
          id: integer() | nil,
          network_id: integer() | nil,
          network: Network.t() | Ecto.Association.NotLoaded.t() | nil,
          name: String.t() | nil,
          description: String.t() | nil,
          position: integer() | nil,
          enabled: boolean() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  schema "network_featured_channels" do
    belongs_to :network, Network

    field :name, :string
    field :description, :string
    field :position, :integer, default: 0
    field :enabled, :boolean, default: true

    timestamps(type: :utc_datetime_usec)
  end

  @doc """
  Create/update changeset. `name` is required, canonicalized to its
  lowercased channel form, and validated as a syntactic IRC channel;
  `(network_id, name)` uniqueness is enforced at the DB layer.
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(featured, attrs) do
    featured
    |> cast(attrs, [:network_id, :name, :description, :position, :enabled])
    |> validate_required([:network_id, :name])
    |> update_change(:name, &canonicalize_name/1)
    |> validate_channel_name()
    |> validate_length(:description, max: 255)
    |> unique_constraint([:network_id, :name],
      name: :network_featured_channels_network_id_name_index
    )
  end

  # Channel case-fold invariant — store lowercased so #Chan/#chan/#CHAN
  # collapse to one featured row and match the directory entry fold.
  @spec canonicalize_name(String.t()) :: String.t()
  defp canonicalize_name(name) when is_binary(name), do: Identifier.canonical_channel(name)

  @spec validate_channel_name(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp validate_channel_name(changeset) do
    validate_change(changeset, :name, fn :name, value ->
      if Identifier.valid_channel?(value),
        do: [],
        else: [{:name, "must be a valid IRC channel name"}]
    end)
  end
end
