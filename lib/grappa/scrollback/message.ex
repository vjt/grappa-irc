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

  ## Meta — JSON map for event-specific fields

  `meta` is a Jason-encoded JSON map column carrying event-type-specific
  structured fields that don't fit body (KICK target nick, NICK_CHANGE
  new-nick, MODE arg list, etc.).

  Phase 1 only writes `:privmsg` rows where `meta = %{}` so the typing
  softness is unobserved. Per CLAUDE.md "atoms not untyped strings for
  closed sets," the per-kind shape SHOULD be typed via per-kind sum
  types or a `cast_meta/2` per-kind validator. Phase 1 defers this:
  no producer of non-PRIVMSG meta exists yet. When Phase 5 starts
  writing presence events, the disciplined extension is to introduce
  typed meta per kind. Documenting the gap rather than papering over.

  Expected per-kind `meta` shapes (Phase 5+ producers MUST conform):

      :privmsg | :notice | :action | :topic   →  %{}                         (body carries content)
      :join    | :part                        →  %{}                         (channel + sender suffice)
      :quit                                   →  %{}                         (body carries optional reason)
      :nick_change                            →  %{"new_nick" => String.t()}
      :mode                                   →  %{"modes" => "+o", "args" => [String.t()]}
      :kick                                   →  %{"target" => String.t()}   (body carries reason)

  ## String keys are mandatory (no atomization at boundaries)

  All `meta` keys MUST be strings at insert time. JSON serialization via
  Jason emits string-keyed maps; on fetch the column round-trips back as
  a string-keyed map. Atom-keyed input (`%{target: "alice"}`) WORKS at
  insert time because Ecto's `:map` field accepts any term, but the
  returned struct from `Repo.insert/2` keeps atom keys while a
  subsequent `Repo.all/1` fetch decodes the JSON column into string
  keys — producing different shapes via different access paths. The
  inconsistency is a footgun; the discipline that closes it is "always
  string keys, never atomize." Phase 1 producers (REST `POST` →
  `:privmsg` only) never set meta, so the rule is forward-only.

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

  `to_wire/1` is the single source of truth for the public JSON
  contract emitted by every "door" — REST controller, PubSub
  broadcasts, Phoenix Channel pushes — per CLAUDE.md "every door,
  same logic, three access methods." `GrappaWeb.MessagesJSON` (the
  Phoenix view layer) delegates its `index/1` and `show/1` render
  functions here; the controller's per-channel broadcast emits the
  same map; `Grappa.Session.Server`'s PRIVMSG handler (Task 8) does
  too. Field set is the public contract — adding fields is additive,
  removing or renaming is breaking.
  """
  use Ecto.Schema
  import Ecto.Changeset

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
          network_id: String.t(),
          channel: String.t(),
          server_time: integer(),
          kind: kind() | nil,
          sender: String.t(),
          body: String.t() | nil,
          meta: map(),
          inserted_at: DateTime.t() | nil
        }

  @type wire :: %{
          id: integer() | nil,
          network_id: String.t(),
          channel: String.t(),
          server_time: integer(),
          kind: kind() | nil,
          sender: String.t(),
          body: String.t() | nil,
          meta: map()
        }

  schema "messages" do
    field :network_id, :string
    field :channel, :string
    field :server_time, :integer
    field :kind, Ecto.Enum, values: @kinds
    field :sender, :string
    field :body, :string
    field :meta, :map, default: %{}

    timestamps(type: :utc_datetime_usec, updated_at: false)
  end

  @doc """
  Builds an insert changeset.

  Universally required: `:network_id`, `:channel`, `:server_time`,
  `:kind`, `:sender`. The `:kind` field is validated against the
  `Ecto.Enum` value set at cast time.

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
    |> cast(attrs, [:network_id, :channel, :server_time, :kind, :sender, :body, :meta])
    |> validate_required([:network_id, :channel, :server_time, :kind, :sender])
    |> validate_body_for_kind()
  end

  @doc """
  Renders this row to its public JSON-shape map — single source of
  truth for REST, PubSub, and Phoenix Channel surfaces. Per CLAUDE.md
  "every door, same wire shape."
  """
  @spec to_wire(t()) :: wire()
  def to_wire(%__MODULE__{} = m) do
    %{
      id: m.id,
      network_id: m.network_id,
      channel: m.channel,
      server_time: m.server_time,
      kind: m.kind,
      sender: m.sender,
      body: m.body,
      meta: m.meta
    }
  end

  @spec validate_body_for_kind(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp validate_body_for_kind(changeset) do
    case get_field(changeset, :kind) do
      kind when kind in @body_required_kinds -> validate_required(changeset, [:body])
      _ -> changeset
    end
  end
end
