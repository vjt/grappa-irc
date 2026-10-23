defmodule Grappa.E2eInbox.Entry do
  @moduledoc """
  Schema for `e2e_inbox` — one whole end-to-end encrypted message a peer
  sent one device of a subject, waiting for that device to take it (issue
  2430; per device since multi-device, wire v2).

  `payload` is the compact JSON text the peer cut into chunks, joined and
  NOT parsed: grappa holds no key and never reads it. `bytes` is its size,
  derived here, so the queue's bounds are summed without reading a
  payload. `sender` is the RAW nick, a routing hint only — the client pins
  the peer on its master key. `from_did` is the sending device as the
  frame named it, or `*` on a KEYS (it describes a user, not a device).
  `own` marks a copy of a message the subject itself sent from another
  device: its `sender` is our own nick at send time, and it is not mail
  from a peer (it shares one sender bound and expires silently).

  The subject and the network are the device's: an entry has no subject
  columns of its own, and it goes when its device does. Public API lives
  in `Grappa.E2eInbox`.
  """
  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.E2eKeys.Device
  alias Grappa.IRC.{E2e, Identifier}

  # The verbs a client is handed. KEYREQ is not among them: grappa answers
  # key requests itself, so one is never queued for a client.
  @verbs [:keys, :pkmsg, :msg, :nack]

  @type verb :: :keys | :pkmsg | :msg | :nack

  @type t :: %__MODULE__{
          id: pos_integer() | nil,
          device_id: pos_integer() | nil,
          device: Device.t() | Ecto.Association.NotLoaded.t() | nil,
          sender: String.t() | nil,
          from_did: E2e.address() | nil,
          verb: verb() | nil,
          msgid: String.t() | nil,
          bytes: non_neg_integer() | nil,
          payload: String.t() | nil,
          own: boolean(),
          inserted_at: DateTime.t() | nil
        }

  schema "e2e_inbox" do
    belongs_to :device, Device

    field :sender, :string
    field :from_did, :string
    field :verb, Ecto.Enum, values: @verbs
    field :msgid, :string
    field :bytes, :integer
    field :payload, :string
    field :own, :boolean, default: false

    timestamps(type: :utc_datetime, updated_at: false)
  end

  @doc "The verbs an entry may carry."
  @spec verbs() :: [verb(), ...]
  def verbs, do: @verbs

  @doc """
  Builds an insert changeset. Every field is required; the sender must be
  a nick, `from_did` a device id or `*`, the msgid a token
  `Grappa.IRC.E2e.msgid?/1` accepts, and the payload no longer than the
  receiver's per-message bound. `bytes` is derived from the payload, never
  cast.
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(entry, attrs) do
    entry
    |> cast(attrs, [:device_id, :sender, :from_did, :verb, :msgid, :payload, :own])
    |> validate_required([:device_id, :sender, :from_did, :verb, :msgid, :payload])
    |> validate_change(:sender, fn :sender, nick ->
      if Identifier.valid_nick?(nick), do: [], else: [sender: "is not a nick"]
    end)
    |> validate_change(:from_did, fn :from_did, from ->
      if from == "*" or E2e.did?(from), do: [], else: [from_did: "is not a device id"]
    end)
    |> validate_change(:msgid, fn :msgid, msgid ->
      if E2e.msgid?(msgid), do: [], else: [msgid: "is not a msgid"]
    end)
    |> validate_length(:payload, max: E2e.max_payload_bytes(), count: :bytes)
    |> put_bytes()
    |> assoc_constraint(:device)
  end

  @spec put_bytes(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp put_bytes(changeset) do
    case fetch_change(changeset, :payload) do
      {:ok, payload} -> put_change(changeset, :bytes, byte_size(payload))
      :error -> changeset
    end
  end
end
