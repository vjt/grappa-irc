defmodule Grappa.Scrollback do
  @moduledoc """
  Bouncer-owned scrollback persistence — the only sanctioned write/read
  surface for the `messages` table. Internal schema (`Grappa.Scrollback.Message`)
  stays encapsulated; callers never `Repo.insert/2` directly.

  ## Per-user iso (Phase 2 sub-task 2e)

  Every row carries `user_id` (FK → `users.id`) and `network_id` (FK →
  `networks.id`). `fetch/5` filters on the `(user_id, network_id,
  channel)` triple so alice's `GET /messages` on a shared channel does
  NOT see vjt's messages — even though both users' Sessions write to
  the same `(network, channel)` row stream. The composite index
  `messages_user_id_network_id_channel_server_time_index` makes this a
  single index scan.

  The schema is shaped so a future `CHATHISTORY` listener facade is a
  mechanical query translation, not a redesign:

    * monotonic `id` provides stable ordering inside a single
      `server_time` (epoch milliseconds; collisions are rare in Phase 1
      but cannot be assumed away).
    * `(user_id, network_id, channel, server_time)` index makes
      per-channel DESC paginated lookup cheap.

  Pagination uses a strict-less-than `before` cursor on `server_time`.
  The DESC `id` secondary sort makes intra-page order deterministic, but
  two rows with identical `server_time` straddling a page boundary can
  still be lost or duplicated by the cursor. Phase 6 will switch to a
  `(server_time, msgid)` tuple cursor when the IRCv3 `message-tags` cap
  lands; the column is additive — no migration to the existing index is
  needed.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Accounts, Grappa.IRC, Grappa.Repo],
    # `Networks.Network` is referenced by `Scrollback.Message` (the
    # `belongs_to :network` association) and `Scrollback.Wire` (the
    # `%Network{slug: _}` pattern that A1+A26 made the wire-shape
    # contract). `Visitors.Visitor` is referenced by `Scrollback.Message`
    # (the Task 4 `belongs_to :visitor` association). Declaring those
    # refs as dirty xrefs lets two cycle inversions land without
    # transitive cycles: Cluster 2's Networks → Session (which would
    # close `Scrollback → Networks → Session → Scrollback`) and the
    # visitor-auth cluster's Visitors → Networks (which would close
    # `Scrollback → Visitors → Networks → Scrollback` and
    # `Scrollback → Visitors → Networks → Session → Scrollback`).
    # The struct-only nature of both deps means we lose Boundary
    # checks on a use case Boundary couldn't help with anyway
    # (struct field access doesn't go through any function call we'd
    # want to gate); the cost is intentional.
    dirty_xrefs: [Grappa.Networks.Network, Grappa.Visitors.Visitor],
    exports: [Message, Wire]

  import Ecto.Query

  alias Grappa.Repo
  alias Grappa.Scrollback.{Message, Meta}

  @max_limit 500

  @doc """
  Maximum rows returned by a single `fetch/5` call.

  Exposed so callers (REST controller, Phoenix Channel handler, Phase 6
  CHATHISTORY listener) can clamp their own page-size negotiation
  upstream rather than guessing.

  The spec returns the literal `@max_limit` rather than `pos_integer()`
  so Dialyzer's `:underspecs` flag (mandated by mix.exs) doesn't flag
  the helper as wider-than-actual. If the cap moves, update both.
  """
  @spec max_page_size() :: unquote(@max_limit)
  def max_page_size, do: @max_limit

  @doc """
  Persists a scrollback row of arbitrary kind. Takes the full attribute
  map explicitly — no defaulting, no implicit current-time read. Caller
  is responsible for `:server_time` (epoch ms) and `:meta` (`%{}` for
  kinds without event-specific payload).

  The returned row has `:network` preloaded so callers can hand it
  straight to `Grappa.Scrollback.Wire.message_payload/1` (which
  pattern-matches on `%Network{slug: _}` and crashes on unloaded assoc).
  Single source for the wire-shape contract — every door (REST,
  PubSub, future Phase 6 listener) goes through here.

  Body validation per-kind is enforced by `Message.changeset/2`:
  `:privmsg | :notice | :action | :topic` require non-nil body;
  `:join | :part | :quit | :nick_change | :mode | :kick` accept
  `body: nil` (presence kinds + state changes).
  """
  @spec persist_event(%{
          optional(:user_id) => Ecto.UUID.t(),
          optional(:visitor_id) => Ecto.UUID.t(),
          optional(:dm_with) => String.t() | nil,
          required(:network_id) => integer(),
          required(:channel) => String.t(),
          required(:server_time) => integer(),
          required(:kind) => Message.kind(),
          required(:sender) => String.t(),
          required(:body) => String.t() | nil,
          required(:meta) => Meta.t()
        }) :: {:ok, Message.t()} | {:error, Ecto.Changeset.t()}
  def persist_event(%{kind: kind} = attrs) when is_atom(kind) do
    changeset = Message.changeset(%Message{}, attrs)

    case Repo.insert(changeset) do
      {:ok, message} -> {:ok, Repo.preload(message, :network)}
      {:error, _} = err -> err
    end
  end

  @doc """
  CP14 B3 — derive the normalized "DM peer" for a (target, sender,
  own_nick) triple. Returns the peer nick (binary) if the triple is a
  DM exchange between `own_nick` and a peer; `nil` if the triple is a
  channel message, a $server-window message, or any other non-DM
  shape. Caller passes the result as `:dm_with` in the
  `persist_event/1` attrs map; the field is ignored by the schema for
  non-PRIVMSG kinds (they always get `nil` here regardless).

  Rules (PRIVMSG / ACTION only — services and server NOTICEs use the
  `$server` window, never a DM):

    * Inbound:  target == own_nick (case-insensitive) → peer = sender
    * Outbound: sender == own_nick (case-insensitive) AND target is
      nick-shaped (no `#`/`&`/`!`/`+` sigil and not "$server") →
      peer = target
    * Otherwise: nil

  `own_nick` may be nil briefly during connection setup before
  registration assigns the negotiated nick — guard against it here so
  EventRouter's `state.nick` doesn't have to nil-check at every call
  site.

  Single source of truth for the DM-detection predicate so the
  EventRouter inbound path and the Session.Server outbound path stay
  byte-aligned (CLAUDE.md "implement once, reuse everywhere").
  """
  @spec dm_peer(Message.kind(), String.t(), String.t(), String.t() | nil) :: String.t() | nil
  def dm_peer(kind, target, sender, own_nick)
      when kind in [:privmsg, :action] and is_binary(target) and is_binary(sender) and
             is_binary(own_nick) do
    own = String.downcase(own_nick)

    cond do
      String.downcase(target) == own -> sender
      String.downcase(sender) == own and nick_shaped?(target) -> target
      true -> nil
    end
  end

  def dm_peer(_, _, _, _), do: nil

  defp nick_shaped?("$server"), do: false

  defp nick_shaped?(<<sigil::utf8, _::binary>>) when sigil in [?#, ?&, ?!, ?+],
    do: false

  defp nick_shaped?(_), do: true

  @doc """
  Fetches up to `limit` messages for `(subject, network_id, channel)`,
  ordered by `server_time` DESC then `id` DESC (stable inside same-ms
  ties). The subject filter is the central per-subject iso boundary —
  see moduledoc.

  `subject` discriminated union (Task 4 + 30):

    * `{:user, user_id}` — partitions on `m.user_id == ^user_id`.
    * `{:visitor, visitor_id}` — partitions on `m.visitor_id == ^visitor_id`.

  When `before` is an integer, only rows with `server_time < before` are
  returned. When `nil`, returns the latest page.

  `limit` must be a positive integer; non-positive values raise
  `FunctionClauseError` (caller bug, let it crash per CLAUDE.md OTP
  rules). Values above `max_page_size/0` are silently clamped to the
  max as an anti-DoS guard for the REST surface.

  Returned rows have `:network` preloaded so callers can hand the
  result straight to `Scrollback.Wire.to_json/1` (which pattern-matches
  on `%Network{slug: _}` and crashes on unloaded assoc). Single
  network query per page (Ecto deduplicates the `IN (...)` lookup);
  identical wire-shape contract as `persist_event/1` (A4 + A26).
  """
  @type subject :: {:user, Ecto.UUID.t()} | {:visitor, Ecto.UUID.t()}

  @spec fetch(subject(), integer(), String.t(), integer() | nil, pos_integer()) ::
          [Message.t()]
  def fetch(subject, network_id, channel, before, limit)
      when is_integer(network_id) and is_integer(limit) and limit > 0 do
    capped = min(limit, @max_limit)

    Message
    |> subject_where(subject)
    |> where([m], m.network_id == ^network_id)
    |> channel_or_dm_where(channel)
    |> maybe_before(before)
    |> order_by([m], desc: m.server_time, desc: m.id)
    |> limit(^capped)
    |> preload(:network)
    |> Repo.all()
  end

  # CP14 B3 — channel-vs-DM dispatch.
  #
  # Channel-shaped names (#chan, &local, !local, +mode) and the
  # synthetic "$server" pseudo-channel resolve to a pure
  # `channel == ^name` filter — these can never be DM rows, so the
  # `:dm_with` index is irrelevant.
  #
  # Peer-shaped names (anything else, i.e. nick-shaped) resolve to
  # the union of `(channel == ^name) OR (dm_with == ^name)` so a DM
  # window for `peer` returns both:
  #   * outbound — own_nick → peer (channel = peer)
  #   * inbound — peer → own_nick (channel = own_nick, dm_with = peer
  #     populated at persist by EventRouter).
  #
  # Includes pre-CP14-B3 inbound rows where dm_with is nil — those
  # never pulled in via this branch (pre-existing inbound history for
  # peers fetched as own_nick keeps showing under the own-nick
  # window). Backfill in the migration covers as many historical
  # rows as the current credential's nick can identify; the
  # write-time path covers everything from CP14 B3 forward.
  defp channel_or_dm_where(query, channel) when is_binary(channel) do
    if dm_eligible?(channel) do
      where(query, [m], m.channel == ^channel or m.dm_with == ^channel)
    else
      where(query, [m], m.channel == ^channel)
    end
  end

  defp dm_eligible?("$server"), do: false

  defp dm_eligible?(<<sigil::utf8, _::binary>>) when sigil in [?#, ?&, ?!, ?+],
    do: false

  defp dm_eligible?(_), do: true

  defp subject_where(query, {:user, user_id}) when is_binary(user_id),
    do: where(query, [m], m.user_id == ^user_id)

  defp subject_where(query, {:visitor, visitor_id}) when is_binary(visitor_id),
    do: where(query, [m], m.visitor_id == ^visitor_id)

  # B5.4 L-pers-2: explicit fall-through replaces an implicit
  # FunctionClauseError (Erlang-level message hides both the
  # offending value and the function name). ArgumentError carries
  # the inspected subject so caller bugs (typo `:users` for `:user`,
  # `nil` from a stale ref, leftover atom from a refactor) surface
  # with actionable diagnostics. Same fail-loud behaviour, better
  # post-mortem.
  defp subject_where(_, other),
    do: raise(ArgumentError, "unknown subject: #{inspect(other)}")

  defp maybe_before(query, nil), do: query

  defp maybe_before(query, before) when is_integer(before),
    do: where(query, [m], m.server_time < ^before)

  @doc """
  Returns `true` if at least one row exists for `network_id`.

  Sole consumer is `Grappa.Networks.Credentials.unbind_credential/2`'s
  cascade-on-empty path: if the last user unbinds and any archival
  scrollback still references the network, the cascade rolls back
  with `{:error, :scrollback_present}` so the operator must
  explicitly delete the messages first (Phase 5
  `mix grappa.delete_scrollback`).

  Pre-A22 the same query was inlined in `Networks` as a raw
  `from(m in "messages", ...)` to dodge the Networks↔Scrollback
  Boundary cycle — cycle still exists structurally (Scrollback
  schemas reference `Networks.Network` via `belongs_to`), but
  exposing the query through this boundary keeps schema knowledge
  in one place even when `Networks` opts out of taking the
  Boundary dep.

  `Repo.exists?/1` with `limit: 1` is O(index lookup), not a count.
  """
  @spec has_messages_for_network?(integer()) :: boolean()
  def has_messages_for_network?(network_id) when is_integer(network_id) do
    query = from(m in Message, where: m.network_id == ^network_id, select: 1, limit: 1)
    Repo.exists?(query)
  end
end
