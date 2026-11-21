defmodule Grappa.Networks.Wire do
  @moduledoc """
  Single source of truth for the public JSON wire shape of
  `Grappa.Networks.Credential` and `Grappa.Networks.Network` rows.

  ## Why this module exists (CRITICAL — read before adding fields)

  `Credential.password_encrypted` is a `Grappa.EncryptedBinary` Cloak
  column whose `:load` callback decrypts the AES-GCM ciphertext on
  read. After `Repo.one!`, the field IN MEMORY carries the **plaintext
  upstream IRC password** — the field name describes the on-disk
  representation, not the post-load value. The `redact: true` on the
  schema field protects `inspect/1` and Logger output, but NOT
  `Jason.encode!/1`, which walks struct fields directly.

  Without an explicit allowlist serializer, the first naive Phase 3
  controller that does `json(conn, credential)` leaks the upstream
  NickServ password to the world. This module is the only sanctioned
  door from `Networks.Credential` / `Networks.Network` rows to JSON.
  Adding a field to the wire = one edit here. Removing one = a
  breaking change visible at this single site.

  See `Grappa.Scrollback.Wire` for the analogous shape on the
  scrollback side; the two share the convention of crashing loudly
  when a required association isn't preloaded.
  """

  alias Grappa.Networks.{Credential, Network}
  alias Grappa.Uploads
  alias Grappa.Wire.Time, as: WireTime

  @type credential_json :: %{
          network: String.t(),
          nick: String.t(),
          ident: String.t() | nil,
          realname: String.t() | nil,
          sasl_user: String.t() | nil,
          auth_method: Credential.auth_method(),
          auth_command_template: String.t() | nil,
          autojoin_channels: [String.t()],
          connection_state: Credential.connection_state(),
          connection_state_reason: String.t() | nil,
          connection_state_changed_at: String.t() | nil,
          age: String.t() | nil,
          gender: Credential.gender() | nil,
          location: String.t() | nil,
          languages: String.t() | nil,
          custom: String.t() | nil,
          # M3a — the credential's own avatar, absolute URL (built by
          # `Grappa.Uploads.public_url/2` off the preloaded
          # `:avatar_upload`), `nil` when unset. Same "carried here for
          # BOTH subjects so the settings editor can seed itself from
          # `GET /networks`" rationale as the profile fields above.
          avatar_url: String.t() | nil,
          inserted_at: String.t(),
          updated_at: String.t()
        }

  @typedoc """
  #474 scope B — the LIVE upstream connection facts embedded under
  `:connection` on both `GET /networks` twins: which box the socket dialled
  (`:server` = the resolved peer IP string, #550), the transport `:tls`
  posture, and whether the nick is identified to services (`:registered`,
  from the +r umode — the same identity signal #561 keys on). All are live
  Session.Server state (no new IRC traffic); the `:connection` field is
  `nil` whenever there is no live connected session (parked / failed /
  reconnecting), the honest "no live connection" signal — prefer omitting
  over a stale value. Sourced by the controller via
  `Grappa.Session.connection_info/2`.

  #897 — `:connected_at` (ISO-8601) is the instant THIS link came up, and
  it lives HERE rather than beside `:connection_state_changed_at` for one
  reason: it is live state, so it must vanish with the rest of `:connection`
  when there is no live pid. The credential column next to it answers a
  DIFFERENT question — when the ROW last changed state — and a bouncer
  restart never moves the row out of `:connected` (`Networks.connect/1`
  no-ops without a DB write), so it outlives the link by however many
  restarts happened since. `nil` on a session whose state predates the
  field (#216 hot-reload contract): "unknown", never a fabricated instant.

  ⚠️ `registered` does NOT mean "registered with the ircd" (001
  RPL_WELCOME). It is `Grappa.Session.IdentityState.identified?/1` — the
  #388 normalized NickServ IDENTIFIED verdict, which is what cic's
  registration + recover launchers gate on. An `auth_method: :none`
  credential is `false` here for its whole life while being perfectly
  registered upstream. The name is kept (it is published wire, and the
  contract is additive-only) but it is NOT an IRC-registration witness:
  for that, read `connection_state` — since #1675 it means REGISTERED
  UPSTREAM. Measured the hard way; the #1675 e2e asserted this field as a
  001 witness and hung 180 s against a link that had registered fine.
  """
  @type connection_info :: %{
          server: String.t(),
          port: integer(),
          tls: boolean(),
          registered: boolean(),
          connected_at: String.t() | nil
        }

  @typedoc """
  Wire shape for `GET /networks` when the caller has a USER `Credential`
  row — carries `:nick` (the per-network configured IRC nick) AND the
  T32 connection-state fields (`:connection_state`,
  `:connection_state_reason`, `:connection_state_changed_at`) so cic can
  derive the per-network + cascading per-channel greyed treatment from a
  single `GET /networks` payload. The visitor twin is
  `visitor_network_with_nick_json` (#211 phase 6 — same shape, `:kind`
  is `:visitor`).

  Cicchetto uses `:nick` to identify the own-nick topic (`channel:<nick>`)
  for DM subscription and for the own-nick skip in the query-windows loop.
  Without per-network nick in the wire, cicchetto falls back to `user.name`,
  which coincides with query-window targetNick when the operator's account
  name matches a conversation partner's IRC nick — causing the DM handler
  to subscribe to the wrong topic and re-key messages incorrectly.

  T32 fields drive the cic parked-window derivation
  (`networkBySlug[slug].connection_state ∈ {parked, failed}` ⇒ network
  header + every channel/query under it render greyed). The user-topic
  `connection_state_changed` event triggers a `GET /networks` refetch in
  cic; without these fields surfacing here the refetch returns the same
  shape and cic can't derive anything.
  """
  @type network_with_nick_json :: %{
          kind: :user,
          id: integer(),
          slug: String.t(),
          services_flavor: Network.services_flavor() | nil,
          nick: String.t(),
          ident: String.t() | nil,
          realname: String.t() | nil,
          connection_state: Credential.connection_state(),
          connection_state_reason: String.t() | nil,
          connection_state_changed_at: String.t() | nil,
          connection: connection_info() | nil,
          # KVIrc-style CTCP USERINFO profile — carried here (mirroring
          # `:ident`/`:realname` above, #211 phase 7's own precedent) so
          # cic's per-network profile editor (`PATCH /networks/:id/profile`)
          # can seed its inputs from the `GET /networks` rows, for BOTH
          # subjects, the same way the identity editor already does.
          age: String.t() | nil,
          gender: Credential.gender() | nil,
          location: String.t() | nil,
          languages: String.t() | nil,
          custom: String.t() | nil,
          # M3a — the credential's own avatar, absolute URL (built by
          # `Grappa.Uploads.public_url/2` off the preloaded
          # `:avatar_upload`), `nil` when unset. Same "carried here for
          # BOTH subjects so the settings editor can seed itself from
          # `GET /networks`" rationale as the profile fields above.
          avatar_url: String.t() | nil,
          inserted_at: String.t(),
          updated_at: String.t()
        }

  @typedoc """
  #211 phase 6 — the VISITOR twin of `network_with_nick_json`. A visitor
  is multi-network now (phase 4c accretion), so `GET /networks` returns
  one row per attached network — the visitor analogue of the user
  branch (ruling A: "visitors as equal to users as possible").

  Structurally identical to `network_with_nick_json` except the `:kind`
  discriminator is `:visitor`. Carries the per-network `:nick` (from the
  credential, live-nick-with-fallback via `resolve_network_nick/2` — the
  SAME reason the user row carries it: cic's `ownNickForNetwork` /
  DM-topic subscription resolves per-network nick from this, NOT the
  retired singular `me.network_slug`) AND the REAL `connection_state`
  fields (ruling D: the `network_credentials.connection_state` column
  already existed for visitor credentials, just unused — phase 6 uses it
  so a visitor parks/reconnects each network via the same
  `PATCH /networks/:id` users do, persisting across reboot).
  ## #211 phase 7 — per-network identity fields

  Both `network_with_nick_json` and its visitor twin now carry the
  credential's `:ident` + `:realname` (nullable) so cic's per-network
  identity editor (`PATCH /networks/:id/identity`) can seed its inputs for
  BOTH subjects from the `GET /networks` rows — the wire change the phase-6
  visitor editor deferred to "the phase-7 convergence". `:nick` is the
  live-nick-with-fallback (may differ from `cred.nick` after NickServ
  ghost/regain); `:ident`/`:realname` are always credential-row-of-record
  (no live divergence — they're set once at USER registration).
  """
  @type visitor_network_with_nick_json :: %{
          kind: :visitor,
          id: integer(),
          slug: String.t(),
          services_flavor: Network.services_flavor() | nil,
          nick: String.t(),
          ident: String.t() | nil,
          realname: String.t() | nil,
          connection_state: Credential.connection_state(),
          connection_state_reason: String.t() | nil,
          connection_state_changed_at: String.t() | nil,
          connection: connection_info() | nil,
          # KVIrc-style CTCP USERINFO profile — carried here (mirroring
          # `:ident`/`:realname` above, #211 phase 7's own precedent) so
          # cic's per-network profile editor (`PATCH /networks/:id/profile`)
          # can seed its inputs from the `GET /networks` rows, for BOTH
          # subjects, the same way the identity editor already does.
          age: String.t() | nil,
          gender: Credential.gender() | nil,
          location: String.t() | nil,
          languages: String.t() | nil,
          custom: String.t() | nil,
          # M3a — the credential's own avatar, absolute URL (built by
          # `Grappa.Uploads.public_url/2` off the preloaded
          # `:avatar_upload`), `nil` when unset. Same "carried here for
          # BOTH subjects so the settings editor can seed itself from
          # `GET /networks`" rationale as the profile fields above.
          avatar_url: String.t() | nil,
          inserted_at: String.t(),
          updated_at: String.t()
        }

  @typedoc """
  Per-channel wire shape returned by `GET /networks/:net/channels`. Object
  envelope (not a bare string) per architecture review A5 close: every
  channel entry advertises both `:joined` (currently-in-session) and
  `:source` (`:autojoin` if declared in the credential's autojoin list,
  `:joined` if dynamically joined via REST/IRC after boot). When a
  channel is in BOTH sources, `:autojoin` wins (operator intent durable).

  Q3 of P4-1 cluster pinned the merge order; P4-1 is the cluster that
  landed it.
  """
  @type channel_json :: %{
          name: String.t(),
          joined: boolean(),
          source: :autojoin | :joined
        }

  @typedoc """
  UX-4 bucket B: per-row entry inside the `:home` window's networks
  list. Strict subset of `network_with_nick_json` — no `id`, no
  timestamps, no `kind` discriminator. The home pane is a UI view, not
  a network mirror.

  Identical shape used in two places:

    * `home_data/2` envelope (returned from `GET /me` for BOTH
      subjects since #211 phase 6, nested under `home_data.networks`).
    * `connection_state_changed_event/5`'s `:network` field
      (per-row patch on every credential `connection_state` transition,
      so cic can patch the matching slot in-place without a `GET /me`
      refetch). REV-J M15 folded the prior
      `home_network_state_changed_event/2` arm into this single payload.

  Keeping the two payloads structurally identical via the shared
  `home_network_row/2` builder is the "single edit, not fourteen"
  rule: future field add lands here and at the builder, both
  consumers pick it up without drift.
  """
  @type home_network_row :: %{
          slug: String.t(),
          nick: String.t(),
          connection_state: Credential.connection_state(),
          connection_state_reason: String.t() | nil,
          connection_state_changed_at: String.t() | nil,
          # #581 (D2) — the credential carries a NickServ secret, so the
          # visitor "recover my identity" action has something to identify
          # with. The "recoverable credential on file" half of the /recover
          # button gate; cic ANDs the "not already +r" + visitor-only halves.
          # Derived (not stored) via `Credential.has_nickserv_secret?/1`.
          recoverable: boolean()
        }

  @typedoc """
  #211 phase 6 / #481: a network AVAILABLE for a subject to connect
  on-demand — `visitor_enabled` MINUS the subject's already-attached set.
  Rendered on the (shared) home page's "available to connect" section
  (ruling C: "home page shows connected + available"). #481 populates it
  for BOTH subjects (was visitor-only); `visitor_enabled` is the
  operator-approved self-serve allowlist, a property of the network, so
  the same bound admits users. Just the slug — the connect action POSTs it
  to `/session/networks`.
  """
  @type available_network_row :: %{slug: String.t()}

  @typedoc """
  #2606 — the write-only set-ness answer for the server `PASS` slot.

  ONE shape, two doors: the user-facing `GET`/`PUT
  `/networks/:network_id/server_pass` (#1044) and the admin
  `GET`/`PUT /admin/credentials/:user_id/:network_id/server_pass` (#2606)
  both answer it, so it is defined once here rather than copied into each
  controller. The boolean says whether the slot holds a secret; the secret
  itself is never serialised — the same posture `$oper_pass` has on the
  perform surface.
  """
  @type server_pass_json :: %{server_pass_set: boolean()}

  @typedoc """
  UX-4 bucket B / #211 phase 6: home envelope nested under
  `MeJSON.show/1`'s `:home_data` key. Populated for BOTH subjects now
  (ruling A — the user + visitor home pages are the SAME data-driven
  component). `networks` = the subject's attached networks (per-network
  nick + connection_state); `available_networks` = the on-demand-connect
  tier (visitor: `visitor_enabled − attached`; user: `[]`).

  Nested (not flat) so future home cards (`home_data.pinned`,
  `home_data.mentions_summary`, etc.) land as sibling keys without
  touching every caller.
  """
  @type home_data :: %{
          networks: [home_network_row()],
          available_networks: [available_network_row()]
        }

  @typedoc """
  issue 2219 — wire payload for `kind: "network_detached"`, broadcast on
  `Topic.user(subject_label)` when a subject detaches a network.

  Carries the identity of the network that left and nothing else. There
  is no state to report: a detach of an already-parked credential moves
  no `connection_state`, and the row it describes is, by the time a
  consumer reads this, absent from `GET /networks` and from the `$home`
  envelope. So the payload names what went, and the client re-reads the
  two surfaces that own the answer.
  """
  @type network_detached_event :: %{
          kind: :network_detached,
          network_id: integer(),
          network_slug: String.t()
        }

  @typedoc """
  issue 2219 — wire payload for `kind: "network_attached"`, the twin of
  `network_detached` above, broadcast when a network JOINS the subject's
  set: a fresh accretion or the re-attach of something detached.

  It exists because the detach announcing itself and the attach staying
  silent is worse than neither announcing. A second tab that did not
  initiate the re-attach would keep the network under
  `available_networks` with no attached row, and a third-party client
  would have no signal at all — `connection_state_changed` fires on the
  `:parked → :connected` flip but refreshes only `GET /networks`, never
  the `/me` envelope the `$home` rows come from.

  Same three fields and the same contract as its twin: it carries no
  state, and the client re-reads the two surfaces that own the answer.
  """
  @type network_attached_event :: %{
          kind: :network_attached,
          network_id: integer(),
          network_slug: String.t()
        }

  @typedoc """
  Wire payload for `kind: "connection_state_changed"` broadcast on
  `Topic.user(user_name)`. Cic's `userTopic.ts` consumes this to refresh
  the per-network connection-state badge + the HomePane row in-place
  (T32 connect/disconnect).

  Pre-CP16 B3: `Networks.broadcast_state_change/4` built this payload
  inline at the broadcast site. CP16 B3 moves it here per the
  CLAUDE.md hard invariant — every PubSub broadcast payload routes
  through a context-owned Wire fn.

  REV-J M15: pre-fix `Networks.broadcast_state_change/4` emitted two
  events per transition — `connection_state_changed` for Sidebar /
  query-window consumers + `home_network_state_changed` for HomePane.
  Subscribers seeing both arms observed a temporal window where the
  first event reflected the new state and the second hadn't landed,
  with neither narrower payload describing the full transition.
  Folded into a single `connection_state_changed` payload with the
  `network` field carrying the same `home_network_row` shape HomePane
  consumed before. One logical event, one wire payload, one broadcast.
  `home_network_state_changed_event/2` retired.
  """
  @type connection_state_event :: %{
          kind: :connection_state_changed,
          user_id: String.t() | nil,
          network_id: integer(),
          network_slug: String.t(),
          from: Credential.connection_state(),
          to: Credential.connection_state(),
          reason: String.t() | nil,
          at: String.t() | nil,
          network: home_network_row()
        }

  @doc """
  Renders a `Networks.Credential` row to its public JSON shape. The
  `:network` association MUST be preloaded — pattern match fails
  loudly otherwise (same convention as `Scrollback.Wire.to_json/1`).

  Excludes `:password_encrypted` (the post-Cloak-load plaintext
  upstream secret) and the virtual `:password` field — both must
  NEVER appear on the wire. If you're tempted to add either, stop
  and re-read the moduledoc. #124's per-network password field writes
  that column and deliberately publishes NOTHING about it — not even
  its set-ness. The field is write-only end to end.

  The same holds for #1044's `:server_pass_encrypted` / `:server_pass`
  pair: a second secret slot is still a secret slot, and it inherits
  the write-only posture rather than an exception to it.

  Includes T32 connection-state fields (`connection_state`,
  `connection_state_reason`, `connection_state_changed_at`) so the
  REST surface for `PATCH /networks/:id` can return the updated
  credential state without a separate endpoint.
  """
  @spec credential_to_json(Credential.t()) :: credential_json()
  def credential_to_json(%Credential{network: %Network{slug: slug}} = c) do
    %{
      network: slug,
      nick: c.nick,
      ident: c.ident,
      realname: c.realname,
      sasl_user: c.sasl_user,
      auth_method: c.auth_method,
      auth_command_template: c.auth_command_template,
      autojoin_channels: c.autojoin_channels,
      connection_state: c.connection_state,
      connection_state_reason: c.connection_state_reason,
      connection_state_changed_at: WireTime.iso8601_or_nil(c.connection_state_changed_at),
      # KVIrc-style CTCP USERINFO profile — additive, snake_case, no
      # `protocol_version` bump needed (CLAUDE.md's additive-only wire
      # contract). Un-prefixed on the wire (the `profile_` prefix is a
      # storage-column concern); `PATCH /networks/:id/profile` accepts
      # the same un-prefixed keys back.
      age: c.profile_age,
      gender: c.profile_gender,
      location: c.profile_location,
      languages: c.profile_languages,
      custom: c.profile_custom,
      avatar_url: avatar_url(c),
      inserted_at: DateTime.to_iso8601(c.inserted_at),
      updated_at: DateTime.to_iso8601(c.updated_at)
    }
  end

  @doc """
  M3a — the credential's own avatar as an absolute URL
  (`Grappa.Uploads.public_url/2` off the preloaded `:avatar_upload`),
  or `nil` when unset. Absolute (not a bare `/uploads/...` path)
  because the SAME value also feeds the CTCP AVATAR NOTICE reply
  (`Grappa.Session.EventRouter`) — plain text sent to an arbitrary
  remote IRC client with no origin of its own to resolve a relative
  URL against — so there is exactly one avatar-URL shape everywhere,
  not a relative one for JSON and a separately-built absolute one for
  IRC.

  `:avatar_upload` MUST be preloaded (same convention as `:network`
  above — every context function that returns a credential for
  rendering preloads both, see `Grappa.Networks.Credentials`). An
  un-preloaded association reads as `Ecto.Association.NotLoaded`, not
  `nil` — the second clause below only matches a genuinely unset FK.
  """
  @spec avatar_url(Credential.t()) :: String.t() | nil
  def avatar_url(%Credential{avatar_upload: %Uploads.Upload{} = upload}) do
    Uploads.public_url(upload.slug, upload.mime)
  end

  def avatar_url(%Credential{avatar_upload_id: nil}), do: nil

  @doc """
  #2606 — the `server_pass_json` answer: set-ness only, never the value.

  `Credential.upstream_server_pass/1` resolves the slot the credential's
  `auth_method` would actually spend, so the boolean answers the question
  the UI asks ("is a PASS stored for this binding?") rather than "does the
  dedicated column happen to be filled".
  """
  @spec server_pass_json(Credential.t()) :: server_pass_json()
  def server_pass_json(%Credential{} = credential) do
    %{server_pass_set: Credential.upstream_server_pass(credential) != nil}
  end

  @doc """
  Renders a `Networks.Network` + the credential's nick + T32
  connection-state fields to the extended `network_with_nick_json` shape
  used by `GET /networks` for user subjects.

  The caller — `GrappaWeb.NetworksController.index` — already has the
  `Credential` row (from `Credentials.list_credentials_for_user/1`) and
  passes the network + nick + credential triple. `nick` is accepted
  separately because it may be the LIVE IRC nick from the running
  Session.Server (BUG1-FIX: `resolve_network_nick/2`), which can differ
  from `cred.nick` after NickServ ghost/regain — but the T32 state
  fields are always credential-row-of-record (DB-persisted user intent),
  so they come straight off the credential without divergence.
  """
  @spec network_with_nick_to_json(
          Network.t(),
          String.t(),
          Credential.t(),
          Grappa.Session.connection_info() | nil
        ) :: network_with_nick_json()
  def network_with_nick_to_json(%Network{} = n, nick, %Credential{} = cred, connection)
      when is_binary(nick) and nick != "" and (is_map(connection) or is_nil(connection)) do
    %{
      kind: :user,
      id: n.id,
      slug: n.slug,
      services_flavor: n.services_flavor,
      nick: nick,
      ident: cred.ident,
      realname: cred.realname,
      connection_state: cred.connection_state,
      connection_state_reason: cred.connection_state_reason,
      connection_state_changed_at: WireTime.iso8601_or_nil(cred.connection_state_changed_at),
      connection: connection_json(connection),
      age: cred.profile_age,
      gender: cred.profile_gender,
      location: cred.profile_location,
      languages: cred.profile_languages,
      custom: cred.profile_custom,
      avatar_url: avatar_url(cred),
      inserted_at: DateTime.to_iso8601(n.inserted_at),
      updated_at: DateTime.to_iso8601(n.updated_at)
    }
  end

  @doc """
  #211 phase 6 — the VISITOR twin of `network_with_nick_to_json/4`.
  Renders a `Networks.Network` + the visitor credential's live-nick +
  the credential's `connection_state` fields to the
  `visitor_network_with_nick_json` shape used by `GET /networks` for
  visitor subjects.

  Same threading as the user branch: the caller
  (`GrappaWeb.NetworksController.index`) already holds the visitor's
  `Credential` (from `Credentials.list_visitor_credentials/1`) and
  passes `{network, nick, credential}` triples. `nick` may be the LIVE
  IRC nick from the running Session.Server (BUG1-FIX parity:
  `resolve_network_nick/2` with the visitor subject), which can differ
  from `cred.nick` after NickServ ghost/regain; the `connection_state`
  fields come straight off the credential row of record (ruling D:
  visitors now carry a real `connection_state`). Only the `:kind`
  discriminator differs from the user twin (`:visitor` vs `:user`) so
  cic resolves the correct subject-scoped nick.
  """
  @spec visitor_network_to_json(
          Network.t(),
          String.t(),
          Credential.t(),
          Grappa.Session.connection_info() | nil
        ) :: visitor_network_with_nick_json()
  def visitor_network_to_json(%Network{} = n, nick, %Credential{} = cred, connection)
      when is_binary(nick) and nick != "" and (is_map(connection) or is_nil(connection)) do
    %{
      kind: :visitor,
      id: n.id,
      slug: n.slug,
      services_flavor: n.services_flavor,
      nick: nick,
      ident: cred.ident,
      realname: cred.realname,
      connection_state: cred.connection_state,
      connection_state_reason: cred.connection_state_reason,
      connection_state_changed_at: WireTime.iso8601_or_nil(cred.connection_state_changed_at),
      connection: connection_json(connection),
      age: cred.profile_age,
      gender: cred.profile_gender,
      location: cred.profile_location,
      languages: cred.profile_languages,
      custom: cred.profile_custom,
      avatar_url: avatar_url(cred),
      inserted_at: DateTime.to_iso8601(n.inserted_at),
      updated_at: DateTime.to_iso8601(n.updated_at)
    }
  end

  @doc """
  Renders a single channel entry to its public JSON shape, given the
  channel `name`, the live `joined` state, and the `source` of the
  list entry. Caller is responsible for the source-merge logic
  (private `merge_channel_sources/2` in `GrappaWeb.ChannelsController`).
  """
  @spec channel_to_json(String.t(), boolean(), :autojoin | :joined) :: channel_json()
  def channel_to_json(name, joined, source)
      when is_binary(name) and is_boolean(joined) and source in [:autojoin, :joined] do
    %{name: name, joined: joined, source: source}
  end

  @doc """
  Renders the broadcast event emitted by
  `Networks.broadcast_state_change/4` after a credential's
  `connection_state` transitions (T32 connect/disconnect verbs +
  upstream socket-close hits). Fanned out on `Topic.user(user_name)`
  via `Grappa.PubSub.broadcast_event/2`.

  Codebase-review-fixes 2026-05-08 H1 fix landed the
  `broadcast_event/2` route; CP16 B3 moves the payload itself behind
  this Wire fn so the same {kind, user_id, network_id, network_slug,
  from, to, reason, at} contract is one edit instead of fourteen.
  Cic's `userTopic.ts` consumes the payload directly; the fields
  match what cic's discriminated `WireUserEvent` arm declares
  (CP16 B5).

  #211 phase 6 — subject-polymorphic. `user_id` is nil for a VISITOR
  credential (the XOR FK — `visitor_id` is set instead); cic's handler
  acts on `payload.network` only, so the id is diagnostic, not
  load-bearing. The `at`/`network` fields are subject-agnostic.
  """
  @spec connection_state_changed_event(
          Credential.t(),
          Credential.connection_state(),
          Credential.connection_state(),
          String.t() | nil,
          String.t()
        ) :: connection_state_event()
  def connection_state_changed_event(
        %Credential{network: %Network{slug: slug}} = c,
        from,
        to,
        reason,
        nick
      )
      when is_binary(nick) and nick != "" do
    %{
      kind: :connection_state_changed,
      user_id: c.user_id,
      network_id: c.network_id,
      network_slug: slug,
      from: from,
      to: to,
      reason: reason,
      at: WireTime.iso8601_or_nil(c.connection_state_changed_at),
      network: home_network_row(c, nick)
    }
  end

  @doc """
  issue 2219 — builds the `network_detached` payload. `:network` MUST be
  preloaded (same convention as every builder in this module).
  """
  @spec network_detached_event(Credential.t()) :: network_detached_event()
  def network_detached_event(%Credential{network: %Network{slug: slug}} = c) do
    %{kind: :network_detached, network_id: c.network_id, network_slug: slug}
  end

  @doc """
  issue 2219 — builds the `network_attached` payload. `:network` MUST be
  preloaded (same convention as every builder in this module).
  """
  @spec network_attached_event(Credential.t()) :: network_attached_event()
  def network_attached_event(%Credential{network: %Network{slug: slug}} = c) do
    %{kind: :network_attached, network_id: c.network_id, network_slug: slug}
  end

  @doc """
  Builds a single `home_network_row` from a `Credential` + the live
  nick (resolved by the caller via `Session.current_nick/2`, falling
  back to `cred.nick` on `:no_session`). The `:network` association
  MUST be preloaded — pattern match fails loudly otherwise.

  Shared by `home_data/2` (envelope) and
  `connection_state_changed_event/5`'s `:network` field (typed
  broadcast — REV-J M15 folded the prior
  `home_network_state_changed_event/2` arm into the consolidated
  payload) so the row shape is one edit, not two.
  """
  @spec home_network_row(Credential.t(), String.t()) :: home_network_row()
  def home_network_row(%Credential{network: %Network{slug: slug}} = cred, nick)
      when is_binary(nick) and nick != "" do
    %{
      slug: slug,
      nick: nick,
      connection_state: cred.connection_state,
      connection_state_reason: cred.connection_state_reason,
      connection_state_changed_at: WireTime.iso8601_or_nil(cred.connection_state_changed_at),
      recoverable: Credential.has_nickserv_secret?(cred)
    }
  end

  @doc """
  Renders the `home_data` envelope — the attached-network
  `(credential, live_nick)` pairs + the `available_networks` slugs — to
  the nested `%{networks: [...], available_networks: [...]}` shape.

  #211 phase 6 (ruling A): populated for BOTH subjects (the user +
  visitor home pages are the SAME data-driven component). Callers compose
  the inputs via `Networks.home_data_for_user/1` (available = `[]`) /
  `Networks.home_data_for_visitor/1` (available = `visitor_enabled −
  attached`).
  """
  @spec home_data([{Credential.t(), String.t()}], [String.t()]) :: home_data()
  def home_data(pairs, available_slugs) when is_list(pairs) and is_list(available_slugs) do
    %{
      networks: Enum.map(pairs, fn {cred, nick} -> home_network_row(cred, nick) end),
      available_networks: Enum.map(available_slugs, fn slug -> %{slug: slug} end)
    }
  end

  # #474 B — projects the `Grappa.Session.connection_info/2` result (the map
  # the controller resolved, or nil when there is no live connected session)
  # onto the exact `:connection` wire shape. Rebuilt field-by-field rather
  # than passed through so this module stays the SSOT for the JSON shape.
  # It is also where the domain/wire type split is paid: the session speaks
  # `%DateTime{}`, the wire speaks ISO-8601 (#897).
  #
  # `connected_at` is matched, not `Map.get`-defaulted: every producer is
  # `Grappa.Session.connection_info/2`, so a map without the key means a
  # NEW producer forgot it — a loud FunctionClauseError beats a silently
  # missing uptime row.
  @spec connection_json(Grappa.Session.connection_info() | nil) :: connection_info() | nil
  defp connection_json(nil), do: nil

  defp connection_json(%{
         server: server,
         port: port,
         tls: tls,
         registered: registered,
         connected_at: connected_at
       }) do
    %{
      server: server,
      port: port,
      tls: tls,
      registered: registered,
      connected_at: WireTime.iso8601_or_nil(connected_at)
    }
  end
end
