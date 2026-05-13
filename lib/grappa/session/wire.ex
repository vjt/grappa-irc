defmodule Grappa.Session.Wire do
  @moduledoc """
  Single source of truth for the public JSON wire shape of the
  events broadcast by `Grappa.Session.Server` over Phoenix.PubSub
  and pushed by `GrappaWeb.GrappaChannel` after-join helpers.

  ## Why this module exists (CRITICAL — read before adding events)

  CP15 B7 elevated to a CLAUDE.md hard invariant:

    > PubSub broadcast + Channel push payloads MUST be JSON-encodable
    > — convert structs to wire shape via a context-owned `*.Wire`
    > module. Wire conversion is per-context responsibility.

  Sibling Wire modules: `Grappa.Scrollback.Wire`, `Grappa.Networks.Wire`,
  `Grappa.Accounts.Wire`, `Grappa.QueryWindows.Wire`. This module
  closes the same gap for `Grappa.Session.Server` — the busiest event
  producer in the codebase, and the one CP15 explicitly hardened.

  Pre-extraction, `Session.Server` constructed 9 distinct event
  payloads inline (`apply_effects` arms + `maybe_broadcast_*`) and
  `window_state_payload/3` re-built three of them for the
  cold-WS-subscribe snapshot path. Byte-identicality between
  event-time and snapshot was enforced by code-review prose in the
  moduledoc — not by a function. A diff that added a field to one
  arm without updating the snapshot path would compile, pass tests
  for the live broadcast, and silently regress the deploy-reconnect
  race CP15 B3 specifically fixed.

  After extraction: every broadcast site calls one of these verbs.
  `window_state_payload/3` becomes a one-liner that calls the same
  verb (`joined/2` / `join_failed/4` / `kicked/4`) so snapshot +
  event are LITERALLY the same expression. Adding a field to an
  event = one edit here.

  ## Wire-shape rules

    * `kind:` is ALWAYS a string literal (the JSON-wire convention
      established by CLAUDE.md "kind: STRING JSON-wire convention").
      `Message.kind()` (Ecto.Enum atom) is converted at the Wire
      boundary inside `mentions_bundle/5`.
    * Network discriminator on the wire is `:network` carrying the
      slug (string), NOT the integer `network_id` — same convention
      as `Scrollback.Wire`. Exception: `own_nick_changed/2` carries
      `:network_id` (integer) because cic's networks store keys on
      id and the user-level topic is not network-scoped.

  ## Mentions bundle decision (arch review A8)

  The `mentions_bundle/5` per-message map is a deliberately-stripped
  projection of `Scrollback.Message` — `%{server_time, channel,
  sender_nick, body, kind}`. The bundle is rendered as a
  cross-channel summary view that doesn't need id/network/meta;
  keeping the divergence small but EXPLICIT in one place. Note the
  `sender_nick:` field name (vs `sender:` in `Scrollback.Wire.t/0`)
  is the historical bundle shape; a deeper unification is a separate
  decision deferred to the next channel-client-polish cluster.
  """

  alias Grappa.Scrollback.Message

  @typedoc """
  The closed set of event kinds emitted by Session. Useful when
  Dialyzer-typing handler dispatch tables; the on-wire form is the
  string projection of each atom (per the wire-shape rules above).
  """
  @type wire_event_kind ::
          :channels_changed
          | :own_nick_changed
          | :topic_changed
          | :channel_modes_changed
          | :channel_created
          | :members_seeded
          | :joined
          | :window_pending
          | :join_failed
          | :kicked
          | :away_confirmed
          | :mentions_bundle
          | :whois_bundle
          | :peer_away
          | :invite_ack
          | :lusers_bundle
          | :whowas_bundle

  @type channels_changed_payload :: %{kind: String.t()}

  @type own_nick_changed_payload :: %{
          kind: String.t(),
          network_id: integer(),
          nick: String.t()
        }

  @type topic_changed_payload :: %{
          kind: String.t(),
          network: String.t(),
          channel: String.t(),
          topic: map()
        }

  @type channel_modes_changed_payload :: %{
          kind: String.t(),
          network: String.t(),
          channel: String.t(),
          modes: map()
        }

  @type channel_created_payload :: %{
          kind: String.t(),
          network: String.t(),
          channel: String.t(),
          created_at: String.t()
        }

  @type members_seeded_payload :: %{
          kind: String.t(),
          network: String.t(),
          channel: String.t(),
          members: [member()]
        }

  @typedoc """
  Per-member wire shape — emitted by `member/1` and consumed by both
  the REST envelope (`members_index/1` →
  `GrappaWeb.MembersJSON.index/1`) and the Channel event
  (`members_seeded/3` → `GrappaWeb.GrappaChannel`). Centralising the
  per-member shape here means a future change to
  `Grappa.Session.member()` (e.g. wrapping in a struct, adding an
  `:account` field) flows through ONE seam — no parallel envelopes
  to keep in lockstep.
  """
  @type member :: %{nick: String.t(), modes: [String.t()]}

  @typedoc """
  REST envelope returned by `GrappaWeb.MembersJSON.index/1`. Same
  per-member shape as the Channel `members_seeded` event — surface
  envelopes diverge intentionally (REST is a snapshot resource;
  Channel is an event broadcast carrying network/channel context),
  the per-member shape is the unification point.
  """
  @type members_index_payload :: %{members: [member()]}

  @type joined_payload :: %{
          kind: String.t(),
          network: String.t(),
          channel: String.t(),
          state: String.t()
        }

  @type window_pending_payload :: %{
          kind: String.t(),
          network: String.t(),
          channel: String.t(),
          state: String.t()
        }

  @type join_failed_payload :: %{
          kind: String.t(),
          network: String.t(),
          channel: String.t(),
          state: String.t(),
          reason: String.t() | nil,
          numeric: pos_integer() | nil
        }

  @type kicked_payload :: %{
          kind: String.t(),
          network: String.t(),
          channel: String.t(),
          state: String.t(),
          by: String.t() | nil,
          reason: String.t() | nil
        }

  @type away_confirmed_payload :: %{
          kind: String.t(),
          network: String.t(),
          state: String.t()
        }

  @type mentions_bundle_message :: %{
          server_time: integer(),
          channel: String.t(),
          sender_nick: String.t(),
          body: String.t() | nil,
          kind: String.t()
        }

  @type mentions_bundle_payload :: %{
          kind: String.t(),
          network: String.t(),
          away_started_at: String.t(),
          away_ended_at: String.t(),
          away_reason: String.t() | nil,
          messages: [mentions_bundle_message()]
        }

  @typedoc """
  WHOIS bundle — the aggregated reply to a `/whois <nick>` issued by
  the operator. Fields are populated as the corresponding numerics
  arrive (311/312/313/317/319) and the bundle is broadcast on
  `318 RPL_ENDOFWHOIS`. Every field is nullable: a stripped-down
  upstream (or a non-existent target) may emit only 318, in which case
  the bundle has only `target` populated and cic renders a "no such
  nick" surface. `channels` is the joined list from 319 RPL_WHOISCHANNELS
  (with mode prefixes preserved).
  """
  @type whois_bundle_payload :: %{
          kind: String.t(),
          network: String.t(),
          target: String.t(),
          user: String.t() | nil,
          host: String.t() | nil,
          realname: String.t() | nil,
          server: String.t() | nil,
          server_info: String.t() | nil,
          is_operator: boolean(),
          idle_seconds: integer() | nil,
          signon: integer() | nil,
          channels: [String.t()] | nil,
          # P-0a — Cluster `numeric-delegation-p0` 2026-05-13. Add-only
          # extension for 11 newly delegated WHOIS-leg numerics. cic builds
          # the human-readable strings from these typed flags per
          # `feedback_no_localized_strings_server_side`. Default false for
          # boolean flags (legacy bundles without the new numerics still
          # marshal cleanly); nil for optional strings.
          using_ssl: boolean(),
          is_registered: boolean(),
          is_admin: boolean(),
          is_services_admin: boolean(),
          is_helper: boolean(),
          is_chanop: boolean(),
          is_agent: boolean(),
          is_java: boolean(),
          umodes: String.t() | nil,
          away_message: String.t() | nil,
          actually_host: String.t() | nil,
          actually_ip: String.t() | nil
        }

  @typedoc """
  P-0b — standalone 301 RPL_AWAY ephemeral. Fires when the operator
  /msg's an away peer; upstream replies with a 301 carrying the away
  message. Server emits one event per upstream 301 (no server-side
  rate-limit / dedup — display-rate is a UI concern); cic's dm-listener
  renders an inline ephemeral row in the peer's DM window. cic owns
  the human-readable rendering per
  `feedback_no_localized_strings_server_side`.
  """
  @type peer_away_payload :: %{
          kind: String.t(),
          network: String.t(),
          peer: String.t(),
          message: String.t()
        }

  @typedoc """
  P-0e — 341 RPL_INVITING ephemeral. Fires when the operator issues
  `/invite <peer> <channel>` and upstream confirms the relay. Broadcast
  on the channel's per-channel topic (channel-scoped action confirmation
  belongs in the channel transcript). cic synthesizes an ephemeral
  inline row in the channel scrollback — NOT persisted, lost on full
  refetch (immediate-feedback signal, not audit log). cic owns the
  human-readable rendering per `feedback_no_localized_strings_server_side`.
  """
  @type invite_ack_payload :: %{
          kind: String.t(),
          network: String.t(),
          channel: String.t(),
          peer: String.t()
        }

  @typedoc """
  P-0d — LUSERS bundle. Aggregated snapshot of network state (clients,
  invisible, operators, channels, servers, local/global) folded from
  Bahamut's 7-numeric sequence (251/252/253/254/255/265/266). Emitted
  on connect-welcome AND on operator-issued `/lusers`; cic
  last-write-wins replaces the per-network snapshot. All values are
  integers (or nil for the optional 253 RPL_LUSERUNKNOWN). cic owns
  the human-readable rendering per `feedback_no_localized_strings_server_side`.
  """
  @type lusers_bundle_payload :: %{
          kind: String.t(),
          network: String.t(),
          total_users: integer() | nil,
          invisible: integer() | nil,
          servers: integer() | nil,
          operators: integer() | nil,
          unknown_connections: integer() | nil,
          channels_formed: integer() | nil,
          local_clients: integer() | nil,
          local_servers: integer() | nil,
          current_local: integer() | nil,
          max_local: integer() | nil,
          current_global: integer() | nil,
          max_global: integer() | nil
        }

  @typedoc """
  P-0c — WHOWAS bundle. Aggregated reply to operator-issued `/whowas`.
  Server emits typed structured fields only — `not_found` is the
  boolean discriminator between "history found" and "no such nickname"
  (406 ERR_WASNOSUCHNICK). When `not_found: true` the historical-user
  fields (user/host/realname/server/logoff_time) are nil; when
  `not_found: false` the most-recent historical entry is projected
  into them. cic owns the human-readable rendering per
  `feedback_no_localized_strings_server_side` — `logoff_time` ships
  as the upstream-supplied display string (Bahamut sends a localized
  ctime from `:server`'s locale; cic shows it verbatim, no parsing).
  Multi-history-entry rendering is out of MVP — the bundle exposes
  only the most-recent entry; future cluster can extend if needed.
  """
  @type whowas_bundle_payload :: %{
          kind: String.t(),
          network: String.t(),
          target: String.t(),
          user: String.t() | nil,
          host: String.t() | nil,
          realname: String.t() | nil,
          server: String.t() | nil,
          logoff_time: String.t() | nil,
          not_found: boolean()
        }

  @doc """
  Discriminator-only ping that tells cic the channel set has changed
  and to refetch via REST. Arch A6 flags this shape as a workaround
  worth replacing with `channel_added` / `channel_removed` typed
  deltas; deferred to a future cluster.
  """
  @spec channels_changed() :: channels_changed_payload()
  def channels_changed, do: %{kind: "channels_changed"}

  @doc """
  Live IRC nick change for the operator's session. Carries
  `:network_id` (NOT `:network` slug) because cic's networks store
  keys on id and the user-level topic is not network-scoped.
  """
  @spec own_nick_changed(integer(), String.t()) :: own_nick_changed_payload()
  def own_nick_changed(network_id, nick) when is_integer(network_id) and is_binary(nick) do
    %{kind: "own_nick_changed", network_id: network_id, nick: nick}
  end

  @doc """
  TOPIC change — entry shape decided by `EventRouter`'s topic cache.
  """
  @spec topic_changed(String.t(), String.t(), map()) :: topic_changed_payload()
  def topic_changed(network_slug, channel, entry)
      when is_binary(network_slug) and is_binary(channel) and is_map(entry) do
    %{kind: "topic_changed", network: network_slug, channel: channel, topic: entry}
  end

  @doc """
  Channel MODE change — entry shape decided by `EventRouter`'s modes
  cache.
  """
  @spec channel_modes_changed(String.t(), String.t(), map()) :: channel_modes_changed_payload()
  def channel_modes_changed(network_slug, channel, entry)
      when is_binary(network_slug) and is_binary(channel) and is_map(entry) do
    %{kind: "channel_modes_changed", network: network_slug, channel: channel, modes: entry}
  end

  @doc """
  Channel-creation timestamp from 329 RPL_CREATIONTIME. Emitted on
  the per-channel topic so cic's `channelCreated` store can seed
  JoinBanner's "Channel was created on …" line. The DateTime is
  projected to its ISO 8601 string at the wire boundary — every
  other consumer (`set_at` in `topic_changed`'s topic entry) does the
  same, keeping the on-wire shape Jason-encoder-trivial without
  relying on the bespoke `Jason.Encoder` derive on DateTime.
  """
  @spec channel_created(String.t(), String.t(), DateTime.t()) :: channel_created_payload()
  def channel_created(network_slug, channel, %DateTime{} = dt)
      when is_binary(network_slug) and is_binary(channel) do
    %{
      kind: "channel_created",
      network: network_slug,
      channel: channel,
      created_at: DateTime.to_iso8601(dt)
    }
  end

  @doc """
  Pre-sorted member list emitted on `366 RPL_ENDOFNAMES`. Caller is
  responsible for the mIRC-tier sort; the per-member projection
  through `member/1` does NOT re-sort. Per-member shape is funneled
  through `member/1` so REST + Channel agree on the per-row contract
  (web/S3+S4 finding, codebase review 2026-05-12).
  """
  @spec members_seeded(String.t(), String.t(), [Grappa.Session.member()]) ::
          members_seeded_payload()
  def members_seeded(network_slug, channel, members)
      when is_binary(network_slug) and is_binary(channel) and is_list(members) do
    %{
      kind: "members_seeded",
      network: network_slug,
      channel: channel,
      members: Enum.map(members, &member/1)
    }
  end

  @doc """
  Renders one `Grappa.Session.member()` to the per-member wire shape.
  Today the source `Session.member()` IS already `%{nick:, modes:}`
  so this is an identity-shaped projection — but the function is
  load-bearing for future shape changes: any drift in the source
  type (struct wrapping, extra fields, atom-set tightening) requires
  a change here AND nowhere else. CLAUDE.md "Wire conversion is
  per-context responsibility."
  """
  @spec member(Grappa.Session.member()) :: member()
  def member(%{nick: nick, modes: modes}) when is_binary(nick) and is_list(modes) do
    %{nick: nick, modes: modes}
  end

  @doc """
  Wraps a list of `Grappa.Session.member()` rows in the canonical
  REST envelope `%{members: [...]}`. The controller
  (`GrappaWeb.MembersJSON.index/1`) delegates to this verb so the
  per-member shape stays single-sourced with the Channel
  `members_seeded` event — the two surfaces unify on `member/1`.
  """
  @spec members_index([Grappa.Session.member()]) :: members_index_payload()
  def members_index(members) when is_list(members) do
    %{members: Enum.map(members, &member/1)}
  end

  @doc """
  CP15 B1 — own-nick JOIN echo received → window transitions to
  `:joined`. Same shape used at event-time AND at the
  cold-WS-subscribe snapshot push (`window_state_payload/3` calls
  this verb, NOT a re-built map).
  """
  @spec joined(String.t(), String.t()) :: joined_payload()
  def joined(network_slug, channel)
      when is_binary(network_slug) and is_binary(channel) do
    %{kind: "joined", network: network_slug, channel: channel, state: "joined"}
  end

  @doc """
  CP17 — outbound JOIN recorded as in-flight: the per-channel window
  enters `:pending` state. Broadcast on `Topic.user(...)` (NOT the
  per-channel topic), because cic only subscribes to the per-channel
  topic AFTER seeing `:pending` in `windowStateByChannel` — broadcasting
  on the per-channel topic would be chicken-and-egg. Userid-level topic
  is joined from boot via `userTopic.ts` createRoot effect, so the
  delivery is guaranteed.

  Naming convention `window_pending` (not bare `pending`) mirrors the
  existing `connection_state_changed` user-topic verb: state-change
  events on the user-topic carry a window-namespace prefix to avoid
  collision with channel-namespace verbs that share state names
  (`joined` etc.).
  """
  @spec window_pending(String.t(), String.t()) :: window_pending_payload()
  def window_pending(network_slug, channel)
      when is_binary(network_slug) and is_binary(channel) do
    %{kind: "window_pending", network: network_slug, channel: channel, state: "pending"}
  end

  @doc """
  CP15 B2 — JOIN failure numeric (471/473/474/475/403/405)
  correlated against an in-flight JOIN. Same shape used at event-
  time AND at snapshot push.
  """
  @spec join_failed(String.t(), String.t(), String.t() | nil, pos_integer() | nil) ::
          join_failed_payload()
  def join_failed(network_slug, channel, reason, numeric)
      when is_binary(network_slug) and is_binary(channel) do
    %{
      kind: "join_failed",
      network: network_slug,
      channel: channel,
      state: "failed",
      reason: reason,
      numeric: numeric
    }
  end

  @doc """
  CP15 B3 — own-target KICK observed. Window stays in the active
  sidebar (greyed) so the operator can /join to retry. Same shape
  used at event-time AND at snapshot push. `by` and `reason` are
  nullable — the snapshot path may not have recorded kick meta if
  the kick predated the WS subscribe.
  """
  @spec kicked(String.t(), String.t(), String.t() | nil, String.t() | nil) ::
          kicked_payload()
  def kicked(network_slug, channel, by, reason)
      when is_binary(network_slug) and is_binary(channel) do
    %{
      kind: "kicked",
      network: network_slug,
      channel: channel,
      state: "kicked",
      by: by,
      reason: reason
    }
  end

  @doc """
  S3.4 — `305 RPL_UNAWAY` / `306 RPL_NOWAWAY` confirmed by upstream.
  Caller passes the lowercase string literal `"present"` or
  `"away"` (the `Atom.to_string/1` conversion happens in the
  Session.Server arm so this fn stays a pure data shaper).
  """
  @spec away_confirmed(String.t(), String.t()) :: away_confirmed_payload()
  def away_confirmed(network_slug, state)
      when is_binary(network_slug) and state in ["present", "away"] do
    %{kind: "away_confirmed", network: network_slug, state: state}
  end

  @doc """
  Cross-channel mentions summary fired on auto-away → present
  transition. Per-message map is a deliberately-stripped projection
  of `Scrollback.Wire.t/0`. `Message.kind()` (atom) is converted to
  string at the Wire boundary inside this fn — callers pass
  `Message.t()` instances unchanged.
  """
  @spec mentions_bundle(String.t(), String.t(), String.t(), String.t() | nil, [Message.t()]) ::
          mentions_bundle_payload()
  def mentions_bundle(network_slug, away_started_at, away_ended_at, away_reason, messages)
      when is_binary(network_slug) and is_binary(away_started_at) and
             is_binary(away_ended_at) and is_list(messages) do
    %{
      kind: "mentions_bundle",
      network: network_slug,
      away_started_at: away_started_at,
      away_ended_at: away_ended_at,
      away_reason: away_reason,
      messages: Enum.map(messages, &project_bundle_message/1)
    }
  end

  @spec project_bundle_message(Message.t()) :: mentions_bundle_message()
  defp project_bundle_message(%Message{} = m) do
    %{
      server_time: m.server_time,
      channel: m.channel,
      sender_nick: m.sender,
      body: m.body,
      kind: Atom.to_string(m.kind)
    }
  end

  @doc """
  WHOIS aggregation — emitted by Session.Server on 318 RPL_ENDOFWHOIS
  after folding 311/312/313/317/319. The `accum` map carries the
  raw fields populated by EventRouter; this verb projects them into
  the wire shape (with `kind:` injected and missing fields normalized
  to nil / false / nil-list).

  Per spec #2: ephemeral — NOT persisted in scrollback. Broadcast on
  `Topic.user/1` and rendered inline in cic via the `whois_bundle`
  arm in `userTopic.ts`. The cic-side `whoisCard.ts` store keys by
  network and replaces on each new bundle (one card visible at a time
  per network).
  """
  @spec whois_bundle(String.t(), String.t(), map()) :: whois_bundle_payload()
  def whois_bundle(network_slug, target, accum)
      when is_binary(network_slug) and is_binary(target) and is_map(accum) do
    %{
      kind: "whois_bundle",
      network: network_slug,
      target: target,
      user: Map.get(accum, :user),
      host: Map.get(accum, :host),
      realname: Map.get(accum, :realname),
      server: Map.get(accum, :server),
      server_info: Map.get(accum, :server_info),
      is_operator: Map.get(accum, :is_operator, false),
      idle_seconds: Map.get(accum, :idle_seconds),
      signon: Map.get(accum, :signon),
      channels: Map.get(accum, :channels),
      # P-0a — 11 new WHOIS-leg flags / strings folded by EventRouter.
      # Booleans default to false; strings default to nil. cic localizes.
      using_ssl: Map.get(accum, :using_ssl, false),
      is_registered: Map.get(accum, :is_registered, false),
      is_admin: Map.get(accum, :is_admin, false),
      is_services_admin: Map.get(accum, :is_services_admin, false),
      is_helper: Map.get(accum, :is_helper, false),
      is_chanop: Map.get(accum, :is_chanop, false),
      is_agent: Map.get(accum, :is_agent, false),
      is_java: Map.get(accum, :is_java, false),
      umodes: Map.get(accum, :umodes),
      away_message: Map.get(accum, :away_message),
      actually_host: Map.get(accum, :actually_host),
      actually_ip: Map.get(accum, :actually_ip)
    }
  end

  @doc """
  P-0b — standalone 301 RPL_AWAY. Broadcast on `Topic.user/1`
  (mirroring `whois_bundle/3`'s ephemeral routing); cic's dm-listener
  arm inspects the `peer:` field and renders an inline ephemeral row
  in that peer's DM window. NOT persisted in scrollback — the away
  banner is a transient hint, not a chat message.
  """
  @spec peer_away(String.t(), String.t(), String.t()) :: peer_away_payload()
  def peer_away(network_slug, peer, message)
      when is_binary(network_slug) and is_binary(peer) and is_binary(message) do
    %{kind: "peer_away", network: network_slug, peer: peer, message: message}
  end

  @doc """
  P-0e — 341 RPL_INVITING. Broadcast on `Topic.channel/3` for the
  channel the operator was on when issuing `/invite`. cic dispatches
  in `subscribe.ts` (channel-topic event), synthesizes an ephemeral
  inline row in the channel scrollback. NOT persisted — invite-ack is
  immediate-feedback, not an audit log.
  """
  @spec invite_ack(String.t(), String.t(), String.t()) :: invite_ack_payload()
  def invite_ack(network_slug, channel, peer)
      when is_binary(network_slug) and is_binary(channel) and is_binary(peer) do
    %{kind: "invite_ack", network: network_slug, channel: channel, peer: peer}
  end

  @doc """
  P-0d — LUSERS bundle. Broadcast on `Topic.user/1`; cic dispatches in
  `userTopic.ts`'s `lusers_bundle` arm into the `lusersBundle.ts`
  store, last-write-wins replaces the per-network snapshot. NOT
  persisted — operator types /lusers to refresh; cic shows the most
  recent snapshot only.
  """
  @spec lusers_bundle(String.t(), map()) :: lusers_bundle_payload()
  def lusers_bundle(network_slug, accum)
      when is_binary(network_slug) and is_map(accum) do
    %{
      kind: "lusers_bundle",
      network: network_slug,
      total_users: Map.get(accum, :total_users),
      invisible: Map.get(accum, :invisible),
      servers: Map.get(accum, :servers),
      operators: Map.get(accum, :operators),
      unknown_connections: Map.get(accum, :unknown_connections),
      channels_formed: Map.get(accum, :channels_formed),
      local_clients: Map.get(accum, :local_clients),
      local_servers: Map.get(accum, :local_servers),
      current_local: Map.get(accum, :current_local),
      max_local: Map.get(accum, :max_local),
      current_global: Map.get(accum, :current_global),
      max_global: Map.get(accum, :max_global)
    }
  end

  @doc """
  P-0c — WHOWAS bundle. Broadcast on `Topic.user/1` (mirrors
  `whois_bundle/3` — single-entity historical-user data, ephemeral).
  cic dispatches in `userTopic.ts`'s `whowas_bundle` arm into the
  per-network `whowasCard.ts` store (last-write-wins replacement).

  `not_found: true` flags the 406 ERR_WASNOSUCHNICK case — historical
  fields stay nil and cic renders a "no history" surface. Otherwise
  the most-recent 314 RPL_WHOWASUSER entry is projected into the
  user/host/realname/server/logoff_time fields. NOT persisted —
  operator types /whowas to refresh.
  """
  @spec whowas_bundle(String.t(), String.t(), map()) :: whowas_bundle_payload()
  def whowas_bundle(network_slug, target, accum)
      when is_binary(network_slug) and is_binary(target) and is_map(accum) do
    not_found = Map.get(accum, :not_found, false)

    last_entry =
      if not_found do
        %{}
      else
        case Map.get(accum, :entries, []) do
          [] -> %{}
          # Entries are stored REVERSED by EventRouter (head = most
          # recent 314 RPL_WHOWASUSER). MVP renders only the most-
          # recent entry; multi-history is out of scope.
          [head | _] -> head
        end
      end

    %{
      kind: "whowas_bundle",
      network: network_slug,
      target: target,
      user: Map.get(last_entry, :user),
      host: Map.get(last_entry, :host),
      realname: Map.get(last_entry, :realname),
      server: Map.get(last_entry, :server),
      logoff_time: Map.get(last_entry, :logoff_time),
      not_found: not_found
    }
  end
end
