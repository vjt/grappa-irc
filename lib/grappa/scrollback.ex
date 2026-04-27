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
    # contract). Declaring those refs as dirty xrefs lets the
    # Cluster 2 cycle inversion (Networks → Session) land without a
    # transitive `Scrollback → Networks → Session → Scrollback`
    # cycle. The struct-only nature of the dep means we lose
    # boundary checks on a use case Boundary couldn't help with
    # anyway (struct field access doesn't go through any function
    # call we'd want to gate); the cost is intentional.
    dirty_xrefs: [Grappa.Networks.Network],
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
  straight to `Grappa.Scrollback.Wire.message_event/1` (which
  pattern-matches on `%Network{slug: _}` and crashes on unloaded assoc).
  Single source for the wire-shape contract — every door (REST,
  PubSub, future Phase 6 listener) goes through here.

  Body validation per-kind is enforced by `Message.changeset/2`:
  `:privmsg | :notice | :action | :topic` require non-nil body;
  `:join | :part | :quit | :nick_change | :mode | :kick` accept
  `body: nil` (presence kinds + state changes).
  """
  @spec persist_event(%{
          required(:user_id) => Ecto.UUID.t(),
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
  Fetches up to `limit` messages for `(user_id, network_id, channel)`,
  ordered by `server_time` DESC then `id` DESC (stable inside same-ms
  ties). The `user_id` filter is the central per-user iso boundary —
  see moduledoc.

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
  @spec fetch(Ecto.UUID.t(), integer(), String.t(), integer() | nil, pos_integer()) ::
          [Message.t()]
  def fetch(user_id, network_id, channel, before, limit)
      when is_binary(user_id) and is_integer(network_id) and is_integer(limit) and limit > 0 do
    capped = min(limit, @max_limit)

    Message
    |> where(
      [m],
      m.user_id == ^user_id and m.network_id == ^network_id and m.channel == ^channel
    )
    |> maybe_before(before)
    |> order_by([m], desc: m.server_time, desc: m.id)
    |> limit(^capped)
    |> preload(:network)
    |> Repo.all()
  end

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
