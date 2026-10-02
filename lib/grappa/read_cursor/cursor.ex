defmodule Grappa.ReadCursor.Cursor do
  @moduledoc """
  Schema for `read_cursors` — one row per (subject, network, channel)
  recording the operator's last-read message id.

  Public API lives in `Grappa.ReadCursor`; callers receive `%Cursor{}`
  structs by type and reference the schema only via the parent context.
  The Boundary annotation on `Grappa.ReadCursor` exports this module so
  the `t()` cross-module reference resolves cleanly in published docs.

  ## Subject XOR

  Mirrors `Grappa.Scrollback.Message`'s shape: exactly one of
  `:user_id` / `:visitor_id` is set. The XOR is enforced at three
  layers:

    * Schema-level `Grappa.Subject.validate_xor/1` (errors attach to the
      synthetic `:subject` key for uniform client-side rendering).
    * DB CHECK constraint `read_cursors_subject_xor`.
    * Two partial unique indexes (one per subject branch) that
      enforce per-subject uniqueness without polluting the index with
      NULL pairs that would otherwise collide spuriously.

  ## Direction

  `last_read_message_id` is advanced monotonically by
  `Grappa.ReadCursor.set/4` (a lower id is clamped to the current
  cursor — #233). The changeset enforces the FK + subject XOR +
  non-negative id; the advance-only direction is a context concern, not
  a column-level invariant.
  """

  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.Accounts.User
  alias Grappa.IRC.Identifier
  alias Grappa.Networks.Network
  alias Grappa.Scrollback.Message
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
          last_read_message_id: integer() | nil,
          last_read_message: Message.t() | Ecto.Association.NotLoaded.t() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  schema "read_cursors" do
    belongs_to :user, User, type: :binary_id
    belongs_to :visitor, Visitor, type: :binary_id
    belongs_to :network, Network
    belongs_to :last_read_message, Message, foreign_key: :last_read_message_id

    field :channel, :string

    timestamps(type: :utc_datetime_usec)
  end

  @doc """
  Builds an insert / update changeset.

  All five fields are required at cast time; subject XOR validation
  (`Grappa.Subject.validate_xor/1`) attaches to the synthetic `:subject` key.
  `assoc_constraint/2` on each FK converts a missing parent into a
  changeset error (mirrors `Scrollback.Message.changeset/2` +
  `QueryWindows.Window.changeset/2`).
  """
  @spec changeset(t() | %__MODULE__{}, map()) :: Ecto.Changeset.t()
  def changeset(cursor, attrs) do
    cursor
    |> cast(attrs, [:user_id, :visitor_id, :network_id, :channel, :last_read_message_id])
    |> canonicalize_channel()
    |> validate_required([:network_id, :channel, :last_read_message_id])
    |> validate_length(:channel, min: 1)
    |> Subject.validate_xor()
    |> assoc_constraint(:user)
    |> assoc_constraint(:visitor)
    |> assoc_constraint(:network)
    |> assoc_constraint(:last_read_message)
    |> unique_constraint(:channel, name: :read_cursors_user_network_channel_index)
    |> unique_constraint(:channel, name: :read_cursors_visitor_network_channel_index)
    |> check_constraint(:subject,
      name: :read_cursors_subject_xor,
      message: "user_id and visitor_id are mutually exclusive"
    )
  end

  # #532 D — defense-in-depth canonicalisation. Was `canonical_channel/1`
  # (UX-4 bucket A), which WAS a no-op for a DM-peer nick — so a
  # nick-keyed cursor stored whatever casing reached the
  # changeset, forking one DM window into one row per casing. The write
  # boundary (`ReadCursor.set/4`) now pre-folds via `canonical_target/1`;
  # this last-line-of-defence fold uses the same function so ANY writer
  # that builds this changeset directly still lands the canonical key.
  @spec canonicalize_channel(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp canonicalize_channel(changeset) do
    case get_change(changeset, :channel) do
      ch when is_binary(ch) ->
        put_change(changeset, :channel, Identifier.canonical_target(ch))

      _ ->
        changeset
    end
  end
end
