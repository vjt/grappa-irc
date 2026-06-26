# Channel directory `/list` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upstream IRC `LIST` channel discovery — a per-user server-side sqlite snapshot, paginated/searchable REST resource, a live-populating 📇 window in cic, and one-click join.

**Architecture:** Fat server / lean shell. `Grappa.ChannelDirectory` (context + `Entry` schema + `Wire`) owns a per-`(subject, network)` snapshot; `DirectoryController` serves it server-paginated/searched/sorted. `Session.Server` issues `LIST`, intercepts 321/322/323 while a refresh is in-flight, batches rows into the snapshot, and emits tiny `directory_progress/complete/failed` pings on the user topic. cic re-GETs its current page on each ping (scroll preserved), reusing the existing `"list"` `WindowKind`.

**Tech Stack:** Elixir/Phoenix/Ecto+sqlite, Phoenix PubSub/Channels, SolidJS (cicchetto), `Grappa.IRCServer` test fake, ExUnit/StreamData/Mox, vitest, Playwright e2e.

**Design:** `docs/plans/2026-06-26-channel-directory-design.md` (approved).

**Build order:** Phases A–C are the server, independently testable + shippable (merge + deploy before cic). Phases D–E are cic, built against the merged server contract. Run `scripts/check.sh` green before starting (fix any pre-existing failures first).

**Conventions to mirror (read these siblings before writing):**
- Schema + subject-XOR + check constraint: `lib/grappa/query_windows/window.ex`, migration `priv/repo/migrations/20260504130000_create_query_windows.exs`.
- Context + `Grappa.Session.Subject` helpers (`subject_where/2`, `put_subject_id/2`, `to_session/1`, `Subject.t()`): `lib/grappa/query_windows.ex`.
- Wire: `lib/grappa/query_windows/wire.ex`. Controller + FallbackController: `lib/grappa_web/controllers/channels_controller.ex`, `.../fallback_controller.ex`. Router: `lib/grappa_web/router.ex` (the `scope "/networks/:network_id"` block).
- Session.Server send/broadcast/state/config-injection + numeric routing: `lib/grappa/session/server.ex`, `lib/grappa/session/numeric_router.ex`.
- cic: `lib/lib/windowKinds.ts`, `lib/api.ts`, `lib/wireNarrow.ts`, `lib/subscribe.ts`, `lib/userTopic.ts`, `lib/home.ts`, `Sidebar.tsx`, `HomePane.tsx`.

Tests run via `scripts/test.sh` / `scripts/check.sh` / `scripts/bun.sh run test` (see `docs/TESTING.md`). Never `mix`/`docker compose` on the host.

---

## Phase A — Server: storage + context

### Task A1: `channel_directory` migration + `Entry` schema

**Files:**
- Create: `priv/repo/migrations/20260626120000_create_channel_directory.exs`
- Create: `lib/grappa/channel_directory/entry.ex`
- Test: `test/grappa/channel_directory/entry_test.exs`

- [ ] **Step 1: Write the failing changeset test**

```elixir
# test/grappa/channel_directory/entry_test.exs
defmodule Grappa.ChannelDirectory.EntryTest do
  use Grappa.DataCase, async: true

  alias Grappa.ChannelDirectory.Entry

  describe "changeset/2" do
    test "valid with a user subject" do
      cs = Entry.changeset(%Entry{}, %{user_id: Ecto.UUID.generate(), network_id: 1, name: "#grappa", topic: "hi", user_count: 42, captured_at: nil})
      assert cs.valid?
    end

    test "requires name + network_id + user_count" do
      cs = Entry.changeset(%Entry{}, %{user_id: Ecto.UUID.generate()})
      refute cs.valid?
      assert %{network_id: _, name: _, user_count: _} = errors_on(cs)
    end

    test "rejects setting both user_id and visitor_id (subject XOR)" do
      cs = Entry.changeset(%Entry{}, %{user_id: Ecto.UUID.generate(), visitor_id: Ecto.UUID.generate(), network_id: 1, name: "#x", user_count: 0})
      refute cs.valid?
      assert %{subject: _} = errors_on(cs)
    end

    test "rejects neither subject" do
      cs = Entry.changeset(%Entry{}, %{network_id: 1, name: "#x", user_count: 0})
      refute cs.valid?
      assert %{subject: _} = errors_on(cs)
    end
  end
end
```

- [ ] **Step 2: Run it, verify it fails**

Run: `scripts/test.sh test/grappa/channel_directory/entry_test.exs`
Expected: FAIL — `Grappa.ChannelDirectory.Entry` does not exist.

- [ ] **Step 3: Write the migration**

```elixir
# priv/repo/migrations/20260626120000_create_channel_directory.exs
defmodule Grappa.Repo.Migrations.CreateChannelDirectory do
  use Ecto.Migration

  def change do
    create table(:channel_directory) do
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all)
      add :visitor_id, references(:visitors, type: :binary_id, on_delete: :delete_all)
      add :network_id, references(:networks, on_delete: :delete_all), null: false
      add :name, :string, null: false
      add :topic, :string
      add :user_count, :integer, null: false, default: 0
      # NULL until RPL_LISTEND (323) — "present" iff captured_at is set.
      add :captured_at, :utc_datetime

      timestamps(type: :utc_datetime)
    end

    # Sort-by-users page (default) and sort-by-name page.
    create index(:channel_directory, [:user_id, :network_id, :user_count, :name])
    create index(:channel_directory, [:user_id, :network_id, :name])
    create index(:channel_directory, [:visitor_id, :network_id, :user_count, :name])
    create index(:channel_directory, [:visitor_id, :network_id, :name])

    # Subject XOR — mirror of query_windows_subject_xor.
    create constraint(:channel_directory, :channel_directory_subject_xor,
             check: "(user_id IS NOT NULL) <> (visitor_id IS NOT NULL)"
           )
  end
end
```

- [ ] **Step 4: Write the schema (mirror `QueryWindows.Window`)**

```elixir
# lib/grappa/channel_directory/entry.ex
defmodule Grappa.ChannelDirectory.Entry do
  @moduledoc """
  One row per `(subject, network, channel)` in a user's discovery
  snapshot of an upstream `LIST`. `captured_at` is NULL until
  `RPL_LISTEND` finalises the snapshot — a snapshot counts as "present"
  only once any row carries a non-nil `captured_at`.
  """
  use Ecto.Schema
  import Ecto.Changeset

  alias Grappa.Accounts.User
  alias Grappa.Networks.Network
  alias Grappa.Visitors.Visitor

  @type t :: %__MODULE__{
          id: integer() | nil,
          user_id: Ecto.UUID.t() | nil,
          visitor_id: Ecto.UUID.t() | nil,
          network_id: integer() | nil,
          name: String.t() | nil,
          topic: String.t() | nil,
          user_count: integer() | nil,
          captured_at: DateTime.t() | nil,
          inserted_at: DateTime.t() | nil,
          updated_at: DateTime.t() | nil
        }

  schema "channel_directory" do
    belongs_to :user, User, type: :binary_id
    belongs_to :visitor, Visitor, type: :binary_id
    belongs_to :network, Network

    field :name, :string
    field :topic, :string
    field :user_count, :integer
    field :captured_at, :utc_datetime

    timestamps(type: :utc_datetime)
  end

  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(entry, attrs) do
    entry
    |> cast(attrs, [:user_id, :visitor_id, :network_id, :name, :topic, :user_count, :captured_at])
    |> validate_required([:network_id, :name, :user_count])
    |> validate_length(:name, min: 1)
    |> validate_subject_xor()
    |> assoc_constraint(:user)
    |> assoc_constraint(:visitor)
    |> assoc_constraint(:network)
    |> check_constraint(:subject,
      name: :channel_directory_subject_xor,
      message: "user_id and visitor_id are mutually exclusive"
    )
  end

  @spec validate_subject_xor(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp validate_subject_xor(changeset) do
    case {get_field(changeset, :user_id), get_field(changeset, :visitor_id)} do
      {nil, nil} -> add_error(changeset, :subject, "must set user_id or visitor_id")
      {_, nil} -> changeset
      {nil, _} -> changeset
      {_, _} -> add_error(changeset, :subject, "user_id and visitor_id are mutually exclusive")
    end
  end
end
```

- [ ] **Step 5: Run migration in the container + tests pass**

