# T31 Admission Control — Infrastructure Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the data-shape + state primitives that T31 admission control consumes. Schema columns, `Grappa.Admission` context with `check_capacity/1` + `verify_captcha/2` verbs, `NetworkCircuit` ETS GenServer (per-network failure breaker), `Captcha` behaviour with `Disabled` impl. NO consumer wiring — Login/Bootstrap/cicchetto changes ship in Plan 2.

**Architecture:** New top-level `Grappa.Admission` boundary. Two new schema columns (`accounts_sessions.client_id`, `networks.max_concurrent_sessions`+`max_per_client`). One new ETS GenServer mirroring the `Grappa.Session.Backoff` (S20) pattern but keyed on `network_id` only. One Captcha provider behaviour with a single `Disabled` impl (Turnstile + hCaptcha land in Plan 2). All caps query existing data — `Registry.count_match/3` for the network-total cap, SQL union over `accounts_sessions` for the per-client cap.

**Tech Stack:** Elixir 1.19 / OTP 28, Ecto 3 + ecto_sqlite3, ETS named tables, Boundary library, ExUnit + StreamData. All work runs inside the `grappa` container via `scripts/*.sh`.

## Reference docs

- Brainstorm conversation S21 (this session) — establishes the design.
- `lib/grappa/session/backoff.ex` — sibling ETS-GenServer pattern from S20 (Plan 1's NetworkCircuit mirrors this shape).
- `test/grappa/session/backoff_test.exs` — sibling test scaffold.
- CLAUDE.md "OTP patterns", "Phoenix / Ecto patterns", "Testing Standards", "Engineering Standards".
- Memory pin `feedback_dialyzer_plt_staleness` — defaults must live in BOTH `config/config.exs` AND `config/test.exs`.

## Worktree first

This plan runs on a new worktree off main, NOT in `/srv/grappa` directly:

```bash
git checkout main
git pull
git worktree add ../grappa-task-t31-infra cluster/t31-infra
cd ../grappa-task-t31-infra
```

All `scripts/*.sh` invocations from the worktree are worktree-aware (mount worktree source over main's container). Final merge: rebase onto main, ff-merge, deploy.

## File structure

**Create:**

| path | responsibility |
|---|---|
| `priv/repo/migrations/20260503090000_add_client_id_to_sessions.exs` | M1: nullable `client_id` column + index on `accounts_sessions` |
| `priv/repo/migrations/20260503090001_add_admission_caps_to_networks.exs` | M2: `max_concurrent_sessions` + `max_per_client` columns on `networks` |
| `lib/grappa/admission.ex` | public verb surface: `check_capacity/1`, `verify_captcha/2` |
| `lib/grappa/admission/network_circuit.ex` | ETS-backed per-`network_id` failure circuit-breaker |
| `lib/grappa/admission/captcha.ex` | `@callback verify(token, ip)` behaviour |
| `lib/grappa/admission/captcha/disabled.ex` | Captcha impl: always `:ok` (test/dev/operator-private default) |
| `test/grappa/admission_test.exs` | verb-level matrix tests |
| `test/grappa/admission/network_circuit_test.exs` | sibling of `BackoffTest` |
| `test/grappa/admission/captcha/disabled_test.exs` | trivial impl test |

**Modify:**

| path | what changes |
|---|---|
| `lib/grappa/accounts/session.ex` | add `:client_id` field + add to `@cast_fields` |
| `lib/grappa/networks/network.ex` | add `:max_concurrent_sessions`, `:max_per_client` fields + cast + validations |
| `lib/grappa/application.ex` | supervise `Grappa.Admission.NetworkCircuit`; add `Grappa.Admission` to boundary deps |
| `config/config.exs` | `:grappa, :admission` defaults + Logger metadata allowlist additions |
| `config/test.exs` | shrunk admission overrides |
| `test/grappa/accounts/sessions_test.exs` | new case: `client_id` round-trips through changeset |
| `test/grappa/networks/network_test.exs` (new file) | cap field changeset tests |

**Out of scope for Plan 1 (these land in Plan 2):**

- `Grappa.Visitors.Login` consumes `Admission.check_capacity/1` + `verify_captcha/2`.
- `Grappa.Bootstrap` consumes network-total cap on cold-start.
- `Plugs.Authn` plumbs `X-Grappa-Client-Id` header into `:current_client_id` conn assign.
- `GrappaWeb.AuthController` + `FallbackController` map new error atoms to HTTP responses.
- `cicchetto` generates + sends `client_id`; renders new error responses.
- `Grappa.Admission.Captcha.Turnstile` + `Grappa.Admission.Captcha.HCaptcha` real provider impls.
- `Grappa.Session.Backoff.reset/2` new verb (called by Login on case-2 preempt).

---

## Task 1 — Migration M1: `accounts_sessions.client_id`

**Files:**
- Create: `priv/repo/migrations/20260503090000_add_client_id_to_sessions.exs`

- [ ] **Step 1: Write the migration**

```elixir
defmodule Grappa.Repo.Migrations.AddClientIdToSessions do
  use Ecto.Migration

  def change do
    alter table(:sessions) do
      add :client_id, :string, null: true
    end

    create index(:sessions, [:client_id])
  end
end
```

Note: the table is `sessions` not `accounts_sessions` — `Grappa.Accounts.Session` schema declares `schema "sessions" do`. Confirmed in `lib/grappa/accounts/session.ex:57`.

- [ ] **Step 2: Run the migration**

```bash
scripts/mix.sh ecto.migrate
```

Expected: `[info] == Running 20260503090000 Grappa.Repo.Migrations.AddClientIdToSessions.change/0 forward` followed by `[info] == Migrated`.

- [ ] **Step 3: Verify column exists**

```bash
scripts/db.sh ".schema sessions"
```

Expected output includes `client_id TEXT`. Index visible via `.indexes sessions` showing `sessions_client_id_index`.

- [ ] **Step 4: Commit**

```bash
git add priv/repo/migrations/20260503090000_add_client_id_to_sessions.exs
git commit -m "$(cat <<'EOF'
feat(t31): migration M1 — accounts_sessions.client_id column

T31 admission control needs per-(client_id, network_id) session count
to enforce the per-device cap. The cicchetto-side `client_id` (UUID v4
in localStorage, sent via X-Grappa-Client-Id) lands on the bearer
session row at create time. Nullable: mix-task-created sessions and
legacy rows have no associated client.

Index added so the per-client cap query (Plan 1 Task 10) doesn't full-
scan accounts_sessions on every Login attempt.

Plan 1 of 2 — see docs/plans/2026-05-03-t31-admission-infra.md.
EOF
)"
```

## Task 2 — Migration M2: `networks.max_concurrent_sessions` + `max_per_client`

**Files:**
- Create: `priv/repo/migrations/20260503090001_add_admission_caps_to_networks.exs`

- [ ] **Step 1: Write the migration**

```elixir
defmodule Grappa.Repo.Migrations.AddAdmissionCapsToNetworks do
  use Ecto.Migration

  def change do
    alter table(:networks) do
      add :max_concurrent_sessions, :integer, null: true
      add :max_per_client, :integer, null: true
    end
  end
end
```

Both nullable. `nil` on `max_concurrent_sessions` means "uncapped". `nil` on `max_per_client` means "use global default" (`config :grappa, :admission, default_max_per_client_per_network: N`).

- [ ] **Step 2: Run the migration**

```bash
scripts/mix.sh ecto.migrate
```

Expected: `[info] == Migrated 20260503090001` line.

- [ ] **Step 3: Verify columns exist**

```bash
scripts/db.sh ".schema networks"
```

Expected output includes `max_concurrent_sessions INTEGER` and `max_per_client INTEGER`.

- [ ] **Step 4: Commit**

```bash
git add priv/repo/migrations/20260503090001_add_admission_caps_to_networks.exs
git commit -m "$(cat <<'EOF'
feat(t31): migration M2 — networks per-network admission caps

Two nullable integer columns:

  * max_concurrent_sessions — global cap on total live IRC sessions
    to this network across all subjects. nil = uncapped. Per-network
    config because azzurra's "max 3 concurrent per source IP" limit
    differs from a permissive testnet's.

  * max_per_client — per-client-device cap on this network. nil =
    inherit global :default_max_per_client_per_network (default 1).
    Operator can raise per-network to allow multi-nick power users.

No data migration; both default to nil = inheriting. Existing networks
keep current uncapped behavior until operator sets values.

Plan 1 of 2 — see docs/plans/2026-05-03-t31-admission-infra.md.
EOF
)"
```

## Task 3 — `Accounts.Session` schema: `client_id` field

**Files:**
- Modify: `lib/grappa/accounts/session.ex`
- Modify: `test/grappa/accounts/sessions_test.exs`

- [ ] **Step 1: Write the failing test**

Append to `test/grappa/accounts/sessions_test.exs` inside the existing `describe "changeset/2"` block (find it via `grep -n "changeset/2" test/grappa/accounts/sessions_test.exs`):

```elixir
test "accepts and round-trips client_id" do
  user = Grappa.AuthFixtures.user_fixture()
  now = DateTime.utc_now()

  attrs = %{
    user_id: user.id,
    created_at: now,
    last_seen_at: now,
    client_id: "550e8400-e29b-41d4-a716-446655440000"
  }

  changeset = Grappa.Accounts.Session.changeset(%Grappa.Accounts.Session{}, attrs)
  assert changeset.valid?
  assert {:ok, session} = Grappa.Repo.insert(changeset)
  assert session.client_id == "550e8400-e29b-41d4-a716-446655440000"
end

test "client_id is optional (nil for mix-task / legacy rows)" do
  user = Grappa.AuthFixtures.user_fixture()
  now = DateTime.utc_now()

  attrs = %{user_id: user.id, created_at: now, last_seen_at: now}
  changeset = Grappa.Accounts.Session.changeset(%Grappa.Accounts.Session{}, attrs)

  assert changeset.valid?
  assert {:ok, session} = Grappa.Repo.insert(changeset)
  assert session.client_id == nil
end
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
scripts/mix.sh test test/grappa/accounts/sessions_test.exs --warnings-as-errors
```

Expected: failure on `cast/3` not knowing `:client_id`, OR a change-but-no-cast warning. Either way the new test must fail.

- [ ] **Step 3: Add field + cast in `Accounts.Session`**

In `lib/grappa/accounts/session.ex`:

Update the `@type t` (lines 43-54 currently) to add:

```elixir
client_id: String.t() | nil,
```

after the `ip:` line.

In the `schema "sessions" do` block (lines 57-66), add as a new line after `field :ip, :string`:

```elixir
field :client_id, :string
```

In `@cast_fields` (line 68), append `:client_id`:

```elixir
@cast_fields [:user_id, :visitor_id, :created_at, :last_seen_at, :ip, :user_agent, :client_id]
```

- [ ] **Step 4: Run test, expect PASS**

```bash
scripts/mix.sh test test/grappa/accounts/sessions_test.exs --warnings-as-errors
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/accounts/session.ex test/grappa/accounts/sessions_test.exs
git commit -m "$(cat <<'EOF'
feat(t31): Accounts.Session.client_id schema field

Field is nullable + cast-only; no validation here because the value is
opaque to the server — cicchetto generates a UUID v4 and the bouncer
just remembers what it saw. Validation at the boundary plug (Plan 2)
will reject malformed values before they reach the changeset.

Plan 1 of 2.
EOF
)"
```

## Task 4 — `Networks.Network` schema: cap fields

**Files:**
- Modify: `lib/grappa/networks/network.ex`
- Create: `test/grappa/networks/network_test.exs`

- [ ] **Step 1: Write the failing test**

Create `test/grappa/networks/network_test.exs`:

```elixir
defmodule Grappa.Networks.NetworkTest do
  use Grappa.DataCase, async: true

  alias Grappa.Networks.Network

  describe "changeset/2" do
    test "accepts max_concurrent_sessions and max_per_client" do
      attrs = %{slug: "testnet", max_concurrent_sessions: 10, max_per_client: 2}
      changeset = Network.changeset(%Network{}, attrs)

      assert changeset.valid?
      assert Ecto.Changeset.get_change(changeset, :max_concurrent_sessions) == 10
      assert Ecto.Changeset.get_change(changeset, :max_per_client) == 2
    end

    test "both cap fields are optional (nil = uncapped / inherit default)" do
      changeset = Network.changeset(%Network{}, %{slug: "testnet"})
      assert changeset.valid?
    end

    test "rejects negative max_concurrent_sessions" do
      changeset = Network.changeset(%Network{}, %{slug: "testnet", max_concurrent_sessions: -1})
      refute changeset.valid?
      assert "must be greater than 0" in errors_on(changeset).max_concurrent_sessions
    end

    test "rejects negative max_per_client" do
      changeset = Network.changeset(%Network{}, %{slug: "testnet", max_per_client: 0})
      refute changeset.valid?
      assert "must be greater than 0" in errors_on(changeset).max_per_client
    end
  end
end
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
scripts/mix.sh test test/grappa/networks/network_test.exs --warnings-as-errors
```

Expected: failure — fields not cast, validations missing.

- [ ] **Step 3: Add fields + validations**

In `lib/grappa/networks/network.ex`:

Update `@type t` (lines 22-29) to include:

```elixir
max_concurrent_sessions: non_neg_integer() | nil,
max_per_client: non_neg_integer() | nil,
```

after the `slug:` line.

In `schema "networks" do` (lines 31-38), add after `field :slug, :string`:

```elixir
field :max_concurrent_sessions, :integer
field :max_per_client, :integer
```

In `changeset/2` (lines 53-59), update to:

```elixir
@spec changeset(t(), map()) :: Ecto.Changeset.t()
def changeset(network, attrs) do
  network
  |> cast(attrs, [:slug, :max_concurrent_sessions, :max_per_client])
  |> validate_required([:slug])
  |> validate_change(:slug, &validate_slug/2)
  |> validate_number(:max_concurrent_sessions, greater_than: 0)
  |> validate_number(:max_per_client, greater_than: 0)
  |> unique_constraint(:slug)
end
```

`validate_number` is a no-op when the field is nil, so optionality is preserved.

- [ ] **Step 4: Run test, expect PASS**

```bash
scripts/mix.sh test test/grappa/networks/network_test.exs --warnings-as-errors
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/networks/network.ex test/grappa/networks/network_test.exs
git commit -m "$(cat <<'EOF'
feat(t31): Networks.Network admission cap fields + changeset validation

Two cap fields:

  * max_concurrent_sessions: per-network total live sessions cap
    across all subjects. nil = uncapped.
  * max_per_client: per-network override of the global per-client cap.
    nil = inherit :default_max_per_client_per_network.

validate_number with greater_than: 0 keeps the contract honest — a
zero cap would blackhole the network (no one can connect), almost
certainly a typo. Operator who actually wants "blocked" should drop
the network row entirely.

Plan 1 of 2.
EOF
)"
```

## Task 5 — Captcha behaviour module

**Files:**
- Create: `lib/grappa/admission/captcha.ex`

- [ ] **Step 1: Write the behaviour**

```elixir
defmodule Grappa.Admission.Captcha do
  @moduledoc """
  Behaviour contract for CAPTCHA verification at fresh-anon visitor
  login. Plan 1 ships only the `Disabled` impl (always `:ok`); Plan 2
  adds `Turnstile` (Cloudflare) and `HCaptcha` impls.

  ## Why a behaviour

  Provider lock-in is bad — the operator picks at runtime via
  `config :grappa, :admission, captcha_provider: <module>`, the verb
  delegates. Tests stub a `CaptchaMock` via Mox.

  ## Contract

  `verify/2` takes the client-supplied token + the request IP and
  returns `:ok` on a valid solve OR a tagged error:

    * `:captcha_required` — token is `nil` / empty (client didn't
      send one).
    * `:captcha_failed` — provider rejected the token (expired /
      already used / not a real solve).
    * `:captcha_provider_unavailable` — provider's HTTP endpoint
      returned 5xx, was unreachable, or our request timed out. Distinct
      from `:captcha_failed` because operator-side issue, not user-side.

  Implementations MUST NOT raise. Network errors land as
  `{:error, :captcha_provider_unavailable}`.
  """

  @type token :: String.t() | nil
  @type ip :: String.t() | nil
  @type error :: :captcha_required | :captcha_failed | :captcha_provider_unavailable

  @callback verify(token(), ip()) :: :ok | {:error, error()}
end
```

- [ ] **Step 2: Verify it compiles**

```bash
scripts/mix.sh compile --warnings-as-errors
```

Expected: clean compile (no impls reference it yet).

- [ ] **Step 3: Commit**

```bash
git add lib/grappa/admission/captcha.ex
git commit -m "$(cat <<'EOF'
feat(t31): Grappa.Admission.Captcha behaviour

Provider-abstracted contract for CAPTCHA verify at fresh-anon visitor
login. Plan 1 ships the Disabled impl only (next task); Turnstile and
hCaptcha land in Plan 2 wired through the same callback.

Three error tags split user-side from operator-side failure:
captcha_required (no token), captcha_failed (rejected), and
captcha_provider_unavailable (HTTP 5xx / timeout). Web layer
(Plan 2 FallbackController) maps captcha_provider_unavailable to 503
service_degraded so an outage at the captcha vendor doesn't look like
user error.

Plan 1 of 2.
EOF
)"
```

## Task 6 — Captcha `Disabled` impl + test

**Files:**
- Create: `lib/grappa/admission/captcha/disabled.ex`
- Create: `test/grappa/admission/captcha/disabled_test.exs`

- [ ] **Step 1: Write the failing test**

```elixir
defmodule Grappa.Admission.Captcha.DisabledTest do
  @moduledoc """
  The Disabled impl is the test/dev/operator-private default. Its
  contract is "always :ok regardless of inputs" — verify that.
  """
  use ExUnit.Case, async: true

  alias Grappa.Admission.Captcha.Disabled

  test "returns :ok for a real-looking token" do
    assert Disabled.verify("0x.real-looking-token", "1.2.3.4") == :ok
  end

  test "returns :ok for nil token + nil ip" do
    assert Disabled.verify(nil, nil) == :ok
  end

  test "returns :ok for empty string token" do
    assert Disabled.verify("", "1.2.3.4") == :ok
  end
end
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
scripts/mix.sh test test/grappa/admission/captcha/disabled_test.exs --warnings-as-errors
```

Expected: `(UndefinedFunctionError) function Grappa.Admission.Captcha.Disabled.verify/2 is undefined`.

- [ ] **Step 3: Write the impl**

`lib/grappa/admission/captcha/disabled.ex`:

```elixir
defmodule Grappa.Admission.Captcha.Disabled do
  @moduledoc """
  Captcha behaviour impl that always returns `:ok`. Default for
  `config/test.exs` and for operator-private deployments where there's
  no need for human-vs-bot distinguishing — friends-and-family
  bouncer, dev environment, etc.

  Operator opts into a real provider (Plan 2 `Turnstile` / `HCaptcha`)
  via `config :grappa, :admission, captcha_provider: <module>`.
  """
  @behaviour Grappa.Admission.Captcha

  @impl Grappa.Admission.Captcha
  @spec verify(Grappa.Admission.Captcha.token(), Grappa.Admission.Captcha.ip()) :: :ok
  def verify(_token, _ip), do: :ok
end
```

- [ ] **Step 4: Run test, expect PASS**

```bash
scripts/mix.sh test test/grappa/admission/captcha/disabled_test.exs --warnings-as-errors
```

Expected: 3 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/admission/captcha/disabled.ex test/grappa/admission/captcha/disabled_test.exs
git commit -m "$(cat <<'EOF'
feat(t31): Captcha.Disabled impl — always-:ok default

The test/dev/operator-private default. config/test.exs wires this in
Task 12 so test runs don't hit a real captcha provider; operators
running a private bouncer with no abuse threat surface keep this in
prod too.

Plan 2 lands Turnstile + hCaptcha as additional impls swappable via
the :captcha_provider config knob.

Plan 1 of 2.
EOF
)"
```

## Task 7 — `NetworkCircuit` GenServer skeleton + math

**Files:**
- Create: `lib/grappa/admission/network_circuit.ex`
- Create: `test/grappa/admission/network_circuit_test.exs`

This task lands the pure math (`compute_cooldown/2`, jitter window) + ETS table machinery + the GenServer skeleton. Behavior verbs (`record_failure`, `record_success`, `check`) ship in Task 8 — split for review surface.

- [ ] **Step 1: Write failing tests for the math**

`test/grappa/admission/network_circuit_test.exs`:

```elixir
defmodule Grappa.Admission.NetworkCircuitTest do
  @moduledoc """
  Per-network failure circuit-breaker. Threshold + window govern
  open transition; cooldown + jitter govern close transition.

  `async: false` because the GenServer + ETS table is a module
  singleton (named-table) shared across the suite.
  """
  use ExUnit.Case, async: false

  alias Grappa.Admission.NetworkCircuit

  setup do
    for {key, _, _, _, _} <- NetworkCircuit.entries(),
        do: :ets.delete(:admission_network_circuit_state, key)

    :ok
  end

  describe "compute_cooldown/2" do
    test "returns cooldown_ms ± 25% jitter window" do
      base = NetworkCircuit.cooldown_ms()
      jitter = trunc(base * 0.25)

      for _ <- 1..50 do
        ms = NetworkCircuit.compute_cooldown(base, 25)
        assert ms >= base - jitter
        assert ms <= base + jitter
      end
    end

    test "0 jitter pct returns exact base" do
      assert NetworkCircuit.compute_cooldown(1_000, 0) == 1_000
    end
  end

  describe "module-level config readers" do
    test "threshold/0 is positive" do
      assert NetworkCircuit.threshold() > 0
    end

    test "window_ms/0 is positive" do
      assert NetworkCircuit.window_ms() > 0
    end

    test "cooldown_ms/0 is positive" do
      assert NetworkCircuit.cooldown_ms() > 0
    end
  end
end
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
scripts/mix.sh test test/grappa/admission/network_circuit_test.exs --warnings-as-errors
```

Expected: module-undefined errors.

- [ ] **Step 3: Write the skeleton + math**

`lib/grappa/admission/network_circuit.ex`:

```elixir
defmodule Grappa.Admission.NetworkCircuit do
  @moduledoc """
  Per-`network_id` failure circuit-breaker for Login fresh-provision
  fail-fast. ETS-backed so state survives `Grappa.Visitors.Login`
  process churn.

  ## Why

  `Grappa.Session.Backoff` (S20) paces SESSION-LEVEL respawn delays
  per `(subject, network_id)` — but a fresh anon login (case-1) hasn't
  CREATED a subject yet, so per-`(subject, network)` keying can't gate
  the first probe. NetworkCircuit fills that gap: per-`network_id`
  failure window across all subjects. After threshold N failures in a
  rolling window, circuit opens; subsequent Login attempts fail fast
  with a `Retry-After` hint instead of synchronously probing a known-
  bad upstream.

  ## State per network_id

  Stored as ETS row: `{network_id, count, window_start_ms, state, cooled_at_ms}`.

    * `count` — failures in the current window.
    * `window_start_ms` — monotonic time of the window's first failure.
      Window resets when `now - window_start > window_ms`.
    * `state` — `:closed` | `:open`.
    * `cooled_at_ms` — monotonic time at which an open circuit returns
      to closed (= `opened_at + jittered(cooldown_ms)`). Unused when
      state is `:closed`.

  ## API contract

    * `record_failure/1` — bump count; transition to `:open` on
      threshold. Cast (async).
    * `record_success/1` — clear state to `:closed, count=0`. Cast.
    * `check/1` — fast read; direct ETS lookup. Returns `:ok` or
      `{:error, :open, retry_after_seconds}`.
    * `entries/0` — debug helper, full table snapshot.

  Writes funnel through the GenServer for read-modify-write
  consistency under concurrent failures (two visitors crashing
  simultaneously). Reads are direct ETS lookups (`:read_concurrency`)
  so the Login hot path takes no GenServer roundtrip.

  ## Tuning

  Defaults from `config :grappa, :admission`:

    * `network_circuit_threshold` (5) — failures-in-window to open.
    * `network_circuit_window_ms` (60_000) — rolling window size.
    * `network_circuit_cooldown_ms` (300_000) — open-state duration
      before re-allowing probes. ±25% jitter applied per-event.

  No half-open state — after cooldown elapses, circuit is `:closed`
  and probes flow freely; if they fail again, circuit re-opens. Client
  cap (default 1) + CAPTCHA + network-total cap together serialize
  concurrent attempts → no thundering herd risk worth the gating
  complexity of half-open.
  """
  use GenServer

  @table :admission_network_circuit_state
  @jitter_pct 25

  @threshold Application.compile_env(:grappa, [:admission, :network_circuit_threshold], 5)
  @window_ms Application.compile_env(:grappa, [:admission, :network_circuit_window_ms], 60_000)
  @cooldown_ms Application.compile_env(:grappa, [:admission, :network_circuit_cooldown_ms], 300_000)

  @typep entry :: {integer(), non_neg_integer(), integer(), :closed | :open, integer()}

  @doc false
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(_) do
    GenServer.start_link(__MODULE__, [], name: __MODULE__)
  end

  ## Internals

  @doc false
  @spec compute_cooldown(non_neg_integer(), non_neg_integer()) :: non_neg_integer()
  def compute_cooldown(base_ms, jitter_pct \\ @jitter_pct) when jitter_pct >= 0 do
    jitter = trunc(base_ms * jitter_pct / 100)

    if jitter == 0 do
      base_ms
    else
      base_ms - jitter + :rand.uniform(2 * jitter + 1) - 1
    end
  end

  @doc false
  @spec threshold() :: pos_integer()
  def threshold, do: @threshold

  @doc false
  @spec window_ms() :: pos_integer()
  def window_ms, do: @window_ms

  @doc false
  @spec cooldown_ms() :: pos_integer()
  def cooldown_ms, do: @cooldown_ms

  @doc false
  @spec entries() :: [entry()]
  def entries, do: :ets.tab2list(@table)

  ## GenServer

  @impl GenServer
  def init(_) do
    _ = :ets.new(@table, [:named_table, :set, :public, read_concurrency: true])
    {:ok, %{}}
  end
end
```

- [ ] **Step 4: Run test, expect PASS**

```bash
scripts/mix.sh test test/grappa/admission/network_circuit_test.exs --warnings-as-errors
```

The GenServer is not yet supervised — the test's `setup` block calls `entries/0` which expects the ETS table to exist. Add a manual start in test setup. Replace the existing `setup` block with:

```elixir
setup do
  start_supervised!(NetworkCircuit)

  on_exit(fn ->
    case :ets.whereis(:admission_network_circuit_state) do
      :undefined -> :ok
      _ -> :ets.delete_all_objects(:admission_network_circuit_state)
    end
  end)

  :ok
end
```

Re-run:

```bash
scripts/mix.sh test test/grappa/admission/network_circuit_test.exs --warnings-as-errors
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/admission/network_circuit.ex test/grappa/admission/network_circuit_test.exs
git commit -m "$(cat <<'EOF'
feat(t31): NetworkCircuit GenServer skeleton + cooldown jitter math

Sibling shape to Grappa.Session.Backoff (S20): named ETS table,
GenServer-funneled writes, direct-lookup reads, compile-env
defaults. Differs in keying: NetworkCircuit is per-network_id only,
not per-(subject, network_id), because the Login fresh-provision
case-1 fail-fast use case has no subject yet.

This task lands the math + table + skeleton. Behavior verbs
(record_failure, record_success, check) ship in the next task —
split for review surface.

Plan 1 of 2.
EOF
)"
```

## Task 8 — `NetworkCircuit` behavior verbs

**Files:**
- Modify: `lib/grappa/admission/network_circuit.ex`
- Modify: `test/grappa/admission/network_circuit_test.exs`

- [ ] **Step 1: Write failing tests for record_failure / record_success / check**

Append new `describe` blocks to `test/grappa/admission/network_circuit_test.exs`:

```elixir
describe "record_failure/1 + check/1" do
  test "fresh network reads :closed → check returns :ok" do
    assert NetworkCircuit.check(1) == :ok
  end

  test "single failure stays :closed (under threshold)" do
    :ok = NetworkCircuit.record_failure(1)
    _ = :sys.get_state(NetworkCircuit)
    assert NetworkCircuit.check(1) == :ok
  end

  test "threshold-many failures opens circuit; check returns retry_after" do
    for _ <- 1..NetworkCircuit.threshold() do
      :ok = NetworkCircuit.record_failure(1)
    end

    _ = :sys.get_state(NetworkCircuit)

    assert {:error, :open, retry_after} = NetworkCircuit.check(1)
    assert retry_after > 0
    assert retry_after <= div(NetworkCircuit.cooldown_ms(), 1_000) + 1
  end

  test "isolated per-network_id" do
    for _ <- 1..NetworkCircuit.threshold() do
      :ok = NetworkCircuit.record_failure(1)
    end

    _ = :sys.get_state(NetworkCircuit)

    assert {:error, :open, _} = NetworkCircuit.check(1)
    assert NetworkCircuit.check(2) == :ok
  end
