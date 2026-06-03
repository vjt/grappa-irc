# Per-Server Outbound Source Address Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a `network_servers` row carry a fixed literal source IP (v4 or v6) that outbound IRC connections bind as their source address (bypassing the rotating visitor pool), and auto-exclude every configured fixed source from that pool so a visitor can never draw a dedicated oper IP.

**Architecture:** A nullable `source_address` column on `network_servers` is validated to a strict IP literal at the changeset boundary and threaded — as a field on the already-picked `%Server{}` — through both `SessionPlan` builders → `Session.start_opts` → `Session.Server.client_opts/1` → `IRC.Client` connect, where a new fixed-source bind path resolves the upstream for the source's family only and hard-errors on a family mismatch. `Grappa.Bootstrap`, before spawning any session, subtracts every configured fixed source from the effective `OutboundV6Pool` (subtract-never-assert: overlap never refuses boot).

**Tech Stack:** Elixir 1.19 / OTP 28, Ecto + ecto_sqlite3, `:inet` / `:inet_res` for socket binding, `Grappa.IRCServer` in-process fake for connect tests. All gates run in-container via `scripts/test.sh` and `scripts/check.sh`.

**Source of truth:** `docs/superpowers/specs/2026-06-03-per-server-source-address-design.md`. Read it before starting. Non-goals are binding: NO WEBIRC, NO IPv4 *pool*, NO all-servers-same-source constraint, NO visitor-admission guard.

**Worktree:** All code lands in worktree `/home/vjt/code/IRC/grappa-task-source-addr`, branch `feat/per-server-source-address`, branched from **local** main. This plan file is docs and lives on main. NEVER `mix` on the host — every gate is `scripts/*.sh` (container). Run them FROM the worktree (scripts are worktree-aware).

---

## File touch-list (decomposition)

| File | Responsibility | Task |
|------|----------------|------|
| `priv/repo/migrations/<ts>_add_source_address_to_servers.exs` (new) | add nullable column | 1 |
| `lib/grappa/networks/server.ex` | schema field + `@type` + cast + strict-IP-literal validation (canonicalize) | 1 |
| `lib/grappa/outbound_v6_pool.ex` | `apply_exclusions/1`, `raw_pool/0`, raw-vs-effective split | 2 |
| `test/support/irc_server.ex` | `peername/1` so a connect test can observe the bound source | 3 |
| `lib/grappa/irc/client.ex` | `do_connect/4`, fixed-source bind path (v4+v6), family-mismatch error, opts type | 3 |
| `lib/grappa/networks/session_plan.ex` | thread `source_address` into the user plan | 4 |
| `lib/grappa/visitors/session_plan.ex` | thread `source_address` into the visitor plan | 4 |
| `lib/grappa/session.ex` | `start_opts/0` gains `source_address` | 4 |
| `lib/grappa/session/server.ex` | `init_opts/0` + `client_opts/1` carry `source_address` | 4 |
| `lib/grappa/networks/servers.ex` | `list_source_addresses/0` (non-NULL sources) | 5 |
| `lib/grappa/bootstrap.ex` | gather sources → `apply_exclusions/1` → honest log, before spawn; boundary dep | 5 |
| `lib/mix/tasks/grappa.bind_network.ex` | `--source` option | 6 |
| `lib/mix/tasks/grappa.add_server.ex` | `--source` option + in-pool notice | 6 |
| `docs/DESIGN_NOTES.md`, `README.md` | landing record + server-field doc | 7 |

Task order is linear and keeps the tree green at every commit: 1 (column+schema, nothing reads it yet) → 2 (pool, independent) → 3 (client accepts an optional source; existing callers unaffected) → 4 (resolvers set it + types tighten) → 5 (bootstrap wires exclusion) → 6 (operator surface) → 7 (docs).

---

## Pre-flight (already done in this session, re-verify in the worktree)

- [ ] **Confirm baseline green.** From the worktree: `scripts/check.sh`. If the container's deps volume is stale, `scripts/mix.sh deps.get` first (the lock can drift from `mix.lock`). Must be fully green before Task 1. **Do not trust a piped exit code** — read the tail of the log (RC2 lesson: `cmd | tail` reports `tail`'s exit, not the command's).

---

## Task 1: Migration + `source_address` schema field + changeset validation

**Files:**
- Create: `priv/repo/migrations/<ts>_add_source_address_to_servers.exs`
- Modify: `lib/grappa/networks/server.ex`
- Test: `test/grappa/networks/server_test.exs` (create if absent; otherwise add a `describe`)

- [ ] **Step 1: Write the failing changeset tests**

Create/extend `test/grappa/networks/server_test.exs`:

```elixir
defmodule Grappa.Networks.ServerTest do
  use Grappa.DataCase, async: true

  alias Grappa.Networks.Server

  @base %{network_id: 1, host: "irc.example.org", port: 6697}

  defp source_changeset(value),
    do: Server.changeset(%Server{}, Map.put(@base, :source_address, value))

  describe "source_address validation" do
    test "accepts a strict IPv4 literal and stores it canonical" do
      cs = source_changeset("127.0.0.1")
      assert cs.valid?
      assert Ecto.Changeset.get_change(cs, :source_address) == "127.0.0.1"
    end

    test "accepts a strict IPv6 literal and stores it canonical (compressed)" do
      cs = source_changeset("2a03:4000:0002:033c:0000:0000:0000:9000")
      assert cs.valid?
      assert Ecto.Changeset.get_change(cs, :source_address) == "2a03:4000:2:33c::9000"
    end

    test "NULL source is valid (pool semantics, unchanged)" do
      assert Server.changeset(%Server{}, @base).valid?
    end

    test "rejects a hostname" do
      refute source_changeset("irc.azzurra.org").valid?
    end

    test "rejects CIDR notation" do
      refute source_changeset("2a03:4000:2:33c::/64").valid?
    end

    test "rejects the empty string" do
      refute source_changeset("").valid?
    end

    test "rejects garbage" do
      refute source_changeset("not-an-ip").valid?
    end

    test "rejects a non-strict (zero-padded-octet) IPv4" do
      # :inet.parse_ipv4strict_address rejects 0177-style / leading-zero octets
      refute source_changeset("010.0.0.1").valid?
    end
  end
end
```