Run: `scripts/mix.sh ecto.migrate` then `scripts/test.sh test/grappa/channel_directory/entry_test.exs`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add priv/repo/migrations/20260626120000_create_channel_directory.exs lib/grappa/channel_directory/entry.ex test/grappa/channel_directory/entry_test.exs
git commit -m "feat(directory): channel_directory schema + migration (#84)"
```

---

### Task A2: `ChannelDirectory` context — replace/ingest/finalize + list

**Files:**
- Create: `lib/grappa/channel_directory.ex`
- Test: `test/grappa/channel_directory_test.exs`

The context takes `Grappa.Session.Subject.t()` (`{:user, uuid} | {:visitor, uuid}`). It owns: snapshot lifecycle (`replace_start/2`, `ingest/3`, `finalize/2`), and the read query (`list/3` — sort/search/keyset-page + `status` + `total`). TTL is injected (no `Application.get_env` at runtime) — pass `ttl_ms` in `opts`.

- [ ] **Step 1: Write the failing lifecycle test**

```elixir
# test/grappa/channel_directory_test.exs
defmodule Grappa.ChannelDirectoryTest do
  use Grappa.DataCase, async: true

  alias Grappa.ChannelDirectory, as: Dir

  setup do
    user = Grappa.AccountsFixtures.user_fixture()
    network = Grappa.NetworksFixtures.network_fixture()
    {:ok, subject: {:user, user.id}, network_id: network.id}
  end

  defp rows(n), do: for(i <- 1..n, do: %{name: "#c#{i}", topic: "t#{i}", user_count: i})

  test "replace_start nukes, ingest inserts, finalize stamps captured_at", %{subject: s, network_id: nid} do
    :ok = Dir.replace_start(s, nid)
    :ok = Dir.ingest(s, nid, rows(3))
    # before finalize: rows exist but unstamped -> status :refreshing/empty
    assert %{status: status, total: 3} = Dir.list(s, nid, ttl_ms: 1_000)
    assert status in [:refreshing, :empty]

    :ok = Dir.finalize(s, nid)
    assert %{status: :fresh, total: 3, entries: entries, captured_at: ca} = Dir.list(s, nid, ttl_ms: 1_000)
    assert ca != nil
    # default sort: user_count DESC
    assert Enum.map(entries, & &1.name) == ["#c3", "#c2", "#c1"]
  end

  test "replace_start clears a prior snapshot", %{subject: s, network_id: nid} do
    :ok = Dir.replace_start(s, nid); :ok = Dir.ingest(s, nid, rows(2)); :ok = Dir.finalize(s, nid)
    :ok = Dir.replace_start(s, nid); :ok = Dir.ingest(s, nid, rows(1)); :ok = Dir.finalize(s, nid)
    assert %{total: 1} = Dir.list(s, nid, ttl_ms: 1_000)
  end

  test "empty snapshot -> status :empty", %{subject: s, network_id: nid} do
    assert %{status: :empty, total: 0, entries: []} = Dir.list(s, nid, ttl_ms: 1_000)
  end

  test "stale snapshot (older than ttl) -> status :stale", %{subject: s, network_id: nid} do
    :ok = Dir.replace_start(s, nid); :ok = Dir.ingest(s, nid, rows(1)); :ok = Dir.finalize(s, nid)
    assert %{status: :stale} = Dir.list(s, nid, ttl_ms: 0)
  end

  test "?q= filters by name substring (case-insensitive)", %{subject: s, network_id: nid} do
    :ok = Dir.replace_start(s, nid)
    :ok = Dir.ingest(s, nid, [%{name: "#elixir", topic: "", user_count: 5}, %{name: "#ruby", topic: "", user_count: 9}])
    :ok = Dir.finalize(s, nid)
    assert %{entries: [%{name: "#elixir"}], total: 1} = Dir.list(s, nid, ttl_ms: 1_000, q: "ELIX")
  end

  test "sort: :name orders alphabetically", %{subject: s, network_id: nid} do
    :ok = Dir.replace_start(s, nid)
    :ok = Dir.ingest(s, nid, [%{name: "#b", topic: "", user_count: 9}, %{name: "#a", topic: "", user_count: 1}])
    :ok = Dir.finalize(s, nid)
    assert %{entries: [%{name: "#a"}, %{name: "#b"}]} = Dir.list(s, nid, ttl_ms: 1_000, sort: :name)
  end

  test "keyset pagination is stable + non-overlapping", %{subject: s, network_id: nid} do
    :ok = Dir.replace_start(s, nid); :ok = Dir.ingest(s, nid, rows(5)); :ok = Dir.finalize(s, nid)
    %{entries: p1, next_cursor: c1} = Dir.list(s, nid, ttl_ms: 1_000, limit: 2)
    %{entries: p2} = Dir.list(s, nid, ttl_ms: 1_000, limit: 2, cursor: c1)
    names = Enum.map(p1 ++ p2, & &1.name)
    assert names == Enum.uniq(names)
    assert Enum.map(p1, & &1.name) == ["#c5", "#c4"]
    assert Enum.map(p2, & &1.name) == ["#c3", "#c2"]
  end
end
```

- [ ] **Step 2: Run, verify it fails**

Run: `scripts/test.sh test/grappa/channel_directory_test.exs`
Expected: FAIL — `Grappa.ChannelDirectory` undefined.

- [ ] **Step 3: Write the context**

```elixir
# lib/grappa/channel_directory.ex
defmodule Grappa.ChannelDirectory do
  @moduledoc """
  Per-`(subject, network)` discovery snapshot of an upstream `LIST`.

  Lifecycle (driven by `Session.Server` during a refresh):
  `replace_start/2` (nuke) → `ingest/3` (batched insert of streamed
  322 rows) → `finalize/2` (stamp `captured_at` on 323). Reads via
  `list/3` (server-side sort/search/keyset-page + `status` + `total`).
  TTL is injected (`opts[:ttl_ms]`) — never read from app env at runtime.
  """
  import Ecto.Query

  alias Grappa.ChannelDirectory.Entry
  alias Grappa.Repo
  alias Grappa.Session.Subject

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

  @spec replace_start(Subject.t(), integer()) :: :ok
  def replace_start({_, _} = subject, network_id) when is_integer(network_id) do
    Entry
    |> Subject.subject_where(subject)
    |> where([e], e.network_id == ^network_id)
    |> Repo.delete_all()

    :ok
  end

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

  @spec finalize(Subject.t(), integer()) :: :ok
  def finalize({_, _} = subject, network_id) when is_integer(network_id) do
    now = DateTime.truncate(DateTime.utc_now(), :second)

    Entry
    |> Subject.subject_where(subject)
    |> where([e], e.network_id == ^network_id)
    |> Repo.update_all(set: [captured_at: now])

    :ok
  end

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

    total = Repo.aggregate(maybe_search(base, q), :count, :id)
    captured_at = Repo.one(from e in base, select: max(e.captured_at))

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
    # Plain substring on name + topic. Channel names don't contain % / _;
    # a literal % / _ in a search term acts as a wildcard, which is
    # acceptable for v1 (no ESCAPE-clause complexity).
    like = "%#{String.downcase(q)}%"

    where(
      query,
      [e],
      like(fragment("lower(?)", e.name), ^like) or like(fragment("lower(?)", e.topic), ^like)
    )
  end

  defp order_for(query, :users), do: order_by(query, [e], desc: e.user_count, asc: e.name)
  defp order_for(query, :name), do: order_by(query, [e], asc: e.name)

  # Keyset: encode the last row's sort key. users -> "{count}\t{name}", name -> name.
  defp apply_cursor(query, _sort, nil), do: query

  defp apply_cursor(query, :users, cursor) do
    [count_str, name] = String.split(Base.decode64!(cursor), "\t", parts: 2)
    count = String.to_integer(count_str)
    where(query, [e], e.user_count < ^count or (e.user_count == ^count and e.name > ^name))
  end

  defp apply_cursor(query, :name, cursor) do
    name = Base.decode64!(cursor)
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

  defp encode_cursor(%Entry{user_count: c, name: n}, :users), do: Base.encode64("#{c}\t#{n}")
  defp encode_cursor(%Entry{name: n}, :name), do: Base.encode64(n)

  defp status_of(nil, 0, _ttl), do: :empty
  defp status_of(nil, _total, _ttl), do: :refreshing

  defp status_of(%DateTime{} = captured_at, _total, ttl_ms) do
    age_ms = DateTime.diff(DateTime.utc_now(), captured_at, :millisecond)
    if age_ms <= ttl_ms, do: :fresh, else: :stale
  end
