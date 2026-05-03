# T31 Admission Control — Integration Plan (Plan 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Plan 1 infrastructure (`Grappa.Admission` verbs + `NetworkCircuit` + Captcha behaviour) into the Login + Bootstrap surfaces; ship real captcha provider impls (Turnstile + hCaptcha) with Mox + Bypass test coverage; plumb `client_id` end-to-end (cicchetto → header → Plug → schema); land HTTP error mappings + cicchetto error-rendering. After Plan 2 ships, `POST /auth/login` enforces all three caps + captcha + circuit-breaker; Bootstrap respects network-total cap on cold-start; cicchetto generates + persists a stable client identity; Login probe-timeout cuts to 3s; per-(subject, network) Backoff is reset on operator-initiated case-2 preempt.

**Architecture:** Plan 1 landed `Admission.check_capacity/1` + `Admission.verify_captcha/2` as inert verbs. Plan 2 wires them into `Grappa.Visitors.Login.handle_login/3` (case-1 = capacity + captcha + probe; case-2/3 = capacity + maybe Backoff.reset, no captcha). `Grappa.Bootstrap` consumes capacity (network-total only) on cold-start. `Plugs.Authn` extracts `X-Grappa-Client-Id` header and assigns `:current_client_id` for downstream consumers. `FallbackController` maps the six new admission error atoms; `AuthController` + `AuthJSON` surface the captcha-required response carrying the provider's `site_key`. cicchetto: `crypto.randomUUID()` → localStorage → `X-Grappa-Client-Id` header on every authenticated request; new error renderers for the 429/503/400 admission responses; captcha widget integration.

**Tech Stack:** Elixir 1.19 / OTP 28, Bypass for HTTP fakes, Mox for behaviour mocking, telemetry, TypeScript 5 + Solid 2 + Vitest in cicchetto. All Elixir work runs inside the `grappa` container via `scripts/*.sh`. cicchetto runs separately under `cd cicchetto && npm run dev` for the local dev iteration loop.

## Reference docs

- `docs/plans/2026-05-03-t31-admission-infra.md` — Plan 1, prerequisite. Plan 2 assumes ALL Plan 1 tasks LANDED on main.
- Brainstorm conversation S21 (this session).
- Existing patterns: `lib/grappa/visitors/login.ex` (current Login orchestrator), `lib/grappa_web/plugs/authn.ex` (subject plumbing), `lib/grappa_web/controllers/fallback_controller.ex` (error envelope), `cicchetto/src/lib/api.ts` (typed fetch client), `cicchetto/src/lib/auth.ts` (subject/token persistence).
- CLAUDE.md "Phoenix / Ecto patterns", "Charset / wire-format rule", "Testing Standards".
- Memory pin `feedback_dialyzer_plt_staleness` — defaults must live in BOTH config files; standalone dialyzer required before LANDED claim.

## Worktree first

```bash
git checkout main
git pull
git worktree add ../grappa-task-t31-integration cluster/t31-integration
cd ../grappa-task-t31-integration
```

## File structure

**Create:**

| path | responsibility |
|---|---|
| `lib/grappa/admission/captcha/turnstile.ex` | Cloudflare Turnstile verify impl |
| `lib/grappa/admission/captcha/h_captcha.ex` | hCaptcha verify impl |
| `lib/grappa/admission/telemetry.ex` | telemetry event emission helpers (open/close transitions, capacity rejections) |
| `test/grappa/admission/captcha/turnstile_test.exs` | Bypass-driven HTTP fake tests |
| `test/grappa/admission/captcha/h_captcha_test.exs` | Bypass-driven HTTP fake tests |
| `test/support/captcha_mock.ex` | Mox-defined behaviour mock |
| `cicchetto/src/lib/clientId.ts` | `client_id` generation + localStorage persistence |
| `cicchetto/src/__tests__/clientId.test.ts` | vitest coverage for client_id lifecycle |
| `cicchetto/src/lib/captcha.ts` | thin wrapper around the captcha provider widget (Turnstile + hCaptcha share a token-callback shape) |

**Modify:**

| path | what changes |
|---|---|
| `lib/grappa/session/backoff.ex` | add `reset/2` verb |
| `lib/grappa/visitors/login.ex` | wire admission gates + probe-timeout config + circuit record_failure/success + Backoff.reset on preempt |
| `lib/grappa/bootstrap.ex` | wire network-total cap on `spawn_one/2` + `spawn_visitor/2` |
| `lib/grappa_web/plugs/authn.ex` | extract `X-Grappa-Client-Id` header, assign `:current_client_id` |
| `lib/grappa_web/controllers/auth_controller.ex` | thread `current_client_id` into Login input; surface captcha-required + capacity errors |
| `lib/grappa_web/controllers/auth_json.ex` | new response shape for captcha-required (carries `site_key`) |
| `lib/grappa_web/controllers/fallback_controller.ex` | clauses for 6 new error atoms |
| `cicchetto/src/lib/api.ts` | send `X-Grappa-Client-Id` on every fetch; type new error wire shapes |
| `cicchetto/src/Login.tsx` | render captcha widget on `captcha_required` response |
| `lib/grappa/visitors.ex` | rebrand `count_active_for_ip/1` to a deprecation note OR remove entirely (W3 superseded by T31's per-`(client, network)` cap) |
| `lib/grappa/visitors/login.ex` | drop `@max_per_ip` + `check_ip_cap/1` (W3 retired by T31) |
| `config/runtime.exs` | prod-only env-var resolution for `:captcha_provider`, `:captcha_secret`, `:captcha_site_key` |
| `test/grappa/visitors/login_test.exs` | new cases: cap_exceeded, captcha_required/failed, circuit_open, Backoff.reset on preempt |
| `test/grappa/bootstrap_test.exs` | new case: over-cap visitor rows skipped + warned |
| `test/grappa_web/controllers/auth_controller_test.exs` | new HTTP error mapping tests |

---

## Task 1 — `Session.Backoff.reset/2` verb

**Files:**
- Modify: `lib/grappa/session/backoff.ex`
- Modify: `test/grappa/session/backoff_test.exs`

- [ ] **Step 1: Failing test**

In `test/grappa/session/backoff_test.exs`, add a new describe block:

```elixir
describe "reset/2" do
  test "clears state for explicit (subject, network)" do
    :ok = Backoff.record_failure({:visitor, "v1"}, 7)
    :ok = Backoff.record_failure({:visitor, "v1"}, 7)
    _ = :sys.get_state(Backoff)

    assert Backoff.failure_count({:visitor, "v1"}, 7) == 2

    :ok = Backoff.reset({:visitor, "v1"}, 7)
    _ = :sys.get_state(Backoff)

    assert Backoff.failure_count({:visitor, "v1"}, 7) == 0
    assert Backoff.wait_ms({:visitor, "v1"}, 7) == 0
  end

  test "is no-op for fresh key" do
    :ok = Backoff.reset({:visitor, "fresh"}, 99)
    _ = :sys.get_state(Backoff)
    assert Backoff.failure_count({:visitor, "fresh"}, 99) == 0
  end
end
```

- [ ] **Step 2: Run, expect FAIL**: `scripts/mix.sh test test/grappa/session/backoff_test.exs --warnings-as-errors`

- [ ] **Step 3: Add `reset/2`**

In `lib/grappa/session/backoff.ex`, add (in the API surface area, after `record_success/2`):

```elixir
@doc """
Clear the failure counter for `(subject, network_id)`. Operator-
initiated paths (Login.preempt_and_respawn) call this before
respawning so prior crash backoff doesn't gate an explicit user
action. Asynchronous (cast).

Distinct from `record_success/2` semantically: success means "we
saw a welcome, prior failures are stale"; reset means "operator is
overriding any failure history, start fresh." Same effect on the
table; different intent at call site.
"""
@spec reset(Session.subject(), integer()) :: :ok
def reset(subject, network_id) when is_integer(network_id) do
  GenServer.cast(__MODULE__, {:reset, {subject, network_id}})
end
```

In the GenServer's `handle_cast` block, add:

```elixir
def handle_cast({:reset, key}, state) do
  :ets.delete(@table, key)
  {:noreply, state}
end
```

- [ ] **Step 4: Run, expect PASS**: `scripts/mix.sh test test/grappa/session/backoff_test.exs --warnings-as-errors`

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/session/backoff.ex test/grappa/session/backoff_test.exs
git commit -m "$(cat <<'EOF'
feat(session): Backoff.reset/2 — explicit clear for operator-initiated paths

T31 Plan 2 prereq. Visitors.Login.preempt_and_respawn calls
Backoff.reset(subject, network) before respawning so a recent crash's
backoff window doesn't gate a user explicitly re-logging in. Distinct
from record_success semantically (success = "saw welcome", reset =
"operator override"); same table effect.
EOF
)"
```

## Task 2 — `Plugs.Authn` plumbs `client_id`

**Files:**
- Modify: `lib/grappa_web/plugs/authn.ex`
- Modify: `test/grappa_web/plugs/authn_test.exs`

- [ ] **Step 1: Failing tests**

In `test/grappa_web/plugs/authn_test.exs`, add:

```elixir
describe "client_id plumbing" do
  test "X-Grappa-Client-Id header populates :current_client_id assign", %{conn: conn} do
    user = Grappa.AuthFixtures.user_fixture()
    {:ok, session} = Grappa.Accounts.create_session({:user, user.id}, "1.2.3.4", nil)

    conn =
      conn
      |> put_req_header("authorization", "Bearer " <> session.id)
      |> put_req_header("x-grappa-client-id", "device-uuid-1")
      |> GrappaWeb.Plugs.Authn.call(GrappaWeb.Plugs.Authn.init([]))

    assert conn.assigns.current_client_id == "device-uuid-1"
  end

  test "missing header → :current_client_id is nil", %{conn: conn} do
    user = Grappa.AuthFixtures.user_fixture()
    {:ok, session} = Grappa.Accounts.create_session({:user, user.id}, "1.2.3.4", nil)

    conn =
      conn
      |> put_req_header("authorization", "Bearer " <> session.id)
      |> GrappaWeb.Plugs.Authn.call(GrappaWeb.Plugs.Authn.init([]))

    assert conn.assigns.current_client_id == nil
  end

  test "rejects malformed client_id (non-UUID, length > 64)", %{conn: conn} do
    user = Grappa.AuthFixtures.user_fixture()
    {:ok, session} = Grappa.Accounts.create_session({:user, user.id}, "1.2.3.4", nil)
    bogus = String.duplicate("x", 200)

    conn =
      conn
      |> put_req_header("authorization", "Bearer " <> session.id)
      |> put_req_header("x-grappa-client-id", bogus)
      |> GrappaWeb.Plugs.Authn.call(GrappaWeb.Plugs.Authn.init([]))

    # Treat malformed as absent — don't 400 the request, just nil the
    # assign. Cicchetto generates UUID v4 by spec; only an attacker
    # would submit garbage. Logging in defensive paths sufficient.
    assert conn.assigns.current_client_id == nil
  end
