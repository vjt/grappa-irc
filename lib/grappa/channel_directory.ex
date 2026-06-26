defmodule Grappa.ChannelDirectory do
  @moduledoc """
  Per-`(subject, network)` discovery snapshot of an upstream `LIST`.

  Lifecycle (driven by `Session.Server` during a refresh):
  `replace_start/2` (nuke) -> `ingest/3` (batched insert of streamed
  322 rows) -> `finalize/2` (stamp `captured_at` on 323). Reads via
  `list/3` (server-side sort/search/keyset-page + `status` + `total`).
  TTL is injected (`opts[:ttl_ms]`) — never read from app env at runtime.
  """
  use Boundary,
    top_level?: true,
    deps: [Grappa.Accounts, Grappa.Networks, Grappa.Repo, Grappa.Subject],
    dirty_xrefs: [Grappa.Visitors.Visitor],
    exports: [Entry, Wire]

  import Ecto.Query

  alias Grappa.ChannelDirectory.Entry
  alias Grappa.Repo
  alias Grappa.Subject

  @type ingest_row :: %{name: String.t(), topic: String.t() | nil, user_count: integer()}
  @type status :: :fresh | :stale | :empty | :refreshing
  @type sort :: :users | :name
  @type page :: %{
          entries: [%{name: String.t(), topic: String.t() | nil, user_count: integer()}],
          next_cursor: String.t() | nil,
          total: non_neg_integer(),
          captured_at: DateTime.t() | nil,
          status: status()
        }

  @default_limit 100

  @doc """
  Nukes all entries for `(subject, network_id)` to begin a fresh `LIST` snapshot.

  Called by `Session.Server` at the start of a new upstream LIST run, before
  any `ingest/3` calls. Safe to call on an empty table.
  """
  @spec replace_start(Subject.t(), integer()) :: :ok
  def replace_start({_, _} = subject, network_id) when is_integer(network_id) do
    Entry
    |> Subject.subject_where(subject)
    |> where([e], e.network_id == ^network_id)
    |> Repo.delete_all()

    :ok
  end

  @doc """
  Bulk-inserts a batch of 322 rows into the snapshot for `(subject, network_id)`.

  Called repeatedly by `Session.Server` as the upstream LIST stream arrives.
  Each row must carry `name`, `user_count`, and optionally `topic`.
  `captured_at` is left `nil` until `finalize/2` stamps it.
  """
  @spec ingest(Subject.t(), integer(), [ingest_row()]) :: :ok
  def ingest({_, _} = subject, network_id, rows) when is_integer(network_id) and is_list(rows) do
    now = DateTime.truncate(DateTime.utc_now(), :second)

    entries =
      Enum.map(rows, fn r ->
        Subject.put_subject_id(
          %{
            network_id: network_id,
            name: r.name,
            topic: Map.get(r, :topic),
            user_count: r.user_count,
            captured_at: nil,
            inserted_at: now,
            updated_at: now
          },
          subject
        )
      end)

    Repo.insert_all(Entry, entries)
    :ok
  end

  @doc """
  Stamps `captured_at = now()` on every entry for `(subject, network_id)`.

  Called by `Session.Server` on receipt of the upstream 323 (end-of-list).
  A non-nil `captured_at` is the TTL anchor — `list/3` uses it to derive
  `:fresh` vs `:stale` status.
  """
  @spec finalize(Subject.t(), integer()) :: :ok
  def finalize({_, _} = subject, network_id) when is_integer(network_id) do
    now = DateTime.truncate(DateTime.utc_now(), :second)

    Entry
    |> Subject.subject_where(subject)
    |> where([e], e.network_id == ^network_id)
    |> Repo.update_all(set: [captured_at: now])

    :ok
  end

  @doc """
  Returns a keyset-paged snapshot of channels for `(subject, network_id)`.

  ## Options

    * `:ttl_ms` (required) — freshness window in milliseconds; used to derive
      `status` (`:fresh` if `captured_at` is within TTL, `:stale` otherwise).
    * `:sort` — `:users` (default, descending user count then ascending name) or
      `:name` (ascending name).
    * `:q` — case-insensitive substring filter applied to both `name` and `topic`.
    * `:limit` — page size (default #{@default_limit}).
    * `:cursor` — opaque keyset cursor returned in `next_cursor` of a prior page.

  Returns a `t:page/0` map with `entries`, `next_cursor`, `total`, `captured_at`,
  and `status` (`:empty | :refreshing | :fresh | :stale`).
  """
  @spec list(Subject.t(), integer(), keyword()) :: page()
  def list({_, _} = subject, network_id, opts) when is_integer(network_id) do
    ttl_ms = Keyword.fetch!(opts, :ttl_ms)
    sort = Keyword.get(opts, :sort, :users)
    q = Keyword.get(opts, :q)
    limit = Keyword.get(opts, :limit, @default_limit)
    cursor = Keyword.get(opts, :cursor)

    base =
      Entry
      |> Subject.subject_where(subject)
      |> where([e], e.network_id == ^network_id)

    total = base |> maybe_search(q) |> Repo.aggregate(:count, :id)
    captured_at = base |> select([e], max(e.captured_at)) |> Repo.one()

    rows =
      base
      |> maybe_search(q)
      |> order_for(sort)
      |> apply_cursor(sort, cursor)
      |> limit(^(limit + 1))
      |> Repo.all()

    {page_rows, next_cursor} = paginate(rows, limit, sort)

    %{
      entries: Enum.map(page_rows, &%{name: &1.name, topic: &1.topic, user_count: &1.user_count}),
      next_cursor: next_cursor,
      total: total,
      captured_at: captured_at,
      status: status_of(captured_at, total, ttl_ms)
    }
  end

  defp maybe_search(query, nil), do: query
  defp maybe_search(query, ""), do: query

  defp maybe_search(query, q) when is_binary(q) do
    like = "%#{String.downcase(q)}%"

    where(
      query,
      [e],
      like(fragment("lower(?)", e.name), ^like) or like(fragment("lower(?)", e.topic), ^like)
    )
  end

  defp order_for(query, :users), do: order_by(query, [e], desc: e.user_count, asc: e.name)
  defp order_for(query, :name), do: order_by(query, [e], asc: e.name)

  defp apply_cursor(query, _, nil), do: query

  defp apply_cursor(query, :users, cursor) do
    # Cursor is server-minted and opaque — a malformed or tampered cursor raising here is intentional.
    [count_str, name] = String.split(Base.url_decode64!(cursor), "\t", parts: 2)
    count = String.to_integer(count_str)
    where(query, [e], e.user_count < ^count or (e.user_count == ^count and e.name > ^name))
  end

  defp apply_cursor(query, :name, cursor) do
    name = Base.url_decode64!(cursor)
    where(query, [e], e.name > ^name)
  end

  defp paginate(rows, limit, sort) do
    if length(rows) > limit do
      page = Enum.take(rows, limit)
      {page, encode_cursor(List.last(page), sort)}
    else
      {rows, nil}
    end
  end

  defp encode_cursor(%Entry{user_count: c, name: n}, :users), do: Base.url_encode64("#{c}\t#{n}")
  defp encode_cursor(%Entry{name: n}, :name), do: Base.url_encode64(n)

  defp status_of(nil, 0, _), do: :empty
  defp status_of(nil, _, _), do: :refreshing

  defp status_of(%DateTime{} = captured_at, _, ttl_ms) do
    age_ms = DateTime.diff(DateTime.utc_now(), captured_at, :millisecond)
    if age_ms <= ttl_ms, do: :fresh, else: :stale
  end
end