end

describe "record_success/1" do
  test "clears state mid-window" do
    for _ <- 1..(NetworkCircuit.threshold() - 1) do
      :ok = NetworkCircuit.record_failure(1)
    end

    :ok = NetworkCircuit.record_success(1)
    _ = :sys.get_state(NetworkCircuit)

    assert NetworkCircuit.check(1) == :ok
  end

  test "clears open circuit" do
    for _ <- 1..NetworkCircuit.threshold() do
      :ok = NetworkCircuit.record_failure(1)
    end

    _ = :sys.get_state(NetworkCircuit)
    assert {:error, :open, _} = NetworkCircuit.check(1)

    :ok = NetworkCircuit.record_success(1)
    _ = :sys.get_state(NetworkCircuit)

    assert NetworkCircuit.check(1) == :ok
  end
end

describe "window expiry" do
  test "failures outside window don't carry — count resets" do
    # Configure window_ms to a tiny value via compile_env wouldn't
    # work mid-test; rely on test config's :network_circuit_window_ms
    # being set to ~100ms in config/test.exs (Task 12). Sleep past
    # window, then verify a failure starts a fresh count.
    for _ <- 1..(NetworkCircuit.threshold() - 1) do
      :ok = NetworkCircuit.record_failure(1)
    end

    _ = :sys.get_state(NetworkCircuit)
    assert NetworkCircuit.check(1) == :ok

    Process.sleep(NetworkCircuit.window_ms() + 50)

    :ok = NetworkCircuit.record_failure(1)
    _ = :sys.get_state(NetworkCircuit)

    assert NetworkCircuit.check(1) == :ok
  end
