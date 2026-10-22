defmodule Grappa.E2eKeys.Key do
  @moduledoc """
  Schema for `e2e_keys` — one key of a device's bundle (issue 2430,
  multi-device): a one-time key, handed out once, or the device's fallback
  key, handed out when its one-time keys run out.

  `key` is the Curve25519 key and `sig` the device's signature over
  `"irc-e2e:v1:otk:" + key` (wire v2 keeps v1's `otk` block, 2430 comment
  6346236542). grappa checks their shape and nothing else: the peer
  verifies the signature.

  The subject and the network are the device's: a key has no subject
  columns of its own, so it cannot disagree with its device about whose it
  is, and it goes when the device does. Public API lives in
  `Grappa.E2eKeys`.
  """
  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.E2eKeys.Device

  @kinds [:otk, :fallback]

  @type kind :: :otk | :fallback

  @type t :: %__MODULE__{
          id: pos_integer() | nil,
          device_id: pos_integer() | nil,
          device: Device.t() | Ecto.Association.NotLoaded.t() | nil,
          kind: kind() | nil,
          key: String.t() | nil,
          sig: String.t() | nil,
          inserted_at: DateTime.t() | nil
        }

  schema "e2e_keys" do
    belongs_to :device, Device

    field :kind, Ecto.Enum, values: @kinds
    field :key, :string
    field :sig, :string

    timestamps(type: :utc_datetime, updated_at: false)
  end

  @doc """
  Builds an insert changeset. Every field is required; `key` must be a key
  and `sig` a signature (`Grappa.E2eKeys.Device`).
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(key, attrs) do
    key
    |> cast(attrs, [:device_id, :kind, :key, :sig])
    |> validate_required([:device_id, :kind, :key, :sig])
    |> validate_change(:key, fn :key, value -> if Device.key?(value), do: [], else: [key: "is not a key"] end)
    |> validate_change(:sig, fn :sig, value ->
      if Device.signature?(value), do: [], else: [sig: "is not a signature"]
    end)
    |> assoc_constraint(:device)
    |> unique_constraint([:device_id, :key], error_key: :key)
    |> unique_constraint(:device_id, name: :e2e_keys_device_id_index, error_key: :kind)
  end
end
