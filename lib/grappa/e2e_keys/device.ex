defmodule Grappa.E2eKeys.Device do
  @moduledoc """
  Schema for `e2e_devices` — one device of a subject on a network (issue
  2430, multi-device): the id block it publishes to peers, and the `did`
  that addresses it.

  The id block is the device's Curve25519 key, its Ed25519 key, and `sig`,
  the signature by the Ed25519 key over `"irc-e2e:v2:id:" + curve25519 +
  ":" + master` (wire v2, 2430 comment 6346236542). grappa checks only its
  shape: a peer verifies it, and grappa never decides trust.

  `did` is derived here, never taken from the client: the first 8 bytes of
  SHA-256 over the raw Ed25519 key, base64url (RFC 4648 §5) without
  padding, 11 characters. URL-safe because it travels raw in a REST path,
  where the standard alphabet's `/` would split the segment. It is a
  routing label and nothing more — a frame's `<to>` names it, and no trust
  decision rests on it.

  Exactly one of `:user_id` / `:visitor_id` is set, enforced by
  `Grappa.Subject.validate_xor/1` and the `e2e_devices_subject_xor` CHECK,
  like every other per-subject table. Public API lives in
  `Grappa.E2eKeys`.
  """
  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.Accounts.User
  alias Grappa.Networks.Network
  alias Grappa.Subject
  alias Grappa.Visitors.Visitor

  @type t :: %__MODULE__{
          id: pos_integer() | nil,
          user_id: Ecto.UUID.t() | nil,
          user: User.t() | Ecto.Association.NotLoaded.t() | nil,
          visitor_id: Ecto.UUID.t() | nil,
          visitor: Visitor.t() | Ecto.Association.NotLoaded.t() | nil,
          network_id: integer() | nil,
          network: Network.t() | Ecto.Association.NotLoaded.t() | nil,
          did: String.t() | nil,
          ed25519: String.t() | nil,
          curve25519: String.t() | nil,
          sig: String.t() | nil,
          inserted_at: DateTime.t() | nil
        }

  schema "e2e_devices" do
    belongs_to :user, User, type: :binary_id
    belongs_to :visitor, Visitor, type: :binary_id
    belongs_to :network, Network

    field :did, :string
    field :ed25519, :string
    field :curve25519, :string
    field :sig, :string

    timestamps(type: :utc_datetime, updated_at: false)
  end

  @doc """
  The `did` of an Ed25519 key, or `:error` for a string that is not a key
  (`key?/1`).
  """
  @spec did(String.t()) :: {:ok, String.t()} | :error
  def did(ed25519) when is_binary(ed25519) do
    if key?(ed25519) do
      raw = Base.decode64!(ed25519, padding: false)
      <<head::binary-size(8), _::binary>> = :crypto.hash(:sha256, raw)
      {:ok, Base.url_encode64(head, padding: false)}
    else
      :error
    end
  end

  @doc """
  True iff `value` is a 32-byte key in the canonical form vodozemac's
  `to_base64()` writes: standard base64, unpadded, 43 characters. A string
  that decodes to the same bytes but is spelled differently is refused, so
  two spellings of one key can never be two rows.
  """
  @spec key?(term()) :: boolean()
  def key?(value), do: canonical?(value, 32)

  @doc "True iff `value` is a 64-byte Ed25519 signature, standard base64, unpadded (86 characters)."
  @spec signature?(term()) :: boolean()
  def signature?(value), do: canonical?(value, 64)

  @spec canonical?(term(), 32 | 64) :: boolean()
  defp canonical?(value, size) when is_binary(value) do
    case Base.decode64(value, padding: false) do
      {:ok, raw} -> byte_size(raw) == size and Base.encode64(raw, padding: false) == value
      :error -> false
    end
  end

  defp canonical?(_, _), do: false

  @doc """
  Builds the changeset of a device. Every field is required, the two keys
  must pass `key?/1` and `sig` `signature?/1`; `did` is derived from
  `ed25519`, never cast.
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(device, attrs) do
    device
    |> cast(attrs, [:user_id, :visitor_id, :network_id, :ed25519, :curve25519, :sig])
    |> validate_required([:network_id, :ed25519, :curve25519, :sig])
    |> validate_change(:ed25519, &validate(&1, &2, key?(&2), "is not a key"))
    |> validate_change(:curve25519, &validate(&1, &2, key?(&2), "is not a key"))
    |> validate_change(:sig, &validate(&1, &2, signature?(&2), "is not a signature"))
    |> put_did()
    |> Subject.validate_xor()
    |> assoc_constraint(:user)
    |> assoc_constraint(:visitor)
    |> assoc_constraint(:network)
    |> unique_constraint([:user_id, :network_id, :did], error_key: :did)
    |> unique_constraint([:visitor_id, :network_id, :did], error_key: :did)
    |> check_constraint(:subject,
      name: :e2e_devices_subject_xor,
      message: "user_id and visitor_id are mutually exclusive"
    )
  end

  @spec validate(atom(), term(), boolean(), String.t()) :: Keyword.t()
  defp validate(_, _, true, _), do: []
  defp validate(field, _, false, message), do: [{field, message}]

  @spec put_did(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp put_did(changeset) do
    with ed25519 when is_binary(ed25519) <- get_field(changeset, :ed25519),
         {:ok, did} <- did(ed25519) do
      put_change(changeset, :did, did)
    else
      _ -> changeset
    end
  end
end