end

describe "cooldown expiry" do
  test "open circuit returns to :closed after cooldown_ms" do
    for _ <- 1..NetworkCircuit.threshold() do
      :ok = NetworkCircuit.record_failure(1)
    end

    _ = :sys.get_state(NetworkCircuit)
    assert {:error, :open, _} = NetworkCircuit.check(1)

    # Test config sets cooldown_ms to ~50ms.
    Process.sleep(NetworkCircuit.cooldown_ms() + 30)

    assert NetworkCircuit.check(1) == :ok
  end
end
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
scripts/mix.sh test test/grappa/admission/network_circuit_test.exs --warnings-as-errors
```

Expected: undefined function failures for `record_failure/1`, `record_success/1`, `check/1`.

- [ ] **Step 3: Implement the verbs**

In `lib/grappa/admission/network_circuit.ex`, before the `## GenServer` section, add:

```elixir
@doc """
Whether the circuit for `network_id` permits a new admission attempt.

Direct ETS lookup — no GenServer roundtrip. `:ok` if circuit is
closed OR the recorded cooldown has elapsed; `{:error, :open,
retry_after_seconds}` if currently open with cooldown remaining.
"""
@spec check(integer()) :: :ok | {:error, :open, non_neg_integer()}
def check(network_id) when is_integer(network_id) do
  case :ets.lookup(@table, network_id) do
    [] ->
      :ok

    [{_, _, _, :closed, _}] ->
      :ok

    [{_, _, _, :open, cooled_at_ms}] ->
      now = System.monotonic_time(:millisecond)

      if now >= cooled_at_ms do
        :ok
      else
        {:error, :open, ceil((cooled_at_ms - now) / 1_000)}
      end
  end
end

@doc """
Record a failed admission attempt against `network_id`. Bumps count
within the current window; transitions to `:open` when count reaches
threshold. Async (cast).
"""
@spec record_failure(integer()) :: :ok
def record_failure(network_id) when is_integer(network_id) do
  GenServer.cast(__MODULE__, {:failure, network_id})
end

@doc """
Record a successful admission against `network_id` — clears the entry
to `:closed, count=0`. Called from `Grappa.Visitors.Login` (Plan 2)
when probe-connect receives `001 RPL_WELCOME`. Async (cast).
"""
@spec record_success(integer()) :: :ok
def record_success(network_id) when is_integer(network_id) do
  GenServer.cast(__MODULE__, {:success, network_id})
end
```

