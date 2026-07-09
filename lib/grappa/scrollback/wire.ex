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
  "verb" (this module's `to_json/1` and `message_payload/1`).

  ## Phase 2 sub-task 2e — wire-shape changes

    * The wire emits the network **slug** (string) under key
      `:network`, NOT the integer `network_id` FK. Callers must
      preload `:network` on the message before calling `to_json/1`;
      the function pattern-matches and crashes loudly if the assoc
      is unloaded — invariant violation worth crashing on, per
      CLAUDE.md "let it crash."
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

  @type t :: %{
          id: integer(),
          network: String.t(),
          channel: String.t(),
          server_time: integer(),
          kind: Message.kind(),
          sender: String.t(),
          body: String.t() | nil,
          meta: Meta.t()
        }

  @type event :: %{kind: String.t(), message: t()}

  @typedoc """
  Per-target archive entry — public wire shape returned by
  `GrappaWeb.ArchiveJSON.index/1`. The `:kind` atom (`:channel |
  :query`) is converted to its string projection at the wire
  boundary, mirroring the `kind: STRING JSON-wire convention`
  documented in `Grappa.Session.Wire` — closed atom sets stringify
  here so cic never observes Elixir-specific values.
  """
  @type archive_wire_entry :: %{
          target: String.t(),
          kind: String.t(),
          last_activity: integer(),
          row_count: non_neg_integer()
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
  codegen pins it). `archive_entry/1` keeps its own `Atom.to_string/1`
  because its `:channel | :query` set is not a `Message.kind()` and has
  no generated counterpart.
  """
  @spec to_json(Message.t()) :: t()
  def to_json(%Message{network: %Network{slug: slug}, kind: kind} = m) when kind != nil do
    %{
      id: m.id,
      network: slug,
      channel: m.channel,
      server_time: m.server_time,
      kind: kind,
      sender: m.sender,
      body: m.body,
      meta: m.meta
    }
  end

  @doc """
  Wraps a `Message` row as the canonical broadcast event payload —
  the inner map of the `"event"` push delivered to cicchetto via
  `GrappaWeb.GrappaChannel`.

  Use this with `Grappa.PubSub.broadcast_event/2`:

      Grappa.PubSub.broadcast_event(topic, Wire.message_payload(message))

  The caller is responsible for preloading `:network` before calling.

  Renamed from `message_event/1` (which returned the legacy `{:event,
  payload}` tuple shape used with raw `Phoenix.PubSub.broadcast/3`)
  when BUG 6 forced a switch to the framework-native fastlane path.
  See `Grappa.PubSub.broadcast_event/2` for the new broadcast surface.
  """
  @spec message_payload(Message.t()) :: event()
  def message_payload(%Message{} = m) do
    %{kind: "message", message: to_json(m)}
  end

  @doc """
  Renders one `Scrollback.archive_entry()` to its public wire shape.
  Atom-stringifies `:kind` (`:channel | :query` → `"channel" |
  "query"`) so cic doesn't see Elixir-specific values; same
  convention as `Session.Wire`. The schema-level keys (atoms) match
  the rest of the wire surface — `Jason` encodes atom-keyed maps to
  string-keyed JSON natively.
  """
  @spec archive_entry(Scrollback.archive_entry()) :: archive_wire_entry()
  def archive_entry(%{target: target, kind: kind, last_activity: last_activity, row_count: row_count})
      when is_atom(kind) do
    %{
      target: target,
      kind: Atom.to_string(kind),
      last_activity: last_activity,
      row_count: row_count
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
  @type archive_changed_payload :: %{kind: String.t(), network_slug: String.t()}

  @doc """
  Build the `archive_changed` event envelope for a network slug —
  used by `ChannelsController.delete/2` (PART) to notify connected
  cic tabs that the archive section for this network needs a refresh.
  """
  @spec archive_changed_payload(String.t()) :: archive_changed_payload()
  def archive_changed_payload(network_slug) when is_binary(network_slug) do
    %{kind: "archive_changed", network_slug: network_slug}
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
          kind: String.t(),
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
    %{kind: "archive_purged", network_slug: network_slug, target: target}
  end
end