- [ ] **Step 2: Run it, verify it fails**

Run: `scripts/test.sh test/grappa/networks/server_test.exs`
Expected: FAIL — `source_address` is not cast/validated yet (changes absent, accepts-garbage assertions red).

- [ ] **Step 3: Generate the migration**

Run: `scripts/mix.sh ecto.gen.migration add_source_address_to_servers`
Then replace the generated file body with:

```elixir
defmodule Grappa.Repo.Migrations.AddSourceAddressToServers do
  @moduledoc """
  Per-server outbound source address. A non-NULL `source_address` is a
  literal IPv4/IPv6 the IRC client binds as the connection's source
  (bypassing the rotating `OutboundV6Pool`); NULL keeps the existing
  pool/kernel-default path. Validated to a strict IP literal at the
  `Grappa.Networks.Server` changeset boundary — the column is plain text.

  Spec: docs/superpowers/specs/2026-06-03-per-server-source-address-design.md
  """
  use Ecto.Migration

  def change do
    alter table(:network_servers) do
      add :source_address, :string, null: true
    end
  end
end
```

- [ ] **Step 4: Add the schema field, type, cast, and validation**

In `lib/grappa/networks/server.ex`:

Add to `@type t`:
```elixir
          source_address: String.t() | nil,
```
(place it after `enabled:` to keep field order readable)

Add to `schema "network_servers"` (after `field :enabled, ...`):
```elixir
    field :source_address, :string
```

In `changeset/2`, add `:source_address` to the cast list and a validation call:
```elixir
  def changeset(server, attrs) do
    server
    |> cast(attrs, [:network_id, :host, :port, :tls, :priority, :enabled, :source_address])
    |> validate_required([:network_id, :host, :port])
    |> validate_length(:host, min: 1, max: 255)
    |> validate_number(:port, greater_than: 0, less_than_or_equal_to: 65_535)
    |> validate_source_address()
    |> unique_constraint([:network_id, :host, :port],
      name: :network_servers_network_id_host_port_index
    )
  end

  # `source_address`, when set, MUST be a strict literal IPv4 or IPv6
  # address — no hostname (the operator resolves m42.openssl.it
  # themselves), no CIDR, no empty string. A strict parse makes the
  # bind family unambiguous and the pool subtraction a static set
  # difference (spec §1, decision 2). On success the value is rewritten
  # to its canonical form (`:inet.ntoa/1`) so the stored string is
  # stable regardless of how the operator typed it.
  @spec validate_source_address(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp validate_source_address(changeset) do
    case fetch_change(changeset, :source_address) do
      :error -> changeset
      {:ok, nil} -> changeset
      {:ok, value} -> validate_ip_literal(changeset, value)
    end
  end

  defp validate_ip_literal(changeset, value) do
    charlist = String.to_charlist(value)

    cond do
      match?({:ok, _}, :inet.parse_ipv4strict_address(charlist)) -> put_canonical(changeset, charlist)
      match?({:ok, _}, :inet.parse_ipv6strict_address(charlist)) -> put_canonical(changeset, charlist)
      true -> add_error(changeset, :source_address, "must be a literal IPv4 or IPv6 address (no hostname, CIDR, or port)")
    end
  end

  defp put_canonical(changeset, charlist) do
    {:ok, tuple} = :inet.parse_address(charlist)
    put_change(changeset, :source_address, to_string(:inet.ntoa(tuple)))
  end
```

Add `import Ecto.Changeset` already present (it is). No new alias needed.

- [ ] **Step 5: Run the migration + tests**

Run: `scripts/mix.sh ecto.migrate` then `scripts/test.sh test/grappa/networks/server_test.exs`
Expected: PASS — all eight assertions green.

- [ ] **Step 6: Commit**

```bash
git add priv/repo/migrations lib/grappa/networks/server.ex test/grappa/networks/server_test.exs
git commit -m "$(cat <<'EOF'
feat(networks): add per-server source_address column + strict-IP validation

Nullable network_servers.source_address: a literal IPv4/IPv6 the IRC
client will bind as the outbound source, bypassing the rotating
OutboundV6Pool. Validated to a strict IP literal at the changeset
boundary (rejects hostname/CIDR/empty) and stored canonical so the
pool-exclusion set difference is unambiguous.

Spec: docs/superpowers/specs/2026-06-03-per-server-source-address-design.md
EOF
)"
```

---

## Task 2: `OutboundV6Pool.apply_exclusions/1` + `raw_pool/0` (raw-vs-effective)

**Files:**
- Modify: `lib/grappa/outbound_v6_pool.ex`
- Test: `test/grappa/outbound_v6_pool_test.exs`

**Contract:** `apply_exclusions([String.t()]) :: :ok` — recompute `effective = raw -- normalize(exclusions)` and install it at the key `pick/0` reads, keeping `raw` separate so the op is idempotent. `raw_pool/0 :: [:inet.ip6_address()]` exposes the unmodified env pool (for the operator-notice in Task 6). v4 exclusions against the v6 pool are a no-op (disjoint by family).

- [ ] **Step 1: Write the failing tests**

Append to `test/grappa/outbound_v6_pool_test.exs` (the `setup` already restores boot state on exit):

