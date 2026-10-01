defmodule Grappa.Scrollback.Wire do
  @moduledoc """
  Single source of truth for the public wire shape of
  `Grappa.Scrollback.Message` rows + the broadcast event that wraps
  them.

  Three doors emit this contract today: REST (`MessagesJSON`),
  PubSub (`MessagesController` + `Session.Server` broadcasts), and
  Phoenix.Channel pushes (consumed verbatim by `GrappaChannel`).
  Phase 6 IRCv3 `CHATHISTORY` listener will be the fourth — different
  serializer (IRC bytes, not JSON) but same domain event. Centralising
  the shape here separates "data" (`Scrollback.Message` schema) from
  "verb" (this module's `to_json/1,2` and `message_payload/2`).

  ## Where the slug comes from, and why there are two doors (#1657b)

  The wire's `:network` is a **slug**, and a caller reaches it one of
  two ways. `to_json/2` TAKES it; `to_json/1` DERIVES it from a
  preloaded `:network` assoc. One body, two entrances — not two
  shapes.

  Which door a caller uses is decided by what it already holds, and
  that is not a style choice:

    * A **read** path (`MessagesJSON`) receives rows out of a query
      that preloaded `:network` as part of the same fetch, and its
      render function is handed nothing but the rows. It has no slug
      of its own, so it uses `to_json/1`.
    * A **broadcast** path always knows the slug already — it is in
      the topic it is about to publish on. `Persistor` computes
      `Topic.channel(…, ctx.network_slug, …)` on the line above the
      payload. So `message_payload/2` takes it, and there is no
      1-arity: making the write path re-derive a value sitting in the
      adjacent expression cost `Scrollback.persist_event/1` a whole
      extra DB round-trip per row, and cost the #1429 census its
      honesty when that round-trip failed (see `Scrollback.persist_row/1`).

  `to_json/1` pattern-matches and crashes loudly if the assoc is
  unloaded — invariant violation worth crashing on, per CLAUDE.md
  "let it crash." That is the read-path contract, unchanged.

  ## Phase 2 sub-task 2e — wire-shape changes

    * The wire emits the network **slug** (string) under key
      `:network`, NOT the integer `network_id` FK.
    * The wire does NOT carry `user_id` (decision G3). The user
      identity is a topic discriminator (in the PubSub topic string
      and the channel join URL), not a payload field — the client
      already knows who it is from `/me`. Leaking user_id into the
      payload would also cross the per-user iso boundary.

  Adding a field to a Message row that should appear on the wire =
  one edit here. Removing a field = breaking change visible at this
  one site.
  """

  alias Grappa.Networks.Network
  alias Grappa.Scrollback
  alias Grappa.Scrollback.{Message, Meta}

  @typedoc """
  One scrollback row. `dm_conversation_id` (issue 1365 leg 2, protocol 34)
  names the DM conversation the row belongs to, BESIDE `channel` and
  `sender`, which keep their meaning. It is `null` on every row that is not
  in a DM — channels, `$server` — and on the one DM class leg 1 could not
  attribute (an inbound DM written before the field, keyed on our own nick
  with no `dm_with`).

  It is `optional` because a server predating protocol 34 omits it; absent
  and `null` are different statements, and a client must reject neither.

  `dm_with` (issue 1365, protocol 36) is the column verbatim: RAW, `nil` off
  a DM — the same field, name and optionality the away bundle's row carries
  (`Grappa.Session.Wire.mentions_bundle_message`, issue 2333). It is what
  "is this row a DM?" reads (`Message.dm?/1`, cic `pushTriggers.ts`), and it
  is the one DM fact a nick change never rewrites: an inbound DM's `channel`
  is the nick WE held at receipt, which goes stale on our first rename.
  """
  @type t :: %{
          required(:id) => integer(),
          required(:network) => String.t(),
          required(:channel) => String.t(),
          required(:server_time) => integer(),
          required(:kind) => Message.kind(),
          required(:sender) => String.t(),
          required(:body) => String.t() | nil,
          required(:meta) => Meta.t(),
          optional(:dm_conversation_id) => integer() | nil,
          optional(:dm_with) => String.t() | nil
        }

  @type event :: %{kind: :message, message: t()}

  @typedoc """
  Per-target archive entry — public wire shape returned by
  `GrappaWeb.ArchiveJSON.index/1`. The `:kind` atom (`:channel |
  :query`) passes through UNCHANGED (Jason stringifies at the JSON
  edge), so the typed contract keeps the closed atom union and
  `mix grappa.gen_wire_types` pins the literal TS union
  (`"channel" | "query"`) — same S14 convention as the message
  `:kind` in `t/0`. See `archive_entry/1`.

  Carried `row_count` until #1626 (protocol v8), which removed it. It is
  the first field this wire has ever taken back, and the removal is the
  cure rather than a tidy-up: an exact per-group count has to visit the
  group's rows, so while it was emitted the archive listing stayed bound
  to the size of the account instead of to its number of targets. See
  `Grappa.Scrollback.list_archive/3` and `Grappa.Protocol`.
  """
  @type archive_wire_entry :: %{
          target: String.t(),
          kind: :channel | :query,
          last_activity: integer()
        }

  @typedoc """
  Top-level envelope for the per-network archive REST response — the
  wire shape returned by `Scrollback.list_archive/3` once funneled
  through `archive_index/1`. Single source of truth for the JSON
  shape; the controller delegates rather than rebuilding.
  """
  @type archive_wire_index :: %{archive: [archive_wire_entry()]}

  @doc """
  Renders a `Grappa.Scrollback.Message` row to its public JSON wire
  shape. The `:network` association MUST be preloaded — pattern match
  fails loudly otherwise. Adding a field to the wire requires
  extending the schema first, then this function and `t/0`.

  ## kind — atom passes through, codegen pins the literal union (S14)

  `Message.kind` is an `Ecto.Enum` over `@kinds` (atom values).
  `Jason.encode!/1` converts atom values to JSON strings on its own,
  so the wire ALWAYS ships a string. `t/0` declares `kind:
  Message.kind()` — the closed atom union — and `to_json/1` passes the
  atom through UNCHANGED (Jason stringifies at the JSON boundary,
  identical bytes to `Atom.to_string/1`). This is the
  `server_reply_source` precedent (`Grappa.Session.Wire`): keep the
  atom in the typed contract so `mix grappa.gen_wire_types` emits a
  LITERAL string union (`"privmsg" | "notice" | ...`) that cic asserts
  against, instead of the `kind: String.t()` widening that erased the
  closed set from codegen (review S14). Superseding the earlier B6.3
  `Atom.to_string(m.kind)` boundary: that produced a `String.t()` value
  Dialyzer could not type as a union, defeating the codegen gate — the
  atom-through form is strictly stronger (Dialyzer reads the union AND
  codegen pins it). `archive_entry/1` follows the SAME S14 convention:
  its `:channel | :query` kind passes through unchanged so
  `archive_wire_entry.kind` codegens as the `"channel" | "query"`
  literal union rather than a bare `string`.
  """
  @spec to_json(Message.t()) :: t()
  def to_json(%Message{network: %Network{slug: slug}} = m), do: to_json(m, slug)

  @doc """
  As `to_json/1`, with the network slug supplied by the caller instead
  of read off a preloaded `:network` assoc.

  This is the body both doors share; `to_json/1` is the read-path
  entrance that derives `slug` and delegates here. See the moduledoc
  for which caller owes which.
  """
  @spec to_json(Message.t(), String.t()) :: t()
  def to_json(%Message{kind: kind} = m, slug) when kind != nil and is_binary(slug) do
    %{
      id: m.id,
      network: slug,
      channel: m.channel,
      server_time: m.server_time,
      kind: kind,
      sender: m.sender,
      body: m.body,
      meta: m.meta,
      dm_conversation_id: m.dm_conversation_id,
      dm_with: m.dm_with
    }
  end

  @doc """
  Wraps a `Message` row as the canonical broadcast event payload —
  the inner map of the `"event"` push delivered to cicchetto via
  `GrappaWeb.GrappaChannel`.

  Use this with `Grappa.PubSub.broadcast_event/2`:

      Grappa.PubSub.broadcast_event(topic, Wire.message_payload(message, slug))

  The caller supplies the network slug. There is deliberately **no
  1-arity form** (#1657b): every broadcast door already holds the slug
  — it is in the topic it is publishing on — so a variant that read it
  back off a preloaded assoc would only re-create the extra DB
  round-trip this removed. See the moduledoc.

  Renamed from `message_event/1` (which returned the legacy `{:event,
  payload}` tuple shape used with raw `Phoenix.PubSub.broadcast/3`)
  when BUG 6 forced a switch to the framework-native fastlane path.
  See `Grappa.PubSub.broadcast_event/2` for the new broadcast surface.
  """
  @spec message_payload(Message.t(), String.t()) :: event()
  def message_payload(%Message{} = m, network_slug) when is_binary(network_slug) do
    %{kind: :message, message: to_json(m, network_slug)}
  end

  @doc """
  Renders one `Scrollback.archive_entry()` to its public wire shape.
  The `:kind` atom (`:channel | :query`) passes through UNCHANGED —
  Jason stringifies it at the JSON edge (identical bytes to the former
  `Atom.to_string/1`), so the typed contract keeps the closed union
  and codegen pins the `"channel" | "query"` literal (S14; see `t/0`'s
  `:kind`). The schema-level keys (atoms) match the rest of the wire
  surface — `Jason` encodes atom-keyed maps to string-keyed JSON
  natively.
  """
  @spec archive_entry(Scrollback.archive_entry()) :: archive_wire_entry()
  def archive_entry(%{target: target, kind: kind, last_activity: last_activity})
      when kind in [:channel, :query] do
    %{
      target: target,
      kind: kind,
      last_activity: last_activity
    }
  end

  @doc """
  Wraps a list of `Scrollback.archive_entry()` rows as the canonical
  REST envelope `%{archive: [archive_entry()]}`. The controller
  (`GrappaWeb.ArchiveJSON.index/1`) delegates to this verb so wire
  shape stays single-sourced — adding a field to the per-target
  entry = one edit in `archive_entry/1`.
  """
  @spec archive_index([Scrollback.archive_entry()]) :: archive_wire_index()
  def archive_index(entries) when is_list(entries) do
    %{archive: Enum.map(entries, &archive_entry/1)}
  end

  @typedoc """
  UX-1 (2026-05-17) — `archive_changed` push payload broadcast on
  `Topic.user(subject_label)` after a successful archive-entry mutation
  that affects the network's archive LIST shape (e.g. PART moves a
  channel from active → archive). Carries `network_slug` so the cic
  dispatcher knows which per-network archive section to refresh; cic
  re-fetches via `loadArchive(network_slug)` rather than rendering an
  embedded delta (small, simple, idempotent — re-arriving the broadcast
  on reconnect is a no-op).

  No `target` field on purpose — for archive-list refreshes, the delete
  is fait accompli on the server; cic's local archive cache for that
  network is stale until the refresh lands, but the only loss is briefly
  stale row counts. Sending the target would tempt cic-side optimistic
  patches that drift from server truth.

  For the DESTRUCTIVE archive-delete path (which also purges scrollback
  rows for the target), see `archive_purged_payload/2` — separate event
  kind so cic can fan into the cache-invalidation arm WITHOUT widening
  this envelope.
  """
  @type archive_changed_payload :: %{kind: :archive_changed, network_slug: String.t()}

  @doc """
  Build the `archive_changed` event envelope for a network slug —
  used by `ChannelsController.delete/2` (PART) to notify connected
  cic tabs that the archive section for this network needs a refresh.
  """
  @spec archive_changed_payload(String.t()) :: archive_changed_payload()
  def archive_changed_payload(network_slug) when is_binary(network_slug) do
    %{kind: :archive_changed, network_slug: network_slug}
  end

  @typedoc """
  UX-7-B (2026-05-22) — `archive_purged` push payload broadcast on
  `Topic.user(subject_label)` after a successful
  `DELETE /networks/:slug/archive/:target` (i.e. the operator dropped
  scrollback rows for the target). Carries `network_slug` + `target` so
  cic can BOTH:
    (a) invalidate the in-memory `scrollbackByChannel[key]` for the
        target — without this the pre-delete rows persist in the live
        Solid store and reappear on re-JOIN (the `refreshScrollback`
        cursor is the high-water mark, which is already past every
        deleted row); AND
    (b) refresh the per-network archive section (same shape as
        `archive_changed` — `loadArchive(network_slug)`).

  Separate event kind from `archive_changed` so a cic-side handler
  can distinguish "archive list shape moved" (PART) from "history was
  destructively purged" (DELETE). Conflating them under one kind would
  either over-invalidate (PART would wrongly drop scrollback the user
  expects to see on re-JOIN) or under-invalidate (DELETE without
  target would leak ghosts — the original bug).
  """
  @type archive_purged_payload :: %{
          kind: :archive_purged,
          network_slug: String.t(),
          target: String.t()
        }

  @doc """
  Build the `archive_purged` event envelope for a `(network_slug,
  target)` pair — used by `ArchiveController.delete/2` after a
  destructive purge of scrollback rows.
  """
  @spec archive_purged_payload(String.t(), String.t()) :: archive_purged_payload()
  def archive_purged_payload(network_slug, target)
      when is_binary(network_slug) and is_binary(target) do
    %{kind: :archive_purged, network_slug: network_slug, target: target}
  end
end