end
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement header extraction in `Plugs.Authn`**

In `lib/grappa_web/plugs/authn.ex`, in the success branches that already assign `:current_subject` (lines 77-91 area per the orientation read), add `assign(:current_client_id, extract_client_id(conn))` before the `:current_subject` assign in BOTH the user and visitor branches.

Add the helper:

```elixir
defp extract_client_id(conn) do
  case get_req_header(conn, "x-grappa-client-id") do
    [value | _] when is_binary(value) ->
      if valid_client_id?(value), do: value, else: nil

    _ ->
      nil
  end
end

# Accept any URL-safe ASCII string up to 64 bytes. cicchetto generates
# a UUID v4 (36 chars), but the server contract is "opaque token, server
# stores verbatim". Defensive cap protects schema (varchar) from absurd
# values without forcing a UUID-strict regex that ties cicchetto's
# implementation choice to the server.
defp valid_client_id?(value) when is_binary(value) do
  byte_size(value) > 0 and byte_size(value) <= 64 and String.match?(value, ~r/\A[A-Za-z0-9_-]+\z/)
end
```

NOTE: UUID v4 contains `-` which the regex allows. Reject `0` length, anything > 64 bytes, anything outside `[A-Za-z0-9_-]`.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
feat(t31): Plugs.Authn plumbs X-Grappa-Client-Id → :current_client_id

cicchetto generates a stable client_id UUID v4 in localStorage on
first load and sends it as X-Grappa-Client-Id on every authenticated
request. The plug extracts + validates (URL-safe charset, ≤64 bytes,
non-empty), assigns to :current_client_id. Malformed values silently
nil rather than 400 — the server contract is opaque token, defensive
validation only protects the schema column from garbage.

Plan 2 of 2.
```

## Task 3 — `Visitors.Login` admission integration

**Files:**
- Modify: `lib/grappa/visitors/login.ex`
- Modify: `test/grappa/visitors/login_test.exs`

This is the heart of Plan 2. Login becomes:

```
Login.login(input, opts):
  1. validate_nick (existing)
  2. resolve visitor_network (existing)
  3. lookup_visitor by (nick, slug)
  4. dispatch:
     - case 1 (no row, fresh anon):
         a. Admission.check_capacity(:login_fresh, ...)
         b. Admission.verify_captcha(input.captcha_token, input.ip)
         c. Visitors.find_or_provision_anon
         d. spawn_and_await with login_probe_timeout_ms
            - on success: NetworkCircuit.record_success
            - on failure: NetworkCircuit.record_failure + purge anon
         e. issue_token
     - case 2 (registered + password):
         a. Admission.check_capacity(:login_existing, ...)
         b. check_password (existing)
         c. revoke_sessions + purge_if_anon + stop_session
         d. **Backoff.reset(subject, network_id)**  ← NEW (Section 4)
         e. spawn_and_await with login_probe_timeout_ms
         f. send_post_login_identify (existing)
         g. issue_token
     - case 3 (anon token rotate):
         a. Admission.check_capacity(:login_existing, ...)
         b. check_anon_token (existing)
         c. rotate_token (existing)
