defmodule Grappa.ChannelDirectory do
  @moduledoc """
  Per-`(subject, network)` discovery snapshot of an upstream `LIST`.

  Lifecycle: ONE write, at the END of the refresh — `replace/3` nukes the
  prior snapshot and inserts the whole capture already stamped (issue
  2046). Reads via `list/3` (server-side sort/search/keyset-page +
  `status` + `total`). TTL is injected (`opts[:ttl_ms]`) — never read from
  app env at runtime. `ttl_ms/0` is the canonical source callers (e.g. the
  REST controller) pass as that `:ttl_ms` opt.

  ## Persistence is DEFERRED, and that is the load-bearing property

  Until issue 2046 the ETL wrote WHILE the stream arrived: `replace_start/2`
  nuked at the moment `LIST` hit the wire, `ingest/3` flushed every 200
  rows, and `finalize/2` stamped `captured_at` on the 323. A reader landing
  in that window saw a partition that was neither the old snapshot nor the
  new one — half of a capture, carrying no stamp.

  `Session.Server` now buffers the whole capture in memory and hands it over
  once, so **the partition holds the PREVIOUS snapshot, whole, for the
  entire duration of a refresh**. Three consequences, stated because a later
  edit can take them away without any test noticing:

    * a truncated refresh (the watchdog, a session crash) no longer destroys
      what was there — it writes nothing at all;
    * `captured_at` is stamped at INSERT, so a row without a stamp cannot
      exist. Every row of a partition carries the SAME stamp, which is why
      `list/3` reads the snapshot's `captured_at` off the page rows instead
      of spending a second query on `max(captured_at)`;
    * a stamp therefore means "a capture COMPLETED", never "a capture
      touched this partition" — the discriminant every `status` branch
      below rests on.

  The price, accepted by ruling: RAM for the buffer — a few thousand rows
  per session that is running a `LIST`.
  """
  use Boundary,
    top_level?: true,
    # `Grappa.IRC` — `Wire.mark_featured/2` folds directory names via
    # `Identifier.canonical_target/1` (ASCII, #364/#525/#537) to key them against
    # the canonical featured set.
    # Neither `Grappa.Accounts` nor `Networks.Network` is declared, and there
    # is no waiver for either: `Entry` reaches `User` and `Network` only by
    # `belongs_to` and a typespec, which are not references the checker
    # resolves (#1399 for the first, #1398 for the second).
    deps: [Grappa.IRC, Grappa.Repo, Grappa.Subject, Grappa.Visitors.Visitor],
    exports: [Entry, Wire]

  import Ecto.Query

  alias Grappa.ChannelDirectory.Entry
  alias Grappa.{Repo, Subject}

  @cfg Application.compile_env(:grappa, __MODULE__, [])
  @ttl_ms Keyword.get(@cfg, :ttl_ms, 48 * 60 * 60 * 1000)

  @doc "Snapshot freshness window in ms — the REST resource labels a snapshot :fresh while age <= this, else :stale."
  # `unquote(@ttl_ms)` pins the spec to the folded compile-time singleton
  # (the configured TTL), mirroring `Session.Backoff.base_ms/0` +
  # `Admission.NetworkCircuit.threshold/0`. A bare `pos_integer()` spec is a
  # `:underspecs` supertype of the success typing and fails the Dialyzer gate.
  @spec ttl_ms() :: unquote(@ttl_ms)
  def ttl_ms, do: @ttl_ms

  @type ingest_row :: %{name: String.t(), topic: String.t() | nil, user_count: integer()}
  @type status :: :fresh | :stale | :no_results | :unknown | :loading
  @type sort :: :users | :name
  @type page :: %{
          entries: [%{name: String.t(), topic: String.t() | nil, user_count: integer()}],
          next_cursor: String.t() | nil,
          total: non_neg_integer(),
          captured_at: DateTime.t() | nil,
          status: status()
        }

  @default_limit 100

  # A whole capture arrives as one list, and one `INSERT` cannot carry it:
  # SQLite caps a statement at `SQLITE_MAX_VARIABLE_NUMBER` (32766 on the
  # bundled engine) and `Entry` spends 8 of them per row, so ~4095 rows is
  # the wall — under a Libera-sized LIST (tens of thousands of channels), not
  # over it. This is a STORAGE constraint, not a tuning knob: it belongs here
  # with the schema whose column count sets it, and NOT in config, where the
  # old `ingest_batch` sat while it meant "how often to flush mid-stream".
  @insert_chunk 500

  @doc """
  Replaces the whole `(subject, network_id)` snapshot with `rows`, stamped
  `captured_at = now` at insert.

  Called ONCE by `Session.Server` on the 323 RPL_LISTEND, with everything
  the capture buffered. `rows == []` is a legitimate capture — a network
  that answered `LIST` with no channels — and leaves the partition empty,
  which `list/3` reports as `:unknown`: an empty snapshot and a snapshot
  that never happened are the same observation, and saying so is honest.

  Not wrapped in a transaction, deliberately. The delete and the chunked
  inserts run back to back on one connection, and the gap between them is
  invisible through the REST door because `DirectoryController.index/2`
  asks the session whether a capture is in flight BEFORE it reads — that
  call queues behind this very write on the session's mailbox, so a reader
  either sees the old snapshot (capture still streaming) or the new one
  (write already committed). See the controller for the full ordering
  argument.
  """
  @spec replace(Subject.t(), integer(), [ingest_row()]) :: :ok
  def replace({_, _} = subject, network_id, rows) when is_integer(network_id) and is_list(rows) do
    now = DateTime.truncate(DateTime.utc_now(), :second)

    {_, _} =
      Entry
      |> Subject.subject_where(subject)
      |> where([e], e.network_id == ^network_id)
      |> Repo.delete_all()

    rows
    |> Enum.chunk_every(@insert_chunk)
    |> Enum.each(fn chunk ->
      {_, _} = Repo.insert_all(Entry, Enum.map(chunk, &entry_attrs(&1, subject, network_id, now)))
    end)

    :ok
  end

  @spec entry_attrs(ingest_row(), Subject.t(), integer(), DateTime.t()) :: map()
  defp entry_attrs(row, subject, network_id, now) do
    Subject.put_subject_id(
      %{
        network_id: network_id,
        name: row.name,
        topic: Map.get(row, :topic),
        user_count: row.user_count,
        captured_at: now,
        inserted_at: now,
        updated_at: now
      },
      subject
    )
  end

  @doc """
  Returns a keyset-paged snapshot of channels for `(subject, network_id)`.

  ## Options

    * `:ttl_ms` (required) — freshness window in milliseconds; used to derive
      `status` (`:fresh` if `captured_at` is within TTL, `:stale` otherwise).
      **The anchor is second-precision** (`Entry`'s `captured_at` is
      `:utc_datetime`, so `replace/3` truncates), so the derived age
      OVERSTATES the true age by up to 999 ms and never understates it: a
      snapshot is born up to a second old. A window comparable to that
      granularity therefore answers by the clock rather than by the data —
      `ttl_ms: 1_000` read immediately after `replace/3` yields `:fresh` or
      `:stale` depending on where in the wall-clock second the stamp landed
      (#713). Production is clear of it by five orders of magnitude
      (`ttl_ms/0` is 48h). This is a documented floor and NOT a runtime
      rejection, deliberately — see #713 in `docs/DESIGN_NOTES.md` for why a
      sub-granularity guard would have rejected two legitimate callers and
      still not have caught the case that prompted the question.
    * `:refreshing?` (required) — whether a capture is in flight for this
      `(subject, network)` RIGHT NOW. Not derivable from the table: with
      persistence deferred, a running capture writes nothing, so the rows say
      exactly what they said before it started. It is the only thing that
      separates `:loading` from `:unknown`, and the caller owns it because
      the fact lives in `Session.Server`, not here.
    * `:sort` — `:users` (default, descending user count then ascending name) or
      `:name` (ascending name).
    * `:q` — case-insensitive substring filter applied to both `name` and `topic`.
    * `:limit` — page size (default #{@default_limit}).
    * `:cursor` — opaque keyset cursor returned in `next_cursor` of a prior page.

  Returns a `t:page/0` map with `entries`, `next_cursor`, `total`,
  `captured_at`, and `status`.

  ## One statement, so `total` cannot contradict `entries`

  `total` is a `count(*) over ()` window ON THE PAGE'S OWN STATEMENT, and
  `captured_at` rides the page rows. That is the whole cure for issue 2046:
  the three values used to come from three round trips, and a capture
  landing between them produced payloads like `total: 0` beside five
  entries — self-contradictory, and read by cic's pane as "0 channels /
  never" over a populated list.

  The window sits INSIDE a subquery and the keyset cursor is applied
  OUTSIDE it. That ordering is load-bearing: window functions are evaluated
  after `WHERE`, so a cursor inside would count "the rows from here on"
  and `total` would shrink page by page — exact on page 1 and wrong on
  every other, the failure mode a per-page count was rejected for.

  ## When the page comes back empty

  A statement that returns no rows carries no window value either, so the
  envelope is asked for separately in exactly that case, and only then:

    * the filtered set is non-empty but the CURSOR is past its end (the
      snapshot changed under a scroll) — one row of the same subquery still
      answers with the exact `total` and the stamp;
    * the filtered set really is empty — `total` is 0 by construction, and
      the stamp is read from the partition so that a search matching
      nothing still reports WHEN the list it searched was captured. Without
      that read a search miss would render as "never" and, worse, as
      `:unknown`, which is the state the controller arms a re-capture on.
  """
  @spec list(Subject.t(), integer(), keyword()) :: page()
  def list({_, _} = subject, network_id, opts) when is_integer(network_id) do
    ttl_ms = Keyword.fetch!(opts, :ttl_ms)
    refreshing? = Keyword.fetch!(opts, :refreshing?)
    sort = Keyword.get(opts, :sort, :users)
    q = Keyword.get(opts, :q)
    limit = Keyword.get(opts, :limit, @default_limit)
    cursor = Keyword.get(opts, :cursor)

    base =
      Entry
      |> Subject.subject_where(subject)
      |> where([e], e.network_id == ^network_id)

    inner =
      base
      |> maybe_search(q)
      |> select([e], %{
        name: e.name,
        topic: e.topic,
        user_count: e.user_count,
        captured_at: e.captured_at,
        total: fragment("count(*) over ()")
      })

    rows =
      from(r in subquery(inner))
      |> order_for(sort)
      |> apply_cursor(sort, cursor)
      |> limit(^(limit + 1))
      |> Repo.all()

    {page_rows, next_cursor} = paginate(rows, limit, sort)
    {total, captured_at} = envelope(rows, inner, base)

    %{
      entries: Enum.map(page_rows, &%{name: &1.name, topic: &1.topic, user_count: &1.user_count}),
      next_cursor: next_cursor,
      total: total,
      captured_at: captured_at,
      status: status_of(captured_at, total, refreshing?, ttl_ms)
    }
  end

  @spec envelope([map()], Ecto.Query.t(), Ecto.Query.t()) :: {non_neg_integer(), DateTime.t() | nil}
  defp envelope([%{total: total, captured_at: captured_at} | _], _inner, _base),
    do: {total, captured_at}

  defp envelope([], inner, base) do
    case Repo.one(from(r in subquery(inner), limit: 1)) do
      %{total: total, captured_at: captured_at} -> {total, captured_at}
      nil -> {0, Repo.one(from(e in base, select: max(e.captured_at)))}
    end
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

  defp encode_cursor(%{user_count: c, name: n}, :users), do: Base.url_encode64("#{c}\t#{n}")
  defp encode_cursor(%{name: n}, :name), do: Base.url_encode64(n)

  # The stamp answers "is there a completed snapshot", the count answers
  # "did this search find anything in it", and the in-flight flag separates
  # the two ways of having nothing. Note what is NOT an argument here: the
  # QUERY. `total` is search-scoped and the stamp is not, so a non-nil stamp
  # beside `total == 0` can only be a search that matched nothing — a `q`
  # parameter would be re-stating a fact these two already carry.
  @spec status_of(DateTime.t() | nil, non_neg_integer(), boolean(), integer()) :: status()
  defp status_of(nil, _total, true, _ttl_ms), do: :loading
  defp status_of(nil, _total, false, _ttl_ms), do: :unknown
  defp status_of(%DateTime{}, 0, _refreshing?, _ttl_ms), do: :no_results

  defp status_of(%DateTime{} = captured_at, _total, _refreshing?, ttl_ms) do
    age_ms = DateTime.diff(DateTime.utc_now(), captured_at, :millisecond)
    if age_ms <= ttl_ms, do: :fresh, else: :stale
  end
end