```elixir
  describe "apply_exclusions/1 + raw_pool/0" do
    setup do
      Application.put_env(:grappa, :outbound_v6_pool, [
        {0x2A03, 0x4000, 0x2, 0x33C, 0, 0, 0, 0x9000},
        {0x2A03, 0x4000, 0x2, 0x33C, 0, 0, 0, 0x442}
      ])

      :ok = OutboundV6Pool.boot()
    end

    test "effective pool = raw minus the excluded source" do
      :ok = OutboundV6Pool.apply_exclusions(["2a03:4000:2:33c::9000"])

      assert OutboundV6Pool.raw_pool() == [
               {0x2A03, 0x4000, 0x2, 0x33C, 0, 0, 0, 0x9000},
               {0x2A03, 0x4000, 0x2, 0x33C, 0, 0, 0, 0x442}
             ]

      # pick/0 now only ever returns the surviving member
      assert {:ok, {0x2A03, 0x4000, 0x2, 0x33C, 0, 0, 0, 0x442}} = OutboundV6Pool.pick()
    end

    test "string-format variant of a pool member is still removed" do
      # zero-padded / uncompressed spelling of ::9000 normalizes to the
      # same tuple as the stored pool entry
      :ok = OutboundV6Pool.apply_exclusions(["2a03:4000:0002:033c:0000:0000:0000:9000"])
      refute {0x2A03, 0x4000, 0x2, 0x33C, 0, 0, 0, 0x9000} in effective()
    end

    test "v4 exclusion against the v6 pool is a no-op" do
      :ok = OutboundV6Pool.apply_exclusions(["203.0.113.7"])
      assert length(effective()) == 2
    end

    test "is idempotent — re-running with the same exclusion is stable" do
      :ok = OutboundV6Pool.apply_exclusions(["2a03:4000:2:33c::9000"])
      :ok = OutboundV6Pool.apply_exclusions(["2a03:4000:2:33c::9000"])
      assert length(effective()) == 1
    end
  end

  # Reads the effective pool the way pick/0 does, for assertion.
  defp effective, do: :persistent_term.get({OutboundV6Pool, :pool}, [])
```

- [ ] **Step 2: Run it, verify it fails**

Run: `scripts/test.sh test/grappa/outbound_v6_pool_test.exs`
Expected: FAIL — `apply_exclusions/1` and `raw_pool/0` are undefined.

- [ ] **Step 3: Implement raw-vs-effective**

In `lib/grappa/outbound_v6_pool.ex`, add a raw key and update `boot/0`:

```elixir
  @key {__MODULE__, :pool}
  @raw_key {__MODULE__, :raw_pool}
```

```elixir
  def boot do
    pool = Application.get_env(:grappa, :outbound_v6_pool, [])
    :persistent_term.put(@raw_key, pool)
    :persistent_term.put(@key, pool)
    :ok
  end
```

Add the two new functions (place after `pick/0`):

```elixir
  @doc """
  Installs an *effective* pool = `raw_pool/0 -- exclusions`, written to
  the `:persistent_term` key `pick/0` reads. `exclusion_ips` is a list
  of literal IP strings (the configured per-server `source_address`es);
  each is normalized to an `:inet` IP tuple before the set difference so
  string-format differences (`::1` vs `0:0:..:1`) can't leak a dedicated
  IP back into the pool. v4 exclusions against the v6 pool are disjoint
  by family — a harmless no-op.

  Idempotent: recomputes from the immutable raw pool every call, so
  re-running with the same or an expanded exclusion set is safe. Called
  by `Grappa.Bootstrap` before it spawns any session (spec §3).
  """
  @spec apply_exclusions([String.t()]) :: :ok
  def apply_exclusions(exclusion_ips) when is_list(exclusion_ips) do
    excluded = exclusion_ips |> Enum.map(&normalize/1) |> MapSet.new()
    effective = Enum.reject(raw_pool(), &MapSet.member?(excluded, &1))
    :persistent_term.put(@key, effective)
    :ok
  end

  @doc """
  The raw env-derived pool, before any exclusions. Operator-facing
  surface for the `--source already in GRAPPA_OUTBOUND_V6_POOL` notice
  in `mix grappa.bind_network` / `grappa.add_server`.
  """
  @spec raw_pool() :: [:inet.ip6_address()]
  def raw_pool, do: :persistent_term.get(@raw_key, [])

  # Source strings are already validated strict literals at the
  # Server changeset boundary, so a parse failure here is a broken
  # invariant — let it crash loud rather than silently drop an
  # exclusion (which would leak a dedicated IP into the visitor pool).
  @spec normalize(String.t()) :: :inet.ip_address()
  defp normalize(ip_string) do
    {:ok, tuple} = :inet.parse_address(String.to_charlist(ip_string))
    tuple
  end
```

- [ ] **Step 4: Run it, verify pass**

Run: `scripts/test.sh test/grappa/outbound_v6_pool_test.exs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/outbound_v6_pool.ex test/grappa/outbound_v6_pool_test.exs
git commit -m "$(cat <<'EOF'
feat(pool): OutboundV6Pool.apply_exclusions/1 — subtract fixed sources

Raw-vs-effective split: boot/0 stashes the env pool at a separate raw
key; apply_exclusions/1 recomputes effective = raw - exclusions (tuple-
normalized, idempotent) into the key pick/0 reads. raw_pool/0 exposes
the unmodified pool for the operator notice. v4 exclusions against the
v6 pool are a family-disjoint no-op. No assertion — subtract, never
refuse to boot (spec §3).
EOF
)"
```

---

## Task 3: `IRC.Client` fixed-source bind path (v4 + v6 + family-mismatch)

**Files:**
- Modify: `test/support/irc_server.ex` (add `peername/1`)
- Modify: `lib/grappa/irc/client.ex`
- Test: `test/grappa/irc/client_test.exs`

**Contract:** `handle_continue({:connect, opts}, _)` reads `Map.get(opts, :source_address)` and passes it to `do_connect/4`. With a NULL source the existing `resolve_and_ifaddr/1` path runs verbatim. With a fixed source: derive the family from the literal, resolve the upstream host for *that family only* (`:inet.getaddr/2` — handles literal upstreams too), bind `ifaddr` + connect over that family; on `[]`/error resolution return `{:error, {:source_family_mismatch, source, host, fam}}` (logged) so the existing connect-fail throttle surfaces the misconfig. Deterministic — no per-connect roll.

