defmodule Grappa.Scrollback.Message do
  @moduledoc """
  One row of IRC scrollback.

  ## Kind enum

  `kind` is a closed-set atom backed by `Ecto.Enum` (stored as a string in
  sqlite — sqlite has no native enum type). The enum spans every IRC event
  type Phase 6's `CHATHISTORY` listener facade must replay, even though
  Phase 1 only WRITES `:privmsg` rows. The remaining kinds (`:join`,
  `:part`, `:quit`, `:nick_change`, `:mode`, `:topic`, `:kick`,
  `:notice`, `:action`) are reserved so the schema fits without
  redesign when Phase 5 wires presence-event capture. Cast-time
  validation rejects unknown values; raw SQL inserts that bypass Ecto
  are forbidden by CLAUDE.md ("Never apply DDL manually via raw SQL").

  Per CLAUDE.md "Atoms or `@type t :: literal | literal` — never
  untyped strings for closed sets."

  ## Body — nullable, validated per-kind

  `body` is canonical UTF-8 (the IRC parser converts incoming bytes at
  the boundary; CTCP `\\x01` framing is preserved verbatim per
  CLAUDE.md "wire-format rule").

  The column is nullable because not all event types carry text content:
  `:join` and `:part` and `:nick_change` and `:mode` have no body;
  `:privmsg`, `:notice`, `:action`, `:topic` do. The changeset
  enforces presence per-kind. This is a deliberate split from
  CLAUDE.md "Total consistency or nothing" — but the cases ARE
  semantically distinct: PRIVMSG with no body is a malformed message,
  while JOIN with a body is a malformed event. The validation rule
  encodes the domain truth, not an arbitrary preference.

  ## Meta — typed atom-keyed map for event-specific fields

  `meta` is a JSON map column carrying event-type-specific structured
  fields that don't fit `body` (KICK target nick, NICK_CHANGE
  new-nick, MODE arg list, etc.). The custom Ecto type
  `Grappa.Scrollback.Meta` normalizes keys to atoms via a known-key
  allowlist on `cast/1` and `load/1`, so the shape is the SAME via
  every access path (Repo.insert return, Repo.all fetch, controller
  render). See that module's moduledoc for the per-kind shape table
  and the security rationale for `String.to_existing_atom/1` over
  `String.to_atom/1`.

  Per CLAUDE.md "atoms or @type t :: literal | literal — never
  untyped strings for closed sets" — atom keys with an explicit
  allowlist is the disciplined choice over plain `:map` with string
  keys.

  Phase 1 only writes `:privmsg` rows where `meta = %{}` so the
  per-kind machinery is dormant; Phase 5+ presence-event producers
  light it up.

  ## Cross-system identifier (deferred to Phase 6)

  `server_time` is epoch milliseconds. IRC's `server-time` IRCv3 tag is
  RFC3339; the conversion happens at the parser/inserter boundary.
  Integer storage is sortable lexically and avoids TZ ambiguity in
  sqlite. The `(network_id, channel, server_time)` index makes
  per-channel paginated DESC scans cheap — Phase 6's IRCv3
  `CHATHISTORY` listener relies on this exact shape.

  Phase 6 will add a nullable `msgid` column for the IRCv3
  `message-tags` cap (CHATHISTORY uses `BEFORE/AFTER msgid=...`
  cursors). Today's monotonic auto-increment `id` covers Phase 1's
  pagination needs but isn't the cross-system identifier the listener
  facade will need; that migration is mechanical and intentionally
  deferred.

  ## Wire shape

  Wire-shape rendering lives in `Grappa.Scrollback.Wire` (separated
  from this schema module per architecture review A7 — schemas
  describe data, formatters convert between formats). Every "door"
  (REST, PubSub, Channel push, Phase 6 listener) goes through that
  module; field set is the public contract.
  """
  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.Accounts.User
  alias Grappa.IRC.Identifier
  alias Grappa.Networks.Network
  alias Grappa.Scrollback.Meta

  @kinds [
    :privmsg,
    :notice,
    :action,
    :join,
    :part,
    :quit,
    :nick_change,
    :mode,
    :topic,
    :kick
  ]

  @body_required_kinds [:privmsg, :notice, :action, :topic]

  @type kind ::
          :privmsg
          | :notice
          | :action
          | :join
          | :part
          | :quit
          | :nick_change
          | :mode
          | :topic
          | :kick

  @type t :: %__MODULE__{
          id: integer() | nil,
          user_id: Ecto.UUID.t() | nil,
          user: User.t() | Ecto.Association.NotLoaded.t() | nil,
          network_id: integer() | nil,
          network: Network.t() | Ecto.Association.NotLoaded.t() | nil,
          channel: String.t(),
          server_time: integer(),
          kind: kind() | nil,
          sender: String.t(),
          body: String.t() | nil,
          meta: Meta.t(),
          inserted_at: DateTime.t() | nil
        }

  schema "messages" do
    belongs_to :user, User, type: :binary_id
    belongs_to :network, Network
    field :channel, :string
    field :server_time, :integer
    field :kind, Ecto.Enum, values: @kinds
    field :sender, :string
    field :body, :string
    field :meta, Grappa.Scrollback.Meta, default: %{}

    timestamps(type: :utc_datetime_usec, updated_at: false)
  end

  @doc """
  Builds an insert changeset.

  Universally required: `:user_id`, `:network_id`, `:channel`,
  `:server_time`, `:kind`, `:sender`. The `:kind` field is validated
  against the `Ecto.Enum` value set at cast time.

  `:body` is required only for content-bearing kinds
  (`:privmsg`, `:notice`, `:action`, `:topic`). Presence-event kinds
  (`:join`, `:part`, etc.) accept `body: nil`. Per-kind validation
  encodes the domain truth that PRIVMSG with no body is malformed
  while JOIN with a body is malformed; see moduledoc.

  `:meta` defaults to `%{}` via the schema-level field default —
  callers may omit it for kinds that have no event-specific payload.
  """
  @spec changeset(t() | %__MODULE__{}, map()) :: Ecto.Changeset.t()
  def changeset(message, attrs) do
    message
    |> cast(attrs, [
      :user_id,
      :network_id,
      :channel,
      :server_time,
      :kind,
      :sender,
      :body,
      :meta
    ])
    |> validate_required([:user_id, :network_id, :channel, :server_time, :kind, :sender])
    |> validate_identifier(:channel, &Identifier.valid_channel?/1)
    |> validate_identifier(:sender, &Identifier.valid_sender?/1)
    |> validate_body_for_kind()
    |> assoc_constraint(:user)
    |> assoc_constraint(:network)
  end

  @spec validate_body_for_kind(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp validate_body_for_kind(changeset) do
    case get_field(changeset, :kind) do
      kind when kind in @body_required_kinds -> validate_required(changeset, [:body])
      _ -> changeset
    end
  end

  @spec validate_identifier(Ecto.Changeset.t(), atom(), (term() -> boolean())) :: Ecto.Changeset.t()
  defp validate_identifier(changeset, field, predicate) do
    validate_change(changeset, field, fn _, value ->
      if predicate.(value), do: [], else: [{field, "is not a valid IRC identifier"}]
    end)
  end
end