end
```

- [ ] **Step 4: Run tests, verify pass**

Run: `scripts/test.sh test/grappa/channel_directory_test.exs`
Expected: PASS (8 tests). If `errors_on`/fixtures differ, align to `Grappa.DataCase` + existing `*Fixtures` module names (grep `test/support`).

- [ ] **Step 5: Property test for keyset non-overlap**

Add to the test file:

```elixir
  property "keyset paging visits every row exactly once (users sort)" do
    check all n <- StreamData.integer(1..40) do
      user = Grappa.AccountsFixtures.user_fixture()
      network = Grappa.NetworksFixtures.network_fixture()
      s = {:user, user.id}
      :ok = Grappa.ChannelDirectory.replace_start(s, network.id)
      :ok = Grappa.ChannelDirectory.ingest(s, network.id, for(i <- 1..n, do: %{name: "#c#{i}", topic: "", user_count: rem(i, 7)}))
      :ok = Grappa.ChannelDirectory.finalize(s, network.id)

      seen = collect_all(s, network.id, nil, [])
      assert length(seen) == n
      assert seen == Enum.uniq(seen)
    end
  end

  defp collect_all(s, nid, cursor, acc) do
    %{entries: es, next_cursor: c} = Grappa.ChannelDirectory.list(s, nid, ttl_ms: 1_000, limit: 3, cursor: cursor)
    acc = acc ++ Enum.map(es, & &1.name)
    if c, do: collect_all(s, nid, c, acc), else: acc
  end
```

Add `use ExUnitProperties` to the test module header. Run: `scripts/test.sh test/grappa/channel_directory_test.exs`. Expected: PASS. (Property uses non-async DB writes — if the sandbox complains under `async: true`, mark this describe block `async: false` or use a shared checkout per the existing property tests.)

- [ ] **Step 6: Commit**

```bash
git add lib/grappa/channel_directory.ex test/grappa/channel_directory_test.exs
git commit -m "feat(directory): ChannelDirectory context — replace/ingest/finalize + paginated list (#84)"
```

---

### Task A3: `ChannelDirectory.Wire`

**Files:**
- Create: `lib/grappa/channel_directory/wire.ex`
- Test: `test/grappa/channel_directory/wire_test.exs`

`list/3` already returns plain maps for `entries`, but the wire module owns the **outer** JSON envelope (mirrors `QueryWindows.Wire.windows_list_payload/1`) so the controller + any future channel push share one shape.

- [ ] **Step 1: Failing test**

```elixir
# test/grappa/channel_directory/wire_test.exs
defmodule Grappa.ChannelDirectory.WireTest do
  use ExUnit.Case, async: true
  alias Grappa.ChannelDirectory.Wire

  test "index_payload renders the page envelope with ISO8601 captured_at" do
    page = %{entries: [%{name: "#a", topic: "t", user_count: 3}], next_cursor: "C", total: 1,
             captured_at: ~U[2026-06-26 10:00:00Z], status: :fresh}
    assert Wire.index_payload(page) == %{
             entries: [%{name: "#a", topic: "t", user_count: 3}],
             next_cursor: "C", total: 1,
             captured_at: "2026-06-26T10:00:00Z", status: "fresh"
           }
  end

  test "nil captured_at stays nil" do
    page = %{entries: [], next_cursor: nil, total: 0, captured_at: nil, status: :empty}
    assert %{captured_at: nil, status: "empty"} = Wire.index_payload(page)
  end
end
```

- [ ] **Step 2: Run, fail.** `scripts/test.sh test/grappa/channel_directory/wire_test.exs` → FAIL.

- [ ] **Step 3: Implement**

```elixir
# lib/grappa/channel_directory/wire.ex
defmodule Grappa.ChannelDirectory.Wire do
  @moduledoc """
  Wire shape for the channel-directory REST resource. The `entries`
  are already plain maps from `ChannelDirectory.list/3`; this owns the
  outer envelope (atom→string `status`, DateTime→ISO8601 `captured_at`).
  Same convention as `Grappa.QueryWindows.Wire`.
  """
  alias Grappa.ChannelDirectory

  @type index_payload :: %{
          entries: [%{name: String.t(), topic: String.t() | nil, user_count: integer()}],
          next_cursor: String.t() | nil,
          total: non_neg_integer(),
          captured_at: String.t() | nil,
          status: String.t()
        }

  @spec index_payload(ChannelDirectory.page()) :: index_payload()
  def index_payload(%{captured_at: ca} = page) do
    %{
      entries: page.entries,
      next_cursor: page.next_cursor,
      total: page.total,
      captured_at: ca && DateTime.to_iso8601(ca),
      status: Atom.to_string(page.status)
    }
  end
end
```

- [ ] **Step 4: Run, pass.** Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/channel_directory/wire.ex test/grappa/channel_directory/wire_test.exs
git commit -m "feat(directory): Wire envelope for the directory resource (#84)"
```

---

## Phase B — Server: REST

### Task B1: `DirectoryController` + router + JSON view

**Files:**
- Create: `lib/grappa_web/controllers/directory_controller.ex`
- Create: `lib/grappa_web/controllers/directory_json.ex`
- Modify: `lib/grappa_web/router.ex` (the `scope "/networks/:network_id"` block)
- Modify: `lib/grappa_web/controllers/fallback_controller.ex` (only if `:session_not_connected` not already mapped — reuse existing `:no_session`/`:not_connected` if present)
- Test: `test/grappa_web/controllers/directory_controller_test.exs`

Contract: `GET /networks/:network_id/directory?sort=&q=&cursor=&limit=` → `index_payload`. `POST /networks/:network_id/directory/refresh` → `202 {}` (triggers/no-ops) or an error. The controller injects the configured TTL (read at boot — see Task C1; until then read it the same way other controllers read injected config — pass via a small `Grappa.ChannelDirectory.Config` or the application env helper used elsewhere; if none exists, use the boot-time value from Task C1). `refresh` delegates to `Grappa.Session.refresh_directory/2` (Task C2).

- [ ] **Step 1: Failing controller test**

```elixir
# test/grappa_web/controllers/directory_controller_test.exs
defmodule GrappaWeb.DirectoryControllerTest do
  use GrappaWeb.ConnCase, async: true
  alias Grappa.ChannelDirectory, as: Dir

  setup %{conn: conn} do
    user = Grappa.AccountsFixtures.user_fixture()
    network = Grappa.NetworksFixtures.network_fixture_for(user)  # creates credential so resolve_network passes
    conn = conn |> authed_as(user)  # existing ConnCase helper that sets the bearer
    {:ok, conn: conn, user: user, network: network}
  end

  test "GET returns empty/refreshing when no snapshot + no live session", %{conn: conn, network: network} do
    resp = conn |> get(~p"/networks/#{network.slug}/directory") |> json_response(200)
    assert resp["status"] in ["empty", "refreshing"]
    assert resp["entries"] == []
    assert resp["total"] == 0
  end

  test "GET serves a finalized snapshot sorted by users", %{conn: conn, user: user, network: network} do
    s = {:user, user.id}
    :ok = Dir.replace_start(s, network.id)
    :ok = Dir.ingest(s, network.id, [%{name: "#big", topic: "t", user_count: 99}, %{name: "#small", topic: "", user_count: 1}])
    :ok = Dir.finalize(s, network.id)

    resp = conn |> get(~p"/networks/#{network.slug}/directory") |> json_response(200)
    assert resp["status"] == "fresh"
    assert Enum.map(resp["entries"], & &1["name"]) == ["#big", "#small"]
  end

  test "POST refresh without a live session returns a clean error, not 404-silent", %{conn: conn, network: network} do
    resp = conn |> post(~p"/networks/#{network.slug}/directory/refresh")
    assert resp.status in [400, 409, 503]
    refute resp.status == 404
  end

  test "GET on someone else's network 404s", %{conn: conn} do
    other = Grappa.NetworksFixtures.network_fixture()
    assert conn |> get(~p"/networks/#{other.slug}/directory") |> response(404)
  end
end
```

- [ ] **Step 2: Run, fail.** Route/controller missing → FAIL.

- [ ] **Step 3: Add the routes** (in `router.ex`, inside `scope "/networks/:network_id", GrappaWeb do`, beside the channels routes):

```elixir
    get "/directory", DirectoryController, :index
    post "/directory/refresh", DirectoryController, :refresh
```

- [ ] **Step 4: Write the controller**

