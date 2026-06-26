defmodule Grappa.ChannelDirectory.Entry do
  @moduledoc """
  One row per `(subject, network, channel)` in a user's discovery
  snapshot of an upstream `LIST`. `captured_at` is NULL until
  `RPL_LISTEND` (323) finalises the snapshot — a snapshot counts as
  "present" only once any row for the subject+network carries a
  non-nil `captured_at`.

  Public API lives in `Grappa.ChannelDirectory`; callers receive
  `%Entry{}` structs by type and reference the schema only via the
  parent context.

  ## Subject XOR

  Mirrors `Grappa.QueryWindows.Window`: exactly one of `:user_id` /
  `:visitor_id` is set. Enforced at three layers:

    * Schema-level `validate_subject_xor/1` (errors attach to the
      synthetic `:subject` key for uniform client-side rendering).
    * DB CHECK constraint `channel_directory_subject_xor`.
    * `check_constraint/3` that converts DB violations into changeset
      errors instead of bubbling raw `Ecto.ConstraintError`s.
  """

  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.Accounts.User
  alias Grappa.Networks.Network
  alias Grappa.Visitors.Visitor

  @type t :: %__MODULE__{
          id: integer() | nil,
          user_id: Ecto.UUID.t() | nil,
          user: User.t() | Ecto.Association.NotLoaded.t() | nil,
          visitor_id: Ecto.UUID.t() | nil,
          visitor: Visitor.t() | Ecto.Association.NotLoaded.t() | nil,
          network_id: integer() | nil,
          network: Network.t() | Ecto.Association.NotLoaded.t() | nil,
          name: String.t() | nil,
          topic: String.t() | nil,
          user_count: integer() | nil,
          captured_at: DateTime.t() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  schema "channel_directory" do
    belongs_to :user, User, type: :binary_id
    belongs_to :visitor, Visitor, type: :binary_id
    belongs_to :network, Network

    field :name, :string
    field :topic, :string
    field :user_count, :integer
    field :captured_at, :utc_datetime

    timestamps(type: :utc_datetime)
  end

  @doc """
  Builds an insert/update changeset.

  Subject XOR is required (`validate_subject_xor/1` attaches errors
  to the synthetic `:subject` key). `network_id`, `name`, and
  `user_count` are required at cast time. The `assoc_constraint`s on
  `user`/`visitor`/`network` convert FK violations into changeset
  errors on the offending field instead of bubbling raw
  `Ecto.ConstraintError`s — same convention as `QueryWindows.Window`
  and `ReadCursor.Cursor`.
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(entry, attrs) do
    entry
    |> cast(attrs, [:user_id, :visitor_id, :network_id, :name, :topic, :user_count, :captured_at])
    |> validate_required([:network_id, :name, :user_count])
    |> validate_length(:name, min: 1)
    |> validate_subject_xor()
    |> assoc_constraint(:user)
    |> assoc_constraint(:visitor)
    |> assoc_constraint(:network)
    |> check_constraint(:subject,
      name: :channel_directory_subject_xor,
      message: "user_id and visitor_id are mutually exclusive"
    )
  end

  # Mirror of `Grappa.QueryWindows.Window.validate_subject_xor/1`.
  @spec validate_subject_xor(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp validate_subject_xor(changeset) do
    user_id = get_field(changeset, :user_id)
    visitor_id = get_field(changeset, :visitor_id)

    case {user_id, visitor_id} do
      {nil, nil} -> add_error(changeset, :subject, "must set user_id or visitor_id")
      {_, nil} -> changeset
      {nil, _} -> changeset
      {_, _} -> add_error(changeset, :subject, "user_id and visitor_id are mutually exclusive")
    end
  end
end
