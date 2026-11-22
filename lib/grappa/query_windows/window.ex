defmodule Grappa.QueryWindows.Window do
  @moduledoc """
  Schema for `query_windows` — one row per (subject, network,
  target_nick) open DM window.

  Public API lives in `Grappa.QueryWindows`; callers receive `%Window{}`
  structs by type.

  ## Its own leaf boundary (issue 2201)

  `Grappa.ReadCursor.set/4` refuses a DM cursor whose window does not exist,
  so it has to ask that question, and it cannot ask the context:
  `QueryWindows.close/4` already deletes the sibling cursor, so `QueryWindows`
  depends on `ReadCursor` and the reverse edge would close a cycle. The
  schema is promoted to a top-level boundary instead — the #1398 / #1399
  rule for a consumer that needs a SCHEMA, not a context — and the one query
  both contexts ask lives here as `for_target/3`. Deps are measured from this
  module's outbound edges: `Grappa.Subject` (`validate_xor/1`,
  `subject_where/2`) and `Grappa.IRC` (the `Identifier.nick_fold/1` macro).

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

  use Boundary, top_level?: true, deps: [Grappa.IRC, Grappa.Subject]

  use Ecto.Schema
  import Ecto.Changeset
  import Ecto.Query, only: [where: 3]

  alias Grappa.Accounts.User
  alias Grappa.IRC.Identifier
  alias Grappa.Networks.Network
  alias Grappa.Subject
  alias Grappa.Visitors.Visitor

  require Identifier

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

  @doc """
  The query for `subject`'s window on `network_id` whose target folds to
  `folded` — at most one row, by the folded unique index.

  `folded` MUST already be `Identifier.canonical_target/1`-folded by the
  caller (the value side of the fold); the column side is
  `Identifier.nick_fold/1`, character-identical to the index expression, so
  the lookup stays sargable. One question, asked by `QueryWindows` (open,
  close, the post-conflict re-select) and by `ReadCursor.set/4`.
  """
  @spec for_target(Subject.t(), integer(), String.t()) :: Ecto.Query.t()
  def for_target(subject, network_id, folded)
      when is_integer(network_id) and is_binary(folded) do
    __MODULE__
    |> Subject.subject_where(subject)
    |> where([w], w.network_id == ^network_id)
    |> where([w], Identifier.nick_fold(w.target_nick) == ^folded)
  end
end