In the `## GenServer` section, after `init/1`, add:

```elixir
@impl GenServer
def handle_cast({:failure, network_id}, state) do
  now = System.monotonic_time(:millisecond)

  {count, window_start} =
    case :ets.lookup(@table, network_id) do
      [] ->
        {1, now}

      [{_, prior_count, prior_start, _, _}] ->
        if now - prior_start > @window_ms do
          {1, now}
        else
          {prior_count + 1, prior_start}
        end
    end

  {circuit_state, cooled_at} =
    if count >= @threshold do
      {:open, now + compute_cooldown(@cooldown_ms)}
    else
      {:closed, 0}
    end

  :ets.insert(@table, {network_id, count, window_start, circuit_state, cooled_at})
  {:noreply, state}
end

def handle_cast({:success, network_id}, state) do
  :ets.delete(@table, network_id)
  {:noreply, state}
end
```

- [ ] **Step 4: Run test, expect PASS**

```bash
scripts/mix.sh test test/grappa/admission/network_circuit_test.exs --warnings-as-errors
```

Expected: 11 tests, 0 failures (will rely on test config from Task 12 — if cooldown/window aren't shrunk yet, the sleep-based tests time out; in that case, mark them with `@tag :pending` until Task 12 lands the test config, then untag).

Practical: if Task 12 hasn't run yet, the test's `Process.sleep(window_ms + 50)` would be 60+ seconds. Run Task 12 first if iterating; otherwise tag the two sleep tests `@tag :slow` and run with `--exclude slow` until Task 12.

Cleaner alternative (preferred): merge Task 12's test config additions into Task 7 prerequisites. Adopt this — Task 12 lands defaults for prod; the test-config shrink is needed at Task 7 time. Update Task 12 to mention "test config additions already landed in Task 7".

For now, also land the test config additions here:

In `config/test.exs`, append (after the existing `:session_backoff` block):

```elixir
# T31 NetworkCircuit — shrink threshold/window/cooldown so circuit-
# transition tests don't drag. Math is identical, only magnitudes
# shrink.
config :grappa, :admission,
  network_circuit_threshold: 3,
  network_circuit_window_ms: 100,
  network_circuit_cooldown_ms: 50
```

Re-run:

```bash
scripts/mix.sh test test/grappa/admission/network_circuit_test.exs --warnings-as-errors
```

Expected: PASS (11 tests, 0 failures).

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/admission/network_circuit.ex test/grappa/admission/network_circuit_test.exs config/test.exs
git commit -m "$(cat <<'EOF'
feat(t31): NetworkCircuit record_failure/record_success/check verbs

ETS row shape: {network_id, count, window_start_ms, state, cooled_at_ms}.

Window resets on first failure after window_ms elapsed.
Threshold-N failures within window flips to :open with cooldown_ms ±
25% jitter. Any record_success clears the row (return to :closed,
count=0). check/1 transitions :open → :closed lazily on read once
cooled_at_ms reaches now — no half-open intermediate state.

Test config shrunk threshold=3 / window=100ms / cooldown=50ms so
sleep-based tests don't drag. Math identical to prod (5 / 60s / 5min).

Plan 1 of 2.
EOF
)"
```

## Task 9 — Wire `NetworkCircuit` into Application supervision

**Files:**
- Modify: `lib/grappa/application.ex`

- [ ] **Step 1: Add to children list + boundary**

In `lib/grappa/application.ex`, update the boundary `deps` (lines 5-14) to include `Grappa.Admission`:

```elixir
use Boundary,
  top_level?: true,
  deps: [
    Grappa.Admission,
    Grappa.Bootstrap,
    Grappa.PubSub,
    Grappa.Repo,
    Grappa.Session,
    Grappa.Vault,
    Grappa.Visitors.Reaper,
    GrappaWeb
  ]
