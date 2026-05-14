defmodule Grappa.QueryWindows.Window do
  @moduledoc """
  Schema for `query_windows` — one row per (subject, network,
  target_nick) open DM window.

  Public API lives in `Grappa.QueryWindows`; callers receive `%Window{}`
  structs by type and reference the schema only via the parent context.
  The Boundary annotation on `Grappa.QueryWindows` exports this module
  so the `t()` cross-module reference resolves cleanly in published
  docs.

  ## Subject XOR

  Mirrors `Grappa.Scrollback.Message` / `Grappa.ReadCursor.Cursor`:
  exactly one of `:user_id` / `:visitor_id` is set. Enforced at three
  layers:

    * Schema-level `validate_subject_xor/1` (errors attach to the
      synthetic `:subject` key for uniform client-side rendering).
    * DB CHECK constraint `query_windows_subject_xor`.
    * Two partial unique indexes (one per subject branch) on
      `(<subject_id>, network_id, lower(target_nick))` enforcing
      per-subject case-insensitive uniqueness without polluting the
      index with NULL pairs that would otherwise collide spuriously.

  See `Grappa.QueryWindows` for the upsert / delete / list semantics.
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
          target_nick: String.t() | nil,
          opened_at: DateTime.t() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  schema "query_windows" do
    belongs_to :user, User, type: :binary_id
    belongs_to :visitor, Visitor, type: :binary_id
    belongs_to :network, Network

    field :target_nick, :string
    field :opened_at, :utc_datetime

    timestamps(type: :utc_datetime)
  end

  @doc """
  Builds an insert changeset.

  Subject XOR is required (`validate_subject_xor/1` attaches errors
  to the synthetic `:subject` key). `network_id`, `target_nick` and
  `opened_at` are required at cast time. The `assoc_constraint`s on
  `user`/`visitor`/`network` convert FK violations into changeset
  errors on the offending field instead of bubbling raw
  `Ecto.ConstraintError`s — same convention as `ReadCursor.Cursor`
  and `Scrollback.Message`.
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(window, attrs) do
    window
    |> cast(attrs, [:user_id, :visitor_id, :network_id, :target_nick, :opened_at])
    |> validate_required([:network_id, :target_nick, :opened_at])
    |> validate_length(:target_nick, min: 1)
    |> validate_subject_xor()
    |> assoc_constraint(:user)
    |> assoc_constraint(:visitor)
    |> assoc_constraint(:network)
    |> check_constraint(:subject,
      name: :query_windows_subject_xor,
      message: "user_id and visitor_id are mutually exclusive"
    )
  end

  # Mirror of `Grappa.ReadCursor.Cursor.validate_subject_xor/1`.
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