```

- [ ] **Step 1: Add capacity check tests**

Append to `test/grappa/visitors/login_test.exs`:

```elixir
describe "capacity gates" do
  setup do
    network = Grappa.AuthFixtures.network_with_server()
    {:ok, network: network}
  end

  test "client_cap_exceeded → {:error, :client_cap_exceeded}", %{network: net} do
    # Pre-populate accounts_sessions with N visitors from same client_id
    # to trip the per-(client_id, network) cap. Default cap in test
    # config is 10; bring it down for this test via ad-hoc app env put.
    Application.put_env(:grappa, :admission,
      Application.get_env(:grappa, :admission) |> Keyword.put(:default_max_per_client_per_network, 1))

    on_exit(fn ->
      Application.put_env(:grappa, :admission,
        Application.get_env(:grappa, :admission) |> Keyword.put(:default_max_per_client_per_network, 10))
    end)

    # Spawn one existing visitor session for client_id "device-a"
    {:ok, _existing} =
      Grappa.Visitors.Login.login(
        %{nick: "old_user", password: nil, ip: "1.2.3.4", user_agent: nil, token: nil, captcha_token: nil, client_id: "device-a"}
      )

    # Second login attempt from same client_id on same network should fail
    result =
      Grappa.Visitors.Login.login(
        %{nick: "second_user", password: nil, ip: "1.2.3.4", user_agent: nil, token: nil, captcha_token: nil, client_id: "device-a"}
      )

    assert result == {:error, :client_cap_exceeded}
  end

  test "network_cap_exceeded → {:error, :network_cap_exceeded}", %{network: net} do
    {:ok, _net} =
      net
      |> Grappa.Networks.Network.changeset(%{max_concurrent_sessions: 0})
      |> Grappa.Repo.update()

    result =
      Grappa.Visitors.Login.login(
        %{nick: "any_nick", password: nil, ip: "1.2.3.4", user_agent: nil, token: nil, captcha_token: nil, client_id: "device-a"}
      )

    assert result == {:error, :network_cap_exceeded}
  end

  test "network_circuit_open → {:error, :network_circuit_open}", %{network: net} do
    for _ <- 1..Grappa.Admission.NetworkCircuit.threshold() do
      :ok = Grappa.Admission.NetworkCircuit.record_failure(net.id)
    end

    _ = :sys.get_state(Grappa.Admission.NetworkCircuit)

    result =
      Grappa.Visitors.Login.login(
        %{nick: "fresh", password: nil, ip: "1.2.3.4", user_agent: nil, token: nil, captcha_token: nil, client_id: "device-a"}
      )

    assert result == {:error, :network_circuit_open}
  end
end
```

(Plan 2 also adds `client_id` and `captcha_token` to the `Login.input` typespec — see Step 3 below.)

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Wire admission into Login**

In `lib/grappa/visitors/login.ex`:

Update `@type input` (currently around line 68):

```elixir
@type input :: %{
        required(:nick) => String.t(),
        required(:password) => String.t() | nil,
        required(:ip) => String.t() | nil,
        required(:user_agent) => String.t() | nil,
        required(:token) => String.t() | nil,
        required(:captcha_token) => String.t() | nil,
        required(:client_id) => String.t() | nil
      }
```

Update `@type login_error` to include the new admission errors:

```elixir
@type login_error ::
        :malformed_nick
        | :client_cap_exceeded
        | :network_cap_exceeded
        | :network_circuit_open
        | :captcha_required
        | :captcha_failed
        | :captcha_provider_unavailable
        | :upstream_unreachable
        | :timeout
        | :no_server
        | :network_unconfigured
        | :password_required
        | :password_mismatch
        | :anon_collision
```

Drop `:ip_cap_exceeded` (W3 superseded by T31).

Update `login/2` head to take the wider input:

```elixir
def login(%{nick: _, password: _, ip: _, user_agent: _, token: _, captcha_token: _, client_id: _} = input, opts \\ []) do
  ...
end
```

Replace `dispatch/4`'s case-1 clause:

```elixir
defp dispatch(nil, input, network, timeout) do
  capacity_input = %{
    subject_kind: :visitor,
    subject_id: nil,
    network_id: network.id,
    client_id: input.client_id,
    flow: :login_fresh
  }

  with :ok <- Grappa.Admission.check_capacity(capacity_input),
       :ok <- Grappa.Admission.verify_captcha(input.captcha_token, input.ip),
       {:ok, visitor} <-
         Grappa.Visitors.find_or_provision_anon(input.nick, network.slug, input.ip) do
    case continue_case_1(visitor, network, input, timeout) do
      {:ok, _} = ok ->
        :ok = Grappa.Admission.NetworkCircuit.record_success(network.id)
        ok

      {:error, _} = err ->
        :ok = Grappa.Admission.NetworkCircuit.record_failure(network.id)
        :ok = Grappa.Visitors.purge_if_anon(visitor.id)
        err
    end
  end
end
```

Replace `dispatch/4`'s case-2 clause:

```elixir
defp dispatch(%Visitor{password_encrypted: pwd} = visitor, input, network, timeout)
     when is_binary(pwd) do
  capacity_input = %{
    subject_kind: :visitor,
    subject_id: visitor.id,
    network_id: network.id,
    client_id: input.client_id,
    flow: :login_existing
  }

  with :ok <- Grappa.Admission.check_capacity(capacity_input),
       :ok <- check_password(input.password, pwd) do
    preempt_and_respawn(visitor, network, input, timeout)
  end
end
```

Replace `dispatch/4`'s case-3 clause similarly:

```elixir
defp dispatch(%Visitor{password_encrypted: nil} = visitor, input, network, _) do
  capacity_input = %{
    subject_kind: :visitor,
    subject_id: visitor.id,
    network_id: network.id,
    client_id: input.client_id,
    flow: :login_existing
  }

  with :ok <- Grappa.Admission.check_capacity(capacity_input),
       :ok <- check_anon_token(input.token, visitor.id) do
    rotate_token(visitor, input)
  end
end
```

Update `preempt_and_respawn/4` to call `Backoff.reset/2`:

```elixir
defp preempt_and_respawn(visitor, network, input, timeout) do
  :ok = Accounts.revoke_sessions_for_visitor(visitor.id)
  :ok = Visitors.purge_if_anon(visitor.id)
  :ok = Session.stop_session({:visitor, visitor.id}, network.id)
  :ok = Grappa.Session.Backoff.reset({:visitor, visitor.id}, network.id)

  with {:ok, _} <- spawn_and_await(visitor, network, timeout) do
    :ok = Grappa.Admission.NetworkCircuit.record_success(network.id)
    send_post_login_identify(visitor, network, input.password)
    issue_token(visitor, input)
  end
end
```

DROP the entire `check_ip_cap/1` family + `@max_per_ip` compile-env (W3 retired by T31).

Update probe timeout to read from runtime config:

```elixir
@login_timeout_ms Application.compile_env(:grappa, [:admission, :login_probe_timeout_ms], 3_000)
```

(Replaces existing `@login_timeout_ms 8_000`.)

Update `Visitors.Login` boundary deps if Login lives under `Visitors` boundary; add `Grappa.Admission` to the `Grappa.Visitors` boundary deps in `lib/grappa/visitors.ex`:

```elixir
use Boundary,
  top_level?: true,
  deps: [
    Grappa.Accounts,
    Grappa.Admission,
    Grappa.Auth.IdentifierClassifier,
    ...
  ]