```

In the `children` list, add `Grappa.Admission.NetworkCircuit` directly after `Grappa.Session.Backoff` (currently around line 53). Both are ETS-backed admission/backoff state owners; they cluster naturally:

```elixir
# Grappa.Session.Backoff (existing) + Grappa.Admission.NetworkCircuit
# (T31): both ETS-backed singletons that must exist before the first
# session spawn or admission check. NetworkCircuit funnels writes
# through its GenServer; the named table is created in init/1.
Grappa.Session.Backoff,
Grappa.Admission.NetworkCircuit,
```

- [ ] **Step 2: Set up `Grappa.Admission` boundary**

The Boundary lib needs `Grappa.Admission` declared as a top-level boundary somewhere. Since `lib/grappa/admission.ex` doesn't exist yet (lands in Task 10), declare a placeholder NOW so Application's boundary deps reference resolves. Create a stub:

`lib/grappa/admission.ex`:

```elixir
defmodule Grappa.Admission do
  @moduledoc """
  Admission-control public surface — verbs land in Tasks 10-11.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Accounts, Grappa.Networks, Grappa.Repo, Grappa.Visitors],
    exports: [Captcha, NetworkCircuit]
end
```

- [ ] **Step 3: Verify the supervisor boots cleanly**

```bash
scripts/mix.sh compile --warnings-as-errors
scripts/test.sh test/grappa/admission/network_circuit_test.exs
```

Expected: green. The test now uses the Application-supervised NetworkCircuit (the test setup's `start_supervised!(NetworkCircuit)` becomes a no-op since the named process already exists — adjust setup).

Update `test/grappa/admission/network_circuit_test.exs`'s `setup` block:

```elixir
setup do
  # NetworkCircuit is supervised by Grappa.Application; just clear
  # state per test.
  for {key, _, _, _, _} <- NetworkCircuit.entries(),
      do: :ets.delete(:admission_network_circuit_state, key)

  :ok
end
```

Re-run:

```bash
scripts/mix.sh test test/grappa/admission/network_circuit_test.exs --warnings-as-errors
```

Expected: 11 tests, 0 failures.

- [ ] **Step 4: Smoke-check the full suite**

```bash
scripts/test.sh
```

Expected: all existing tests + 11 new = 737 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/application.ex lib/grappa/admission.ex test/grappa/admission/network_circuit_test.exs
git commit -m "$(cat <<'EOF'
feat(t31): supervise Grappa.Admission.NetworkCircuit + boundary stub

Application boundary deps += Grappa.Admission. NetworkCircuit child
sits next to Session.Backoff in the supervision tree — both are
ETS-singleton admission/backoff state owners with the same start
shape.

Grappa.Admission stub module declares the top-level Boundary so
Application's deps reference resolves. Public verbs (check_capacity/1,
verify_captcha/2) land in Tasks 10-11 on top of the stub.

Plan 1 of 2.
EOF
)"
```

## Task 10 — `Admission.check_capacity/1`

**Files:**
- Modify: `lib/grappa/admission.ex`
- Create: `test/grappa/admission_test.exs`

- [ ] **Step 1: Write failing tests**

`test/grappa/admission_test.exs`:

```elixir
defmodule Grappa.AdmissionTest do
  @moduledoc """
  Verb-level tests for Grappa.Admission.check_capacity/1. Covers
  each cap dimension and the bypass paths (Bootstrap flows skip
  client-cap because no client_id).
  """
  use Grappa.DataCase, async: false

  alias Grappa.Admission
  alias Grappa.Admission.NetworkCircuit

  setup do
    for {key, _, _, _, _} <- NetworkCircuit.entries(),
        do: :ets.delete(:admission_network_circuit_state, key)

    network = Grappa.AuthFixtures.network_with_server()
    {:ok, network: network}
  end

  describe "check_capacity/1 — network circuit gate" do
    test "open circuit short-circuits with :network_circuit_open", %{network: net} do
      for _ <- 1..NetworkCircuit.threshold() do
        :ok = NetworkCircuit.record_failure(net.id)
      end

      _ = :sys.get_state(NetworkCircuit)

      input = %{
        subject_kind: :visitor,
        subject_id: nil,
        network_id: net.id,
        client_id: "device-a",
        flow: :login_fresh
      }

      assert {:error, :network_circuit_open} = Admission.check_capacity(input)
    end
  end

  describe "check_capacity/1 — network total cap" do
    test "exceeded → :network_cap_exceeded", %{network: net} do
      {:ok, net} =
        net
        |> Grappa.Networks.Network.changeset(%{max_concurrent_sessions: 0})
        |> Grappa.Repo.update()

      input = %{
        subject_kind: :visitor,
        subject_id: nil,
        network_id: net.id,
        client_id: "device-a",
        flow: :login_fresh
      }

      assert {:error, :network_cap_exceeded} = Admission.check_capacity(input)
    end

    test "nil cap = uncapped", %{network: net} do
      input = %{
        subject_kind: :visitor,
        subject_id: nil,
        network_id: net.id,
        client_id: "device-a",
        flow: :login_fresh
      }

      assert :ok = Admission.check_capacity(input)
    end
  end

  describe "check_capacity/1 — Bootstrap paths skip client cap" do
    test ":bootstrap_user with nil client_id is :ok", %{network: net} do
      input = %{
        subject_kind: :user,
        subject_id: Ecto.UUID.generate(),
        network_id: net.id,
        client_id: nil,
        flow: :bootstrap_user
      }

      assert :ok = Admission.check_capacity(input)
    end

    test ":bootstrap_visitor with nil client_id is :ok", %{network: net} do
      input = %{
        subject_kind: :visitor,
        subject_id: Ecto.UUID.generate(),
        network_id: net.id,
        client_id: nil,
        flow: :bootstrap_visitor
      }

      assert :ok = Admission.check_capacity(input)
    end
  end
end
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
scripts/mix.sh test test/grappa/admission_test.exs --warnings-as-errors
```

Expected: undefined function `Admission.check_capacity/1`.

- [ ] **Step 3: Implement `check_capacity/1`**

Replace `lib/grappa/admission.ex` body (extending the stub from Task 9):

```elixir
defmodule Grappa.Admission do
  @moduledoc """
  Admission-control verbs for new IRC session creation.

  Two verbs:

    * `check_capacity/1` — composes (a) NetworkCircuit gate,
      (b) per-network total cap, (c) per-(client, network) cap.
      Local + cheap (Registry count + one DB query). Consumed by
      `Grappa.Visitors.Login`, `Grappa.Bootstrap`, and any future
      session-spawning surface.

    * `verify_captcha/2` — delegates to the configured Captcha
      behaviour impl. HTTP-bound, only required for `:login_fresh`
      flow.

  Cap dimensions and where they're checked:

  | cap                 | applies to                | source                                         |
  |---------------------|---------------------------|------------------------------------------------|
  | NetworkCircuit      | all flows                 | ETS via `Admission.NetworkCircuit.check/1`     |
  | network total       | all flows                 | `Registry.count_match/3` on SessionRegistry    |
  | client per network  | flows with non-nil client | SQL union over accounts_sessions               |

  Bootstrap flows (`:bootstrap_user`, `:bootstrap_visitor`) carry
  `client_id: nil` because there's no live client at cold-start;
  they bypass the client cap by construction.

  Identity-tier exemptions: NONE. Per Section 1 of the design,
  cap is the operator's knob (raise per-network `max_per_client` to
  allow multi-nick power users); identity tier exempts only CAPTCHA
  (in `verify_captcha/2`), not concurrency.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Accounts, Grappa.Networks, Grappa.Repo, Grappa.Visitors],
    exports: [Captcha, NetworkCircuit]

  import Ecto.Query

  alias Grappa.Accounts.Session, as: AccountSession
  alias Grappa.Admission.NetworkCircuit
  alias Grappa.Networks.{Credential, Network}
  alias Grappa.Repo
  alias Grappa.Visitors.Visitor

  @type subject_kind :: :user | :visitor
  @type flow :: :login_fresh | :login_existing | :bootstrap_user | :bootstrap_visitor

  @type capacity_input :: %{
          subject_kind: subject_kind(),
          subject_id: Ecto.UUID.t() | nil,
          network_id: integer(),
          client_id: String.t() | nil,
          flow: flow()
        }

  @type capacity_error :: :client_cap_exceeded | :network_cap_exceeded | :network_circuit_open

  @default_max_per_client_per_network Application.compile_env(
                                        :grappa,
                                        [:admission, :default_max_per_client_per_network],
                                        1
                                      )

  @doc """
  Compose all capacity checks for a candidate new session.

  Order: NetworkCircuit (cheapest, ETS) → network total
  (Registry count) → client cap (DB query). Bail at first failure.

  `:ok` means the session may be spawned. Any error tag means caller
  must NOT spawn — they should surface the error to the user (Login)
  or skip the row + log (Bootstrap).
  """
  @spec check_capacity(capacity_input()) :: :ok | {:error, capacity_error()}
  def check_capacity(%{network_id: network_id} = input) when is_integer(network_id) do
    with :ok <- check_circuit(network_id),
         :ok <- check_network_total(network_id),
         :ok <- check_client_cap(input) do
      :ok
    end
  end

  defp check_circuit(network_id) do
    case NetworkCircuit.check(network_id) do
      :ok -> :ok
      {:error, :open, _retry_after} -> {:error, :network_circuit_open}
    end
  end

  defp check_network_total(network_id) do
    case Repo.get(Network, network_id) do
      %Network{max_concurrent_sessions: nil} ->
        :ok

      %Network{max_concurrent_sessions: cap} ->
        live = count_live_sessions(network_id)
        if live >= cap, do: {:error, :network_cap_exceeded}, else: :ok

      nil ->
        :ok
    end
  end

  defp count_live_sessions(network_id) do
    Registry.count_match(Grappa.SessionRegistry, {:_, network_id}, :_)
  end

  # Bootstrap flows have nil client — skip client-cap check.
  defp check_client_cap(%{client_id: nil}), do: :ok

  defp check_client_cap(%{client_id: client_id, network_id: network_id} = _input)
       when is_binary(client_id) do
    cap = effective_max_per_client(network_id)
    count = count_subjects_for_client_on_network(client_id, network_id)
    if count >= cap, do: {:error, :client_cap_exceeded}, else: :ok
  end

  defp effective_max_per_client(network_id) do
    case Repo.get(Network, network_id) do
      %Network{max_per_client: nil} -> @default_max_per_client_per_network
      %Network{max_per_client: cap} -> cap
      nil -> @default_max_per_client_per_network
    end
  end

  # Count of distinct subjects (visitor_id ∪ user_id) reachable from
  # accounts_sessions where client_id matches AND the subject is bound
  # to the given network_id (visitor.network_slug = network's slug, OR
  # user has a Credential for network_id). Only non-revoked sessions
  # count.
  defp count_subjects_for_client_on_network(client_id, network_id) do
    %Network{slug: slug} = Repo.get!(Network, network_id)

    visitor_subjects =
      from(s in AccountSession,
        join: v in Visitor,
        on: v.id == s.visitor_id,
        where:
          s.client_id == ^client_id and
            v.network_slug == ^slug and
            is_nil(s.revoked_at),
        distinct: s.visitor_id,
        select: s.visitor_id
      )

    user_subjects =
      from(s in AccountSession,
        join: c in Credential,
        on: c.user_id == s.user_id and c.network_id == ^network_id,
        where:
          s.client_id == ^client_id and
            is_nil(s.revoked_at),
        distinct: s.user_id,
        select: s.user_id
      )

    Repo.aggregate(visitor_subjects, :count, :visitor_id) +
      Repo.aggregate(user_subjects, :count, :user_id)
  end
