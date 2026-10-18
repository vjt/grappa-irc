defmodule Grappa.E2eInbox.Entry do
  @moduledoc """
  Schema for `e2e_inbox` — one whole end-to-end encrypted message a peer
  sent a subject on a network, waiting for a client to take it (issue
  2430).

  `payload` is the base64 the peer cut into chunks, joined and NOT
  decoded: grappa holds no key and never reads it. `sender` is the RAW
  nick, a routing hint only — the client pins the peer on its key.

  Exactly one of `:user_id` / `:visitor_id` is set, enforced by
  `Grappa.Subject.validate_xor/1` and the `e2e_inbox_subject_xor` CHECK,
  like every other per-subject table. Public API lives in
  `Grappa.E2eInbox`.
  """
  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.Accounts.User
  alias Grappa.IRC.{E2e, Identifier}
  alias Grappa.Networks.Network
  alias Grappa.Subject
  alias Grappa.Visitors.Visitor

  # The verbs a client is handed. KEYREQ is not among them: grappa answers
  # key requests itself, so one is never queued for a client.
  @verbs [:keys, :pkmsg, :msg, :nack]

  @type verb :: :keys | :pkmsg | :msg | :nack

  @type t :: %__MODULE__{
          id: pos_integer() | nil,
          user_id: Ecto.UUID.t() | nil,
          user: User.t() | Ecto.Association.NotLoaded.t() | nil,
          visitor_id: Ecto.UUID.t() | nil,
          visitor: Visitor.t() | Ecto.Association.NotLoaded.t() | nil,
          network_id: integer() | nil,
          network: Network.t() | Ecto.Association.NotLoaded.t() | nil,
          sender: String.t() | nil,
          verb: verb() | nil,
          msgid: String.t() | nil,
          payload: String.t() | nil,
          inserted_at: DateTime.t() | nil
        }

  schema "e2e_inbox" do
    belongs_to :user, User, type: :binary_id
    belongs_to :visitor, Visitor, type: :binary_id
    belongs_to :network, Network

    field :sender, :string
    field :verb, Ecto.Enum, values: @verbs
    field :msgid, :string
    field :payload, :string

    timestamps(type: :utc_datetime, updated_at: false)
  end

  @doc "The verbs an entry may carry."
  @spec verbs() :: [verb(), ...]
  def verbs, do: @verbs

  @doc """
  Builds an insert changeset. Every field is required; the sender must be
  a nick, the msgid the agreed 11-character token, and the payload no
  longer than the receiver's per-message bound.
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(entry, attrs) do
    entry
    |> cast(attrs, [:user_id, :visitor_id, :network_id, :sender, :verb, :msgid, :payload])
    |> validate_required([:network_id, :sender, :verb, :msgid, :payload])
    |> validate_change(:sender, fn :sender, nick ->
      if Identifier.valid_nick?(nick), do: [], else: [sender: "is not a nick"]
    end)
    |> validate_change(:msgid, fn :msgid, msgid ->
      if E2e.msgid?(msgid), do: [], else: [msgid: "is not a msgid"]
    end)
    |> validate_length(:payload, max: E2e.max_payload_bytes(), count: :bytes)
    |> Subject.validate_xor()
    |> assoc_constraint(:user)
    |> assoc_constraint(:visitor)
    |> assoc_constraint(:network)
    |> check_constraint(:subject,
      name: :e2e_inbox_subject_xor,
      message: "user_id and visitor_id are mutually exclusive"
    )
  end
end