```

- [ ] **Step 4: Run all login tests, expect PASS**

```bash
scripts/mix.sh test test/grappa/visitors/login_test.exs --warnings-as-errors
```

Expect: existing tests pass + new admission tests pass. Existing tests need their input maps extended with `captcha_token: nil, client_id: nil` because the typespec is now stricter. Grep for `Login.login(` in test/, fix each call site.

- [ ] **Step 5: Commit**

```bash
feat(t31): Visitors.Login wires Admission gates + Backoff.reset on preempt

case-1 (fresh anon): check_capacity → verify_captcha → provision →
spawn → on success NetworkCircuit.record_success, on failure
record_failure + purge anon. case-2 (registered): check_capacity → 
password gate → revoke + purge + stop_session + Backoff.reset →
spawn → record_success. case-3 (anon rotate): check_capacity → token
gate → rotate_token (no respawn, no NetworkCircuit interaction).

Probe timeout cut from hard-coded 8s to config :login_probe_timeout_ms
(default 3s) so nginx 504 never bites — meaningful error reaches client
in <5s.

W3 :ip_cap_exceeded retired in favor of T31 per-(client, network) cap;
@max_per_ip + check_ip_cap/1 deleted.

Plan 2 of 2.
```

## Task 4 — `Bootstrap` network-total cap

**Files:**
- Modify: `lib/grappa/bootstrap.ex`
- Modify: `test/grappa/bootstrap_test.exs`

- [ ] **Step 1: Failing test**

In `test/grappa/bootstrap_test.exs`, add:

```elixir
describe "network total cap" do
  test "respawn skips visitors over network cap" do
    network = Grappa.AuthFixtures.network_with_server(slug: "azzurra")
    {:ok, _} = network |> Grappa.Networks.Network.changeset(%{max_concurrent_sessions: 1}) |> Grappa.Repo.update()

    # Provision 3 visitors
    for n <- 1..3 do
      Grappa.AuthFixtures.visitor_fixture(network_slug: "azzurra", nick: "v#{n}")
    end

    log = ExUnit.CaptureLog.capture_log(fn -> Grappa.Bootstrap.run() end)

    started_count = Registry.count_match(Grappa.SessionRegistry, {:_, network.id}, :_)
    assert started_count <= 1
    assert log =~ "skipped — network cap"
  end
end
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Wire `check_capacity` into Bootstrap**

In `lib/grappa/bootstrap.ex`, modify `spawn_one/2` (the user-credential path):

```elixir
defp spawn_one(
       %Credential{user_id: user_id, network_id: network_id, network: %Network{slug: slug}} =
         credential,
       acc
     ) do
  capacity_input = %{
    subject_kind: :user,
    subject_id: user_id,
    network_id: network_id,
    client_id: nil,
    flow: :bootstrap_user
  }

  with :ok <- Grappa.Admission.check_capacity(capacity_input),
       {:ok, plan} <- SessionPlan.resolve(credential),
       {:ok, _} <- Session.start_session({:user, user_id}, network_id, plan) do
    Logger.info("session started", user: user_id, network: slug)
    %{acc | started: acc.started + 1}
  else
    {:error, :network_cap_exceeded} ->
      Logger.warning("session skipped — network cap exceeded",
        user: user_id, network: slug)
      %{acc | failed: acc.failed + 1}

    {:error, {:already_started, _}} ->
      Logger.debug("session already started", user: user_id, network: slug)
      %{acc | started: acc.started + 1}

    {:error, reason} ->
      Logger.error("session start failed",
        user: user_id, network: slug, error: inspect(reason))
      %{acc | failed: acc.failed + 1}
  end
end
```

Mirror the same wrapping in `spawn_visitor/2`. Add `Grappa.Admission` to `Grappa.Bootstrap` boundary deps:

```elixir
use Boundary,
  top_level?: true,
  deps: [Grappa.Admission, Grappa.Networks, Grappa.Session, Grappa.Visitors]
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
feat(t31): Bootstrap respects per-network total session cap on cold-start

50 visitor rows want respawn on a network with cap=20 → 30 over-cap
get skipped + warned. Best-effort per existing Bootstrap moduledoc;
operator sizing the cap correctly is the right pressure. CLAUDE.md
admonition against half-finished implementations applies — no
queue/retry shape, just clean skip+log.

Plan 2 of 2.
```

## Task 5 — `FallbackController` error mappings

**Files:**
- Modify: `lib/grappa_web/controllers/fallback_controller.ex`
- Modify: `test/grappa_web/controllers/fallback_controller_test.exs` (or AuthController test)

- [ ] **Step 1: Failing tests**

Test each new mapping at the controller level:

```elixir
test "POST /auth/login returns 429 on :client_cap_exceeded", %{conn: conn} do
  # Pre-populate a session with same client_id to trip the cap
  # ... fixture setup ...

  conn =
    conn
    |> put_req_header("x-grappa-client-id", "saturated")
    |> post(~p"/auth/login", %{"identifier" => "newnick"})

  assert json_response(conn, 429) == %{"error" => "too_many_sessions"}
end

# Similar tests for :network_cap_exceeded (503 network_busy),
# :network_circuit_open (503 network_unreachable + Retry-After),
# :captcha_required (400 captcha_required + site_key),
# :captcha_failed (400 captcha_failed),
# :captcha_provider_unavailable (503 service_degraded).
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Add clauses to FallbackController**

In `lib/grappa_web/controllers/fallback_controller.ex`, update the `@spec` for `call/2` to include the new atoms, then add clauses:

```elixir
def call(conn, {:error, :client_cap_exceeded}) do
  conn
  |> put_status(:too_many_requests)
  |> json(%{error: "too_many_sessions"})
end

def call(conn, {:error, :network_cap_exceeded}) do
  conn
  |> put_status(:service_unavailable)
  |> json(%{error: "network_busy"})
end

def call(conn, {:error, :network_circuit_open}) do
  conn
  |> put_status(:service_unavailable)
  |> json(%{error: "network_unreachable"})
end

def call(conn, {:error, {:network_circuit_open, retry_after}}) when is_integer(retry_after) do
  conn
  |> put_resp_header("retry-after", to_string(retry_after))
  |> put_status(:service_unavailable)
  |> json(%{error: "network_unreachable"})
end

def call(conn, {:error, :captcha_required}) do
  site_key = Application.get_env(:grappa, :admission, []) |> Keyword.get(:captcha_site_key)

  conn
  |> put_status(:bad_request)
  |> json(%{error: "captcha_required", site_key: site_key})
end

def call(conn, {:error, :captcha_failed}) do
  conn
  |> put_status(:bad_request)
  |> json(%{error: "captcha_failed"})
end

def call(conn, {:error, :captcha_provider_unavailable}) do
  conn
  |> put_status(:service_unavailable)
  |> json(%{error: "service_degraded"})
end
```

NOTE: The `:network_circuit_open` clause is a tuple-shape `{atom, retry_after}` for the Retry-After header path; non-tuple bare atom defaults without the header. This requires `Visitors.Login` to plumb `retry_after_seconds` from `Admission.NetworkCircuit.check/1`'s `{:error, :open, secs}` shape — update Login's error shape accordingly.

(Alternative: have `Admission.check_capacity/1` always return the tuple shape `{:network_circuit_open, retry_after}`. Cleaner. Adjust Plan 1's verb shape OR update at integration.)

For Plan 2, choose the cleaner path: update `Admission.check_capacity/1`'s return type to:

```elixir
@type capacity_error ::
        :client_cap_exceeded
        | :network_cap_exceeded
        | {:network_circuit_open, non_neg_integer()}
```

This requires a touch-up to `lib/grappa/admission.ex` — no test break since Plan 1's tests didn't pin the exact shape.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
feat(t31): FallbackController maps 6 admission error atoms to HTTP

429 too_many_sessions      ← :client_cap_exceeded
503 network_busy           ← :network_cap_exceeded
503 network_unreachable    ← {:network_circuit_open, retry_after}  + Retry-After header
400 captcha_required       ← :captcha_required (carries site_key)
400 captcha_failed         ← :captcha_failed
503 service_degraded       ← :captcha_provider_unavailable

Wire-string convention preserved (snake_case stringification of atom);
no new envelope shape introduced.

Plan 2 of 2.
```

## Task 6 — `AuthController` + `AuthJSON` integration

**Files:**
- Modify: `lib/grappa_web/controllers/auth_controller.ex`
- Modify: `lib/grappa_web/controllers/auth_json.ex`

- [ ] **Step 1: Failing test** — extend AuthController test for captcha_required wire shape, ensuring `site_key` is present in 400 response.

- [ ] **Step 2: Update `auth_controller.ex`'s `visitor_login/3`** to thread `client_id` + `captcha_token` from conn assigns + body params into `Login.login/2`'s input map:

```elixir
input = %{
  nick: nick,
  password: password,
  ip: format_remote_ip(conn.remote_ip),
  user_agent: get_req_header(conn, "user-agent") |> List.first(),
  token: extract_bearer(conn),
  captcha_token: Map.get(params, "captcha_token"),
  client_id: conn.assigns[:current_client_id]
}
```

(`params` is the controller action's input; if the existing controller doesn't pass `params` through, refactor to do so.)

- [ ] **Step 3: Update `AuthJSON`** — no new render needed; FallbackController owns the captcha-required envelope. AuthJSON unchanged.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
feat(t31): AuthController threads client_id + captcha_token into Login

client_id read from :current_client_id conn assign (Plug from Task 2).
captcha_token read from request body (cicchetto sends after widget
solve). Both pass through to Visitors.Login as part of the input map.

Plan 2 of 2.
```

## Task 7 — User logout terminates Session.Server (symmetric with visitor)

**Scope-A** addition (vjt-confirmed in CP11 S21 brainstorm, post-Plan-1 LANDED). Mirror visitor logout pattern shipped in `b809953` (`feat(auth): visitor logout terminates Session.Server + W11 anon-purge`) for user sessions. Currently `AuthController.logout/2` revokes the `accounts_sessions` row but DOES NOT stop running user `Session.Server` processes — the upstream IRC connection survives logout. Symmetry with the visitor flow demands stop.

User identity is persistent (no analog to W11 anon-purge); only the live IRC connection terminates. Re-login spawns a fresh `Session.Server` from the user's `Networks.Credential` rows on next operator-initiated start OR Bootstrap restart. A user-facing "reconnect after logout without re-binding" verb is out of T31 scope (see memory pin `project_t32_disconnect_verb` for the related but distinct disconnect verb).

**Files:**
- Modify: `lib/grappa_web/controllers/auth_controller.ex`
- Modify: `test/grappa_web/controllers/auth_controller_test.exs`

- [ ] **Step 1: Failing test**

Add to `test/grappa_web/controllers/auth_controller_test.exs` (sibling to existing visitor-logout coverage). The exact fixture/spawn verbs depend on what already exists in `test/support/auth_fixtures.ex` and the user-side cold-start path; implementer subagent greps `Bootstrap.spawn_one/2` for the production user-spawn shape and mirrors it in the test:

```elixir
test "user logout terminates all running Session.Server processes for that user", %{conn: conn} do
  user = Grappa.AuthFixtures.user_fixture()
  network = Grappa.AuthFixtures.network_with_server()
  # Bind credential + spawn Session.Server matching the production cold-start path
  # (mirror Bootstrap.spawn_one/2 verbs, NOT a test-only shortcut).
  ...
  pid = ... # the spawned Session.Server pid
  ref = Process.monitor(pid)

  {:ok, session} = Grappa.Accounts.create_session({:user, user.id}, "1.2.3.4", nil)

  conn =
    conn
    |> put_req_header("authorization", "Bearer " <> session.id)
    |> delete(~p"/auth/logout")

  assert response(conn, 204) == ""

  # Session.Server stopped
  assert_receive {:DOWN, ^ref, :process, ^pid, _reason}, 5_000

  # Registry entry gone
  assert Registry.lookup(Grappa.SessionRegistry, {{:user, user.id}, network.id}) == []
end

test "user logout with multiple bindings stops all of them", %{conn: conn} do
  # Same shape, two networks bound; assert both Session.Server pids stopped.
  ...
end
```

- [ ] **Step 2: Run, expect FAIL**

```bash
scripts/mix.sh test test/grappa_web/controllers/auth_controller_test.exs --warnings-as-errors
```

- [ ] **Step 3: Extend logout to user case**

In `lib/grappa_web/controllers/auth_controller.ex`, generalize the visitor-only path. Rename `maybe_terminate_visitor/1` to `maybe_terminate_sessions/1` and add a clause for the user-tagged subject. The exact assign shape (`:current_user` vs `:current_subject`) is whatever `Plugs.Authn` produces for the user branch — implementer subagent reads `lib/grappa_web/plugs/authn.ex` first and picks the matching clause head.

```elixir
@spec logout(Plug.Conn.t(), map()) :: Plug.Conn.t()
def logout(conn, _) do
  :ok = maybe_terminate_sessions(conn.assigns)
  :ok = Accounts.revoke_session(conn.assigns.current_session_id)
  send_resp(conn, :no_content, "")
end

@spec maybe_terminate_sessions(map()) :: :ok
defp maybe_terminate_sessions(%{current_visitor: %Visitor{} = visitor}) do
  :ok = stop_visitor_session(visitor)
  :ok = Visitors.purge_if_anon(visitor.id)
end

# Match whatever Plugs.Authn assigns for the user case. If it assigns
# {:user, id} as :current_subject:
defp maybe_terminate_sessions(%{current_subject: {:user, user_id}}) do
  :ok = stop_all_user_sessions(user_id)
end

defp maybe_terminate_sessions(_), do: :ok

@spec stop_all_user_sessions(integer()) :: :ok
defp stop_all_user_sessions(user_id) do
  # Enumerate all (network_id) currently bound to a live Session.Server
  # for this user via Registry.select on the {{:user, user_id}, network_id}
  # key shape (Plan 1 Task 8 lineage). Implementer subagent confirms the
  # exact key shape against Session.start_session/3 + the existing
  # Visitors.list_active code path before picking the match spec.
  pattern = {{{:user, user_id}, :"$1"}, :_, :_}
  Grappa.SessionRegistry
  |> Registry.select([{pattern, [], [:"$1"]}])
  |> Enum.each(fn network_id ->
    :ok = Grappa.Session.stop_session({:user, user_id}, network_id)
  end)
  :ok
end
```

Order matters (mirrors visitor pattern): stop the `Session.Server` BEFORE revoking the `accounts_sessions` row so the GenServer's `terminate/2` can drain its mailbox cleanly. No analog to `Visitors.purge_if_anon/1` — user identities are persistent.

- [ ] **Step 4: Run, expect PASS**

```bash
scripts/mix.sh test test/grappa_web/controllers/auth_controller_test.exs --warnings-as-errors
```

- [ ] **Step 5: Commit**

```bash
feat(t31): user logout terminates Session.Server processes (symmetric)

Mirror b809953 (visitor logout) for user sessions. AuthController.logout/2
now scans the Grappa.SessionRegistry for all {{:user, id}, network_id}
entries and stops each Session.Server before revoking the access token.
User identity is persistent (no analog to W11 anon-purge — that branch
is visitor-only); only the live IRC connection terminates. Re-login or
next Bootstrap restart respawns from the user's Networks.Credential
rows.

Closes the post-T30 logout-symmetry gap surfaced when designing T31's
admission gates. vjt option (ii) confirmed in CP11 S21 brainstorm.

Plan 2 of 2.
```

## Task 8 — Captcha `Turnstile` impl

**Files:**
- Create: `lib/grappa/admission/captcha/turnstile.ex`
- Create: `test/grappa/admission/captcha/turnstile_test.exs`

Turnstile spec: `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` with form-encoded `{secret, response, remoteip}`. Returns JSON `{success: bool, "error-codes": [...]}`.

- [ ] **Step 1: Bypass-driven test**

```elixir
defmodule Grappa.Admission.Captcha.TurnstileTest do
  use ExUnit.Case, async: true

  alias Grappa.Admission.Captcha.Turnstile

  setup do
    bypass = Bypass.open()
    Application.put_env(:grappa, :admission,
      Application.get_env(:grappa, :admission)
      |> Keyword.put(:captcha_secret, "test-secret")
      |> Keyword.put(:turnstile_endpoint, "http://localhost:#{bypass.port}/siteverify"))

    {:ok, bypass: bypass}
  end

  test "returns :ok on success: true", %{bypass: bypass} do
    Bypass.expect_once(bypass, "POST", "/siteverify", fn conn ->
      conn |> Plug.Conn.put_resp_content_type("application/json") |> Plug.Conn.resp(200, ~s({"success":true}))
    end)

    assert :ok = Turnstile.verify("real-token", "1.2.3.4")
  end

  test "returns :captcha_failed on success: false", %{bypass: bypass} do
    Bypass.expect_once(bypass, "POST", "/siteverify", fn conn ->
      Plug.Conn.resp(conn, 200, ~s({"success":false,"error-codes":["timeout-or-duplicate"]}))
    end)

    assert {:error, :captcha_failed} = Turnstile.verify("expired-token", "1.2.3.4")
  end

  test "returns :captcha_required on nil token" do
    assert {:error, :captcha_required} = Turnstile.verify(nil, "1.2.3.4")
  end

  test "returns :captcha_provider_unavailable on 5xx", %{bypass: bypass} do
    Bypass.expect_once(bypass, fn conn -> Plug.Conn.resp(conn, 500, "") end)
    assert {:error, :captcha_provider_unavailable} = Turnstile.verify("token", "1.2.3.4")
  end

  test "returns :captcha_provider_unavailable on connect failure", %{bypass: bypass} do
    Bypass.down(bypass)
    assert {:error, :captcha_provider_unavailable} = Turnstile.verify("token", "1.2.3.4")
  end
end
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

```elixir
defmodule Grappa.Admission.Captcha.Turnstile do
  @moduledoc """
  Cloudflare Turnstile captcha verify impl.

  Endpoint: https://challenges.cloudflare.com/turnstile/v0/siteverify
  Expected form-encoded body: secret + response + remoteip.
  """
  @behaviour Grappa.Admission.Captcha

  @endpoint_default "https://challenges.cloudflare.com/turnstile/v0/siteverify"
  @timeout_ms 5_000

  @impl Grappa.Admission.Captcha
  def verify(nil, _ip), do: {:error, :captcha_required}
  def verify("", _ip), do: {:error, :captcha_required}

  def verify(token, ip) when is_binary(token) do
    config = Application.get_env(:grappa, :admission, [])
    secret = Keyword.fetch!(config, :captcha_secret)
    endpoint = Keyword.get(config, :turnstile_endpoint, @endpoint_default)

    body = URI.encode_query(%{secret: secret, response: token, remoteip: ip || ""})
    headers = [{"content-type", "application/x-www-form-urlencoded"}]

    case Req.post(endpoint, body: body, headers: headers, receive_timeout: @timeout_ms) do
      {:ok, %{status: 200, body: %{"success" => true}}} -> :ok
      {:ok, %{status: 200, body: %{"success" => false}}} -> {:error, :captcha_failed}
      {:ok, %{status: status}} when status >= 500 -> {:error, :captcha_provider_unavailable}
      {:ok, %{status: _}} -> {:error, :captcha_failed}
      {:error, _} -> {:error, :captcha_provider_unavailable}
    end
  end
end
```

NOTE: requires `Req` HTTP client lib. Check `mix.exs` — if not present, add `{:req, "~> 0.5"}` and run `scripts/mix.sh deps.get`. (Alternative: `Tesla` if already a dep.) Run `grep -E '\{:req|\{:tesla' /srv/grappa/mix.exs` to check current state.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
feat(t31): Captcha.Turnstile — Cloudflare Turnstile verify impl

POST to challenges.cloudflare.com/turnstile/v0/siteverify with
form-encoded {secret, response, remoteip}. Tagged-error mapping per
Captcha behaviour contract. Bypass-driven tests for all 5 paths
(success, failed, required, provider-5xx, connect-fail).

Plan 2 of 2.
```

## Task 9 — Captcha `HCaptcha` impl

Mirror Task 8's shape for hCaptcha. Endpoint: `https://hcaptcha.com/siteverify`. Same form-encoded contract. Same return shapes.

Files: `lib/grappa/admission/captcha/h_captcha.ex` + `test/grappa/admission/captcha/h_captcha_test.exs`. Tests + impl track Task 8 line-for-line, swapping endpoint + module name.

Commit message: `feat(t31): Captcha.HCaptcha — hCaptcha verify impl`.

## Task 10 — `CaptchaMock` for Mox + integration tests

**Files:**
- Create: `test/support/captcha_mock.ex`

```elixir
Mox.defmock(Grappa.Admission.CaptchaMock, for: Grappa.Admission.Captcha)
```

Wire into `test/test_helper.exs`:

```elixir
Mox.defmock(Grappa.Admission.CaptchaMock, for: Grappa.Admission.Captcha)
```

Tests that exercise the captcha-required → captcha-passed flow swap config to `Grappa.Admission.CaptchaMock` per-test.

Commit: `feat(t31): CaptchaMock for Mox-driven Login captcha tests`.

## Task 11 — Telemetry events

**Files:**
- Create: `lib/grappa/admission/telemetry.ex`
- Modify: `lib/grappa/admission/network_circuit.ex` (emit on transitions)
- Modify: `lib/grappa/admission.ex` (emit on capacity rejection)

Events:

```
[:grappa, :admission, :circuit, :open]    %{network_id, threshold, cooldown_ms}
[:grappa, :admission, :circuit, :close]   %{network_id, reason: :success | :cooldown_expired}
[:grappa, :admission, :capacity, :reject] %{flow, error, network_id, client_id}
```

Used by Phase 5's PromEx exporter (deferred); for now just `:telemetry.execute/3` calls. Tests assert events fire via `:telemetry.attach/4` capture pattern.

Commit: `feat(t31): admission telemetry — circuit transitions + capacity rejections`.

## Task 12 — cicchetto `client_id` generation

**Files:**
- Create: `cicchetto/src/lib/clientId.ts`
- Create: `cicchetto/src/__tests__/clientId.test.ts`
- Modify: `cicchetto/src/lib/api.ts`

- [ ] **Step 1: Failing vitest**

```typescript
// clientId.test.ts
import { describe, expect, test, beforeEach, vi } from "vitest";
import { getOrCreateClientId } from "../lib/clientId";

describe("getOrCreateClientId", () => {
  beforeEach(() => localStorage.clear());

  test("generates UUID v4 on first call", () => {
    const id = getOrCreateClientId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("returns same value on subsequent calls", () => {
    const id1 = getOrCreateClientId();
    const id2 = getOrCreateClientId();
    expect(id1).toBe(id2);
  });

  test("regenerates if localStorage cleared", () => {
    const id1 = getOrCreateClientId();
    localStorage.clear();
    const id2 = getOrCreateClientId();
    expect(id1).not.toBe(id2);
  });
});
```

- [ ] **Step 2: Implementation**

```typescript
// clientId.ts
const STORAGE_KEY = "grappa.client_id";

export function getOrCreateClientId(): string {
  const existing = localStorage.getItem(STORAGE_KEY);
  if (existing) return existing;

  const fresh = crypto.randomUUID();
  localStorage.setItem(STORAGE_KEY, fresh);
  return fresh;
}
```

- [ ] **Step 3: Wire into `api.ts`** — every fetch call adds `X-Grappa-Client-Id`:

```typescript
import { getOrCreateClientId } from "./clientId";

function buildHeaders(token?: string): HeadersInit {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-grappa-client-id": getOrCreateClientId()
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}
```

(Replace ad-hoc header construction across api.ts callsites with `buildHeaders(token)`.)

- [ ] **Step 4: Run vitest**

```bash
cd cicchetto && npm test
```

- [ ] **Step 5: Commit**

```bash
feat(t31): cicchetto generates + sends X-Grappa-Client-Id

UUID v4 via crypto.randomUUID, persisted in localStorage under
grappa.client_id. Stable across reloads, regenerates only on cookie/
storage clear. Sent on every authenticated fetch via api.ts's
buildHeaders helper.

Plan 2 of 2.
```

## Task 13 — cicchetto error rendering + captcha widget

**Files:**
- Create: `cicchetto/src/lib/captcha.ts` (Turnstile/hCaptcha widget loader)
- Modify: `cicchetto/src/Login.tsx` (handle captcha_required + render widget)
- Modify: `cicchetto/src/lib/api.ts` (typed error shapes for new wire bodies)

Add types to `api.ts`:

```typescript
export type AdmissionError =
  | { error: "too_many_sessions" }
  | { error: "network_busy" }
  | { error: "network_unreachable"; retry_after?: number }
  | { error: "captcha_required"; site_key: string }
  | { error: "captcha_failed" }
  | { error: "service_degraded" };
```

`Login.tsx`: on `captcha_required` response, lazy-load the widget script (Turnstile: `https://challenges.cloudflare.com/turnstile/v0/api.js`; hCaptcha: `https://js.hcaptcha.com/1/api.js`), mount widget with the `site_key`, on solve callback re-submit Login with `captcha_token`.

User-facing copy for each error:
- `too_many_sessions` → "You're already connected to this network from another device or tab. Close one before opening a new session."
- `network_busy` → "This network is at capacity. Try again in a few minutes."
- `network_unreachable` → "We can't reach the network right now. Retry in N seconds." (use `retry_after`)
- `service_degraded` → "Login service temporarily unavailable. Please try again."

Commit: `feat(t31): cicchetto handles captcha_required + admission errors`.

## Task 14 — Final integration + e2e + deploy

- [ ] **Step 1: Full check**

```bash
scripts/check.sh
scripts/dialyzer.sh
```

Standalone `scripts/dialyzer.sh` is required in addition to `check.sh` per memory pin `feedback_dialyzer_plt_staleness` — cluster-runs can mask warnings under PLT staleness. Both must be green.

- [ ] **Step 2: Rebase + ff-merge to main (NO push yet)**

```bash
git rebase main
cd /srv/grappa
git merge --ff-only cluster/t31-integration
scripts/check.sh
```

DO NOT `git push` here. Push is gated on the e2e matrix at Step 6 + vjt explicit ask. `scripts/deploy.sh` reads from `/srv/grappa` (main), not origin, so the deploy can proceed without an origin push.

- [ ] **Step 3: Pre-deploy operator-bind — `azzurra max_concurrent_sessions=3`**

The 4-tab cap-proof e2e check at Step 5 needs a non-nil `max_concurrent_sessions` cap to trigger against. Plan 1 added the column (default `nil` = uncapped); Plan 2 needs an operator verb to populate it.

Sibling decides the verb name — candidates:
  * Extend `mix grappa.bind_network` with `--max-sessions N` flag.
  * New `mix grappa.set_network_caps --slug azzurra --max-sessions 3 --max-per-client 1`.
  * Reuse `mix grappa.update_network_credential` (already exists per `lib/grappa/mix/tasks/grappa.update_network_credential.ex`) if it can be extended cleanly to network-level (not credential-level) updates — likely wrong fit since current verb is per-credential.

Recommended: new dedicated `mix grappa.set_network_caps` task. Single-purpose, doesn't bloat existing verbs, easy to discover in `--help`. Document chosen verb in DESIGN_NOTES at T31 closing.

After bind, verify:

```bash
scripts/db.sh "SELECT slug, max_concurrent_sessions, max_per_client FROM networks;"
```

The row for `azzurra` must show `max_concurrent_sessions=3` (and `max_per_client` per whatever Plan 2 default makes sense — likely `1` to enforce one session per cicchetto client).

- [ ] **Step 4: Deploy + healthcheck**

```bash
scripts/deploy.sh
scripts/healthcheck.sh
```

- [ ] **Step 5: E2e validation matrix — REAL BROWSER, hard gate**

Plan 1 verbs are inert until Plan 2 wires consumers; the deploy step is the FIRST test of the entire admission stack in prod conditions. Inspection of unit tests + curl-only e2e is INSUFFICIENT. Use real browser automation — `chrome-devtools-mcp` plugin (already configured — see `mcp__plugin_chrome-devtools-mcp_chrome-devtools__*` tools) or equivalent — pointing at the live deployment.

RED at any row = HALT, fix root cause, re-run from the failed row. Do NOT push to origin, do NOT proceed to LANDED status.

**API-level matrix (curl-runnable for fast feedback):**

| step | expected |
|---|---|
| `POST /auth/login` (fresh anon, captcha disabled) | 200 (when `captcha_provider: Disabled`) |
| `POST /auth/login` from same client_id, second nick | 429 `too_many_sessions` (per-client cap=1) |
| Set `networks.max_concurrent_sessions=0`, login | 503 `network_busy` |
| Trigger circuit (`threshold` fails in window), login | 503 `network_unreachable` + `Retry-After` header |
| Captcha provider misconfigured (bad secret), login | 400 `captcha_required`, then 400 `captcha_failed` after fake-token submit |

**Browser-flow matrix (chrome-devtools-mcp / real browser, MANDATORY):**

| step | expected |
|---|---|
| Fresh visitor login → Cloudflare Turnstile widget renders | widget paints in cicchetto Login page; site key `0x4AAAAAADIVjqhMXybemB6v` (public, registered for `grappa.bad.ass`, mode `Managed`) |
| Captcha solves + login proceeds | Turnstile auto-solves for registered host in most cases; if interactive challenge appears, screenshot + flag but proceed if it auto-solves |
| Networks sidebar populates after login | post-spawn + 001 RPL_WELCOME, cicchetto network panel shows the bound network (e.g. azzurra) |
| Phoenix Channels round-trip | open a channel join, send PRIVMSG, verify echo + a fake inbound (drive a second IRC client to PRIVMSG the test nick) |
| 4-tab cap-proof | open 3 browser tabs (same client_id via shared localStorage), all 3 logins succeed (cap=3, set in pre-deploy operator-bind step). Open a 4th tab → admission rejects with 429 `too_many_sessions` and cicchetto error renderer shows the rejection. Verify `Registry.count_match(Grappa.SessionRegistry, {{:_, azzurra_id}, :_}, [], [true])` stays ≤3 throughout via `scripts/observer.sh` or a debug HTTP endpoint. The 4th attempt's rejection MUST come from `Admission.check_capacity/1` in the actual prod container, not from a unit test. |
| `X-Grappa-Client-Id` header present | cicchetto fresh load → Network tab → header sent on every authenticated request, valid UUID v4 |
| Two tabs share client_id | with cap=1, second tab's login → 429 |

If the cap-proof check requires a debug endpoint to read the registry count, build it via `Phoenix.LiveDashboard` or a controller in `GrappaWeb` — per CLAUDE.md "Debugging tools are infrastructure": HTTP endpoint over throwaway IEx script. Never substitute "I checked observer_cli interactively and it looked right" for a verifiable measurement.

The browser-flow matrix is a HARD GATE: every row must be green (with screenshot or live-DOM evidence pasted into the close-out) before LANDED status. Push to origin is gated on completion (see Step 6 below).

- [ ] **Step 6: Push to origin (gated on vjt explicit ask)**

After every row of the e2e matrix is green, surface the green matrix to vjt and WAIT for the push instruction. Do NOT auto-push at e2e-green. main is currently 29 commits ahead of origin (Plan 1 deferred its push per session contract); Plan 2 ships the combined push at this gate.

```bash
git push    # only after vjt explicit ask
```

If anything in the matrix is red or partially observed, push is forbidden — fix root cause + re-run the matrix from the failed row.

- [ ] **Step 7: Worktree cleanup + checkpoint update**

```bash
git worktree remove ../grappa-task-t31-integration
git branch -d cluster/t31-integration
```

Update CP11 (or open CP12) with T31 LANDED entry. Update memory pin `project_t31_admission_control` to LANDED status with completion date + commit refs. Update DESIGN_NOTES with T31 closing note (admission control + captcha + circuit-breaker as the FINAL post-S16 ops follow-up; NetworkCircuit lazy-expiry + window-vs-cooldown semantics per Plan 1 follow-up commit `8fdeaef`; chosen operator-bind verb name from Step 3).

## Plan 2 exit criteria

- [ ] All 14 tasks landed on `cluster/t31-integration`.
- [ ] `scripts/check.sh` green.
- [ ] Standalone `scripts/dialyzer.sh` green.
- [ ] cicchetto `npm test` green.
- [ ] Branch rebased + ff-merged to main.
- [ ] `scripts/deploy.sh` succeeded; `scripts/healthcheck.sh` green.
- [ ] E2e matrix all passes verified at `http://192.168.53.11`.
- [ ] Origin pushed.
- [ ] CP entry written documenting Plan 2 LANDED + T31 closed.
- [ ] DESIGN_NOTES updated with T31 closing note (admission control + captcha + circuit-breaker as the FINAL post-S16 ops follow-up).
- [ ] Memory pin `project_t31_admission_control` updated to LANDED status with completion date + commit refs.

## Post-T31 state

- The `post_p4_1_arc` memory pin's "anti-abuse hardening" leg of the cluster work is closed.
- W3 (`max_visitors_per_ip`) is retired in favor of T31's per-`(client_id, network_id)` cap. Memory pin or DESIGN_NOTES entry documents the supersession.
- Phase 5 hardening backlog gains: PromEx exporter for `[:grappa, :admission, :*]` events; HSM-keyed Vault for captcha secrets (currently env-var); per-network override knob on `block_datacenter_ips` (deferred from T31 brainstorm) IF abuse data shows we need it.
- Login probe-connect timeout configurable; Backoff + NetworkCircuit cleanly separated by keying (per-`(subject, network)` vs per-`network`); Bootstrap respects upstream capacity at cold-start.
- **Partial index on `sessions.client_id`** — Plan 1 Task 1 ships a plain `create index(:sessions, [:client_id])`. Code-quality review flagged this as a candidate for a partial index (`where: "client_id IS NOT NULL"`): until cicchetto rolls out, most rows are NULL, so a partial index is ~100x denser and the query pattern (`WHERE client_id = ? AND ...`) never reads the NULL bucket. Non-blocking optimization; defer until row count justifies (target: revisit once `accounts_sessions` row count crosses ~50k). When picked up: new migration `priv/repo/migrations/<ts>_partial_client_id_index.exs` drops the plain index and recreates with the `where:` clause — sqlite supports partial indices natively.
- **DB-level CHECK constraints on `networks.max_concurrent_sessions` + `max_per_client`** — Plan 1 Task 2 ships plain nullable INTEGER columns; Plan 1 Task 4 adds `validate_number greater_than: 0` at the changeset layer. Code-quality review flagged that a CHECK constraint (`max_concurrent_sessions IS NULL OR max_concurrent_sessions > 0`, same for `max_per_client`) would defend against direct-SQL operator mistakes + future code paths that bypass the changeset. Non-blocking; the changeset is the canonical boundary per CLAUDE.md "Ecto.Changeset for ALL user input." Defer until either the operator footgun materializes or a non-Ecto write path appears. When picked up: new migration `priv/repo/migrations/<ts>_check_networks_caps_positive.exs` adds the constraints via raw `execute/1` since Ecto.Migration's column-level constraint syntax is dialect-fragile on ecto_sqlite3.
- **Network changeset test name tightening** — Plan 1 Task 4 ships `test "rejects negative max_per_client"` whose body actually exercises `0` (per spec verbatim, since `validate_number greater_than: 0` rejects both 0 and negatives with the same message). Cosmetic: rename to `"rejects zero or negative max_per_client"` and/or add a sibling test for true negatives. Zero-value reproduction is the more-likely operator typo, so keep the existing assertion shape. Pure rename, no behavior change.
- **NetworkCircuit cosmetic test polish** — Plan 1 Task 7 ships 5 tests for the math + readers. Code-quality review flagged two non-blocking gaps: (a) no explicit test for `compute_cooldown(0, jitter_pct)` (the if-zero short-circuit currently relies on the more general jitter window test to imply correctness for zero base); (b) no inline comment in the test `setup` block explaining the `start_supervised!` + `on_exit` + `:ets.delete_all_objects` cleanup contract for the named-singleton ETS table. Both pure cosmetics; defer to whenever the file is next touched.
- **NetworkCircuit semantics — DESIGN_NOTES entry at T31 closing** — Plan 1 Task 8 ships two intentional but non-obvious behaviours that should land in `docs/DESIGN_NOTES.md` when T31 closes (Plan 2 final commit): (a) **Lazy expiry**: when an `:open` row's `cooled_at_ms` elapses, `check/1` returns `:ok` but the ETS row stays `:open` — only `record_failure/1` (which re-evaluates window/threshold) or `record_success/1` (which deletes the row) physically transition it. Tradeoff: hot-path read does no mutation. (b) **Window-vs-cooldown independence**: a failure arriving outside `window_ms` resets count to 1 and circuit_state to `:closed`, even if `cooled_at_ms` hasn't elapsed yet. Treats the old failure burst as stale; rare path under prod settings (window 60s vs cooldown 5min) but possible.
- **Reviewer-template upgrade — gates must be RUN, not asserted** — Plan 1 Task 6 + Task 7 surfaced a recurring failure mode of the `subagent-driven-development` two-stage review: code-quality reviewer subagents claimed `Format / Credo / Dialyzer ✓` based on inspection alone, without invoking `scripts/credo.sh` or `scripts/dialyzer.sh`. Both claims turned out false: Task 6 had 2 credo `Consistency.UnusedVariableNames` findings on `Captcha.Disabled.verify(_token, _ip)` (fixed in commit 9b31d77 on cluster/t31-infra); Task 7 had 4 dialyzer `missing_range`/`contract_supertype` warnings on `NetworkCircuit` reader specs + `compute_cooldown/2` (fixed in commit 930482a). Memory pin `feedback_dialyzer_plt_staleness` already calls out cluster-runs masking dialyzer issues — same lesson on the reviewer side. Action: amend the local `.claude/skills` reviewer prompts (or our internal subagent dispatch wrappers) to REQUIRE pasting the last-N-lines output of `scripts/format.sh --check`, `scripts/credo.sh`, and `scripts/dialyzer.sh` as evidence in the review, with explicit "I ran X, here is the tail" framing. Inspection-only gate claims are forbidden. This is a process change, not a code change — append to the Plan 2 close-out checklist alongside the DESIGN_NOTES entry.

T31 closes the post-Phase-4 ops follow-up cluster. Next clusters per `post_p4_1_arc`: text-polish, M2 NickServ-IDP, anon-webirc(+48h sliding scrollback), P4-V.
