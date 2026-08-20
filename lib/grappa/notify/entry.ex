defmodule Grappa.Notify.Entry do
  @moduledoc """
  Schema for `notify_entries` — one row per (subject, network, nick)
  presence-watch entry (GH #247).

  Public API lives in `Grappa.Notify`; callers receive `%Entry{}`
  structs by type and reference the schema only via the parent context.

  ## Subject XOR

  Mirrors `Grappa.QueryWindows.Window` / `Grappa.ReadCursor.Cursor`:
  exactly one of `:user_id` / `:visitor_id` is set. Enforced at three
  layers:

    * Schema-level `Grappa.Subject.validate_xor/1` (errors attach to the
      synthetic `:subject` key for uniform client-side rendering).
    * DB CHECK constraint `notify_entries_subject_xor`.
    * Two partial unique expression indexes (one per subject branch) on
      `(<subject_id>, network_id, ascii-fold(nick))` (GH #121/#525)
      enforcing per-subject case-insensitive uniqueness.

  The `nick` column is case-preserving (display form; first add wins).
  Presence state is NOT stored here — the live online/offline map is
  session-owned (`Grappa.Session.Server`), fed by MONITOR/WATCH
  numerics; this table is only the durable watch list that survives
  reconnects.
  """

  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.Accounts.User
  alias Grappa.IRC.Identifier
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
          nick: String.t() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  schema "notify_entries" do
    belongs_to :user, User, type: :binary_id
    belongs_to :visitor, Visitor, type: :binary_id
    belongs_to :network, Network

    field :nick, :string

    timestamps(type: :utc_datetime)
  end

  @doc """
  Builds an insert changeset.

  Subject XOR is required (`Grappa.Subject.validate_xor/1` attaches errors to
  the synthetic `:subject` key). `network_id` and `nick` are required;
  `nick` must satisfy `Grappa.IRC.Identifier.valid_nick?/1` — a watch
  entry for a channel-shaped or garbage token would silently never
  match a MONITOR/WATCH reply. The `assoc_constraint`s convert FK
  violations into changeset errors, same convention as
  `QueryWindows.Window`.
  """
  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(entry, attrs) do
    entry
    |> cast(attrs, [:user_id, :visitor_id, :network_id, :nick])
    |> validate_required([:network_id, :nick])
    |> validate_nick()
    |> Subject.validate_xor()
    |> assoc_constraint(:user)
    |> assoc_constraint(:visitor)
    |> assoc_constraint(:network)
    |> check_constraint(:subject,
      name: :notify_entries_subject_xor,
      message: "user_id and visitor_id are mutually exclusive"
    )
  end

  @spec validate_nick(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp validate_nick(changeset) do
    case get_field(changeset, :nick) do
      nil ->
        changeset

      nick ->
        if Identifier.valid_nick?(nick) do
          changeset
        else
          add_error(changeset, :nick, "is not a valid IRC nick")
        end
    end
  end
end