> **Why `:inet.getaddr/2`, not `:inet_res.lookup/3` (the pool path's call):** the fixed-source family check is "is the upstream reachable in the operator-pinned family?" `:inet.getaddr(host, fam)` answers exactly that AND resolves literal upstream IPs and `/etc/hosts` (which `:inet_res.lookup/3`, a pure-DNS query, returns `[]` for — that would make every literal-host config and the loopback test a spurious family mismatch). The NULL-source path keeps `:inet_res.lookup/3` untouched.

- [ ] **Step 1: Add `peername/1` to the IRCServer fake**

In `test/support/irc_server.ex`, add a public call + handler (mirror the existing `port/1`):

```elixir
  @doc "Peer (client source) address of the accepted connection."
  def peername(server), do: GenServer.call(server, :peername)
```
```elixir
  def handle_call(:peername, _, state), do: {:reply, :inet.peername(state.sock), state}
```
(place the `handle_call(:peername, ...)` next to `handle_call(:port, ...)`)

- [ ] **Step 2: Write the failing tests**

Add to `test/grappa/irc/client_test.exs` (uses the existing `start_client/2`, `free_port/0`, `await_handshake/1`, and an echo/no-op handler):

```elixir
  describe "outbound source-address bind" do
    test "binds a v4 source — server observes the bound peer, not the default" do
      # Source 127.0.0.2 is a distinct loopback address from the default
      # 127.0.0.1, so the observed peer proves the ifaddr bind took effect.
      {:ok, server} = IRCServer.start_link(fn state, _line -> {:reply, nil, state} end)
      port = IRCServer.port(server)

      _client = start_client(port, %{source_address: "127.0.0.2"})
      :ok = await_handshake(server)

      assert {:ok, {{127, 0, 0, 2}, _ephemeral}} = IRCServer.peername(server)
    end

    test "NULL source still connects via the pool/kernel-default path" do
      {:ok, server} = IRCServer.start_link(fn state, _line -> {:reply, nil, state} end)
      port = IRCServer.port(server)

      _client = start_client(port, %{source_address: nil})
      :ok = await_handshake(server)

      assert {:ok, {{127, 0, 0, 1}, _ephemeral}} = IRCServer.peername(server)
    end

    test "source_bind/2: v4 source yields inet family + ifaddr tuple" do
      assert {:ok, {[ifaddr: {127, 0, 0, 2}], :inet}} =
               Client.__source_bind_for_test__(~c"127.0.0.1", "127.0.0.2")
    end

    test "source_bind/2: v6 source yields inet6 family + ifaddr tuple" do
      assert {:ok, {[ifaddr: {0, 0, 0, 0, 0, 0, 0, 1}], :inet6}} =
               Client.__source_bind_for_test__(~c"::1", "::1")
    end

    test "source_bind/2: source family vs upstream-only-other-family is a clear error" do
      assert {:error, {:source_family_mismatch, "::1", "127.0.0.1", :inet6}} =
               Client.__source_bind_for_test__(~c"127.0.0.1", "::1")
    end

    test "source_bind/2: NULL source delegates to the pool path (inet, no ifaddr)" do
      assert {:ok, {[], :inet}} = Client.__source_bind_for_test__(~c"127.0.0.1", nil)
    end
  end
```

- [ ] **Step 3: Run it, verify it fails**

Run: `scripts/test.sh test/grappa/irc/client_test.exs`
Expected: FAIL — `__source_bind_for_test__/2` undefined; `start_client` doesn't thread `source_address`.

- [ ] **Step 4: Implement the bind path**

In `lib/grappa/irc/client.ex`:

(a) `opts` type — add as the last entry (keep it optional; many test callers and the existing `start_client/2` helper omit it):
```elixir
          optional(:password) => String.t() | nil,
          optional(:source_address) => String.t() | nil
```

(b) `handle_continue({:connect, opts}, state)` — pass the source:
```elixir
    case do_connect(host, opts.port, opts.tls, Map.get(opts, :source_address)) do
```

(c) Replace the two `do_connect/3` clauses + `resolve_and_ifaddr/1` block. Keep `resolve_and_ifaddr/1` exactly as is; route through a new `do_connect/4` + `source_bind/2`:
```elixir
  defp do_connect(host, port, tls, source_address) do
    case source_bind(host, source_address) do
      {:ok, {bind_opts, fam}} ->
        transport_connect(host, port, tls, bind_opts, fam)

      {:error, {:source_family_mismatch, _, _, _} = reason} ->
        # Permanent misconfig (e.g. a v4 source pinned to a v6-only
        # upstream). Surface it loud; the existing connect-fail throttle
        # + :transient give-up machinery handles the rest. `:error` is
        # the allowlisted Logger key (config/config.exs) — the full
        # tuple rides inside it, no metadata-allowlist churn.
        Logger.error("outbound source-address family mismatch — refusing connect",
          error: inspect(reason)
        )

        {:error, reason}
    end
  end

  defp transport_connect(host, port, false, bind_opts, fam) do
    :gen_tcp.connect(host, port, [:binary, fam, packet: :line, active: :once] ++ bind_opts, @connect_timeout_ms)
  end

  defp transport_connect(host, port, true, bind_opts, fam) do
    :ssl.connect(
      host,
      port,
      [:binary, fam, packet: :line, active: :once, verify: :verify_none] ++ bind_opts,
      @connect_timeout_ms
    )
  end

  # Fixed source present → bind that literal as `ifaddr` over its own
  # family, after confirming the upstream is reachable in that family.
  # NULL source → the existing rotating-pool / kernel-default path,
  # verbatim. Deterministic for a fixed source (no per-connect roll) so
  # the upstream sees a stable O-line host on every retry (spec §2).
  @spec source_bind(charlist(), String.t() | nil) ::
          {:ok, {keyword(), :inet | :inet6}}
          | {:error, {:source_family_mismatch, String.t(), String.t(), :inet | :inet6}}
  defp source_bind(host, nil), do: {:ok, resolve_and_ifaddr(host)}

  defp source_bind(host, source) when is_binary(source) do
    {fam, source_tuple} = parse_source_family(source)

    case :inet.getaddr(host, fam) do
      {:ok, _} -> {:ok, {[ifaddr: source_tuple], fam}}
      {:error, _} -> {:error, {:source_family_mismatch, source, to_string(host), fam}}
    end
  end

  # The source string is a strict literal (validated at the Server
  # changeset boundary), so exactly one parser succeeds. A failure here
  # is a broken invariant — let it crash (no silent fallback).
  @spec parse_source_family(String.t()) :: {:inet | :inet6, :inet.ip_address()}
  defp parse_source_family(source) do
    charlist = String.to_charlist(source)

    case :inet.parse_ipv4strict_address(charlist) do
      {:ok, v4} ->
        {:inet, v4}

      {:error, _} ->
        {:ok, v6} = :inet.parse_ipv6strict_address(charlist)
        {:inet6, v6}
    end
  end

  @doc false
  # Test-only seam for the family / ifaddr / mismatch logic. Production
  # callers go through do_connect/4. Mirrors the __merge_autojoin_for_test__
  # convention in Networks.SessionPlan — greppable, absent from public docs.
  @spec __source_bind_for_test__(charlist(), String.t() | nil) ::
          {:ok, {keyword(), :inet | :inet6}}
          | {:error, {:source_family_mismatch, String.t(), String.t(), :inet | :inet6}}
  def __source_bind_for_test__(host, source), do: source_bind(host, source)
```

(d) `start_client/2` in the test file already merges `overrides` over a base map — `source_address` flows through `Map.merge` with no change needed. (No production edit; the `%{source_address: ...}` override lands in `opts` and `handle_continue` reads it via `Map.get`.)

- [ ] **Step 5: Run it, verify pass**

Run: `scripts/test.sh test/grappa/irc/client_test.exs`
Expected: PASS — all six new tests + the existing connect/auth suite green. The v4-peer test requires `127.0.0.2` to be loopback-bindable (true on Linux/RPi).

- [ ] **Step 6: Re-run the full IRC suite (parser/client are binary-pattern-sensitive)**

Run: `scripts/test.sh test/grappa/irc/`
Expected: PASS, zero warnings.

- [ ] **Step 7: Commit**

```bash
git add lib/grappa/irc/client.ex test/support/irc_server.ex test/grappa/irc/client_test.exs
git commit -m "$(cat <<'EOF'
feat(irc): fixed-source outbound bind path (v4 + v6) on IRC.Client

do_connect/4 takes the picked server's source_address. NULL → existing
rotating-pool/kernel-default path verbatim. Fixed source → derive
family from the literal, confirm the upstream resolves in that family
(:inet.getaddr/2, handles literal hosts), bind ifaddr + connect over
that family. Family mismatch (e.g. v4 source vs v6-only upstream) is a
clear logged {:source_family_mismatch, ...} error routed through the
existing connect-fail throttle — no silent fallback. Deterministic per
spec §2 (O-line host stability). IRCServer fake gains peername/1 so the
test observes the bound source (127.0.0.2 distinct from the default).
EOF
)"
```

---

## Task 4: Thread `source_address` from the picked server to the connect

**Files:**
- Modify: `lib/grappa/networks/session_plan.ex`
- Modify: `lib/grappa/visitors/session_plan.ex`
- Modify: `lib/grappa/session.ex` (`start_opts/0`)
- Modify: `lib/grappa/session/server.ex` (`init_opts/0` + `client_opts/1`)
- Test: `test/grappa/networks/session_plan_test.exs`, `test/grappa/visitors/session_plan_test.exs`

**Contract:** Both resolvers always emit `source_address: server.source_address` (nil or canonical string) — so `start_opts/0` and `init_opts/0` carry it as a **required** key (`String.t() | nil`), and `client_opts/1` forwards it to `IRC.Client`. The field is connect-time only; it is NOT stored on `Session.Server` `t` state.

- [ ] **Step 1: Write the failing resolver tests**

In `test/grappa/networks/session_plan_test.exs`, add inside the existing `describe "resolve/1"` (or a new one). Use the existing fixtures; `network_with_server/1` and `credential_fixture/3` live in `test/support/auth_fixtures.ex`:

```elixir
    test "carries the picked server's source_address into the plan" do
      %{network: network} = network_with_server(source_address: "203.0.113.9")
      user = user_fixture()
      cred = credential_fixture(user, network)

      assert {:ok, plan} = SessionPlan.resolve(cred)
      assert plan.source_address == "203.0.113.9"
    end

    test "NULL source server yields source_address: nil in the plan" do
      %{network: network} = network_with_server()
      user = user_fixture()
      cred = credential_fixture(user, network)

      assert {:ok, plan} = SessionPlan.resolve(cred)
      assert plan.source_address == nil
    end
```

> `network_with_server/1` currently hardcodes the server attrs — extend it in Step 3 to forward an optional `:source_address`. Mirror the same two tests in `test/grappa/visitors/session_plan_test.exs` against `VisitorSessionPlan.resolve/1` + the visitor fixtures.

- [ ] **Step 2: Run them, verify they fail**

Run: `scripts/test.sh test/grappa/networks/session_plan_test.exs test/grappa/visitors/session_plan_test.exs`
Expected: FAIL — `plan.source_address` key missing; `network_with_server` doesn't accept `:source_address`.

- [ ] **Step 3: Thread the field through every layer**

(a) `test/support/auth_fixtures.ex` `network_with_server/1` — forward an optional source to the server attrs:
```elixir
    {:ok, server} =
      Servers.add_server(network, %{
        host: host,
        port: port,
        tls: tls,
        source_address: Keyword.get(attrs, :source_address)
      })
```

(b) `lib/grappa/networks/session_plan.ex` `build_plan/4` map — add after `tls: server.tls,`:
```elixir
      source_address: server.source_address,
```

(c) `lib/grappa/visitors/session_plan.ex` `build_plan/3` map — add after `tls: server.tls,`:
```elixir
      source_address: server.source_address,
```

(d) `lib/grappa/session.ex` `start_opts/0` — add after `required(:tls) => boolean(),`:
```elixir
          required(:source_address) => String.t() | nil,
```

(e) `lib/grappa/session/server.ex` `init_opts/0` — add after `required(:tls) => boolean(),`:
```elixir
          required(:source_address) => String.t() | nil,
```

(f) `lib/grappa/session/server.ex` `client_opts/1` — add after `tls: opts.tls,`:
```elixir
      source_address: opts.source_address,
```

- [ ] **Step 4: Run the resolver tests, verify pass**

Run: `scripts/test.sh test/grappa/networks/session_plan_test.exs test/grappa/visitors/session_plan_test.exs`
Expected: PASS.

- [ ] **Step 5: Run the session + bootstrap + controller suites (required-key churn check)**

Making `source_address` a required `start_opts`/`init_opts` key means any direct opts builder that omits it would crash `client_opts/1`. Production builders are the two resolvers; test builders go through `auth_fixtures` helpers. Confirm nothing else hand-rolls the map:

Run: `scripts/test.sh test/grappa/session/ test/grappa/bootstrap_test.exs test/grappa_web/`
Expected: PASS, zero warnings. If a test fails on a missing `source_address`, fix the *fixture/helper* it uses (do NOT weaken `client_opts/1` to `Map.get` — the production contract is "always present").

- [ ] **Step 6: Commit**

```bash
git add lib/grappa/networks/session_plan.ex lib/grappa/visitors/session_plan.ex \
        lib/grappa/session.ex lib/grappa/session/server.ex test/support/auth_fixtures.ex \
        test/grappa/networks/session_plan_test.exs test/grappa/visitors/session_plan_test.exs
git commit -m "$(cat <<'EOF'
feat(session): thread source_address from picked server to IRC connect

Both SessionPlan resolvers emit source_address (nil or canonical
string) from the already-picked %Server{}; start_opts/0 and init_opts/0
carry it as a required key; client_opts/1 forwards it to IRC.Client. One
extra value on the existing host/port/tls path — no new control flow.
Connect-time only, not stored on Session.Server state.
EOF
)"
```

---

## Task 5: `Bootstrap` subtracts fixed sources from the pool before spawn

**Files:**
- Modify: `lib/grappa/networks/servers.ex` (`list_source_addresses/0`)
- Modify: `lib/grappa/bootstrap.ex` (gather → exclude → log; boundary dep)
- Test: `test/grappa/networks/servers_test.exs`, `test/grappa/bootstrap_test.exs`

**Contract:** `Servers.list_source_addresses/0 :: [String.t()]` returns every non-NULL `source_address`. `Bootstrap.run/0`, after the hard-fail validators and **before** any spawn, calls `OutboundV6Pool.apply_exclusions(Servers.list_source_addresses())` and logs an honest one-liner (counts in the message string — no new Logger metadata keys).

- [ ] **Step 1: Write the failing tests**

`test/grappa/networks/servers_test.exs`:
```elixir
  describe "list_source_addresses/0" do
    test "returns only non-NULL source addresses" do
      %{network: net} = network_with_server(source_address: "203.0.113.9")
      {:ok, _} = Servers.add_server(net, %{host: "irc2.example.org", port: 6697})

      assert Servers.list_source_addresses() == ["203.0.113.9"]
    end

    test "returns [] when no server has a source" do
      network_with_server()
      assert Servers.list_source_addresses() == []
    end
  end
```

`test/grappa/bootstrap_test.exs` (this suite already drives `Bootstrap.run/0` against a sandboxed Repo):
```elixir
  describe "outbound pool exclusion" do
    setup do
      prior = Application.get_env(:grappa, :outbound_v6_pool, [])

      on_exit(fn ->
        Application.put_env(:grappa, :outbound_v6_pool, prior)
        :ok = Grappa.OutboundV6Pool.boot()
      end)

      Application.put_env(:grappa, :outbound_v6_pool, [
        {0x2A03, 0x4000, 0x2, 0x33C, 0, 0, 0, 0x9000}
      ])

      :ok = Grappa.OutboundV6Pool.boot()
    end

    test "subtracts a configured fixed source that overlaps the pool, with an honest log" do
      %{network: _} = network_with_server(source_address: "2a03:4000:2:33c::9000")

      log =
        ExUnit.CaptureLog.capture_log(fn ->
          {:ok, _result} = Grappa.Bootstrap.run()
        end)

      # Excluded from the effective pool — pick can no longer return it
      assert :persistent_term.get({Grappa.OutboundV6Pool, :pool}, []) == []
      assert log =~ "outbound pool"
      assert log =~ "1 excluded"
    end
  end
```

- [ ] **Step 2: Run them, verify they fail**

Run: `scripts/test.sh test/grappa/networks/servers_test.exs test/grappa/bootstrap_test.exs`
Expected: FAIL — `list_source_addresses/0` undefined; no exclusion/log in `run/0`.

- [ ] **Step 3: Implement the context query**

In `lib/grappa/networks/servers.ex` (it already imports `Ecto.Query` and aliases `Server` + `Repo` — verify; add `import Ecto.Query, only: [from: 2]` and `alias Grappa.Repo` if missing):

```elixir
  @doc """
  Every configured non-NULL outbound `source_address`, as canonical IP
  strings. Consumed by `Grappa.Bootstrap` to subtract fixed sources
  from the effective `OutboundV6Pool` before spawning sessions (spec §3).
  """
  @spec list_source_addresses() :: [String.t()]
  def list_source_addresses do
    Repo.all(from s in Server, where: not is_nil(s.source_address), select: s.source_address)
  end
```

- [ ] **Step 4: Wire Bootstrap (before spawn) + boundary dep**

In `lib/grappa/bootstrap.ex`:

Add `Grappa.OutboundV6Pool` to the boundary `deps` list:
```elixir
  use Boundary,
    top_level?: true,
    deps: [Grappa.Networks, Grappa.OutboundV6Pool, Grappa.Session, Grappa.SpawnOrchestrator, Grappa.Visitors]
```

Add the alias near the others:
```elixir
  alias Grappa.Networks.Servers
```

In `run/0`, after `validate_credential_servers!(credentials, visitors)` and before `user_stats = ...`:
```elixir
    # Subtract every configured fixed source from the effective visitor
    # pool BEFORE spawning, so no visitor session can pick/0 a dedicated
    # oper IP (spec §3). Subtract-never-assert: overlap is silently
    # excluded, never a boot failure. Two-phase: Application.start
    # installed the raw env pool; this refines it to the effective pool
    # while no session has spawned yet.
    exclude_fixed_sources_from_pool()
```

Add the private helper (place after `run/0`):
```elixir
  @spec exclude_fixed_sources_from_pool() :: :ok
  defp exclude_fixed_sources_from_pool do
    sources = Servers.list_source_addresses()
    raw_count = length(Grappa.OutboundV6Pool.raw_pool())
    :ok = Grappa.OutboundV6Pool.apply_exclusions(sources)
    effective_count = length(Grappa.OutboundV6Pool.raw_pool()) - excluded_from_pool_count(sources, raw_count)

    # Honest log per CLAUDE.md: state what was OBSERVED. Counts live in
    # the message string (no new Logger metadata-allowlist keys). The
    # `M excluded` figure is the number of fixed sources that were
    # actually in the raw pool — the line that makes the subtraction
    # observable when it bit.
    Logger.info(
      "outbound pool: #{raw_count} configured, " <>
        "#{excluded_from_pool_count(sources, raw_count)} excluded as fixed sources " <>
        "#{inspect(sources)}, #{effective_pool_count()} effective"
    )

    :ok
  end
```

> **Simplify before implementing:** the helper above double-computes. Collapse to a single read of the effective pool after exclusion. Final shape:
```elixir
  @spec exclude_fixed_sources_from_pool() :: :ok
  defp exclude_fixed_sources_from_pool do
    sources = Servers.list_source_addresses()
    raw = Grappa.OutboundV6Pool.raw_pool()
    :ok = Grappa.OutboundV6Pool.apply_exclusions(sources)
    effective = :persistent_term.get({Grappa.OutboundV6Pool, :pool}, [])
    excluded = length(raw) - length(effective)

    Logger.info(
      "outbound pool: #{length(raw)} configured, #{excluded} excluded as fixed " <>
        "sources #{inspect(sources)}, #{length(effective)} effective"
    )

    :ok
  end
```

> **Boundary note:** reading `:persistent_term` for the effective count is acceptable inside Bootstrap (it's runtime state, not `Application.get_env`). If Boundary/Credo objects to reaching into the pool's persistent_term key, add a thin `OutboundV6Pool.effective_pool/0` accessor (mirrors `raw_pool/0`) and use it instead — preferred if you touch it anyway. **Use the accessor.** Add to `outbound_v6_pool.ex`:
```elixir
  @doc "The effective pool pick/0 currently draws from (raw minus exclusions)."
  @spec effective_pool() :: [:inet.ip6_address()]
  def effective_pool, do: :persistent_term.get(@key, [])
```
and in Bootstrap use `Grappa.OutboundV6Pool.effective_pool()` instead of the raw `:persistent_term.get/2`.

- [ ] **Step 5: Run the tests, verify pass**

Run: `scripts/test.sh test/grappa/networks/servers_test.exs test/grappa/bootstrap_test.exs`
Expected: PASS. Confirm the log line reads e.g. `outbound pool: 1 configured, 1 excluded as fixed sources ["2a03:4000:2:33c::9000"], 0 effective`.

- [ ] **Step 6: Commit**

```bash
git add lib/grappa/networks/servers.ex lib/grappa/outbound_v6_pool.ex lib/grappa/bootstrap.ex \
        test/grappa/networks/servers_test.exs test/grappa/bootstrap_test.exs
git commit -m "$(cat <<'EOF'
feat(bootstrap): exclude fixed sources from visitor pool before spawn

Servers.list_source_addresses/0 + Bootstrap.run/0 refine the effective
OutboundV6Pool = raw - fixed sources before any session spawns, so a
rotating visitor on a pool-source network can never draw a dedicated
oper IP. Subtract-never-assert; honest log states configured/excluded/
effective counts. OutboundV6Pool gains an effective_pool/0 accessor.
EOF
)"
```

---

## Task 6: `--source` on `grappa.bind_network` + `grappa.add_server`

**Files:**
- Modify: `lib/mix/tasks/grappa.bind_network.ex`
- Modify: `lib/mix/tasks/grappa.add_server.ex`
- Test: `test/mix/tasks/grappa_add_server_test.exs`, `test/mix/tasks/grappa_bind_network_test.exs` (extend whichever exist; check `test/mix/tasks/`)

**Contract:** `--source <ip>` sets `source_address` on the server attrs. Validation is the Server changeset's (reuse, don't re-implement) — an invalid literal halts via the existing `Output.halt_changeset`. An informational notice (not an error) prints if `<ip>` is also in `GRAPPA_OUTBOUND_V6_POOL`.

- [ ] **Step 1: Write/extend the failing task tests**

In `test/mix/tasks/grappa_add_server_test.exs`:
```elixir
    test "--source persists the server source_address" do
      network_fixture(slug: "azzurra")

      Mix.Tasks.Grappa.AddServer.run([
        "--network", "azzurra",
        "--server", "irc.azzurra.org:6697",
        "--source", "203.0.113.9"
      ])

      [server] = Servers.list_servers(Networks.get_network_by_slug!("azzurra"))
      assert server.source_address == "203.0.113.9"
    end

    test "--source with an invalid literal halts loudly" do
      network_fixture(slug: "azzurra")

      assert catch_exit(
               Mix.Tasks.Grappa.AddServer.run([
                 "--network", "azzurra",
                 "--server", "irc.azzurra.org:6697",
                 "--source", "not-an-ip"
               ])
             )
    end
```

> Match the existing task-test conventions in that file (some use `Mix.shell(Mix.Shell.Process)` + `assert_received {:mix_shell, :info, _}`; `halt_changeset` exits, so `catch_exit/1` is the assertion for the invalid case — confirm against a sibling task test before finalizing).

- [ ] **Step 2: Run it, verify it fails**

Run: `scripts/test.sh test/mix/tasks/grappa_add_server_test.exs`
Expected: FAIL — `--source` is an unknown switch (strict parser drops it; `source_address` never set).

- [ ] **Step 3: Implement `--source` on both tasks**

`grappa.add_server.ex`:
- Add `source: :string` to `@switches`.
- Add to the `attrs` map: `source_address: Keyword.get(opts, :source)`.
- Add `Grappa.OutboundV6Pool` to the task's Boundary `deps`.
- After a successful add (the `{:ok, _}` branch), emit the in-pool notice:
```elixir
      {:ok, _} ->
        IO.puts("added server #{host}:#{port} to #{slug}")
        maybe_notice_source_in_pool(Keyword.get(opts, :source))
```
- Add the helper:
```elixir
  # Informational only (spec §5): a source that overlaps the visitor
  # pool is excluded from it at boot — not an error, just a heads-up.
  defp maybe_notice_source_in_pool(nil), do: :ok

  defp maybe_notice_source_in_pool(source) do
    case :inet.parse_address(String.to_charlist(source)) do
      {:ok, tuple} ->
        if tuple in Grappa.OutboundV6Pool.raw_pool() do
          IO.puts("note: #{source} is in GRAPPA_OUTBOUND_V6_POOL; it will be excluded from the visitor pool")
        end

        :ok

      {:error, _} ->
        # Invalid literal already surfaced via the changeset halt; nothing to add.
        :ok
    end
  end
```

`grappa.bind_network.ex`:
- Add `source: :string` to `@switches`.
- Add `source_address: Keyword.get(opts, :source)` to the `Servers.add_server(network, %{...})` attrs map.
- Add `Grappa.OutboundV6Pool` to the task Boundary `deps` and the same `maybe_notice_source_in_pool/1` helper, called after the server-bind `{:ok, _}`/`:already_exists` path (print the notice once, regardless of the no-op).

Update each task's `@shortdoc`/`@moduledoc` usage block to mention `[--source <ip>]`.

- [ ] **Step 4: Run the task tests, verify pass**

Run: `scripts/test.sh test/mix/tasks/grappa_add_server_test.exs test/mix/tasks/grappa_bind_network_test.exs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/mix/tasks/grappa.add_server.ex lib/mix/tasks/grappa.bind_network.ex test/mix/tasks/
git commit -m "$(cat <<'EOF'
feat(mix): --source on bind_network + add_server

Operator sets a server's fixed outbound source IP at bind time. Reuses
the Server changeset's strict-literal validation (invalid → loud halt).
Prints an informational notice when --source is also in
GRAPPA_OUTBOUND_V6_POOL (it gets excluded from the visitor pool at boot).
EOF
)"
```

---

## Task 7: Docs

**Files:**
- Modify: `docs/DESIGN_NOTES.md` (chronological entry)
- Modify: `README.md` (server-config section, if it enumerates server fields)

- [ ] **Step 1: DESIGN_NOTES entry**

Append a dated entry: the per-server `source_address` decision, the subtract-never-assert pool exclusion, the family-mismatch hard error (no silent fallback), the `:inet.getaddr/2`-vs-`:inet_res.lookup/3` split and why, and the accepted limitation (per-server bind has no subject-level gate — keeping visitors off dedicated networks is operator config responsibility, spec §4). Reference the spec path.

- [ ] **Step 2: README server-config**

If `README.md` lists `network_servers` fields or documents `grappa.add_server` / `grappa.bind_network` flags, add `--source <ip>` + the one-line semantics (literal v4/v6, binds outbound source, excluded from the visitor pool). If it doesn't enumerate server fields, skip — don't invent a section.

- [ ] **Step 3: Commit**

```bash
git add docs/DESIGN_NOTES.md README.md
git commit -m "docs: record per-server source_address design + operator flags"
```

---

## Definition of done

- [ ] `scripts/check.sh` fully green from the worktree (compile/format/credo/deps.audit/hex.audit/sobelow/doctor/`test --warnings-as-errors`/dialyzer/docs + wire-types + bats). Read the log tail, don't trust a piped exit.
- [ ] Spec §6 testing matrix covered: source-bind unit (v4/v6/mismatch), changeset (accept v4+v6 / reject hostname+CIDR+empty+garbage), pool subtraction (effective = raw−fixed / v4-vs-v6 no-op / format-variant removed / pick never excluded / bootstrap log), threading (fixed-source plan carries the literal, NULL still pools).
- [ ] Code review (never optional) → fix → commit.
- [ ] Docs landed in the same flow.
- [ ] **Do NOT deploy in this session** — vjt is evaluating hot-vs-cold. The migration makes this a COLD deploy (schema change + BEAM restart + `ecto.migrate`); surface that and stop at "ready to merge."

## Self-review notes (run against the spec before executing)

- Spec §1 data model → Task 1. §2 connect path (v4 path + family-mismatch hard error + NULL verbatim) → Task 3. §3 pool subtraction (raw/effective, normalize, subtract-never-assert) → Tasks 2+5. §4 caveat → Task 7 docs. §5 config surface (both mix tasks + reuse validation + optional notice) → Task 6. §6 testing → spread across all tasks. All non-goals respected (no WEBIRC, no IPv4 pool, no constraint, no admission guard).
- Type consistency: `source_address` is `String.t() | nil` everywhere; `source_bind/2` returns `{:ok, {keyword(), :inet | :inet6}} | {:error, {:source_family_mismatch, String.t(), String.t(), :inet | :inet6}}` consistently in Task 3 spec + impl + test.
- Open question from the spec (confirm connect-entry signature) is resolved in Task 4: `handle_continue({:connect, opts})` → `do_connect/4` via `Map.get(opts, :source_address)`.
