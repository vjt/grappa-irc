defmodule Grappa.ChannelSnapshots.Snapshot do
  @moduledoc """
  Schema for `channel_snapshots` — one row per 366 RPL_ENDOFNAMES on a
  channel the session is joined to (issue 2348). Append-only.

  Exactly one of `:user_id` / `:visitor_id` is set, enforced by
  `Grappa.Subject.validate_xor/1` here and by the column-level CHECK
  `channel_snapshots_subject_xor` in the substrate.

  `channel` is the folded key (the 366's channel param is normalised at
  ingress); `nicks` are the raw display nicks; `ts` is epoch milliseconds
  on the clock `messages.server_time` uses.
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
          channel: String.t() | nil,
          ts: integer() | nil,
          nicks: [String.t()] | nil
        }

  schema "channel_snapshots" do
    belongs_to :user, User, type: :binary_id
    belongs_to :visitor, Visitor, type: :binary_id
    belongs_to :network, Network

    field :channel, :string
    field :ts, :integer
    field :nicks, {:array, :string}
  end

  @doc """
  Builds an insert changeset. Subject XOR, `network_id`, `channel`, `ts`
  and `nicks` are required; FK and CHECK violations surface as changeset
  errors rather than raw constraint exceptions.
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(snapshot, attrs) do
    snapshot
    |> cast(attrs, [:user_id, :visitor_id, :network_id, :channel, :ts, :nicks])
    |> validate_required([:network_id, :channel, :ts, :nicks])
    |> Subject.validate_xor()
    |> assoc_constraint(:user)
    |> assoc_constraint(:visitor)
    |> assoc_constraint(:network)
    |> check_constraint(:subject,
      name: :channel_snapshots_subject_xor,
      message: "user_id and visitor_id are mutually exclusive"
    )
  end
end
