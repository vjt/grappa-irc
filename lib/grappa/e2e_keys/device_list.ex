defmodule Grappa.E2eKeys.DeviceList do
  @moduledoc """
  Schema for `e2e_device_lists` — the signed device list of a subject on a
  network (issue 2430, multi-device; wire v2, 2430 comment 6346236542).

  `master` is the subject's master Ed25519 key, `devices` the Ed25519 keys
  of the devices it vouches for (1 to 4, sorted strictly ascending in plain
  string order), `ver` the list's version, and `sig` the master's signature
  over `signed_string/2`. Peers decide trust from it; grappa serves it and
  routes by it.

  grappa does verify `sig`, which is the one signature it checks. It is
  input validation, not trust: grappa refuses a `ver` that does not rise,
  so without the check a device that still held its bearer after being
  stolen could SILENTLY lock out the master's real revocation, with a junk
  list under the real master and a `ver` above anything the master will
  sign. The bearer's only other move, starting over under a master of its
  own (`DELETE .../e2e/keys`), is loud: every peer that pinned the real
  master sees the change.

  Exactly one of `:user_id` / `:visitor_id` is set, enforced by
  `Grappa.Subject.validate_xor/1` and the `e2e_device_lists_subject_xor`
  CHECK. Public API lives in `Grappa.E2eKeys`.
  """
  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.Accounts.User
  alias Grappa.E2eKeys.Device
  alias Grappa.Networks.Network
  alias Grappa.Subject
  alias Grappa.Visitors.Visitor

  @max_ver 2_147_483_647
  @max_devices 4

  @type t :: %__MODULE__{
          id: pos_integer() | nil,
          user_id: Ecto.UUID.t() | nil,
          user: User.t() | Ecto.Association.NotLoaded.t() | nil,
          visitor_id: Ecto.UUID.t() | nil,
          visitor: Visitor.t() | Ecto.Association.NotLoaded.t() | nil,
          network_id: integer() | nil,
          network: Network.t() | Ecto.Association.NotLoaded.t() | nil,
          master: String.t() | nil,
          ver: pos_integer() | nil,
          devices: [String.t()] | nil,
          sig: String.t() | nil,
          updated_at: DateTime.t() | nil
        }

  schema "e2e_device_lists" do
    belongs_to :user, User, type: :binary_id
    belongs_to :visitor, Visitor, type: :binary_id
    belongs_to :network, Network

    field :master, :string
    field :ver, :integer
    field :devices, {:array, :string}
    field :sig, :string

    timestamps(type: :utc_datetime, inserted_at: false)
  end

  @doc """
  Devices one subject may hold on one network, and so one list may name
  (wire v2, 2430 comment 6346236542). A message to a user carries one
  encrypted body per device, and every body costs real IRC fake lag, so
  the fan-out is bounded; peers refuse a longer list on the wire, so
  grappa refuses to store one, and `Grappa.E2eKeys` registers no more
  devices than that.
  """
  @spec max_devices() :: 4
  def max_devices, do: @max_devices

  @doc """
  The string the master signs: `"irc-e2e:v2:list:" + ver + ":" +` the
  device keys joined by `","`, `ver` in decimal. Wire v2; a plain string,
  so no JSON canonicalisation enters the signature.
  """
  @spec signed_string(pos_integer(), [String.t(), ...]) :: String.t()
  def signed_string(ver, [_ | _] = devices) when is_integer(ver),
    do: "irc-e2e:v2:list:" <> Integer.to_string(ver) <> ":" <> Enum.join(devices, ",")

  @doc """
  Builds the changeset of a list. `master` must be a key and `sig` a
  signature (`Grappa.E2eKeys.Device`), `ver` an integer in
  `1..2^31-1`, and `devices` 1 to `max_devices/0` keys, sorted strictly
  ascending, no two with the same `did`; then `sig` must verify with
  `master` over `signed_string/2`.
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(list, attrs) do
    list
    |> cast(attrs, [:user_id, :visitor_id, :network_id, :master, :ver, :devices, :sig])
    |> validate_required([:network_id, :master, :ver, :devices, :sig])
    |> validate_number(:ver, greater_than_or_equal_to: 1, less_than_or_equal_to: @max_ver)
    |> validate_change(:master, fn :master, master -> if Device.key?(master), do: [], else: [master: "is not a key"] end)
    |> validate_change(:sig, fn :sig, sig -> if Device.signature?(sig), do: [], else: [sig: "is not a signature"] end)
    |> validate_change(:devices, &validate_devices/2)
    |> validate_signature()
    |> Subject.validate_xor()
    |> assoc_constraint(:user)
    |> assoc_constraint(:visitor)
    |> assoc_constraint(:network)
    |> unique_constraint([:user_id, :network_id], error_key: :network_id)
    |> unique_constraint([:visitor_id, :network_id], error_key: :network_id)
    |> check_constraint(:subject,
      name: :e2e_device_lists_subject_xor,
      message: "user_id and visitor_id are mutually exclusive"
    )
  end

  @spec validate_devices(:devices, [String.t()]) :: Keyword.t()
  defp validate_devices(:devices, devices) do
    cond do
      devices == [] or length(devices) > @max_devices -> [devices: "must hold 1 to #{@max_devices} keys"]
      not Enum.all?(devices, &Device.key?/1) -> [devices: "holds something that is not a key"]
      not ascending?(devices) -> [devices: "is not sorted strictly ascending"]
      dids_collide?(devices) -> [devices: "holds two keys with the same did"]
      true -> []
    end
  end

  @spec ascending?([String.t()]) :: boolean()
  defp ascending?([a, b | rest]), do: a < b and ascending?([b | rest])
  defp ascending?(_), do: true

  @spec dids_collide?([String.t()]) :: boolean()
  defp dids_collide?(devices) do
    dids = Enum.map(devices, fn key -> elem(Device.did(key), 1) end)
    length(Enum.uniq(dids)) != length(dids)
  end

  # Only once every field is well formed: the signature is checked over
  # values already known to be a key, a signature and a valid list.
  @spec validate_signature(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp validate_signature(%Ecto.Changeset{valid?: false} = changeset), do: changeset

  defp validate_signature(changeset) do
    master = get_field(changeset, :master)
    sig = get_field(changeset, :sig)
    message = signed_string(get_field(changeset, :ver), get_field(changeset, :devices))

    if verify?(master, sig, message), do: changeset, else: add_error(changeset, :sig, "does not verify")
  end

  @spec verify?(String.t(), String.t(), String.t()) :: boolean()
  defp verify?(master, sig, message) do
    :crypto.verify(:eddsa, :none, message, Base.decode64!(sig, padding: false), [
      Base.decode64!(master, padding: false),
      :ed25519
    ])
  end
end