end
```

- [ ] **Step 4: Run test, expect PASS**

```bash
scripts/mix.sh test test/grappa/admission_test.exs --warnings-as-errors
```

Expected: 5 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/admission.ex test/grappa/admission_test.exs
git commit -m "$(cat <<'EOF'
feat(t31): Admission.check_capacity/1 — capacity verb

Composes three gates in cheapest-first order:

  1. NetworkCircuit.check (ETS) — fail-fast on known-bad upstream.
  2. Network total cap (Registry.count_match) — protects upstream
     from cluster-wide concurrency limits like azzurra's K-line rule.
  3. Per-(client, network) cap (SQL union on accounts_sessions ∪
     visitors / credentials) — per-device limit. Bootstrap flows
     bypass by construction (nil client_id).

Network-total uses Registry rather than a DB count: Session.Server
registration in Grappa.SessionRegistry IS the canonical "live IRC
session" record, derive don't duplicate (CLAUDE.md).

Per-client cap query is a UNION across visitor + user subject sides;
cap value resolves through network's max_per_client column with
fallback to global :default_max_per_client_per_network (default 1).

No consumers wired in this commit — Login + Bootstrap consume in
Plan 2.

Plan 1 of 2.
EOF
)"
```

## Task 11 — `Admission.verify_captcha/2`

