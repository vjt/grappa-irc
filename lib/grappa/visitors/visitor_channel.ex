defmodule Grappa.Visitors.VisitorChannel do
  @moduledoc """
  Tracks a visitor's joined channels. Source of truth for
  Bootstrap-respawn rejoin list. Updated by Session.Server's join/part
  events for visitor sessions; symmetric to `Networks.Channel` for
  mode-1 users.

  W1 pin: separate from `Networks.Channel` to keep `(user, network)`
  + `(visitor, network)` lifecycles in distinct rowsets — no nullable
  cross-mode FK on `Networks.Channel`.
  """

  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.IRC.Identifier
  alias Grappa.Visitors.Visitor

  @type t :: %__MODULE__{
          id: Ecto.UUID.t() | nil,
          visitor_id: Ecto.UUID.t() | nil,
          visitor: Visitor.t() | Ecto.Association.NotLoaded.t() | nil,
          network_slug: String.t() | nil,
          name: String.t() | nil
        }

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id
  schema "visitor_channels" do
    belongs_to :visitor, Visitor

    field :network_slug, :string
    field :name, :string

    timestamps(type: :utc_datetime_usec)
  end

  @doc """
  Builds a create changeset for a visitor's joined-channel record.
  Required fields: `:visitor_id`, `:network_slug`, `:name`. Both
  `:network_slug` (`Identifier.valid_network_slug?/1`) and `:name`
  (`Identifier.valid_channel?/1`) are validated against canonical
  IRC identifier predicates — channel names go on the wire as JOIN
  arguments, so syntactic hygiene matters. Uniqueness on
  `(visitor_id, network_slug, name)` prevents duplicate JOINs.
  """
  @spec changeset(map()) :: Ecto.Changeset.t()
  def changeset(attrs) do
    %__MODULE__{}
    |> cast(attrs, [:visitor_id, :network_slug, :name])
    |> canonicalize_name()
    |> validate_required([:visitor_id, :network_slug, :name])
    |> validate_change(:network_slug, &validate_network_slug/2)
    |> validate_change(:name, &validate_channel_name/2)
    |> unique_constraint([:visitor_id, :network_slug, :name])
    |> foreign_key_constraint(:visitor_id)
  end

  # UX-4 bucket A — defense-in-depth canonicalisation at the persist
  # boundary. No `Visitors.add_autojoin/3` writer exists in `lib/`
  # today (the visitor JOIN snapshot is read-only via
  # `Visitors.list_autojoin_channels/1`; writes will land when the
  # visitor-rejoin-on-restart cluster lands a producer). Pinning the
  # rule in the changeset means the future writer — whether
  # Session.Server's JOIN persistence path or an operator mix task —
  # cannot corrupt the `(visitor_id, network_slug, name)` unique index
  # with mixed-case keys, the way bucket A pins it for
  # `Scrollback.Message`/`ReadCursor.Cursor`/`Networks.Credential`.
  defp canonicalize_name(changeset) do
    case get_change(changeset, :name) do
      ch when is_binary(ch) -> put_change(changeset, :name, Identifier.canonical_channel(ch))
      _ -> changeset
    end
  end

  defp validate_network_slug(field, value) when is_binary(value) do
    if Identifier.valid_network_slug?(value),
      do: [],
      else: [{field, "must be a valid network slug"}]
  end

  defp validate_channel_name(field, value) when is_binary(value) do
    if Identifier.valid_channel?(value),
      do: [],
      else: [{field, "must be a valid IRC channel name"}]
  end
end
