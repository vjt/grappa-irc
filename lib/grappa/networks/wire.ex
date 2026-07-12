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
          inserted_at: String.t(),
          updated_at: String.t()
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
          nick: String.t(),
          connection_state: Credential.connection_state(),
          connection_state_reason: String.t() | nil,
          connection_state_changed_at: String.t() | nil,
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
  """
  @type visitor_network_with_nick_json :: %{
          kind: :visitor,
          id: integer(),
          slug: String.t(),
          nick: String.t(),
          connection_state: Credential.connection_state(),
          connection_state_reason: String.t() | nil,
          connection_state_changed_at: String.t() | nil,
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
          connection_state_changed_at: String.t() | nil
        }

  @typedoc """
  #211 phase 6: a network AVAILABLE for a visitor to connect on-demand —
  `visitor_enabled` MINUS the visitor's already-attached set. Rendered on
  the (now-shared) home page's "available to connect" section (ruling C:
  "home page shows connected + available"). Users get an empty list
  (they bind via the operator surface, not self-service). Just the slug —
  the connect action POSTs it to `/session/networks`.
  """
  @type available_network_row :: %{slug: String.t()}

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
          kind: String.t(),
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
  and re-read the moduledoc.

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
      inserted_at: DateTime.to_iso8601(c.inserted_at),
      updated_at: DateTime.to_iso8601(c.updated_at)
    }
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
  @spec network_with_nick_to_json(Network.t(), String.t(), Credential.t()) ::
          network_with_nick_json()
  def network_with_nick_to_json(%Network{} = n, nick, %Credential{} = cred)
      when is_binary(nick) and nick != "" do
    %{
      kind: :user,
      id: n.id,
      slug: n.slug,
      nick: nick,
      connection_state: cred.connection_state,
      connection_state_reason: cred.connection_state_reason,
      connection_state_changed_at: WireTime.iso8601_or_nil(cred.connection_state_changed_at),
      inserted_at: DateTime.to_iso8601(n.inserted_at),
      updated_at: DateTime.to_iso8601(n.updated_at)
    }
  end

  @doc """
  #211 phase 6 — the VISITOR twin of `network_with_nick_to_json/3`.
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
  @spec visitor_network_to_json(Network.t(), String.t(), Credential.t()) ::
          visitor_network_with_nick_json()
  def visitor_network_to_json(%Network{} = n, nick, %Credential{} = cred)
      when is_binary(nick) and nick != "" do
    %{
      kind: :visitor,
      id: n.id,
      slug: n.slug,
      nick: nick,
      connection_state: cred.connection_state,
      connection_state_reason: cred.connection_state_reason,
      connection_state_changed_at: WireTime.iso8601_or_nil(cred.connection_state_changed_at),
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
      kind: "connection_state_changed",
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
      connection_state_changed_at: WireTime.iso8601_or_nil(cred.connection_state_changed_at)
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
end