**Files:**
- Modify: `lib/grappa/admission.ex`
- Modify: `test/grappa/admission_test.exs`

- [ ] **Step 1: Write failing tests**

Append to `test/grappa/admission_test.exs`:

```elixir
describe "verify_captcha/2 — Disabled provider" do
  test "always returns :ok" do
    assert :ok = Admission.verify_captcha("any-token", "1.2.3.4")
    assert :ok = Admission.verify_captcha(nil, nil)
    assert :ok = Admission.verify_captcha("", "1.2.3.4")
  end
end
```

(Real provider impls + Mox-based tests for non-Disabled ship in Plan 2.)

- [ ] **Step 2: Run test, expect FAIL**

```bash
scripts/mix.sh test test/grappa/admission_test.exs --warnings-as-errors
```

Expected: undefined function `verify_captcha/2`.

- [ ] **Step 3: Implement `verify_captcha/2`**

Append to `lib/grappa/admission.ex` (inside the module, after `count_subjects_for_client_on_network/2`):

```elixir
@doc """
Delegates to the configured Captcha behaviour impl.

The impl module is read at runtime (NOT compile_env) so test config
can substitute Mox mocks per-test via Application.put_env. This is
the single documented exception to "no runtime config reads" in
CLAUDE.md — captcha provider swapping is a Mox-driven test ergonomic,
not config-as-IPC.
"""
@spec verify_captcha(String.t() | nil, String.t() | nil) ::
        :ok | {:error, Captcha.error()}
def verify_captcha(token, ip) do
  provider = Application.get_env(:grappa, :admission, [])
             |> Keyword.get(:captcha_provider, Grappa.Admission.Captcha.Disabled)

  provider.verify(token, ip)
end
```

NOTE: this is a deliberate exception to CLAUDE.md "Application.{put,get}_env runtime banned." The captcha provider knob has the Mox-substitution property baked in — there's no other clean way to swap a behaviour impl per-test. Document it; don't propagate the pattern.

Add an alias near the top of the file (right under `alias Grappa.Visitors.Visitor`):

```elixir
alias Grappa.Admission.Captcha
```

- [ ] **Step 4: Run test, expect PASS**

```bash
scripts/mix.sh test test/grappa/admission_test.exs --warnings-as-errors
```

Expected: 6 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/admission.ex test/grappa/admission_test.exs
git commit -m "$(cat <<'EOF'
feat(t31): Admission.verify_captcha/2 — provider delegation verb

Reads :captcha_provider at runtime (not compile_env) so test config
can swap Mox mocks per-test. This is a deliberate documented
exception to CLAUDE.md "Application.get_env runtime banned" — no
clean alternative for swapping behaviour impls per-test.

Default provider Grappa.Admission.Captcha.Disabled (always-:ok). Plan
2 lands Turnstile + hCaptcha real impls + per-test Mox substitution.

