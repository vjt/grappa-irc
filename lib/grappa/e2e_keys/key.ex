defmodule Grappa.E2eKeys.Key do
  @moduledoc """
  Schema for `e2e_keys` — one KEYS payload of a subject's key bundle on a
  network (issue 2430): a one-time key, handed out once, or the fallback
  key, handed out when the one-time keys run out.

  `payload` is what the client built and signed, the padded standard
  base64 of the agreed KEYS JSON; grappa frames it and never decodes it.

  Exactly one of `:user_id` / `:visitor_id` is set, enforced by
  `Grappa.Subject.validate_xor/1` and the `e2e_keys_subject_xor` CHECK,
  like every other per-subject table. Public API lives in
  `Grappa.E2eKeys`.
  """
  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.Accounts.User
  alias Grappa.IRC.E2e
  alias Grappa.Networks.Network
  alias Grappa.Subject
  alias Grappa.Visitors.Visitor

  @kinds [:otk, :fallback]

  # A KEYS payload is about 450 bytes; this leaves room for fields a later
  # payload version adds, and keeps every answer to three lines or fewer,
  # so one always fits the connection's KEYS budget
  # (`Grappa.Session.E2eKeyAnswers.bank_budget_ms/0`).
  @max_payload_bytes 1024

  @type kind :: :otk | :fallback

  @type t :: %__MODULE__{
          id: pos_integer() | nil,
          user_id: Ecto.UUID.t() | nil,
          user: User.t() | Ecto.Association.NotLoaded.t() | nil,
          visitor_id: Ecto.UUID.t() | nil,
          visitor: Visitor.t() | Ecto.Association.NotLoaded.t() | nil,
          network_id: integer() | nil,
          network: Network.t() | Ecto.Association.NotLoaded.t() | nil,
          kind: kind() | nil,
          payload: String.t() | nil,
          inserted_at: DateTime.t() | nil
        }

  schema "e2e_keys" do
    belongs_to :user, User, type: :binary_id
    belongs_to :visitor, Visitor, type: :binary_id
    belongs_to :network, Network

    field :kind, Ecto.Enum, values: @kinds
    field :payload, :string

    timestamps(type: :utc_datetime, updated_at: false)
  end

  @doc "The longest payload a key may carry, in bytes."
  @spec max_payload_bytes() :: 1024
  def max_payload_bytes, do: @max_payload_bytes

  @doc """
  Builds an insert changeset. Every field is required, and the payload
  must be base64 (`Grappa.IRC.E2e.chunk?/1`, what the framing needs) no
  longer than `max_payload_bytes/0`.
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(key, attrs) do
    key
    |> cast(attrs, [:user_id, :visitor_id, :network_id, :kind, :payload])
    |> validate_required([:network_id, :kind, :payload])
    |> validate_length(:payload, max: @max_payload_bytes, count: :bytes)
    |> validate_change(:payload, fn :payload, payload ->
      if E2e.chunk?(payload), do: [], else: [payload: "is not base64"]
    end)
    |> Subject.validate_xor()
    |> assoc_constraint(:user)
    |> assoc_constraint(:visitor)
    |> assoc_constraint(:network)
    |> check_constraint(:subject,
      name: :e2e_keys_subject_xor,
      message: "user_id and visitor_id are mutually exclusive"
    )
  end
end
