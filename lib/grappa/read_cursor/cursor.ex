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

    * Schema-level `validate_subject_xor/1` (errors attach to the
      synthetic `:subject` key for uniform client-side rendering).
    * DB CHECK constraint `read_cursors_subject_xor`.
    * Two partial unique indexes (one per subject branch) that
      enforce per-subject uniqueness without polluting the index with
      NULL pairs that would otherwise collide spuriously.

  ## Direction

  `last_read_message_id` is set last-write-wins by
  `Grappa.ReadCursor.set/4`. The changeset enforces the FK + subject
  XOR + non-negative id; direction is a context concern, not a
  column-level invariant.
  """

  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.Accounts.User
  alias Grappa.IRC.Identifier
  alias Grappa.Networks.Network
  alias Grappa.Scrollback.Message
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
  (`validate_subject_xor/1`) attaches to the synthetic `:subject` key.
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
    |> validate_subject_xor()
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

  # UX-4 bucket A — defense-in-depth canonicalisation. Mirrors
  # `Grappa.Scrollback.Message.changeset/2`. Nicks (DM-shape windows)
  # pass through unchanged because `Identifier.canonical_channel/1`
  # only folds sigil-prefixed channel names.
  @spec canonicalize_channel(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp canonicalize_channel(changeset) do
    case get_change(changeset, :channel) do
      ch when is_binary(ch) ->
        put_change(changeset, :channel, Identifier.canonical_channel(ch))

      _ ->
        changeset
    end
  end

  # Mirror of Scrollback.Message.validate_subject_xor/1.
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
