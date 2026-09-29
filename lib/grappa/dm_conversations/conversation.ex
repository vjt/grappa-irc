defmodule Grappa.DmConversations.Conversation do
  @moduledoc """
  Schema for `dm_conversations` — one row per `(subject, network, folded
  peer nick)` DM conversation (issue 1365).

  Public API lives in `Grappa.DmConversations`; callers receive
  `%Conversation{}` structs by type and never build them.

    * `peer_nick` — the RAW display spelling (nick display rule, #121). The
      KEY is `lower(peer_nick)`, on a TOTAL partial-per-subject unique
      expression index: one folded nick is one conversation, open or closed.
    * `opened_at` — non-`nil` while the query window is open (when it was
      opened), `nil` once closed. Open is STATE on the row; closing never
      deletes it.

  Subject XOR as on every sibling (`Grappa.Subject.validate_xor/1` + the
  `dm_conversations_subject_xor` CHECK).
  """

  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.Accounts.User
  alias Grappa.Networks.Network
  alias Grappa.Subject
  alias Grappa.Visitors.Visitor

  @type t :: %__MODULE__{
          id: integer() | nil,
          user_id: Ecto.UUID.t() | nil,
          user: User.t() | Ecto.Association.NotLoaded.t() | nil,
          visitor_id: Ecto.UUID.t() | nil,
          visitor: Visitor.t() | Ecto.Association.NotLoaded.t() | nil,
          network_id: integer() | nil,
          network: Network.t() | Ecto.Association.NotLoaded.t() | nil,
          peer_nick: String.t() | nil,
          opened_at: DateTime.t() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  schema "dm_conversations" do
    belongs_to :user, User, type: :binary_id
    belongs_to :visitor, Visitor, type: :binary_id
    belongs_to :network, Network

    field :peer_nick, :string
    field :opened_at, :utc_datetime

    timestamps(type: :utc_datetime)
  end

  @doc """
  Builds the insert changeset. `network_id` and `peer_nick` are required;
  `opened_at` is optional (a conversation minted by a persisted row starts
  closed, one minted by a window open starts open).
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(conversation, attrs) do
    conversation
    |> cast(attrs, [:user_id, :visitor_id, :network_id, :peer_nick, :opened_at])
    |> validate_required([:network_id, :peer_nick])
    |> validate_length(:peer_nick, min: 1)
    |> Subject.validate_xor()
    |> check_constraint(:subject,
      name: :dm_conversations_subject_xor,
      message: "user_id and visitor_id are mutually exclusive"
    )
  end
end
