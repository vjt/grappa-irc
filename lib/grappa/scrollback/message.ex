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

  no-silent-drops B6.11 (HIGH-7) — `:server_event` joined the enum
  for catch-all rows (KILL, WALLOPS, GLOBOPS, ERROR, CHGHOST, vendor
  verbs) that EventRouter's fallthrough persists to `$server`. Pre-fix
  these wrote `:notice + meta.raw_verb`, which leaked into any future
  filter `kind in [:privmsg, :notice, :action]` for "human content."
  `:server_event` is excluded from `@body_required_kinds` (catch-all
  body is verb-name fallback, not user-meaningful text) and excluded
  from `@dm_with_eligible_kinds` (server events are channel-scoped or
  $server-scoped, never DM peers).

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
  alias Grappa.Visitors.Visitor

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
    :kick,
    :server_event
  ]

  @body_required_kinds [:privmsg, :notice, :action, :topic]

  # S17 (2026-07-08 review) — the human-content subset of `@kinds`:
  # the kinds that carry a notification/message meaning (a real body
  # from a real sender), as opposed to presence/control events
  # (:join, :part, :quit, :nick_change, :mode, :topic, :kick,
  # :server_event). SINGLE SOURCE for the subset that was previously
  # restated verbatim across `Grappa.Scrollback`, `Grappa.Mentions`,
  # `Grappa.Session.EventRouter`, this module's `@dm_with_eligible_kinds`,
  # the `dm_peer/4` guard, and a raw-SQL `IN (...)` bucket — six copies,
  # one already reordered. Every consumer now derives from
  # `content_kinds/0` at compile time so a new content kind is one edit
  # here. Mirrors the cic `CONTENT_KINDS` set (`cicchetto/src/lib/api.ts`).
  @content_kinds [:privmsg, :notice, :action]

  # M8 fix 2026-05-08: kinds for which `:dm_with` may legitimately
  # carry a peer nick. CP23 cluster `code-reload` extended the list to
  # include :notice — peer-to-peer NOTICEs (CTCP-VERSION-query
  # visibility row, future server-emitted DM-shaped notices) are
  # content kinds, semantically equivalent to :privmsg for the
  # active/archive view-derivation. The presence-event leakage M8
  # guarded against (:join/:mode/:topic with stray dm_with) still
  # rejects — those kinds remain channel-scoped by construction.
  #
  # Inbound + outbound DM flows persist as :privmsg, :action, or
  # :notice (CTCP). Every other kind (presence events, channel mode
  # changes, topic sets) is channel-scoped and MUST have `dm_with:
  # nil`. Pinning the rule here closes the convention-not-contract
  # gap noted in audit row `persistence M8`: pre-fix the @spec
  # declared dm_with as `String.t() | nil` for every kind, but the
  # caller-side typespec was informal — a caller bug (forgetting to
  # nil dm_with on a :join row) silently contaminated the
  # active/archive view-derivation rule that depends on dm_with
  # being unique to DM rows.
  #
  # S17: the DM-eligible set IS the content subset — a DM is human
  # content; every content kind is DM-shaped and vice versa — so it
  # derives from `@content_kinds` rather than restating it (this copy
  # was the one already reordered vs the others).
  @dm_with_eligible_kinds @content_kinds

  @doc """
  Returns the closed-set list of valid `:kind` values. Exposed so
  tests can drive coverage assertions over the full enum (e.g.
  `Grappa.Session.EventRouterTest`'s A6 contract test) without
  hard-coding the list at the test site (which would drift the moment
  a new kind lands in the schema).
  """
  @spec kinds() :: [kind(), ...]
  def kinds, do: @kinds

  @doc """
  Returns the human-content subset of `kinds/0` — `[:privmsg,
  :notice, :action]`. S17 SINGLE SOURCE: every consumer that filters
  scrollback to "real message content" (notification counts, mention
  aggregation, DM-peer eligibility, the unread messages-vs-events
  split) derives from this at compile time instead of restating the
  three atoms. Adding a content kind is one edit to `@content_kinds`.
  """
  @spec content_kinds() :: [:privmsg | :notice | :action, ...]
  def content_kinds, do: @content_kinds

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
          | :server_event

  @type t :: %__MODULE__{
          id: integer() | nil,
          user_id: Ecto.UUID.t() | nil,
          user: User.t() | Ecto.Association.NotLoaded.t() | nil,
          visitor_id: Ecto.UUID.t() | nil,
          visitor: Visitor.t() | Ecto.Association.NotLoaded.t() | nil,
          network_id: integer() | nil,
          network: Network.t() | Ecto.Association.NotLoaded.t() | nil,
          channel: String.t(),
          server_time: integer(),
          kind: kind() | nil,
          sender: String.t(),
          body: String.t() | nil,
          meta: Meta.t(),
          dm_with: String.t() | nil,
          inserted_at: DateTime.t() | nil
        }

  schema "messages" do
    belongs_to :user, User, type: :binary_id
    belongs_to :visitor, Visitor, type: :binary_id
    belongs_to :network, Network
    field :channel, :string
    field :server_time, :integer
    field :kind, Ecto.Enum, values: @kinds
    field :sender, :string
    field :body, :string
    field :meta, Grappa.Scrollback.Meta, default: %{}
    # CP14 B3: normalized "DM peer" column. Populated at persist time
    # by `Grappa.Session.EventRouter.build_persist/6` when (kind ==
    # :privmsg AND target == own_nick) → dm_with = sender, OR when
    # (kind == :privmsg AND sender == own_nick AND target is nick-
    # shaped) → dm_with = target. nil otherwise (channel messages,
    # presence events). Lets `Scrollback.fetch/5` merge inbound +
    # outbound DM history in a single query, immune to own-nick
    # rotation. See migration `20260507151920_add_dm_with_to_messages`.
    field :dm_with, :string

    timestamps(type: :utc_datetime_usec, updated_at: false)
  end

  @doc """
  Builds an insert changeset.

  Exactly one of `:user_id` / `:visitor_id` is required — never both,
  never neither. The XOR constraint is enforced both here (via
  `validate_subject_xor/1`) and at the DB layer (CHECK constraint
  `messages_subject_xor`). `:network_id`, `:channel`, `:server_time`,
  `:kind`, `:sender` are universally required.

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
      :visitor_id,
      :network_id,
      :channel,
      :server_time,
      :kind,
      :sender,
      :body,
      :meta,
      :dm_with
    ])
    |> canonicalize_channel()
    |> validate_required([:network_id, :channel, :server_time, :kind, :sender])
    |> validate_subject_xor()
    |> validate_identifier(:channel, &valid_target?/1)
    |> validate_identifier(:sender, &Identifier.valid_sender?/1)
    |> validate_body_for_kind()
    |> validate_dm_with_for_kind()
    |> assoc_constraint(:user)
    |> assoc_constraint(:visitor)
    |> assoc_constraint(:network)
  end

  # UX-4 bucket A — defense-in-depth canonicalisation at the persist
  # boundary. EventRouter already canonicalises every channel-shape
  # param before clause dispatch, but the REST controllers, the
  # operator mix tasks, and any future Phase 6 listener facade also
  # produce `Grappa.Scrollback.Message` changesets — pinning the
  # rule here means a single bypass cannot corrupt the
  # `(user_id, network_id, channel, server_time)` index with mixed-
  # case keys. `dm_with` is a NICK column (display-case-meaningful)
  # so it is intentionally NOT canonicalised; the `valid_target?/1`
  # predicate keeps accepting `$server` and DM-target nicks verbatim.
  @spec canonicalize_channel(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp canonicalize_channel(changeset) do
    case get_change(changeset, :channel) do
      ch when is_binary(ch) -> put_change(changeset, :channel, Identifier.canonical_channel(ch))
      _ -> changeset
    end
  end

  # Mirror of Grappa.Accounts.Session.validate_subject_xor/1.
  #
  # Errors attach to the synthetic `:subject` key (B5.4 M-pers-2): neither
  # `user_id` nor `visitor_id` is unambiguously "wrong" in either failure
  # mode (both-nil = absence-of-either; both-set = pair-conflict), so a
  # single key keeps client-side error rendering uniform. Pre-B5.4 this
  # always attached to `:user_id`, which masked which field was the
  # unexpected addition.
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

  @spec validate_body_for_kind(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp validate_body_for_kind(changeset) do
    case get_field(changeset, :kind) do
      kind when kind in @body_required_kinds -> validate_required(changeset, [:body])
      _ -> changeset
    end
  end

  # M8 fix 2026-05-08: enforce per-kind discipline on `:dm_with`.
  # Only :privmsg and :action persist DM peer info; every other kind
  # is channel-scoped and `dm_with` MUST be nil. Without this guard,
  # a caller bug (passing a stray dm_with on a :join, :mode, :topic,
  # :nick_change, etc.) silently corrupts the active/archive
  # derivation in `Scrollback.list_archive/3` (which uses
  # `COALESCE(dm_with, channel)` to derive the per-window key).
  # Reuses `add_error/3` rather than a custom validator macro so the
  # error-shape stays uniform with the body / identifier validators.
  @spec validate_dm_with_for_kind(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp validate_dm_with_for_kind(changeset) do
    case {get_field(changeset, :kind), get_field(changeset, :dm_with)} do
      {_, nil} ->
        changeset

      {kind, _} when kind in @dm_with_eligible_kinds ->
        changeset

      {_, _} ->
        add_error(changeset, :dm_with, "may only be set on :privmsg or :action rows")
    end
  end

  @spec validate_identifier(Ecto.Changeset.t(), atom(), (term() -> boolean())) :: Ecto.Changeset.t()
  defp validate_identifier(changeset, field, predicate) do
    validate_change(changeset, field, fn _, value ->
      if predicate.(value), do: [], else: [{field, "is not a valid IRC identifier"}]
    end)
  end

  # IRC PRIVMSG accepts both channel targets (#chan, &local, etc.) and nick
  # targets for direct messages. The `:channel` column stores the PRIVMSG
  # target verbatim, so the constraint must accept both shapes (C4 fix-up).
  # BUG2 fix-up: "$server" is the Grappa-internal synthetic channel for
  # server-origin NOTICEs and MOTD lines. It is not a valid IRC channel or
  # nick — add it as an explicit third branch so EventRouter can persist
  # server-window rows without changeset rejection.
  @spec valid_target?(term()) :: boolean()
  defp valid_target?(s), do: Identifier.valid_channel?(s) or Identifier.valid_nick?(s) or s == "$server"
end