Plan 1 of 2.
EOF
)"
```

## Task 12 — Config defaults + Logger metadata + final gates

**Files:**
- Modify: `config/config.exs`
- Modify: `config/test.exs`

- [ ] **Step 1: Add base defaults to `config/config.exs`**

In `config/config.exs`, after the existing `:session_backoff` block (around line 41), add:

```elixir
# T31 admission control. Defaults match the design (CP11 S20 →
# CP11 S21 brainstorm). All values configurable per-env via
# config/runtime.exs at deployment time.
#
#   * default_max_per_client_per_network — global per-(client_id,
#     network_id) cap. Operator can override per-network via the
#     networks.max_per_client column.
#   * captcha_provider — module implementing Grappa.Admission.Captcha
#     behaviour. Disabled = always :ok (test/dev/private deployments).
#     Plan 2 adds Turnstile + HCaptcha modules.
#   * captcha_secret — provider's verify-side secret (env var in prod).
#   * login_probe_timeout_ms — Visitors.Login probe-connect budget.
#     3s default leaves nginx 30s upstream timeout plenty of slack.
#     Was hard-coded 8s pre-T31; Plan 2 wires this in.
#   * network_circuit_threshold / window_ms / cooldown_ms — see
#     Grappa.Admission.NetworkCircuit moduledoc.
config :grappa, :admission,
  default_max_per_client_per_network: 1,
  captcha_provider: Grappa.Admission.Captcha.Disabled,
  captcha_secret: nil,
  login_probe_timeout_ms: 3_000,
  network_circuit_threshold: 5,
  network_circuit_window_ms: 60_000,
  network_circuit_cooldown_ms: 5 * 60_000
```

In the same file, append to the Logger `:console, metadata: [...]` allowlist (currently ends around line 133 with `:failure_count`):

```elixir
,
# T31 admission — rides admission rejection / circuit transition log
# lines so operator can grep cap-exceeded events.
:cap_kind,
:cap_value,
:cap_observed,
:circuit_state,
:retry_after_seconds
```

(Add the comma after `:failure_count` and the new keys before the closing `]`.)

- [ ] **Step 2: Verify test config**

`config/test.exs` already has the shrink set landed in Task 8. Verify it's complete:

```bash
grep -A 5 "admission" config/test.exs
```

Expected: at least the `:network_circuit_threshold/window_ms/cooldown_ms` block. If `default_max_per_client_per_network` and `captcha_provider` are missing for test env, append:

```elixir
config :grappa, :admission,
  default_max_per_client_per_network: 10,
  captcha_provider: Grappa.Admission.Captcha.Disabled,
  network_circuit_threshold: 3,
  network_circuit_window_ms: 100,
  network_circuit_cooldown_ms: 50,
  login_probe_timeout_ms: 100
```

(Note: `config :grappa, :admission, [...]` REPLACES the prior call if rerun — make sure the keys merge by being in ONE call.)

- [ ] **Step 3: Run full check**

```bash
scripts/check.sh
```

Expected: 0 failures, 0 dialyzer, 0 credo, 0 sobelow, ~737 tests (was 726 + 11 NetworkCircuit + 5 Admission verb + 3 Captcha.Disabled + 4 Network.changeset + 2 Session.client_id = 751).

- [ ] **Step 4: Standalone dialyzer (per `feedback_dialyzer_plt_staleness`)**

```bash
scripts/dialyzer.sh
```

Expected: 0 warnings. PLT cache may flag latent issues that the cluster-wide `check.sh` doesn't surface — the memory pin is explicit about running standalone before LANDED claim.

- [ ] **Step 5: Commit**

```bash
git add config/config.exs config/test.exs
git commit -m "$(cat <<'EOF'
chore(t31): admission defaults + Logger metadata allowlist

config/config.exs: :grappa, :admission block with the 7 knobs the
design pins (default_max_per_client_per_network, captcha_provider/secret,
login_probe_timeout_ms, network_circuit_threshold/window_ms/cooldown_ms).
Defaults match the brainstorm decisions. Per dialyzer_plt_staleness
memory pin, defaults live in BOTH config.exs and test.exs.

Logger metadata allowlist += cap_kind, cap_value, cap_observed,
circuit_state, retry_after_seconds. Used by Plan 2's Login + Bootstrap
log lines on admission rejection / circuit transition.

Plan 1 of 2 final commit. Pre-merge gates: scripts/check.sh green
(N tests, 0 dialyzer, 0 credo, 0 sobelow). Standalone dialyzer
verified per feedback_dialyzer_plt_staleness.
EOF
)"
```

---

## Final merge to main

After all 12 tasks land:

```bash
# In the worktree
git rebase main
scripts/check.sh                         # final gate, full clean run
scripts/dialyzer.sh                      # standalone dialyzer per memory pin

# Switch to main
cd /srv/grappa
git checkout main
git pull
git merge --ff-only cluster/t31-infra
scripts/check.sh                         # smoke on main
git push

# Worktree cleanup
git worktree remove ../grappa-task-t31-infra
git branch -d cluster/t31-infra
```

NO `scripts/deploy.sh` from Plan 1 alone. Plan 1 is infrastructure: schemas + verbs + tests + supervised state. Nothing CONSUMES `Admission.check_capacity/1` until Plan 2 wires Login + Bootstrap. Deploying Plan 1 alone is a no-op for the running container — safe to defer until Plan 2 also lands.

If operator preference is to deploy Plan 1 and Plan 2 separately for a smaller blast radius:

```bash
scripts/deploy.sh
scripts/healthcheck.sh
```

After deploy, `Grappa.Admission.NetworkCircuit` is supervised (visible in `scripts/observer.sh`) but inert (no record_failure callers yet). Schema columns visible in `scripts/db.sh ".schema sessions"` and `".schema networks"` but always nil-valued.

## Plan 1 exit criteria

- [ ] All 12 tasks landed on `cluster/t31-infra`.
- [ ] `scripts/check.sh` green (0 failures / 0 dialyzer / 0 credo / 0 sobelow).
- [ ] Standalone `scripts/dialyzer.sh` green (per memory pin).
- [ ] Branch rebased + ff-merged to main.
- [ ] Origin pushed.
- [ ] Worktree + branch cleaned up.
- [ ] CP11 S22 (or new CP) entry written documenting Plan 1 LANDED + Plan 2 carry-forward.

## Carry-forward to Plan 2

Plan 2 (`docs/plans/2026-05-03-t31-admission-integration.md`) will:

1. Plumb `X-Grappa-Client-Id` through `Plugs.Authn` → `:current_client_id` conn assign.
2. Wire `Admission.check_capacity/1` + `verify_captcha/2` into `Visitors.Login.handle_login/3`.
3. Wire `Admission.check_capacity/1` (network-total only) into `Bootstrap.spawn_one/2` + `Bootstrap.spawn_visitor/2`.
4. Add `Session.Backoff.reset/2` verb; call from `Login.preempt_and_respawn/4` to clear stale state on operator-initiated Login.
5. Add real Captcha impls (`Turnstile`, `HCaptcha`) with Bypass-mocked tests.
6. Cut `Login.@login_timeout_ms` hardcoded 8s → `:login_probe_timeout_ms` config (default 3s).
7. Extend `FallbackController` for new error atoms (`:client_cap_exceeded`, `:network_cap_exceeded`, `:network_circuit_open`, `:captcha_required`, `:captcha_failed`, `:captcha_provider_unavailable`).
8. Update `AuthController` + `AuthJSON` for the captcha-required response shape (carries `site_key`).
9. cicchetto: generate `client_id` UUID v4 in localStorage on first load; send `X-Grappa-Client-Id` on every authenticated request; render new error responses (429 too_many_sessions, 503 network_busy / network_unreachable / service_degraded, 400 captcha_required with widget).
10. Telemetry: emit `[:grappa, :admission, :circuit, :open|:close]` events for Phase-5 PromEx.

Plan 2 is shippable independently — Plan 1's verbs are inert until Plan 2 wires consumers. Ship Plan 1 first to land schema + state safely, then Plan 2 brings the user-visible behavior.
