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

  `server_time` is epoch milliseconds, and it is sampled LOCALLY: every
  producer writes `System.system_time(:millisecond)` from inside the
  owning `(subject, network)` `Session.Server`, immediately before the
  insert that mints the `id`. IRC's `server-time` IRCv3 tag is RFC3339,
  but the cap is not in the REQ set — `IRC.AuthFSM` asks for `sasl` /
  `labeled-response` only — so no upstream clock reaches this column and
  there is no RFC3339 value to convert. Converting the tag at the
  parser/inserter boundary is what Phase 6 WOULD owe if the cap were ever
  REQd; it is deferred intent, not machinery that exists.

  Read as present tense that is load-bearing in the wrong direction:
  `Grappa.Scrollback`'s `maybe_before/2` argues the `(id DESC)` seek FROM
  the two columns advancing together, so a reader who believes an
  upstream clock can land here has a documented reason to reintroduce the
  `(server_time DESC, id DESC)` sort CP29 R-2 made unservable by any
  index.

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
  alias Grappa.IRC.{E2e, Identifier}
  alias Grappa.Networks.Network
  alias Grappa.Scrollback.Meta
  alias Grappa.Subject
  alias Grappa.Typespec
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

  # issue 2693 — every kind is classified HERE, once, on every axis a consumer
  # reads, and the BUILD fails on a kind left out or a relation broken (the
  # asserts below). Before, each axis was its own hand list beside `@kinds`,
  # so a new kind was silently NOT content, NOT body-required, NOT suppressed
  # and NOT pausable — defaults nobody chose. The per-axis lists further down
  # are DERIVED from this table and keep `@kinds`' order, the order the cic and
  # shottino mirrors compare against.
  #
  # * `content` — the S17 / #395 unread projection. `:notify` counts as unread
  #   AND badges/pushes (`:privmsg`, and `:action`, CTCP /me). `:unread` counts
  #   but never badges: `:notice`, whose dominant shape is services chatter
  #   (vjt's #395 decision). `false` is presence/control, in neither. One field
  #   holds both projections, so notify ⊆ content holds by construction — two
  #   hand lists disagreeing was the #395 defect (`content_kinds/0`,
  #   `notify_kinds/0`).
  # * `body_required` — the changeset demands a body. Only `:privmsg` and
  #   `:action`: an empty one of those has no reported arrival and no decided
  #   semantics. `:notice` (#1500) and `:topic` (#1505) may carry the EMPTY
  #   trailing the wire sent (RFC 1459 §2.3.1); `TOPIC #chan :` is how a topic
  #   is CLEARED, our own `/topic -delete` echo included
  #   (`IRC.Client.send_topic_clear/2`; cic renders it in `ScrollbackPane.tsx`'s
  #   `case "topic"`). Requiring a body there dropped the row and error-logged
  #   the drop on every arrival. `:server_event`'s body is the verb-name
  #   fallback (B6.11), not user text.
  # * `suppressed` — the #458 presence noise the history fetch omits on a
  #   denoised channel; never content (asserted), so hiding presence can never
  #   drop a real message. `:mode` is in since #1262, and its structural rows
  #   are exempted per ROW by issue 2176 — see `suppressed_presence_kinds/0`,
  #   `structural_meta_key/0`, DESIGN_NOTES 2026-08-13 and the issue-2176 entry.
  # * `pausable` — the #1769 presence a paused socket may never receive. Its
  #   own column and not derived from `suppressed`, so a kind joining the
  #   suppressed set is weighed here on purpose; always ⊆ suppressed (asserted).
  #   See `pausable_presence_kinds/0`.
  @kind_class [
    privmsg: %{content: :notify, body_required: true, suppressed: false, pausable: false},
    notice: %{content: :unread, body_required: false, suppressed: false, pausable: false},
    action: %{content: :notify, body_required: true, suppressed: false, pausable: false},
    join: %{content: false, body_required: false, suppressed: true, pausable: true},
    part: %{content: false, body_required: false, suppressed: true, pausable: true},
    quit: %{content: false, body_required: false, suppressed: true, pausable: true},
    nick_change: %{content: false, body_required: false, suppressed: true, pausable: false},
    mode: %{content: false, body_required: false, suppressed: true, pausable: false},
    topic: %{content: false, body_required: false, suppressed: false, pausable: false},
    kick: %{content: false, body_required: false, suppressed: false, pausable: false},
    server_event: %{content: false, body_required: false, suppressed: false, pausable: false}
  ]

  # issue 2693 — totality and today's set relations, checked by the BUILD.
  # ORDER is part of the first check: `@kinds`' order is the generated
  # `SCROLLBACK_MESSAGE_KIND` order and shottino's `MESSAGE_KIND_NAMES` index
  # order, so the table may not quietly reorder it.
  if Keyword.keys(@kind_class) != @kinds do
    raise "Grappa.Scrollback.Message: @kind_class must classify exactly @kinds, " <>
            "in the same order — expected #{inspect(@kinds)}, got #{inspect(Keyword.keys(@kind_class))}"
  end

  @kind_axes [:body_required, :content, :pausable, :suppressed]

  for {kind, class} <- @kind_class do
    violation =
      cond do
        Enum.sort(Map.keys(class)) != @kind_axes ->
          "must carry exactly the axes #{inspect(@kind_axes)}, got #{inspect(Enum.sort(Map.keys(class)))}"

        class.content not in [:notify, :unread, false] ->
          "has content #{inspect(class.content)}; the closed set is :notify | :unread | false"

        not (is_boolean(class.body_required) and is_boolean(class.suppressed) and is_boolean(class.pausable)) ->
          "has a non-boolean body_required / suppressed / pausable"

        class.content != false and class.suppressed ->
          "is content AND suppressed — hiding presence would drop a real message"

        class.pausable and not class.suppressed ->
          "is pausable but not suppressed — pausable must be a subset of suppressed"

        true ->
          nil
      end

    if violation, do: raise("Grappa.Scrollback.Message @kind_class: #{inspect(kind)} #{violation}")
  end

  # The per-axis projections of `@kind_class`. Each keeps `@kinds`' order.
  @body_required_kinds for {kind, %{body_required: true}} <- @kind_class, do: kind

  # The content kinds with their unread projection — the server twin of cic's
  # `CONTENT_KIND_PROJECTION` (`cicchetto/src/lib/api.ts`).
  @content_kind_projection for {kind, %{content: content}} <- @kind_class, content != false, do: {kind, content}

  # The unread-content kinds, in the cic `CONTENT_KINDS` mirror order (api.ts).
  @content_kinds for {kind, _} <- @content_kind_projection, do: kind

  # The notify-worthy kinds, the ones that raise a badge/push. Selected from the
  # projection, so badge-worthy ⊆ unread holds by construction (#395).
  @notify_kinds for {kind, :notify} <- @content_kind_projection, do: kind

  @suppressed_presence_kinds for {kind, %{suppressed: true}} <- @kind_class, do: kind

  @pausable_presence_kinds for {kind, %{pausable: true}} <- @kind_class, do: kind

  # issue 2176 — the per-ROW exemption from `@suppressed_presence_kinds`. See
  # `structural_meta_key/0`.
  @structural_meta_key :structural

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

  # The `validate_dm_with_for_kind/1` error names the eligible kinds from the
  # set itself. Its hand-written ":privmsg or :action" went stale the day
  # `:notice` became eligible (CP23) and stayed stale.
  @dm_with_error "may only be set on " <> Enum.map_join(@dm_with_eligible_kinds, ", ", &inspect/1) <> " rows"

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
  Returns the human-content subset of `kinds/0` — `#{inspect(@content_kinds)}`.
  S17 SINGLE SOURCE: every consumer that filters
  scrollback to "real message content" (notification counts, mention
  aggregation, DM-peer eligibility, the unread messages-vs-events
  split) derives from this at compile time instead of restating them.
  Adding a content kind starts at its `@kind_class` row and is not one
  edit: the partial index `messages_away_window_user_idx` is built on
  this list (`Grappa.Mentions.away_window_kind_sql/0`), so it also takes
  a migration rebuilding that index, and `MentionsTest` is red by name
  until it lands.
  """
  @spec content_kinds() :: [unquote(Typespec.union(@content_kinds)), ...]
  def content_kinds, do: @content_kinds

  @doc """
  Returns the notify-worthy subset of `content_kinds/0` — `#{inspect(@notify_kinds)}`.
  #395 SINGLE SOURCE: the kinds that raise a badge/push.
  `Grappa.Push.Triggers`' kind gate reads THIS instead of a local
  `[:privmsg, :action]` literal, so the badge/push set can never silently
  drift from — or exceed — the unread-content set (`:notice` counts as
  unread but is deliberately absent here: services chatter never badges).
  Derived from `@content_kind_projection`, so `notify_kinds/0 --
  content_kinds/0 == []` holds by construction. Mirrors the cic
  `NOTIFY_KINDS` set (`cicchetto/src/lib/pushTriggers.ts`).
  """
  @spec notify_kinds() :: [unquote(Typespec.union(@notify_kinds)), ...]
  def notify_kinds, do: @notify_kinds

  @doc """
  Returns the presence-noise subset of `kinds/0` —
  `#{inspect(@suppressed_presence_kinds)}`. #458 SINGLE SOURCE: the
  scrollback fetch omits exactly these kinds when a channel is hiding presence
  (`Grappa.PresenceFilter.hidden?/2` resolves the per-channel decision).
  `:topic`, `:kick` and `:server_event` are deliberately absent — they are
  control rows rather than churn and stay visible.

  `:mode` joined the set in #1262, when vjt withdrew #458's
  "mode carries operator-relevant signal" carve-out. Its accepted cost — a
  structural `+b`/`+k`/`+l`/`+m`/`+i` folded along with the churn — is paid off
  by issue 2176 NOT by taking the kind back out, but by the per-row exemption
  `structural_meta_key/0`: a mode row the server tagged structural is exempt
  even though its KIND is in this set. Read the two together; this list alone
  no longer answers "will this row be folded?". Mirrors
  the cic `SUPPRESSED_PRESENCE_KINDS` set
  (`cicchetto/src/lib/presenceFilter.ts`); the two MUST agree, in the same
  order, so the server history filter and the client live-tail render-filter
  suppress the same rows — enforced by `presence_filter_test.exs`.
  """
  @spec suppressed_presence_kinds() :: [unquote(Typespec.union(@suppressed_presence_kinds)), ...]
  def suppressed_presence_kinds, do: @suppressed_presence_kinds

  @doc """
  Returns the droppable subset of `suppressed_presence_kinds/0` —
  `#{inspect(@pausable_presence_kinds)}`. #1769 SINGLE SOURCE: the kinds
  `GrappaWeb.GrappaChannel` refuses to push to a socket that joined a
  per-channel topic with `presence: false`, the server half of #1680's
  pause.

  The two presence sets are deliberately distinct rather than one derived
  from the other. `suppressed_presence_kinds/0` answers "is this presence?"
  and governs what the HISTORY fetch omits — a row the operator can always
  scroll back to. This one answers "is this presence the client can afford
  never to be told about?", and a kind that says no has a consumer that
  breaks silently without it: `nick_change` keeps a paused socket's own-nick
  cache current (`GrappaChannel.track_own_nick/2`; the #372/#373 client
  identity migration it was first carved out for went with issue 1365),
  `mode` feeds channel-mode state that outlives the pause. Their only consumer being the members map is what makes
  join/part/quit safe to drop — the refetch on resume rebuilds exactly that.

  Mirrors cic's `PAUSABLE_PRESENCE_KINDS`
  (`cicchetto/src/lib/presencePause.ts`), same order; `presence_filter_test.exs`
  gates both the subset relation and the cross-language agreement.
  """
  @spec pausable_presence_kinds() :: [unquote(Typespec.union(@pausable_presence_kinds)), ...]
  def pausable_presence_kinds, do: @pausable_presence_kinds

  @doc """
  The `meta` key whose presence exempts a row from
  `suppressed_presence_kinds/0` — `:structural`. issue 2176 SINGLE SOURCE.

  The suppressed set answers "is this KIND churn?", and for `:mode` the
  honest answer is "it depends on the letters": `+o`/`+v` is the per-JOIN
  churn the denoise filter exists for, `+b`/`+k`/`+l`/`+m`/`+i` changes the
  channel and an operator must see it. Rather than teach both sides to parse
  mode letters — one parser per language, the exact drift the cross-language
  gate exists to catch, and a gate that compares sets of KINDS would not
  catch it — the SERVER classifies once at persist time, where the network's
  own ISUPPORT `PREFIX` table already is
  (`Grappa.Session.ISupport.structural_mode_token?/2`), and tags the row.
  Both sides then filter on the tag.

  There is no `false` form: the key is written ONLY when the row is
  structural, so **absence means fold**. That collapses the two absent cases
  into one rule — a status-prefix row and a row persisted before this key
  existed are both folded, which for the old rows is precisely today's
  behaviour. There is no backfill; a `+b` from before the tag stays folded
  while denoised.

  The cic twin is `STRUCTURAL_META_KEY` in
  `cicchetto/src/lib/presenceFilter.ts`, and `presence_filter_test.exs` gates
  the two spellings against each other — a rename on one side alone would
  otherwise leave both suites green while page-up and the live tail disagree
  about every ban.
  """
  @spec structural_meta_key() :: :structural
  def structural_meta_key, do: @structural_meta_key

  # issue 2228 B — `structural_row?/1`, the shared `json_extract(meta,
  # '$.structural') IS 1` macro, lived here and is GONE. The two SQL sites it
  # kept in step (`Scrollback.maybe_exclude_presence/2`,
  # `ReadCursor.exclude_hidden_presence/2`) now read the `structural` COLUMN
  # directly, so there is no JSON path to drift and no macro needed to hold two
  # spellings together: the field is on the schema and the compiler checks it.
  # The pin test that guarded the literal went with it — an invariant a type
  # system enforces does not need a test, and keeping one would suggest the
  # hazard still exists.

  # issue 2693 — DERIVED from `@kinds`, never restated. `mix
  # grappa.gen_wire_types` emits the wire's `SCROLLBACK_MESSAGE_KIND` from THIS
  # type, not from `@kinds`, so a hand copy let a kind reach the DB enum and
  # never the wire (measured: `:whisper` in `@kinds` alone left the codegen "in
  # sync"). The union keeps `@kinds`' order, which is the generated array's
  # order and shottino's `MESSAGE_KIND_NAMES` index order.
  @type kind :: unquote(Typespec.union(@kinds))

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

    # issue 2228 B — the #2176 structural tag, DERIVED from `meta` by
    # `put_structural/1` and never cast from the caller. It exists because
    # `meta` is in no index: reading the tag out of the JSON blob costs every
    # hide-presence door its COVERING plan (measured `USING INDEX` vs `USING
    # COVERING INDEX`, ~2.8x on a 403,907-row copy of prod). `meta` remains the
    # writer's and cic's channel for the tag — this is a read-path projection
    # of it, not a second input.
    field :structural, :boolean, default: false

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
    |> put_structural()
    |> validate_required([:network_id, :channel, :server_time, :kind, :sender])
    |> Subject.validate_xor()
    |> validate_identifier(:channel, &valid_target?/1)
    |> validate_identifier(:sender, &Identifier.valid_sender?/1)
    |> validate_body_for_kind()
    |> validate_not_e2e()
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

  # issue 2228 B — derive the `structural` COLUMN from the `meta` tag, here and
  # nowhere else. This is the whole reason the column cannot drift from the
  # JSON: no caller sets it, so no caller can set it wrong, and a writer that
  # learns to tag a row gets the column for free. `get_field/2` rather than
  # `get_change/2` so an update that leaves `meta` alone still re-derives from
  # the value the row will actually carry, and it is set UNCONDITIONALLY —
  # dropping the tag has to clear the column, or the exemption outlives it.
  defp put_structural(changeset) do
    tagged? =
      case get_field(changeset, :meta) do
        %{} = meta -> Map.get(meta, @structural_meta_key) == true
        _ -> false
      end

    put_change(changeset, :structural, tagged?)
  end

  @spec validate_body_for_kind(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp validate_body_for_kind(changeset) do
    case get_field(changeset, :kind) do
      kind when kind in @body_required_kinds -> validate_required(changeset, [:body])
      _ -> changeset
    end
  end

  # issue 2430 — an end-to-end encrypted query line is NEVER stored: not in
  # scrollback, so not in search and not in a push payload either, all of
  # which read this table. `EventRouter.route/2` stops inbound E2E lines
  # before any persisting arm; this is the backstop for every OTHER writer
  # (an outbound echo, a mix task, a future facade), keyed on the body for
  # every kind. `E2e.framed?/1` is the wide classifier: a malformed E2E line
  # is still one.
  @spec validate_not_e2e(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp validate_not_e2e(changeset) do
    validate_change(changeset, :body, fn :body, body ->
      if E2e.framed?(body), do: [body: "is an E2E line, which is never stored"], else: []
    end)
  end

  # M8 fix 2026-05-08: enforce per-kind discipline on `:dm_with`.
  # Only the content kinds (`@dm_with_eligible_kinds`) persist DM peer
  # info; every other kind is channel-scoped and `dm_with` MUST be nil.
  # Without this guard, a caller bug (passing a stray dm_with on a :join,
  # :mode, :topic, :nick_change, etc.) silently corrupts the active/archive
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
        add_error(changeset, :dm_with, @dm_with_error)
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
  # Issue 2599: a DM key is a nick the UPSTREAM decided — the peer's on an
  # outbound DM, ours at receipt on an inbound one, which a collision turns
  # into a UID — so it is `wire_nick?/1`, not the portable charset.
  # BUG2 fix-up: "$server" is the Grappa-internal synthetic channel for
  # server-origin NOTICEs and MOTD lines. It is not a valid IRC channel or
  # nick — add it as an explicit third branch so EventRouter can persist
  # server-window rows without changeset rejection.
  @spec valid_target?(term()) :: boolean()
  defp valid_target?(s), do: Identifier.valid_channel?(s) or Identifier.wire_nick?(s) or s == "$server"

  @doc """
  True iff the row threads a DM conversation — `dm_with` is set. Issue 1365
  SINGLE SOURCE for "is this row a DM?": `Grappa.Push.Triggers` (notify +
  badge) and `Grappa.Push.Payload` (title, tag, deep link) both read this.

  It used to be `fold(channel) == fold(own_nick)`: an inbound DM is
  persisted at `channel = <own nick at receipt>`, and that TAG was re-keyed
  on every self-rename (#514) so it kept matching the live nick. The ruling
  on issue 1365 (relayed from vjt) is that a nick change writes nothing to
  the DB, so the TAG now stays at the nick we held — and `dm_with`, which
  `Grappa.Scrollback.dm_peer/4` sets on exactly the rows whose target was
  us at receipt (plus our own outbound DMs), is the one fact a rename never
  touches. Own rows are excluded upstream by the identity test
  (`Triggers.own_row?/2`, #532 C), never by this shape.

  Mirrors `isDm` in `cicchetto/src/lib/pushTriggers.ts`; the shared truth
  table (`should_notify_parity_test.exs`) gates the two.
  """
  @spec dm?(t()) :: boolean()
  def dm?(%__MODULE__{dm_with: dm_with}), do: is_binary(dm_with)
end
