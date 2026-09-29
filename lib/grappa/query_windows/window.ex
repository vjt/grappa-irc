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

    * Schema-level `Grappa.Subject.validate_xor/1` (errors attach to the
      synthetic `:subject` key for uniform client-side rendering).
    * DB CHECK constraint `query_windows_subject_xor`.
    * Two partial unique expression indexes (one per subject branch) on
      `(<subject_id>, network_id, ascii-fold(target_nick))` (GH #121/#525)
      enforcing per-subject case-insensitive uniqueness without
      polluting the index with NULL pairs that would otherwise collide
      spuriously.

  See `Grappa.QueryWindows` for the upsert / delete / list semantics.
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
          target_nick: String.t() | nil,
          opened_at: DateTime.t() | nil,
          dm_conversation_id: integer() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  schema "query_windows" do
    belongs_to :user, User, type: :binary_id
    belongs_to :visitor, Visitor, type: :binary_id
    belongs_to :network, Network

    field :target_nick, :string
    field :opened_at, :utc_datetime

    # issue 1365 leg 2 — the id of the `dm_conversations` row behind this
    # window, published on the wire beside `target_nick`. NOT a column: the
    # table has no FK to its conversation (it is dual-written beside it until
    # leg 4 retires it), so `QueryWindows.list_for_subject/1` fills it by the
    # folded nick. `nil` there means the conversation is MISSING — a
    # divergence, never a default.
    field :dm_conversation_id, :id, virtual: true

    timestamps(type: :utc_datetime)
  end

  @doc """
  Builds an insert changeset.

  Subject XOR is required (`Grappa.Subject.validate_xor/1` attaches errors
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
    |> Subject.validate_xor()
    |> assoc_constraint(:user)
    |> assoc_constraint(:visitor)
    |> assoc_constraint(:network)
    |> check_constraint(:subject,
      name: :query_windows_subject_xor,
      message: "user_id and visitor_id are mutually exclusive"
    )
  end
end
