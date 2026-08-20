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
  `:privmsg` and `:action` do, and the changeset enforces presence for
  exactly those two. `:notice` (#1500) and `:topic` (#1505) are content
  kinds whose body may legitimately be the EMPTY STRING the wire carried —
  see `@body_required_kinds`. This is a deliberate split from
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
  alias Grappa.Subject
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

  # #1500 — `:notice` is NOT here. A NOTICE with an empty trailing is legal
  # (RFC 1459 §2.3.1: `:` followed by nothing is a valid, empty last param),
  # and the empty body is itself the diagnosable event. Requiring a body
  # dropped the row AND error-logged the drop on every arrival.
  #
  # #1505 — `:topic` left too, and it is the SAME defect, not a widening.
  # `TOPIC #chan :` is how an operator CLEARS a topic; it is also the exact
  # line `IRC.Client.send_topic_clear/2` writes for our own `/topic -delete`,
  # so the drop ate our own echo. #1500 measured the server relaxation as free
  # and held it back for one reason only — the renderer had no honest arm and
  # would have printed `* alice changed topic:`, a label and a colon. That arm
  # now exists (`ScrollbackPane.tsx`'s `case "topic"` → "cleared the topic",
  # gated by `hasNoTopic`), so the two halves land together as that issue
  # required.
  #
  # `:privmsg` and `:action` stay: an empty one of those has no reported
  # arrival and no decided semantics, and widening past the measured case is
  # how a rule stops meaning anything.
  @body_required_kinds [:privmsg, :action]

  # S17 (2026-07-08 review) / #395 — the human-content kinds and their
  # unread PROJECTION, declared ONCE. Each content kind maps to whether it
  # is notify-worthy (badge/push eligible):
  #
  #   * `:notify` — a real person's message: `:privmsg` and `:action`
  #     (CTCP /me, semantically a PRIVMSG). Counts as unread AND is
  #     badge/push eligible.
  #   * `:unread` — content that counts as unread but NEVER badges/pushes.
  #     Only `:notice`: services chatter (NickServ/ChanServ/bots) is the
  #     dominant NOTICE shape; badging it would be spam. This is vjt's #395
  #     decision — unchanged behaviour, but now an explicit, single-sourced
  #     rule instead of an accident of two divergent kind lists.
  #
  # BOTH projections (`content_kinds/0`, `notify_kinds/0`) derive from THIS
  # one list, so the notify-worthy set is a SUBSET of the unread-content set
  # BY CONSTRUCTION — not because two hand-maintained lists happen to agree.
  # That accident was the #395 defect: `Grappa.Push.Triggers` carried a
  # divergent `[:privmsg, :action]` literal for its kind gate while the
  # unread path derived from `content_kinds/0` (which includes `:notice`).
  # A kind absent here (`:join`, `:part`, `:quit`, `:nick_change`, `:mode`,
  # `:topic`, `:kick`, `:server_event`) is presence/control → NEITHER
  # projection. This is the SINGLE SOURCE consumed by `Grappa.Scrollback`,
  # `Grappa.Mentions`, `Grappa.Push.Triggers`, `Grappa.Session.EventRouter`,
  # this module's `@dm_with_eligible_kinds`, and the `dm_peer/4` guard.
  # Mirrors the cic `CONTENT_KINDS` / `NOTIFY_KINDS` sets
  # (`cicchetto/src/lib/api.ts`, `cicchetto/src/lib/pushTriggers.ts`).
  @content_kind_projection [privmsg: :notify, notice: :unread, action: :notify]

  # The full unread-content subset of `@kinds`. Order is preserved from the
  # projection so it stays `[:privmsg, :notice, :action]` (the cic
  # `CONTENT_KINDS` mirror order, api.ts).
  @content_kinds for {kind, _} <- @content_kind_projection, do: kind

  # The notify-worthy subset — the kinds that raise a badge/push. Derived by
  # selecting the `:notify` rows of the projection, so it can NEVER contain a
  # kind that is absent from `@content_kinds`: badge-worthy ⊆ unread by
  # construction (#395).
  @notify_kinds for {kind, :notify} <- @content_kind_projection, do: kind

  # #458 — the presence-noise subset the scrollback fetch omits when a channel
  # is hiding presence. `:topic`, `:kick` and `:server_event` stay OUT: they are
  # control rows, not churn, and a denoised channel still shows them.
  #
  # #1262 (2026-08-13) — `:mode` is IN. It was carved out by #458 on the rule
  # "the broad presence/control kinds carry operator-relevant signal and MUST
  # stay visible"; vjt withdrew that rule. The accepted cost, recorded here so
  # nobody rediscovers it as a bug: while a channel is denoised, STRUCTURAL mode
  # transitions (`+b` / `+k` / `+l` / `+m` / `+i`) are folded along with the
  # status-prefix churn the issue was aimed at. A write-time split that folds
  # only the churn is a possible follow-up, not a precondition. Own-nick mode
  # rows (#154(b)) are untouched: they land on the synthetic `$server` window,
  # which has no member count, so `PresenceFilter.hidden?/2` resolves it to
  # SHOW. See DESIGN_NOTES 2026-08-13.
  #
  # Mirrors cic's SUPPRESSED_PRESENCE_KINDS (cicchetto/src/lib/presenceFilter.ts),
  # SAME ORDER, so the server history filter and the client live-tail
  # render-filter agree exactly on which kinds are noise — and unlike the size
  # threshold, that agreement IS gated: `presence_filter_test.exs` parses the cic
  # literal and fails on drift. Disjoint from @content_kinds BY the test
  # invariant (presence noise is never human content), so hiding presence can
  # never drop a real message.
  @suppressed_presence_kinds [:join, :part, :quit, :nick_change, :mode]

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
  three atoms. Adding a content kind is one edit to
  `@content_kind_projection`.
  """
  @spec content_kinds() :: [:privmsg | :notice | :action, ...]
  def content_kinds, do: @content_kinds

  @doc """
  Returns the notify-worthy subset of `content_kinds/0` — `[:privmsg,
  :action]`. #395 SINGLE SOURCE: the kinds that raise a badge/push.
  `Grappa.Push.Triggers`' kind gate reads THIS instead of a local
  `[:privmsg, :action]` literal, so the badge/push set can never silently
  drift from — or exceed — the unread-content set (`:notice` counts as
  unread but is deliberately absent here: services chatter never badges).
  Derived from `@content_kind_projection`, so `notify_kinds/0 --
  content_kinds/0 == []` holds by construction. Mirrors the cic
  `NOTIFY_KINDS` set (`cicchetto/src/lib/pushTriggers.ts`).
  """
  @spec notify_kinds() :: [:privmsg | :action, ...]
  def notify_kinds, do: @notify_kinds

  @doc """
  Returns the presence-noise subset of `kinds/0` —
  `[:join, :part, :quit, :nick_change, :mode]`. #458 SINGLE SOURCE: the
  scrollback fetch omits exactly these kinds when a channel is hiding presence
  (`Grappa.PresenceFilter.hidden?/2` resolves the per-channel decision).
  `:topic`, `:kick` and `:server_event` are deliberately absent — they are
  control rows rather than churn and stay visible.

  `:mode` joined the set in #1262, when vjt withdrew #458's
  "mode carries operator-relevant signal" carve-out; the accepted cost is that
  structural `+b`/`+k`/`+l`/`+m`/`+i` rows are folded too while denoised. Mirrors
  the cic `SUPPRESSED_PRESENCE_KINDS` set
  (`cicchetto/src/lib/presenceFilter.ts`); the two MUST agree, in the same
  order, so the server history filter and the client live-tail render-filter
  suppress the same rows — enforced by `presence_filter_test.exs`.
  """
  @spec suppressed_presence_kinds() :: [:join | :part | :quit | :nick_change | :mode, ...]
  def suppressed_presence_kinds, do: @suppressed_presence_kinds

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
  `Grappa.Subject.validate_xor/1`) and at the DB layer (CHECK constraint
  `messages_subject_xor`). `:network_id`, `:channel`, `:server_time`,
  `:kind`, `:sender` are universally required.

  `:body` is required only for `:privmsg` and `:action`. Presence-event
  kinds (`:join`, `:part`, etc.) accept `body: nil`, and so do the two
  content kinds whose empty body is a real wire value — `:notice` (#1500)
  and `:topic` (#1505). Per-kind validation encodes the domain truth that
  PRIVMSG with no body is malformed while JOIN with a body is malformed;
  see moduledoc.

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
    # #1500 — re-cast `:body` with `empty_values: []` so an explicit `""`
    # survives as a real change. `cast/3`'s default `empty_values: [""]` maps
    # a blank to MISSING, so a NOTICE carrying an empty trailing arrived here
    # as `nil` — which is why the drop reported `can't be blank` rather than
    # anything about emptiness. `""` is what the wire carried; `nil` would
    # assert the row has no body at all, a different fact. Same scoped-re-cast
    # idiom as `Networks.Credential`, `Networks.Server` and `Vhosts.Vhost`.
    |> cast(attrs, [:body], empty_values: [])
    |> canonicalize_channel()
    |> validate_required([:network_id, :channel, :server_time, :kind, :sender])
    |> Subject.validate_xor()
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
  #
  # #537 — folds via `canonical_target/1` (the fold at EVERY identifier
  # boundary), NOT the sigil-gated `canonical_channel/1`: the `:channel`
  # column is a WINDOW KEY that for a DM is a peer nick. The sigil gate
  # left a DM key RAW, forking one window into one row per casing while
  # reads resolved them case-insensitively (the #532-family ghost, one
  # table out). Display case is read from `dm_with`, never from this key,
  # so folding it loses nothing (vjt ruling #537: fold on every identifier).
  @spec canonicalize_channel(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp canonicalize_channel(changeset) do
    case get_change(changeset, :channel) do
      ch when is_binary(ch) -> put_change(changeset, :channel, Identifier.canonical_target(ch))
      _ -> changeset
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