```elixir
# lib/grappa_web/controllers/directory_controller.ex
defmodule GrappaWeb.DirectoryController do
  use GrappaWeb, :controller

  alias Grappa.ChannelDirectory
  alias Grappa.ChannelDirectory.Wire
  alias Grappa.Session.Subject

  action_fallback GrappaWeb.FallbackController

  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, params) do
    network = conn.assigns.network
    subject = conn.assigns.current_subject

    opts = [
      ttl_ms: ChannelDirectory.ttl_ms(),
      sort: parse_sort(params["sort"]),
      q: params["q"],
      cursor: params["cursor"],
      limit: parse_limit(params["limit"])
    ]

    # `current_subject` is the DB-context subject the other contexts take
    # (same shape QueryWindows uses); ChannelDirectory.list/3 consumes it
    # directly via the shared `Subject` helpers.
    page = ChannelDirectory.list(subject, network.id, opts)

    # Empty + a live session → kick off a refresh so the next poll fills.
    if page.status == :empty, do: maybe_auto_refresh(subject, network)

    json(conn, Wire.index_payload(page))
  end

  @spec refresh(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, atom()}
  def refresh(conn, _params) do
    network = conn.assigns.network
    subject = conn.assigns.current_subject

    # :ok (started) and :already_refreshing (a refresh is in-flight) are
    # BOTH 202 — the design's "already running → 202, no-op". Only a
    # missing live session (:not_connected) is an error, mapped by
    # FallbackController to 400.
    case Grappa.Session.refresh_directory(Subject.to_session(subject), network.id) do
      ok when ok in [:ok, {:error, :already_refreshing}] ->
        conn |> put_status(:accepted) |> json(%{})

      {:error, _} = err ->
        err
    end
  end

  defp maybe_auto_refresh(subject, network) do
    _ = Grappa.Session.refresh_directory(Subject.to_session(subject), network.id)
    :ok
  end

  defp parse_sort("name"), do: :name
  defp parse_sort(_), do: :users

  defp parse_limit(nil), do: 100
  defp parse_limit(s) when is_binary(s) do
    case Integer.parse(s) do
      {n, _} when n > 0 and n <= 500 -> n
      _ -> 100
    end
  end
end
```

Notes for the implementer: `Subject.of/1` / `Subject.to_session/1` — match the exact helper names in `lib/grappa/session/subject.ex` (grep; `channels_controller.ex` uses `Subject.to_session(subject)` for the live-pid lookup and `current_subject` directly for DB context — mirror those two call shapes). `ChannelDirectory.ttl_ms/0` is added in Task C1.

- [ ] **Step 5: Write the JSON view** (the controller uses `json/2` directly, so no view module is strictly required; delete `directory_json.ex` from the file list if unused). Keep the controller returning `json(conn, ...)` — simplest, matches `index` returning a bare map.

- [ ] **Step 6: Confirm the error atom is mapped** — grep `fallback_controller.ex` for `:no_session` / `:not_connected`. `refresh_directory/2` (Task C2) returns `{:error, :not_connected}` on no live pid, which FallbackController already maps to 400. No new clause needed. Verify the test's `resp.status in [400, 409, 503]` matches.

