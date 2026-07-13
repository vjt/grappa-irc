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
  sender, body, kind}`. The bundle is rendered as a cross-channel
  summary view that doesn't need id/network/meta; keeping the
  divergence small but EXPLICIT in one place. REV-K M19 (2026-05-22)
  paid down the historical `sender_nick:` field name — bundle now
  uses `sender:` matching `Scrollback.Wire.t/0` so consumers handling
  both shapes use one field name.
  """

  alias Grappa.Scrollback.Message
  alias Grappa.Session.{EventRouter, ISupport}

  @typedoc """
  The closed set of event kinds emitted by Session. Useful when
  Dialyzer-typing handler dispatch tables; the on-wire form is the
  string projection of each atom (per the wire-shape rules above).
  """
  @type wire_event_kind ::
          :channels_changed
          | :own_nick_changed
          | :isupport_changed
          | :topic_changed
          | :channel_modes_changed
          | :channel_created
          | :members_seeded
          | :names_reply
          | :who_reply
          | :server_reply
          | :joined
          | :window_pending
          | :window_invited
          | :join_failed
          | :kicked
          | :away_confirmed
          | :mentions_bundle
          | :whois_bundle
          | :peer_away
          | :invite_ack
          | :lusers_bundle
          | :whowas_bundle
          | :directory_progress
          | :directory_complete
          | :directory_failed
          | :connection_progress

  @type channels_changed_payload :: %{kind: :channels_changed}

  @type own_nick_changed_payload :: %{
          kind: :own_nick_changed,
          network_id: integer(),
          nick: String.t()
        }

  @typedoc """
  Wire projection of `Grappa.Session.ISupport.t/0` (#216). Per-network
  channel-mode capability set the cic `/mode` modal drives its available
  toggles from. The four CHANMODES classes are carried as FLAT top-level
  `chanmodes_a..d` string lists (not a nested object) — every other wire
  payload is flat, and the codegen emits flat maps in a shape biome
  reflows; keeping it flat sidesteps that formatter tug-of-war. PREFIX
  stays a letter→sigil map. Rides `Topic.user/1` (ISUPPORT is
  per (subject, network), not per-channel).
  """
  @type isupport_changed_payload :: %{
          kind: :isupport_changed,
          network_id: integer(),
          chanmodes_a: [String.t()],
          chanmodes_b: [String.t()],
          chanmodes_c: [String.t()],
          chanmodes_d: [String.t()],
          prefix: %{String.t() => String.t()}
        }

  @typedoc """
  Wire projection of `EventRouter.topic_entry/0` — same fields but
  `set_at` is the ISO8601 string the JSON wire delivers (not the
  in-process `DateTime.t()`). REV-H H4: pinned at the Wire boundary
  so the contract cic narrows in `narrowTopicEntry` is single-sourced
  here instead of relying on the bespoke `Jason.Encoder` derive on
  DateTime (same model as `channel_created/3` which is the proof-of-
  pattern at line 369-376).
  """
  @type topic_entry_wire :: %{
          text: String.t() | nil,
          set_by: String.t() | nil,
          set_at: String.t() | nil
        }

  @type topic_changed_payload :: %{
          kind: :topic_changed,
          network: String.t(),
          channel: String.t(),
          topic: topic_entry_wire()
        }

  @typedoc """
  Wire projection of `EventRouter.channel_mode_entry/0`. Already JSON-
  serializable as-is (no DateTime); the alias here pins the wire-side
  shape explicitly so a future field add to the in-process cache
  must come through the Wire boundary first.
  """
  @type channel_modes_wire :: %{
          modes: [String.t()],
          params: %{String.t() => String.t() | nil}
        }

  @type channel_modes_changed_payload :: %{
          kind: :channel_modes_changed,
          network: String.t(),
          channel: String.t(),
          modes: channel_modes_wire()
        }

  @type channel_created_payload :: %{
          kind: :channel_created,
          network: String.t(),
          channel: String.t(),
          created_at: String.t()
        }

  @type members_seeded_payload :: %{
          kind: :members_seeded,
          network: String.t(),
          channel: String.t(),
          members: [member()]
        }

  @typedoc """
  #140 — ephemeral roster bundle for an EXPLICIT `/names` request.
  Same per-member shape as `members_seeded` (both funnel through
  `member/1`), but routed on the user-level topic and NOT persisted —
  it feeds cic's dismissable, grouped `namesModal`, not the sidebar
  members store. `members_seeded` (channel topic) keeps owning the
  authoritative member set; `names_reply` is a view artifact.
  """
  @type names_reply_payload :: %{
          kind: :names_reply,
          network: String.t(),
          channel: String.t(),
          members: [member()]
        }

  @typedoc """
  #169 — one parsed 352 RPL_WHOREPLY row for the /who modal. A SUPERSET of
  `member()` (adds user/host/server/hops/realname/channel). `modes` is the
  raw WHO flags string (e.g. `"H@"` = here + op), NOT the `member()`
  prefix-list — the modal renders it verbatim. `hops`/`realname` are nil
  when the RFC-violating server omits the trailing field. WHOX (354) is not
  handled; this shape leaves room for a future handler to add account etc.
  """
  @type who_user :: %{
          nick: String.t(),
          user: String.t(),
          host: String.t(),
          server: String.t(),
          modes: String.t(),
          hops: integer() | nil,
          realname: String.t() | nil,
          channel: String.t()
        }

  @typedoc """
  #169 — ephemeral WHO roster for an EXPLICIT `/who` request (channel OR
  nick target). Mirror of `names_reply_payload/0`: routed on the user-level
  topic, NOT persisted — it feeds cic's dismissable `whoModal`, never
  scrollback. `target` is the canonical /who target (channel or nick).
  """
  @type who_reply_payload :: %{
          kind: :who_reply,
          network: String.t(),
          target: String.t(),
          users: [who_user()]
        }

  @typedoc """
  #127 — the closed set of server-text-query sources that render a
  `server_reply` modal. `:info` = /INFO (371/374), `:version` =
  /VERSION (351), `:motd` = /MOTD (375/372/376/422). The atom is the
  wire discriminant cic maps to a human title + retro styling — the
  server emits NO display strings (per the no-localized-strings-server
  rule), only the typed source + the raw reply lines.
  """
  @type server_reply_source :: :info | :version | :motd

  @typedoc """
  #127 — ephemeral server-text reply for an EXPLICIT `/info`, `/version`
  or `/motd`. Mirror of `who_reply_payload/0`: routed on the user-level
  topic, NOT persisted — it feeds cic's dismissable `serverReplyModal`,
  never scrollback. Only fires when the matching command primed the
  session (connect-time MOTD stays on the `$server` window). `lines`
  are the raw reply lines in server wire order.
  """
  @type server_reply_payload :: %{
          kind: :server_reply,
          network: String.t(),
          source: server_reply_source(),
          lines: [String.t()]
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
          kind: :joined,
          network: String.t(),
          channel: String.t(),
          state: String.t()
        }

  @type window_pending_payload :: %{
          kind: :window_pending,
          network: String.t(),
          channel: String.t(),
          state: String.t()
        }

  @type window_invited_payload :: %{
          kind: :window_invited,
          network: String.t(),
          channel: String.t(),
          state: String.t()
        }

  @type join_failed_payload :: %{
          kind: :join_failed,
          network: String.t(),
          channel: String.t(),
          state: String.t(),
          reason: String.t() | nil,
          numeric: pos_integer() | nil
        }

  @type kicked_payload :: %{
          kind: :kicked,
          network: String.t(),
          channel: String.t(),
          state: String.t(),
          by: String.t() | nil,
          reason: String.t() | nil
        }

  @type away_confirmed_payload :: %{
          kind: :away_confirmed,
          network: String.t(),
          state: String.t()
        }

  @type mentions_bundle_message :: %{
          server_time: integer(),
          channel: String.t(),
          sender: String.t(),
          body: String.t() | nil,
          kind: Message.kind()
        }

  @type mentions_bundle_payload :: %{
          kind: :mentions_bundle,
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
          kind: :whois_bundle,
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
          kind: :peer_away,
          network: String.t(),
          peer: String.t(),
          message: String.t()
        }

  @typedoc """
  P-0e + P-0f — 341 RPL_INVITING ephemeral. Fires when the operator
  issues `/invite <peer> <channel>` and upstream confirms the relay.
  Broadcast on `Topic.user/1` (P-0f flipped from per-channel topic;
  operators usually invite peers to channels they are NOT in, so the
  channel-topic broadcast was silent-dropping in the common case).
  cic dispatches in `userTopic.ts`'s `invite_ack` arm and renders a
  synthetic inline row in the $server window scrollback — NOT
  persisted, lost on full refetch (immediate-feedback signal, not
  audit log). cic owns the human-readable rendering per
  `feedback_no_localized_strings_server_side`.
  """
  @type invite_ack_payload :: %{
          kind: :invite_ack,
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
          kind: :lusers_bundle,
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
          kind: :whowas_bundle,
          network: String.t(),
          target: String.t(),
          user: String.t() | nil,
          host: String.t() | nil,
          realname: String.t() | nil,
          server: String.t() | nil,
          logoff_time: String.t() | nil,
          not_found: boolean()
        }

  @typedoc """
  Channel directory (#84) refresh progress ping. Broadcast on
  `Topic.user/1` while an upstream `LIST` snapshot is streaming in:
  `count` is the running tally of 322 RPL_LIST rows ingested so far,
  emitted at most once per `directory_progress_throttle_ms`. cic's
  directory store updates a "loading N channels…" affordance. Ephemeral
  — the authoritative snapshot is served via the REST `directory` resource.
  """
  @type directory_progress_payload :: %{
          kind: :directory_progress,
          network: String.t(),
          count: non_neg_integer()
        }

  @typedoc """
  Channel directory (#84) refresh-complete ping. Broadcast on
  `Topic.user/1` when 323 RPL_LISTEND finalises the snapshot; `total`
  is the final ingested row count. cic refetches the REST `directory`
  page (the broadcast carries no rows — it's a "snapshot is fresh now"
  signal, not the data).
  """
  @type directory_complete_payload :: %{
          kind: :directory_complete,
          network: String.t(),
          total: non_neg_integer()
        }

  @typedoc """
  Channel directory (#84) refresh-failed ping. Broadcast on
  `Topic.user/1` when a refresh aborts before 323 — currently the
  watchdog timeout (`reason: "timeout"`). cic clears its in-flight
  "loading…" affordance and surfaces the failure. The prior snapshot
  (if any) is left intact in the DB; only the in-flight refresh state
  is cleared server-side.
  """
  @type directory_failed_payload :: %{
          kind: :directory_failed,
          network: String.t(),
          reason: String.t()
        }

  @typedoc """
  #100 — transient upstream-connection progress signal, PRESENTATIONAL
  ONLY. `state` is `"connecting"` while a `Session.Server` (re)spawn is
  establishing the upstream socket + registering, flipped to
  `"connected"` on `001 RPL_WELCOME`. cic mirrors it into a per-network
  "reconnecting…" sidebar badge.

  This is NOT the durable `Credential.connection_state`
  (`:connected | :parked | :failed`) — that DB state stays `:connected`
  through a transient reconnect (a crashed pid respawning is not an
  operator-intent state change; the DB/live divergence is the honesty
  signal per the CLAUDE.md invariant). The badge is an ephemeral overlay
  the server emits; cic never originates it. Broadcast on `Topic.user/1`
  (like every other network-scoped Session event) with the `network`
  slug discriminator — cic has no per-network channel to receive on.
  """
  @type connection_progress_payload :: %{
          kind: :connection_progress,
          network: String.t(),
          state: String.t()
        }

  @doc """
  Discriminator-only ping that tells cic the channel set has changed
  and to refetch via REST. Arch A6 flags this shape as a workaround
  worth replacing with `channel_added` / `channel_removed` typed
  deltas; deferred to a future cluster.
  """
  @spec channels_changed() :: channels_changed_payload()
  def channels_changed, do: %{kind: :channels_changed}

  @doc """
  Live IRC nick change for the operator's session. Carries
  `:network_id` (NOT `:network` slug) because cic's networks store
  keys on id and the user-level topic is not network-scoped.
  """
  @spec own_nick_changed(integer(), String.t()) :: own_nick_changed_payload()
  def own_nick_changed(network_id, nick) when is_integer(network_id) and is_binary(nick) do
    %{kind: :own_nick_changed, network_id: network_id, nick: nick}
  end

  @doc """
  Per-network ISUPPORT channel-mode capability set (#216). Projects
  `Grappa.Session.ISupport.t/0` to a JSON-encodable payload: the four
  CHANMODES MapSet classes become sorted lists, PREFIX stays a
  letter→sigil map. Carries `:network_id` (not slug) and rides
  `Topic.user/1` — the same rationale as `own_nick_changed/2` (per
  (subject, network) state on a non-network-scoped user topic).
  """
  @spec isupport_changed(integer(), ISupport.t()) :: isupport_changed_payload()
  def isupport_changed(network_id, %{chanmodes: cm, prefix: prefix})
      when is_integer(network_id) do
    %{
      kind: :isupport_changed,
      network_id: network_id,
      chanmodes_a: Enum.sort(cm.a),
      chanmodes_b: Enum.sort(cm.b),
      chanmodes_c: Enum.sort(cm.c),
      chanmodes_d: Enum.sort(cm.d),
      prefix: prefix
    }
  end

  @doc """
  TOPIC change — `EventRouter.topic_entry()` projected to its wire
  shape (`set_at` → ISO8601 string at the boundary, per REV-H H4).
  Mirrors the explicit-conversion pattern in `channel_created/3` so
  the cic-side `narrowTopicEntry` narrower has a single typed source
  for the field set.
  """
  @spec topic_changed(String.t(), String.t(), EventRouter.topic_entry()) ::
          topic_changed_payload()
  def topic_changed(network_slug, channel, %{} = entry)
      when is_binary(network_slug) and is_binary(channel) do
    %{
      kind: :topic_changed,
      network: network_slug,
      channel: channel,
      topic: topic_entry_wire(entry)
    }
  end

  @doc """
  Channel MODE change — `EventRouter.channel_mode_entry()` is already
  JSON-serializable, so the wire-side projection is a structural copy.
  Defining the wire type explicitly (per REV-H H4) pins the contract
  the cic-side `narrowModesEntry` narrower validates against, so any
  future field add to the in-process cache must come through this
  boundary first.
  """
  @spec channel_modes_changed(String.t(), String.t(), EventRouter.channel_mode_entry()) ::
          channel_modes_changed_payload()
  def channel_modes_changed(network_slug, channel, %{modes: modes, params: params})
      when is_binary(network_slug) and is_binary(channel) and is_list(modes) and is_map(params) do
    %{
      kind: :channel_modes_changed,
      network: network_slug,
      channel: channel,
      modes: %{modes: modes, params: params}
    }
  end

  # REV-H H4: explicit DateTime → ISO8601 conversion at the wire
  # boundary mirroring `channel_created/3` so the cic narrower sees
  # a stable string and we don't rely on Jason.Encoder derive on
  # DateTime.
  @spec topic_entry_wire(EventRouter.topic_entry()) :: topic_entry_wire()
  defp topic_entry_wire(%{text: text, set_by: set_by, set_at: set_at})
       when (is_binary(text) or is_nil(text)) and
              (is_binary(set_by) or is_nil(set_by)) do
    %{
      text: text,
      set_by: set_by,
      set_at: encode_set_at(set_at)
    }
  end

  defp encode_set_at(nil), do: nil
  defp encode_set_at(%DateTime{} = dt), do: DateTime.to_iso8601(dt)

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
      kind: :channel_created,
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
      kind: :members_seeded,
      network: network_slug,
      channel: channel,
      members: Enum.map(members, &member/1)
    }
  end

  @doc """
  #140 — projects a completed `/names` roster onto the wire. Same
  `member/1` per-row contract as `members_seeded/3` (one roster shape
  across the seed event and the /names modal); the caller
  (`Session.Server.apply_effects/2`) is responsible for the mIRC-tier
  sort, `member/1` does NOT re-sort. Broadcast on the user-level topic,
  ephemeral — see `names_reply_payload/0`.
  """
  @spec names_reply(String.t(), String.t(), [Grappa.Session.member()]) ::
          names_reply_payload()
  def names_reply(network_slug, channel, members)
      when is_binary(network_slug) and is_binary(channel) and is_list(members) do
    %{
      kind: :names_reply,
      network: network_slug,
      channel: channel,
      members: Enum.map(members, &member/1)
    }
  end

  @doc """
  #169 — build the ephemeral `/who` roster payload (315 RPL_ENDOFWHO drain).
  Mirror of `names_reply/3`: user-level topic, ephemeral — see
  `who_reply_payload/0`. Each row is projected through `who_user/1` so the
  wire shape stays single-sourced and JSON-safe.
  """
  @spec who_reply(String.t(), String.t(), [map()]) :: who_reply_payload()
  def who_reply(network_slug, target, users)
      when is_binary(network_slug) and is_binary(target) and is_list(users) do
    %{
      kind: :who_reply,
      network: network_slug,
      target: target,
      users: Enum.map(users, &who_user/1)
    }
  end

  @doc """
  #127 — build the ephemeral `/info`, `/version` or `/motd` reply payload
  (drained on the terminator numeric). Mirror of `who_reply/3`: user-level
  topic, ephemeral — see `server_reply_payload/0`. `source` is the typed
  discriminant; `lines` are the raw reply lines in server wire order. cic
  owns the human title + rendering.
  """
  @spec server_reply(String.t(), server_reply_source(), [String.t()]) ::
          server_reply_payload()
  def server_reply(network_slug, source, lines)
      when is_binary(network_slug) and source in [:info, :version, :motd] and
             is_list(lines) do
    %{
      kind: :server_reply,
      network: network_slug,
      source: source,
      lines: lines
    }
  end

  @doc """
  #169 — renders one parsed WHO row (`who_pending` reply map) to the
  per-user wire shape. Explicit field projection (like `member/1`): any
  drift in the source row requires a change HERE and nowhere else. `modes`
  is the raw WHO flags string; `hops`/`realname` may be nil.
  """
  @spec who_user(map()) :: who_user()
  def who_user(%{
        nick: nick,
        user: user,
        host: host,
        server: server,
        modes: modes,
        hops: hops,
        realname: realname,
        channel: channel
      })
      when is_binary(nick) and is_binary(user) and is_binary(host) and
             is_binary(server) and is_binary(modes) and is_binary(channel) do
    %{
      nick: nick,
      user: user,
      host: host,
      server: server,
      modes: modes,
      hops: hops,
      realname: realname,
      channel: channel
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
    %{kind: :joined, network: network_slug, channel: channel, state: "joined"}
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
    %{kind: :window_pending, network: network_slug, channel: channel, state: "pending"}
  end

  @doc """
  #78 — inbound INVITE to a channel we are NOT joined to surfaces an
  `:invited` window (a not-joined, greyed sidebar tab the operator can
  `/join` on their own time). Broadcast on `Topic.user(...)` for the same
  chicken-and-egg reason as `window_pending/2`: cic only subscribes to the
  per-channel topic AFTER seeing the state in `windowStateByChannel`, and
  the user-topic is joined from boot so delivery is guaranteed. Same
  `window_`-namespaced naming convention.
  """
  @spec window_invited(String.t(), String.t()) :: window_invited_payload()
  def window_invited(network_slug, channel)
      when is_binary(network_slug) and is_binary(channel) do
    %{kind: :window_invited, network: network_slug, channel: channel, state: "invited"}
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
      kind: :join_failed,
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
      kind: :kicked,
      network: network_slug,
      channel: channel,
      state: "kicked",
      by: by,
      reason: reason
    }
  end

  @doc """
  S3.4 — `305 RPL_UNAWAY` / `306 RPL_NOWAWAY` confirmed by upstream.

  Caller passes the closed-set `:present | :away` atom (the
  EventRouter effect-tuple shape — `{:away_confirmed, :present |
  :away}`). The atom-to-string conversion happens HERE at the wire
  boundary mirroring `Scrollback.Wire.to_json/1`'s
  `Atom.to_string(m.kind)` — keeps Session.Server free of
  presentation-shape concerns, and a fourth `:away`-class atom
  surfaces as a FunctionClauseError at the boundary instead of
  silently shipping `to_string(:unexpected)` over the wire.
  """
  @spec away_confirmed(String.t(), :present | :away) :: away_confirmed_payload()
  def away_confirmed(network_slug, state)
      when is_binary(network_slug) and state in [:present, :away] do
    %{kind: :away_confirmed, network: network_slug, state: Atom.to_string(state)}
  end

  @doc """
  Cross-channel mentions summary fired on auto-away → present
  transition. Per-message map is a deliberately-stripped projection
  of `Scrollback.Wire.t/0`. `Message.kind()` (atom) passes through the
  Wire boundary unchanged (Jason stringifies at the JSON edge) so
  codegen pins the same literal union — callers pass `Message.t()`
  instances unchanged (S14).
  """
  @spec mentions_bundle(String.t(), String.t(), String.t(), String.t() | nil, [Message.t()]) ::
          mentions_bundle_payload()
  def mentions_bundle(network_slug, away_started_at, away_ended_at, away_reason, messages)
      when is_binary(network_slug) and is_binary(away_started_at) and
             is_binary(away_ended_at) and is_list(messages) do
    %{
      kind: :mentions_bundle,
      network: network_slug,
      away_started_at: away_started_at,
      away_ended_at: away_ended_at,
      away_reason: away_reason,
      messages: Enum.map(messages, &project_bundle_message/1)
    }
  end

  @spec project_bundle_message(Message.t()) :: mentions_bundle_message()
  defp project_bundle_message(%Message{kind: kind} = m) when kind != nil do
    %{
      server_time: m.server_time,
      channel: m.channel,
      sender: m.sender,
      body: m.body,
      # S14 consistency: this sibling Message-kind projection passes the
      # atom through (Jason stringifies) so codegen pins the same literal
      # union as `Scrollback.Wire.t/0`, not a widened `String.t()`.
      kind: kind
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
      kind: :whois_bundle,
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
    %{kind: :peer_away, network: network_slug, peer: peer, message: message}
  end

  @doc """
  P-0e + P-0f — 341 RPL_INVITING. Broadcast on `Topic.user/1` (P-0f
  flipped from per-channel topic — operators usually invite peers to
  channels they are NOT in, dropping the channel-topic broadcast on
  the floor in the common case). cic dispatches in `userTopic.ts`'s
  `invite_ack` arm, appends to the per-network store keyed on the
  target channel, and `InviteAckRows` renders synthetic inline rows
  in the $server window scrollback. NOT persisted — invite-ack is
  immediate-feedback, not an audit log.
  """
  @spec invite_ack(String.t(), String.t(), String.t()) :: invite_ack_payload()
  def invite_ack(network_slug, channel, peer)
      when is_binary(network_slug) and is_binary(channel) and is_binary(peer) do
    %{kind: :invite_ack, network: network_slug, channel: channel, peer: peer}
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
      kind: :lusers_bundle,
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
      kind: :whowas_bundle,
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

  @doc """
  Channel directory (#84) progress ping — `count` 322 rows ingested so
  far during an in-flight `LIST` refresh. Broadcast on `Topic.user/1`,
  throttled by `directory_progress_throttle_ms`. cic owns the
  human-readable "loading N channels…" rendering.
  """
  @spec directory_progress(String.t(), non_neg_integer()) :: directory_progress_payload()
  def directory_progress(network_slug, count)
      when is_binary(network_slug) and is_integer(count) and count >= 0 do
    %{kind: :directory_progress, network: network_slug, count: count}
  end

  @doc """
  Channel directory (#84) complete ping — `total` rows in the finalised
  snapshot. Broadcast on `Topic.user/1` on 323 RPL_LISTEND. Carries no
  rows; cic refetches the REST `directory` resource on receipt.
  """
  @spec directory_complete(String.t(), non_neg_integer()) :: directory_complete_payload()
  def directory_complete(network_slug, total)
      when is_binary(network_slug) and is_integer(total) and total >= 0 do
    %{kind: :directory_complete, network: network_slug, total: total}
  end

  @doc """
  Channel directory (#84) failed ping — `reason` is the abort cause
  (`"timeout"` for the watchdog). Broadcast on `Topic.user/1`; cic
  clears the in-flight loading affordance. The prior DB snapshot is
  left intact.
  """
  @spec directory_failed(String.t(), String.t()) :: directory_failed_payload()
  def directory_failed(network_slug, reason)
      when is_binary(network_slug) and is_binary(reason) do
    %{kind: :directory_failed, network: network_slug, reason: reason}
  end

  @doc """
  #100 — transient connection-progress signal for the cic reconnecting
  badge. `state` ∈ `:connecting | :connected`; serialized to the string
  the wire carries (mirrors `away_confirmed/2`'s atom→string projection).
  See `t:connection_progress_payload/0` for why this is distinct from the
  DB `connection_state`.
  """
  @spec connection_progress(String.t(), :connecting | :connected) ::
          connection_progress_payload()
  def connection_progress(network_slug, state)
      when is_binary(network_slug) and state in [:connecting, :connected] do
    %{kind: :connection_progress, network: network_slug, state: Atom.to_string(state)}
  end
end
