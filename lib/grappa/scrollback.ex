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
    deps: [Grappa.Accounts, Grappa.IRC, Grappa.Networks, Grappa.Repo],
    exports: [Message, Wire]

  import Ecto.Query

  alias Grappa.Repo
  alias Grappa.Scrollback.Message

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
  Inserts a scrollback row.

  `attrs` MUST carry `:user_id` (UUID) and `:network_id` (integer);
  both are FK-validated against `users` / `networks` so a stale id
  surfaces as `{:error, changeset}` instead of an FK exception.

  Returns `{:ok, message}` on success or `{:error, changeset}` when the
  attrs fail validation (missing required field, invalid `:kind`,
  unknown FK).
  """
  @spec insert(map()) :: {:ok, Message.t()} | {:error, Ecto.Changeset.t()}
  def insert(attrs) do
    %Message{}
    |> Message.changeset(attrs)
    |> Repo.insert()
  end

  @doc """
  Persists a `:privmsg` row with `server_time` defaulted to the
  current millisecond. The producing-side defaults (kind, server_time)
  live here so callers — REST controller, IRC.Session, future Phase 6
  listener — pass only the domain inputs and stay decoupled from the
  schema's internal field set.
  """
  @spec persist_privmsg(Ecto.UUID.t(), integer(), String.t(), String.t(), String.t()) ::
          {:ok, Message.t()} | {:error, Ecto.Changeset.t()}
  def persist_privmsg(user_id, network_id, channel, sender, body)
      when is_binary(user_id) and is_integer(network_id) do
    insert(%{
      user_id: user_id,
      network_id: network_id,
      channel: channel,
      server_time: System.system_time(:millisecond),
      kind: :privmsg,
      sender: sender,
      body: body
    })
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
    |> Repo.all()
  end

  defp maybe_before(query, nil), do: query

  defp maybe_before(query, before) when is_integer(before),
    do: where(query, [m], m.server_time < ^before)
end