- [ ] **Step 7: Run tests, pass.** Align fixture helper names (`network_fixture_for`, `authed_as`) to the real `ConnCase`/fixtures (grep `test/support/conn_case.ex`). Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/grappa_web/controllers/directory_controller.ex lib/grappa_web/router.ex test/grappa_web/controllers/directory_controller_test.exs
git commit -m "feat(directory): REST index + refresh endpoints (#84)"
```

---

### Task B2: nginx allowlist

**Files:**
- Modify: `infra/nginx.conf` (both `:80` and `:443` server blocks)
- Modify: `cicchetto/e2e/nginx-test.conf` (both blocks)

- [ ] **Step 1: Find the existing `/networks` allowlist** — grep `infra/nginx.conf` for `location` blocks listing `/networks`. The directory routes sit under `/networks/`, so if the allowlist matches `/networks/` as a prefix, **no change needed** — verify by reading the matching `location`. If routes are enumerated individually, add `/directory` and `/directory/refresh` patterns alongside `/channels` in **all four** server blocks (`:80`+`:443` in each file).

- [ ] **Step 2: Commit** (only if changed)

```bash
git add infra/nginx.conf cicchetto/e2e/nginx-test.conf
git commit -m "chore(directory): allow /networks/*/directory through nginx (#84)"
```

---

## Phase C — Server: IRC LIST capture + events + config

### Task C1: Boot-time config injection

**Files:**
- Modify: `config/config.exs`
- Modify: `lib/grappa/application.ex` (where it reads session config to inject into `Session.Server` start opts — grep for where `modes_per_chunk`/`linelen`-style tunables are read)
- Modify: `lib/grappa/channel_directory.ex` (add `ttl_ms/0` reading the injected value)
- Test: `test/grappa/channel_directory_test.exs` (add a `ttl_ms/0` sanity test)

⚠️ A `config/*.exs` change forces a COLD deploy (drops IRC sessions). Batch with the rest of Phase C.

- [ ] **Step 1: Add config keys**

```elixir
# config/config.exs — under the existing :grappa app config block
config :grappa, Grappa.ChannelDirectory,
  ttl_ms: 48 * 60 * 60 * 1000,
  refresh_timeout_ms: 60_000,
  progress_throttle_ms: 1_000,
  ingest_batch: 200
```

- [ ] **Step 2: Failing test**

```elixir
  test "ttl_ms/0 returns the configured 48h" do
    assert Grappa.ChannelDirectory.ttl_ms() == 48 * 60 * 60 * 1000
  end
```

- [ ] **Step 3: Add the reader** (boot-time config boundary is allowed via a module attribute compiled from app env, OR a small `Application.get_env` wrapped at the config boundary; follow whatever the existing session tunables do — grep `Application.compile_env`/`get_env` in `lib/grappa/`). Prefer `Application.compile_env`:

```elixir
# in lib/grappa/channel_directory.ex
@cfg Application.compile_env(:grappa, __MODULE__, [])
@ttl_ms Keyword.get(@cfg, :ttl_ms, 48 * 60 * 60 * 1000)

@spec ttl_ms() :: pos_integer()
def ttl_ms, do: @ttl_ms
```

(`compile_env` is a compile-time read — satisfies the "no runtime `Application.get_env`" rule.)

- [ ] **Step 4: Inject refresh tunables into `Session.Server` opts** — in `application.ex` (or `Networks.SessionPlan`/`Visitors.SessionPlan` where start opts are built), add `directory_refresh_timeout_ms`, `directory_progress_throttle_ms`, `directory_ingest_batch` to the opts map, read via `Application.compile_env`. Add the matching fields to `Session.Server`'s state type + `do_init/1` defaults.

- [ ] **Step 5: Run, pass + commit**

```bash
git add config/config.exs lib/grappa/channel_directory.ex lib/grappa/application.ex test/grappa/channel_directory_test.exs
git commit -m "feat(directory): boot-time TTL + refresh tunables (#84)"
```

---

### Task C2: `Session.Server` refresh trigger + `Grappa.Session.refresh_directory/2`

**Files:**
- Modify: `lib/grappa/session.ex` (public facade — add `refresh_directory/2`)
- Modify: `lib/grappa/session/server.ex` (state field + `handle_call({:refresh_directory}, ...)`; send `LIST` upstream)
- Modify: `lib/grappa/irc/client.ex` (add `send_list/1` if no raw-send exists)
- Test: `test/grappa/session/directory_test.exs` (uses the `Grappa.IRCServer` fake)

State: add `directory_refresh: nil | %{buffer: [ingest_row], count: non_neg_integer, last_emit_ms: integer, timer: reference()}` to the `Session.Server` state type + default `nil` in `do_init/1`.

- [ ] **Step 1: Failing test (fake IRC server)**

```elixir
# test/grappa/session/directory_test.exs
defmodule Grappa.Session.DirectoryTest do
  use Grappa.DataCase, async: false
  import Grappa.SessionTestHelpers  # whatever the existing session tests use to boot a Server against IRCServer

  alias Grappa.ChannelDirectory, as: Dir

  test "refresh issues LIST and a 322/323 burst fills the snapshot" do
    %{server: server, irc: irc, subject: subject, network_id: nid} = start_session!()

    :ok = Grappa.Session.refresh_directory(subject, nid)

    assert_receive_irc(irc, "LIST")  # the fake recorded an outbound LIST

    send_numeric(irc, 321, ["nick", "Channel", "Users  Name"])
    send_numeric(irc, 322, ["nick", "#elixir", "1200", "The Elixir channel"])
    send_numeric(irc, 322, ["nick", "#ruby", "800", "Ruby"])
    send_numeric(irc, 323, ["nick", "End of /LIST"])

    # snapshot finalized
    wait_until(fn -> Dir.list(to_subject(subject), nid, ttl_ms: 1_000).status == :fresh end)
    page = Dir.list(to_subject(subject), nid, ttl_ms: 1_000)
    assert page.total == 2
    assert Enum.map(page.entries, & &1.name) == ["#elixir", "#ruby"]
  end

  test "a second refresh while one is in-flight is a no-op (guard)" do
    %{server: server, subject: subject, network_id: nid} = start_session!()
    :ok = Grappa.Session.refresh_directory(subject, nid)
    assert {:error, :already_refreshing} = Grappa.Session.refresh_directory(subject, nid)
  end
end
```

(Helper names — `start_session!`, `assert_receive_irc`, `send_numeric`, `to_subject` — must match the real `Grappa.IRCServer` helpers; grep an existing `test/grappa/session/*_test.exs` and reuse them verbatim.)

- [ ] **Step 2: Run, fail.**

- [ ] **Step 3: `Grappa.IRC.Client.send_list/1`** (mirror `send_join/3`):

```elixir
# lib/grappa/irc/client.ex
@spec send_list(pid()) :: :ok | {:error, :not_connected}
def send_list(client), do: GenServer.call(client, {:send_raw, "LIST"})
```

(If a generic `{:send_raw, line}` path doesn't exist, add one beside the JOIN sender, encoding the line to bytes at the boundary per the charset rule. Grep `send_join` in `client.ex` for the exact socket-write helper.)

- [ ] **Step 4: Facade + handle_call**

```elixir
# lib/grappa/session.ex
@spec refresh_directory(subject(), integer()) :: :ok | {:error, :not_connected | :already_refreshing}
def refresh_directory(subject, network_id) do
  case whereis(subject, network_id) do
    nil -> {:error, :not_connected}
    pid -> GenServer.call(pid, :refresh_directory)
  end
end
```

```elixir
# lib/grappa/session/server.ex
@impl GenServer
def handle_call(:refresh_directory, _from, %{directory_refresh: nil} = state) do
  case Client.send_list(state.client) do
    :ok ->
      ChannelDirectory.replace_start(state.subject, state.network_id)
      ref = Process.send_after(self(), :directory_refresh_timeout, state.directory_refresh_timeout_ms)
      now = System.monotonic_time(:millisecond)
      {:reply, :ok, %{state | directory_refresh: %{buffer: [], count: 0, last_emit_ms: now, timer: ref}}}

    {:error, _} = err ->
      {:reply, err, state}
  end
end

def handle_call(:refresh_directory, _from, state) do
  {:reply, {:error, :already_refreshing}, state}
end
```

(`ChannelDirectory.*` take the subject tuple; `state.subject` is the Session's subject. If `Grappa.Session.subject()` and the `Subject.t()` the context's `Subject` helpers expect differ in shape, convert via the real `Grappa.Session.Subject` API — grep how a Session context already calls `QueryWindows`. If they're the same tuple, `state.subject` passes straight through.)

- [ ] **Step 5: Run guard test, pass.** The 322/323 fill test stays red until Task C3.

- [ ] **Step 6: Commit**

```bash
git add lib/grappa/session.ex lib/grappa/session/server.ex lib/grappa/irc/client.ex test/grappa/session/directory_test.exs
git commit -m "feat(directory): refresh_directory trigger + send_list + in-flight guard (#84)"
```

---

### Task C3: Intercept 321/322/323 → accumulate → batched ingest + progress pings

**Files:**
- Modify: `lib/grappa/session/server.ex` (numeric ingress branch + helpers)
- Modify: `lib/grappa/session/wire.ex` (or wherever `SessionWire` builds payloads — add `directory_progress/1`)
- Test: `test/grappa/session/directory_test.exs` (the fill test from C2 now goes green; add a progress-emit assertion)

Read first: the `Session.Server` `handle_info({:irc, %Message{command: {:numeric, code}} = msg}, state)` clause(s) (grep `:numeric` in `server.ex`). Insert a branch **before** the general numeric handler: when `state.directory_refresh != nil and code in [321, 322, 323]`, route to the directory accumulator and **do not** persist to `$server` scrollback.

- [ ] **Step 1: Add the directory numeric branch**

```elixir
# lib/grappa/session/server.ex — place ABOVE the generic numeric handle_info
@impl GenServer
def handle_info({:irc, %Message{command: {:numeric, code}} = msg}, %{directory_refresh: ref} = state)
    when not is_nil(ref) and code in [321, 322, 323] do
  {:noreply, handle_directory_numeric(code, msg, state)}
end
```

```elixir
# helpers in server.ex
defp handle_directory_numeric(321, _msg, state), do: state  # RPL_LISTSTART header — ignore

defp handle_directory_numeric(322, %Message{params: params}, state) do
  case parse_list_entry(params) do
    {:ok, row} -> accumulate_directory_row(state, row)
    :error -> state
  end
end

defp handle_directory_numeric(323, _msg, state) do
  state = flush_directory_buffer(state, :final)
  ChannelDirectory.finalize(state.subject, state.network_id)
  _ = if state.directory_refresh.timer, do: Process.cancel_timer(state.directory_refresh.timer)

  broadcast_window_state(
    state,
    SessionWire.directory_complete(state.network_slug, total_directory_rows(state))
  )

  %{state | directory_refresh: nil}
end

# RPL_LIST: "<client> <channel> <#visible> :<topic>"
defp parse_list_entry([_client, channel, count_str, topic]) when is_binary(channel) do
  case Integer.parse(count_str) do
    {count, _} -> {:ok, %{name: channel, topic: topic, user_count: count}}
    :error -> {:ok, %{name: channel, topic: topic, user_count: 0}}
  end
end

defp parse_list_entry([_client, channel, count_str]),
  do: parse_list_entry([nil, channel, count_str, nil])

defp parse_list_entry(_), do: :error

defp accumulate_directory_row(%{directory_refresh: ref} = state, row) do
  ref = %{ref | buffer: [row | ref.buffer], count: ref.count + 1}
  state = %{state | directory_refresh: ref}
  if length(ref.buffer) >= state.directory_ingest_batch,
    do: maybe_emit_progress(flush_directory_buffer(state, :batch)),
    else: maybe_emit_progress(state)
end

defp flush_directory_buffer(%{directory_refresh: %{buffer: []}} = state, _why), do: state

defp flush_directory_buffer(%{directory_refresh: ref} = state, _why) do
  ChannelDirectory.ingest(state.subject, state.network_id, Enum.reverse(ref.buffer))
  %{state | directory_refresh: %{ref | buffer: []}}
end

defp maybe_emit_progress(%{directory_refresh: ref} = state) do
  now = System.monotonic_time(:millisecond)

  if now - ref.last_emit_ms >= state.directory_progress_throttle_ms do
    broadcast_window_state(state, SessionWire.directory_progress(state.network_slug, ref.count))
    %{state | directory_refresh: %{ref | last_emit_ms: now}}
  else
    state
  end
end

defp total_directory_rows(state) do
  ChannelDirectory.list(state.subject, state.network_id, ttl_ms: 0).total
end
```

- [ ] **Step 2: Add the wire payload builders** (mirror `window_pending/2`):

```elixir
# lib/grappa/session/wire.ex
@spec directory_progress(String.t(), non_neg_integer()) :: map()
def directory_progress(network_slug, count),
  do: %{kind: "directory_progress", network: network_slug, count: count}

@spec directory_complete(String.t(), non_neg_integer()) :: map()
def directory_complete(network_slug, total),
  do: %{kind: "directory_complete", network: network_slug, total: total}

@spec directory_failed(String.t(), String.t()) :: map()
def directory_failed(network_slug, reason),
  do: %{kind: "directory_failed", network: network_slug, reason: reason}
```

- [ ] **Step 3: Run the C2 fill test + add a progress assertion** — subscribe the test to `Topic.user(subject_label)`, assert it receives at least one `%{kind: "directory_progress"}` and a terminal `%{kind: "directory_complete", total: 2}`. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/grappa/session/server.ex lib/grappa/session/wire.ex test/grappa/session/directory_test.exs
git commit -m "feat(directory): capture 321/322/323 -> batched ingest + progress pings (#84)"
```

---

### Task C4: Refresh timeout → `directory_failed`

**Files:**
- Modify: `lib/grappa/session/server.ex` (`handle_info(:directory_refresh_timeout, ...)`)
- Test: `test/grappa/session/directory_test.exs`

- [ ] **Step 1: Failing test**

```elixir
  test "a refresh that never sees 323 times out, clears state, and emits directory_failed" do
    %{server: server, irc: irc, subject: subject, network_id: nid, subject_label: label} = start_session!(directory_refresh_timeout_ms: 50)
    Phoenix.PubSub.subscribe(Grappa.PubSub, Grappa.PubSub.Topic.user(label))

    :ok = Grappa.Session.refresh_directory(subject, nid)
    send_numeric(irc, 322, ["nick", "#partial", "5", "half"])
    # no 323
    assert_receive {:event, %{kind: "directory_failed"}}, 500
    assert :sys.get_state(server).directory_refresh == nil
    # unstamped partial reads as :empty -> next open re-triggers
    assert Grappa.ChannelDirectory.list(to_subject(subject), nid, ttl_ms: 1_000).status in [:empty, :refreshing]
  end
```

(Adjust the PubSub receive shape to however `broadcast_event` wraps payloads — grep an existing session test that asserts on a broadcast.)

- [ ] **Step 2: Run, fail.**

- [ ] **Step 3: Implement the timeout handler**

```elixir
# lib/grappa/session/server.ex
@impl GenServer
def handle_info(:directory_refresh_timeout, %{directory_refresh: nil} = state),
  do: {:noreply, state}  # 323 already finalized + cancelled; stale timer

def handle_info(:directory_refresh_timeout, state) do
  Logger.warning("directory refresh timed out before RPL_LISTEND", network: state.network_slug)
  broadcast_window_state(state, SessionWire.directory_failed(state.network_slug, "timeout"))
  {:noreply, %{state | directory_refresh: nil}}
end
```

- [ ] **Step 4: Run, pass. Run the full session suite** (`scripts/test.sh test/grappa/session/`) to confirm the new numeric branch didn't disturb existing numeric routing. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/session/server.ex test/grappa/session/directory_test.exs
git commit -m "feat(directory): refresh timeout emits directory_failed (#84)"
```

- [ ] **Step 6: Phase C gate** — `scripts/check.sh` (test + Dialyzer + Credo + Sobelow + format) green. Update `docs/DESIGN_NOTES.md` with a dated entry (server-side per-user directory; LIST interception while in-flight; the COLD-deploy note). Commit docs. This is the **server-complete** checkpoint — mergeable + deployable (COLD, batched) before Phase D.

---

## Phase D — cic: data layer

### Task D1: `api.ts` — `listDirectory` + `refreshDirectory` + types

**Files:**
- Modify: `cicchetto/src/lib/api.ts`
- Test: `cicchetto/src/lib/api.test.ts` (if `api.ts` has vitest coverage; else assert via the store test in D3)

- [ ] **Step 1: Add the types + functions** (mirror `listChannels`/`postJoin`):

```typescript
// cicchetto/src/lib/api.ts
export type DirectoryEntry = { name: string; topic: string | null; user_count: number };

export type DirectoryStatus = "fresh" | "stale" | "refreshing" | "empty";

export type DirectoryPage = {
  entries: DirectoryEntry[];
  next_cursor: string | null;
  total: number;
  captured_at: string | null;
  status: DirectoryStatus;
};

export async function listDirectory(
  token: string,
  networkSlug: string,
  opts: { sort?: "users" | "name"; q?: string; cursor?: string } = {},
): Promise<DirectoryPage> {
  const p = new URLSearchParams();
  if (opts.sort) p.set("sort", opts.sort);
  if (opts.q) p.set("q", opts.q);
  if (opts.cursor) p.set("cursor", opts.cursor);
  const qs = p.toString();
  const res = await fetch(
    `/networks/${encodeURIComponent(networkSlug)}/directory${qs ? `?${qs}` : ""}`,
    { headers: buildHeaders(token) },
  );
  if (!res.ok) throw await readError(res);
  return (await res.json()) as DirectoryPage;
}

export async function refreshDirectory(token: string, networkSlug: string): Promise<void> {
  const res = await fetch(`/networks/${encodeURIComponent(networkSlug)}/directory/refresh`, {
    method: "POST",
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
}
```

- [ ] **Step 2: Typecheck** — `scripts/bun.sh run build` (real type gate; biome alone can mask tsc). Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add cicchetto/src/lib/api.ts
git commit -m "feat(cic/directory): listDirectory + refreshDirectory api (#84)"
```

---

### Task D2: `wireNarrow.ts` — narrow the three directory events

**Files:**
- Modify: `cicchetto/src/lib/wireNarrow.ts` (the network-topic narrower — the directory pings fan out on `Topic.user`, handled in `userTopic.ts`, so narrow them in the user-topic narrower; grep `narrowUserTopicEvent` / the userTopic union)
- Modify: the user-topic event union type (grep `userTopic.ts` for its `WireUserEvent` / `assertNever` switch)
- Test: `cicchetto/src/lib/wireNarrow.test.ts`

The pings carry `{ kind, network, ... }`. Add arms to the **user-topic** narrower (these are `Topic.user` broadcasts like `channels_changed`, not channel-topic events).

- [ ] **Step 1: Failing narrow test**

```typescript
// cicchetto/src/lib/wireNarrow.test.ts (add to the existing user-topic describe)
test("narrows directory_progress", () => {
  expect(narrowUserTopicEvent({ kind: "directory_progress", network: "libera", count: 42 }))
    .toEqual({ kind: "directory_progress", network: "libera", count: 42 });
});
test("narrows directory_complete", () => {
  expect(narrowUserTopicEvent({ kind: "directory_complete", network: "libera", total: 100 }))
    .toEqual({ kind: "directory_complete", network: "libera", total: 100 });
});
test("narrows directory_failed", () => {
  expect(narrowUserTopicEvent({ kind: "directory_failed", network: "libera", reason: "timeout" }))
    .toEqual({ kind: "directory_failed", network: "libera", reason: "timeout" });
});
test("rejects directory_progress with non-number count", () => {
  expect(narrowUserTopicEvent({ kind: "directory_progress", network: "libera", count: "x" })).toBeNull();
});
```

- [ ] **Step 2: Run, fail.** `scripts/bun.sh run test wireNarrow` → FAIL.

- [ ] **Step 3: Add the union members + narrow arms**

```typescript
// in the WireUserEvent union (userTopic.ts or wireNarrow.ts)
| { kind: "directory_progress"; network: string; count: number }
| { kind: "directory_complete"; network: string; total: number }
| { kind: "directory_failed"; network: string; reason: string }
```

```typescript
// in narrowUserTopicEvent's switch (mirror existing arms)
case "directory_progress": {
  if (typeof r.network !== "string" || typeof r.count !== "number") return null;
  return { kind: "directory_progress", network: r.network, count: r.count };
}
case "directory_complete": {
  if (typeof r.network !== "string" || typeof r.total !== "number") return null;
  return { kind: "directory_complete", network: r.network, total: r.total };
}
case "directory_failed": {
  if (typeof r.network !== "string" || typeof r.reason !== "string") return null;
  return { kind: "directory_failed", network: r.network, reason: r.reason };
}
```

- [ ] **Step 4: Run, pass + typecheck (`scripts/bun.sh run build`).**

- [ ] **Step 5: Commit**

```bash
git add cicchetto/src/lib/wireNarrow.ts cicchetto/src/lib/userTopic.ts cicchetto/src/lib/wireNarrow.test.ts
git commit -m "feat(cic/directory): narrow directory_progress/complete/failed events (#84)"
```

---

### Task D3: `channelDirectory` store

**Files:**
- Create: `cicchetto/src/lib/channelDirectory.ts`
- Test: `cicchetto/src/lib/channelDirectory.test.ts`

State per focused network: `page` (entries+next_cursor+total+captured_at+status), `sort`, `q`, plus `refreshing`. Exposes `loadDirectory(slug)` (GET with current sort/q), `setSort`, `setQuery` (re-GET), and event-driven `onProgress(network)` / `onComplete(network)` / `onFailed(network)` that re-GET the current view. Mirror the `home.ts` `createRoot` + signal/setter export shape.

- [ ] **Step 1: Failing store test**

```typescript
// cicchetto/src/lib/channelDirectory.test.ts
import { describe, expect, test, vi, beforeEach } from "vitest";
import * as api from "./api";
import { directoryPage, loadDirectory, onDirectoryProgress } from "./channelDirectory";

describe("channelDirectory store", () => {
  beforeEach(() => vi.restoreAllMocks());

  test("loadDirectory populates the page for the network", async () => {
    vi.spyOn(api, "listDirectory").mockResolvedValue({
      entries: [{ name: "#a", topic: "t", user_count: 3 }],
      next_cursor: null, total: 1, captured_at: "2026-06-26T10:00:00Z", status: "fresh",
    });
    await loadDirectory("libera");
    expect(directoryPage("libera")?.total).toBe(1);
    expect(directoryPage("libera")?.entries[0].name).toBe("#a");
  });

  test("a progress ping re-GETs the current view", async () => {
    const spy = vi.spyOn(api, "listDirectory").mockResolvedValue({
      entries: [], next_cursor: null, total: 7, captured_at: null, status: "refreshing",
    });
    await loadDirectory("libera");
    spy.mockClear();
    await onDirectoryProgress("libera");
    expect(spy).toHaveBeenCalledOnce();
    expect(directoryPage("libera")?.total).toBe(7);
  });
});
```

- [ ] **Step 2: Run, fail.**

- [ ] **Step 3: Implement the store** (mirror `home.ts`):

```typescript
// cicchetto/src/lib/channelDirectory.ts
import { createRoot, createSignal } from "solid-js";
import { listDirectory, refreshDirectory, type DirectoryPage } from "./api";
import { token } from "./auth";  // match the real token accessor used by HomePane

type View = { sort: "users" | "name"; q: string };

const exports_ = createRoot(() => {
  const [pages, setPages] = createSignal<Record<string, DirectoryPage>>({});
  const [views, setViews] = createSignal<Record<string, View>>({});

  const viewOf = (slug: string): View => views()[slug] ?? { sort: "users", q: "" };

  const fetchInto = async (slug: string): Promise<void> => {
    const t = token();
    if (!t) return;
    const v = viewOf(slug);
    const page = await listDirectory(t, slug, { sort: v.sort, q: v.q });
    setPages((p) => ({ ...p, [slug]: page }));
  };

  const directoryPage = (slug: string): DirectoryPage | undefined => pages()[slug];

  const loadDirectory = (slug: string): Promise<void> => fetchInto(slug);

  const setSort = async (slug: string, sort: "users" | "name"): Promise<void> => {
    setViews((vs) => ({ ...vs, [slug]: { ...viewOf(slug), sort } }));
    await fetchInto(slug);
  };

  const setQuery = async (slug: string, q: string): Promise<void> => {
    setViews((vs) => ({ ...vs, [slug]: { ...viewOf(slug), q } }));
    await fetchInto(slug);
  };

  const triggerRefresh = async (slug: string): Promise<void> => {
    const t = token();
    if (!t) return;
    await refreshDirectory(t, slug);
  };

  const onDirectoryProgress = (slug: string): Promise<void> => fetchInto(slug);
  const onDirectoryComplete = (slug: string): Promise<void> => fetchInto(slug);
  const onDirectoryFailed = (slug: string): Promise<void> => fetchInto(slug);

  return {
    directoryPage, loadDirectory, setSort, setQuery, triggerRefresh,
    onDirectoryProgress, onDirectoryComplete, onDirectoryFailed,
  };
});

export const directoryPage = exports_.directoryPage;
export const loadDirectory = exports_.loadDirectory;
export const setSort = exports_.setSort;
export const setQuery = exports_.setQuery;
export const triggerRefresh = exports_.triggerRefresh;
export const onDirectoryProgress = exports_.onDirectoryProgress;
export const onDirectoryComplete = exports_.onDirectoryComplete;
export const onDirectoryFailed = exports_.onDirectoryFailed;
```

(Match the real token accessor + `identityScopedStore` if directory state should reset on subject flip — prefer `identityScopedStore` like `windowState.ts` so a logout clears it. Adjust import accordingly.)

- [ ] **Step 4: Run, pass + typecheck.**

- [ ] **Step 5: Commit**

```bash
git add cicchetto/src/lib/channelDirectory.ts cicchetto/src/lib/channelDirectory.test.ts
git commit -m "feat(cic/directory): channelDirectory store (#84)"
```

---

### Task D4: Wire the pings into `userTopic.ts`

**Files:**
- Modify: `cicchetto/src/lib/userTopic.ts` (dispatch switch)
- Test: extend `cicchetto/src/lib/channelDirectory.test.ts` or the userTopic test

- [ ] **Step 1: Add dispatch arms** (mirror the `channels_changed` arm):

```typescript
// in userTopic.ts switch
case "directory_progress":
  void onDirectoryProgress(payload.network);
  return;
case "directory_complete":
  void onDirectoryComplete(payload.network);
  return;
case "directory_failed":
  void onDirectoryFailed(payload.network);
  return;
```

Import `onDirectoryProgress/Complete/Failed` from `./channelDirectory`.

- [ ] **Step 2: Typecheck — the `assertNever` default arm now forces all three to be handled** (`scripts/bun.sh run build`). Expected: clean (proves exhaustiveness).

- [ ] **Step 3: Commit**

```bash
git add cicchetto/src/lib/userTopic.ts
git commit -m "feat(cic/directory): dispatch directory pings -> store re-GET (#84)"
```

---

## Phase E — cic: UI

### Task E1: Window constants for the 📇 `list` window

**Files:**
- Modify: `cicchetto/src/lib/windowKinds.ts`
- Test: `cicchetto/src/lib/windowKinds.test.ts`

The `"list"` `WindowKind` already exists with `KIND_HAS_SCROLLBACK.list = false`. Add the constants (mirror `HOME_WINDOW_SLUG`).

- [ ] **Step 1: Confirm `"list"` is unused elsewhere** — grep `cicchetto/src` for `"list"` as a `kind`. If another feature claims it, STOP and reconcile with vjt. (Expected: scaffolded-but-unused.)

- [ ] **Step 2: Add constants + a guard test**

```typescript
// windowKinds.ts
export const LIST_WINDOW_NAME = "$list";
```

```typescript
// windowKinds.test.ts
test("the list window has no scrollback (no /messages fetch)", () => {
  expect(kindHasScrollback("list")).toBe(false);
});
```

- [ ] **Step 3: Run, pass + commit**

```bash
git add cicchetto/src/lib/windowKinds.ts cicchetto/src/lib/windowKinds.test.ts
git commit -m "feat(cic/directory): $list window constant (#84)"
```

---

### Task E2: Sidebar 📇 row below the network header

**Files:**
- Modify: `cicchetto/src/Sidebar.tsx`
- Test: e2e covers it (Task E5); add a vitest only if the sidebar has unit coverage.

- [ ] **Step 1: Render the row** directly after the network-header `<li>` (mirror the server-window button; emoji 📇, label "channels", selects the `$list` window):

```tsx
<li
  class="sidebar-channel-row sidebar-list-row"
  classList={{ selected: isSelected(network.slug, LIST_WINDOW_NAME) }}
  data-window-name={LIST_WINDOW_NAME}
>
  <button
    type="button"
    onClick={() => handleClick(network.slug, LIST_WINDOW_NAME, "list")}
    class="sidebar-window-btn"
  >
    <span class="sidebar-network-emoji" aria-hidden="true">📇</span>
    <span class="sidebar-channel-name">channels</span>
  </button>
</li>
```

(`handleClick(slug, name, kind)` already routes `setSelectedChannel`; `"list"` kind → `kindHasScrollback` false → no `/messages` fetch. Confirm `handleClick`'s 3rd arg is the `WindowKind`.)

- [ ] **Step 2: Typecheck + commit**

```bash
git add cicchetto/src/Sidebar.tsx
git commit -m "feat(cic/directory): 📇 channels row under each network (#84)"
```

---

### Task E3: `DirectoryPane` component

**Files:**
- Create: `cicchetto/src/DirectoryPane.tsx`
- Modify: the pane router that picks a pane by `selectedChannel().kind` (grep where `HomePane` is chosen — likely `Shell.tsx` or a `Pane` switch) to render `DirectoryPane` for `kind === "list"`.
- Test: `cicchetto/src/DirectoryPane.test.tsx` (vitest + @solidjs/testing-library)

Pane contents (design §cic surface): search bar **top-left**, refresh button **top-right**, live **total count**, muted **"Last refreshed N ago"** (red + CTA when status `stale`), **sort button** (icon reflects active sort), channel **rows** (name · user_count · topic; tap → `postJoin`; rows you're already in badged "joined" + disabled, derived from `windowStateByChannel`). No compose bar. On mount: if `directoryPage(slug)` absent → `loadDirectory(slug)` (GET; server auto-refreshes on empty). **Scroll preservation:** before the store swaps the page on a progress-driven re-GET, capture the scroll container's `scrollTop`; restore it after render (a `createEffect` on `directoryPage(slug)` that reads + writes `el.scrollTop`, so the viewport holds while rows move).

- [ ] **Step 1: Failing render test**

```tsx
// cicchetto/src/DirectoryPane.test.tsx
import { render, screen } from "@solidjs/testing-library";
import { DirectoryPane } from "./DirectoryPane";
import * as store from "./lib/channelDirectory";
import { vi } from "vitest";

test("renders entries with user counts and a live total", () => {
  vi.spyOn(store, "directoryPage").mockReturnValue({
    entries: [{ name: "#elixir", topic: "Elixir", user_count: 1200 }],
    next_cursor: null, total: 1, captured_at: "2026-06-26T10:00:00Z", status: "fresh",
  });
  render(() => <DirectoryPane networkSlug="libera" />);
  expect(screen.getByText("#elixir")).toBeInTheDocument();
  expect(screen.getByText("1200")).toBeInTheDocument();
  expect(screen.getByText(/1 channel/)).toBeInTheDocument();
});

test("stale snapshot shows the red last-refreshed CTA", () => {
  vi.spyOn(store, "directoryPage").mockReturnValue({
    entries: [], next_cursor: null, total: 0, captured_at: "2026-06-20T10:00:00Z", status: "stale",
  });
  render(() => <DirectoryPane networkSlug="libera" />);
  expect(screen.getByText(/tap refresh/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run, fail.** `scripts/bun.sh run test DirectoryPane` → FAIL.

- [ ] **Step 3: Implement `DirectoryPane`** (template — adapt class names to the project's CSS conventions; reuse `NickText`/relative-time helpers if present):

```tsx
// cicchetto/src/DirectoryPane.tsx
import { type Component, For, Show, createEffect, createSignal, onMount } from "solid-js";
import {
  directoryPage, loadDirectory, setQuery, setSort, triggerRefresh,
} from "./lib/channelDirectory";
import { windowStateByChannel } from "./lib/windowState";
import { channelKey } from "./lib/keys";        // match the real key helper
import { postJoin } from "./lib/api";
import { token } from "./lib/auth";

export const DirectoryPane: Component<{ networkSlug: string }> = (props) => {
  let scroller: HTMLDivElement | undefined;
  let savedScrollTop = 0;
  const [sort, setLocalSort] = createSignal<"users" | "name">("users");

  onMount(() => {
    if (!directoryPage(props.networkSlug)) void loadDirectory(props.networkSlug);
  });

  // Preserve scroll position while rows repopulate during a refresh.
  createEffect(() => {
    directoryPage(props.networkSlug); // track
    if (scroller) scroller.scrollTop = savedScrollTop;
  });

  const onScroll = () => { if (scroller) savedScrollTop = scroller.scrollTop; };

  const page = () => directoryPage(props.networkSlug);
  const isJoined = (name: string) =>
    windowStateByChannel()[channelKey(props.networkSlug, name)] === "joined";

  const join = async (name: string) => {
    const t = token();
    if (t) await postJoin(t, props.networkSlug, name, null);
  };

  return (
    <div class="directory-pane">
      <div class="directory-toolbar">
        <input
          class="directory-search"
          type="search"
          placeholder="Search channels…"
          onInput={(e) => void setQuery(props.networkSlug, e.currentTarget.value)}
        />
        <button
          type="button"
          class="directory-sort"
          title={`Sort by ${sort() === "users" ? "users" : "name"}`}
          onClick={() => {
            const next = sort() === "users" ? "name" : "users";
            setLocalSort(next);
            void setSort(props.networkSlug, next);
          }}
        >
          {sort() === "users" ? "▼#" : "A→Z"}
        </button>
        <button
          type="button"
          class="directory-refresh"
          onClick={() => void triggerRefresh(props.networkSlug)}
        >
          ⟳
        </button>
      </div>

      <div class="directory-meta">
        <span class="directory-count">{page()?.total ?? 0} channels</span>
        <Show when={page()?.captured_at}>
          <span
            class="directory-last-refreshed"
            classList={{ stale: page()?.status === "stale" }}
          >
            Last refreshed {relTime(page()!.captured_at!)}
            <Show when={page()?.status === "stale"}> — tap refresh to update</Show>
          </span>
        </Show>
      </div>

      <div class="directory-list" ref={scroller} onScroll={onScroll}>
        <For each={page()?.entries ?? []}>
          {(e) => (
            <div class="directory-row">
              <button
                type="button"
                class="directory-join"
                disabled={isJoined(e.name)}
                onClick={() => void join(e.name)}
              >
                {isJoined(e.name) ? "joined" : "join"}
              </button>
              <span class="directory-name">{e.name}</span>
              <span class="directory-users">{e.user_count}</span>
              <span class="directory-topic">{e.topic}</span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
};

function relTime(iso: string): string {
  // reuse the project's existing relative-time formatter if one exists
  // (grep `ago`/`Intl.RelativeTimeFormat`); inline fallback:
  const diffMs = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diffMs / 86_400_000);
  if (days >= 1) return `${days}d ago`;
  const hrs = Math.floor(diffMs / 3_600_000);
  if (hrs >= 1) return `${hrs}h ago`;
  return "just now";
}
```

- [ ] **Step 4: Hook the pane into the pane router** for `kind === "list"`. Run, pass + typecheck.

- [ ] **Step 5: Commit**

```bash
git add cicchetto/src/DirectoryPane.tsx cicchetto/src/Shell.tsx cicchetto/src/DirectoryPane.test.tsx
git commit -m "feat(cic/directory): DirectoryPane — search/sort/refresh/join, scroll-preserved (#84)"
```

---

### Task E4: Homepage "Browse channels" link + `/list` compose command

**Files:**
- Modify: `cicchetto/src/HomePane.tsx` (per-network "Browse channels" link → select that network's `$list` window)
- Modify: `cicchetto/src/lib/compose.ts` (`parseSlash` — add a `/list` command that selects the focused network's `$list` window)
- Test: `cicchetto/src/lib/compose.test.ts`

- [ ] **Step 1: Failing compose test**

```typescript
// compose.test.ts
test("/list selects the $list window for the focused network", () => {
  const cmd = parseSlash("/list", "libera");  // match parseSlash's real signature
  expect(cmd).toEqual({ kind: "list" });       // or whatever the discriminated result shape is
});
```

- [ ] **Step 2: Run, fail.**

- [ ] **Step 3: Add the `/list` arm** in `parseSlash` returning a `{ kind: "list" }` command; in the command executor (where `kind: "join"` calls `postJoin`), handle `kind: "list"` by `setSelectedChannel({ networkSlug: focusedSlug, channelName: LIST_WINDOW_NAME, kind: "list" })`.

- [ ] **Step 4: Add the HomePane link** — in `ConnectedRow` (HomePane.tsx), add a "Browse channels" button that calls `setSelectedChannel({ networkSlug: row.slug, channelName: LIST_WINDOW_NAME, kind: "list" })`.

- [ ] **Step 5: Run, pass + typecheck + commit**

```bash
git add cicchetto/src/HomePane.tsx cicchetto/src/lib/compose.ts cicchetto/src/lib/compose.test.ts
git commit -m "feat(cic/directory): /list command + homepage browse link (#84)"
```

---

### Task E5: e2e

**Files:**
- Create: `cicchetto/e2e/tests/channel-directory.spec.ts`

Use the e2e harness (`scripts/integration.sh` / testnet) with the in-process IRC test server that can answer `LIST`. Mirror an existing spec's setup.

- [ ] **Step 1: Write the e2e**

```typescript
// cicchetto/e2e/tests/channel-directory.spec.ts
import { test, expect } from "./fixtures";  // match the repo's e2e fixtures

test("📇 channels window: opening fires no /messages, search + one-click join work", async ({ page, ircServer }) => {
  // arrange: a connected network whose LIST returns a few channels
  ircServer.onList(["#elixir 1200 :Elixir", "#ruby 800 :Ruby", "#niche 2 :tiny"]);

  // assert no /messages request when selecting the synthetic window (#81 guard)
  const messageReqs: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/messages")) messageReqs.push(r.url()); });

  await page.getByRole("button", { name: "channels" }).first().click();
  await expect(page.getByText("#elixir")).toBeVisible();
  expect(messageReqs).toHaveLength(0);

  // search
  await page.getByPlaceholder("Search channels…").fill("ruby");
  await expect(page.getByText("#ruby")).toBeVisible();
  await expect(page.getByText("#elixir")).toHaveCount(0);

  // one-click join transitions the row
  await page.getByText("#ruby").click();
  // ...assert it appears in the sidebar / row shows "joined"
});
```

- [ ] **Step 2: Run e2e** (`scripts/integration.sh`, or the targeted e2e per `docs/TESTING.md`). Fix selectors to match the rendered DOM. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add cicchetto/e2e/tests/channel-directory.spec.ts
git commit -m "test(cic/directory): e2e — open/search/join + #81 no-messages guard (#84)"
```

---

## Final gate

- [ ] `scripts/check.sh` green (Elixir: test/Dialyzer/Credo/Sobelow/format).
- [ ] `scripts/bun.sh run build` clean (real cic type gate) + `scripts/bun.sh run test` green.
- [ ] e2e green (`scripts/integration.sh`).
- [ ] Update `docs/DESIGN_NOTES.md` (directory decision log) + `todo.md` (remove #84) + checkpoint.
- [ ] Add a `docs/project-story.md` episode if the LIST-interception or scroll-preservation turned out hard-won.
- [ ] Rebase onto main, merge, push, deploy-m42 (COLD — config change + new migration), health-check.
```
