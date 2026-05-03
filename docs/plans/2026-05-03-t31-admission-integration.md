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

- [ ] **Step 2: Run, expect FAIL**: `scripts/test.sh test/grappa/session/backoff_test.exs`

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

- [ ] **Step 4: Run, expect PASS**: `scripts/test.sh test/grappa/session/backoff_test.exs`

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
    # Pin the per-(client, network) cap at 1 via the network's
    # max_per_client column (the operator's knob — Plan 1 schema).
    # Application.put_env on :default_max_per_client_per_network is
    # NOT effective here: Admission reads that key as
    # Application.compile_env, so the test-env value (10) is baked in
    # at compile time. The per-network override IS read at runtime via
    # Repo.get(Network, id), so it's the right test seam.
    {:ok, net} =
      net
      |> Grappa.Networks.Network.changeset(%{max_per_client: 1})
      |> Grappa.Repo.update()

    # Seed one existing visitor + accounts_sessions row for client_id
    # "device-a" on this network. Use direct fixture verbs, not
    # Login.login, to avoid spinning a real Session.Server in the
    # capacity-only test (the spawn path is exercised in other tests).
    {:ok, existing_visitor} =
      Grappa.Visitors.find_or_provision_anon("old_user", net.slug, "1.2.3.4")

    {:ok, _session} =
      Grappa.Accounts.create_session(
        {:visitor, existing_visitor.id},
        "1.2.3.4",
        nil,
        client_id: "device-a"
      )

    # Second login attempt from same client_id on same network should
    # fail at the admission gate, before any spawn attempt.
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
scripts/test.sh test/grappa/visitors/login_test.exs
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

## Task 3.5 — Fix `Admission.count_live_sessions/1` registry-key match-spec

**Why this exists (plan-fix-first, surfaced during Task 4 implementation):**

`Grappa.Admission.count_live_sessions/1` (Plan 1 Task 6) used a match-spec
head `{{:_, network_id}, :_, :_}` — a **2-tuple registry key**. But
`Grappa.Session.Server.registry_key/2` (the canonical production registrar
since Plan 1 Task 6's `Server.via/2`) returns a **3-tuple**
`{:session, subject, network_id}`. The match-spec therefore never matches
real production entries; `count_live_sessions/1` always returns 0;
`check_network_total/1` never trips. The two existing tests that supposedly
exercise the cap (`test/grappa/admission_test.exs` "exceeded →
:network_cap_exceeded" and `test/grappa/visitors/login_test.exs`
"network_cap_exceeded → ...") only "pass" because they pre-register
synthetic 2-tuple keys via raw `Registry.register/3`, bypassing
`Server.registry_key/2`. The match-spec asserts a buggy shape against a
buggy fixture — both wrong, mutually consistent. CLAUDE.md "Never assert
buggy behavior" is violated.

Task 4's contract (Bootstrap respects the per-network cap on cold-start)
cannot be made green without fixing this — the wiring is a no-op against
real sessions until `count_live_sessions/1` matches the production key
shape.

**Files:**
- Modify: `lib/grappa/admission.ex`
- Modify: `test/grappa/admission_test.exs`
- Modify: `test/grappa/visitors/login_test.exs`

- [ ] **Step 1: Read the canonical key shape**

`lib/grappa/session/server.ex` `registry_key/2`:

```elixir
@spec registry_key(Grappa.Session.subject(), integer()) ::
        {:session, Grappa.Session.subject(), integer()}
def registry_key(subject, network_id) when is_tuple(subject) and is_integer(network_id) do
  {:session, subject, network_id}
end
```

Every real production entry uses this 3-tuple. Fakes registered via raw
`Registry.register/3` MUST mirror this shape.

- [ ] **Step 2: Fix the match-spec in `lib/grappa/admission.ex`**

Replace:

```elixir
defp count_live_sessions(network_id) do
  # Registry keys are `{subject, network_id}` (subject = `{:user|:visitor, id}`).
  # Count entries with any subject matching this network_id. The match-spec
  # head `{{:_, network_id}, :_, :_}` literally interpolates network_id at
  # construction time — `:_` matches any subject; the integer matches itself.
  # `count_match/3` won't work here: its `key` arg is matched as a plain
  # Erlang term (`:_` is a literal atom inside a tuple, not a wildcard).
  Registry.count_select(Grappa.SessionRegistry, [
    {{{:_, network_id}, :_, :_}, [], [true]}
  ])
end
```

with:

```elixir
defp count_live_sessions(network_id) do
  # Registry keys are `{:session, subject, network_id}` per
  # `Grappa.Session.Server.registry_key/2`. Match-spec head literally
  # interpolates network_id at construction time — `:_` matches any
  # subject; the integer matches itself. `count_match/3` won't work
  # here: its `key` arg is matched as a plain Erlang term (`:_` is a
  # literal atom inside a tuple, not a wildcard).
  Registry.count_select(Grappa.SessionRegistry, [
    {{{:session, :_, network_id}, :_, :_}, [], [true]}
  ])
end
```

- [ ] **Step 3: Fix the existing test fixtures that encoded the bug**

In `test/grappa/admission_test.exs` "exceeded → :network_cap_exceeded"
(near line 65), replace the raw 2-tuple fake registration:

```elixir
{:ok, _} =
  Registry.register(
    Grappa.SessionRegistry,
    {{:visitor, "fake-vid"}, net.id},
    nil
  )
```

with the canonical 3-tuple shape sourced from `Server.registry_key/2`:

```elixir
{:ok, _} =
  Registry.register(
    Grappa.SessionRegistry,
    Grappa.Session.Server.registry_key({:visitor, "fake-vid"}, net.id),
    nil
  )
```

In `test/grappa/visitors/login_test.exs` "network_cap_exceeded →
{:error, :network_cap_exceeded}" (near line 290), apply the same
substitution. Both tests still assert the same outcome, but now the
fake keys match the production key shape and the match-spec actually
sees them — i.e. the production code path is exercised, not bypassed.

- [ ] **Step 4: Run, expect both targeted tests still PASS**

```bash
scripts/test.sh test/grappa/admission_test.exs
scripts/test.sh test/grappa/visitors/login_test.exs
```

- [ ] **Step 5: Run full check, expect green**

```bash
scripts/check.sh
scripts/dialyzer.sh   # standalone, per PLT-staleness pin
```

- [ ] **Step 6: Commit**

```bash
fix(t31): Admission.count_live_sessions registry-key match-spec

Production registers session keys as `{:session, subject, network_id}`
via `Server.registry_key/2`. The match-spec head used a stale 2-tuple
shape `{:_, network_id}` so it never matched real entries — the cap
never tripped. The two existing tests exercising the cap registered
2-tuple fakes and only "passed" because they bypassed the production
registrar. Both updated to register via `Server.registry_key/2`.

Surfaced during Plan 2 Task 4 implementation when the Bootstrap wiring
correctly called `check_capacity/1` but the cap test continued to fail
because `count_live_sessions/1` returned 0 against real session
entries. CLAUDE.md "Never assert buggy behavior" — the previous tests
encoded the bug and prevented anyone from finding it.

Plan 2 of 2 (Task 3.5, prereq for Task 4).
```

## Task 4 — `Bootstrap` network-total cap

**Files:**
- Modify: `lib/grappa/bootstrap.ex`
- Modify: `test/grappa/bootstrap_test.exs`

- [ ] **Step 1: Failing test**

In `test/grappa/bootstrap_test.exs`, add inside the existing test module
(matching the existing fixture conventions — `start_server/0` returns
`{server_pid, port}` for a fake IRC listener; `visitor_fixture/1` lives in
`Grappa.AuthFixtures` and is already imported; module-level Logger info
gating mirrors the file's other capture-log tests):

```elixir
describe "run/0 network total cap (T31)" do
  # Plan 2 Task 4 — Bootstrap respects per-network total session cap on
  # cold-start. If `networks.max_concurrent_sessions` is lower than the
  # number of credential/visitor rows pointing at that network, the
  # over-cap rows are skipped + warned. No queue, no retry — clean
  # skip-and-log per the Bootstrap moduledoc's best-effort contract.
  test "respawn skips visitors over network cap" do
    {_, port} = start_server()
    slug = "azzurra-#{System.unique_integer([:positive])}"
    {:ok, network} = Networks.find_or_create_network(%{slug: slug})

    {:ok, _} =
      Grappa.Networks.Servers.add_server(network, %{
        host: "127.0.0.1",
        port: port,
        tls: false
      })

    {:ok, network} =
      network
      |> Grappa.Networks.Network.changeset(%{max_concurrent_sessions: 1})
      |> Grappa.Repo.update()

    for n <- 1..3 do
      visitor_fixture(network_slug: slug, nick: "v#{n}#{System.unique_integer([:positive])}")
    end

    Logger.put_module_level(Grappa.Bootstrap, :info)
    on_exit(fn -> Logger.delete_module_level(Grappa.Bootstrap) end)

    log = capture_log(fn -> assert :ok = Bootstrap.run() end)

    on_exit(fn ->
      Registry.select(Grappa.SessionRegistry, [
        {{{:session, :"$1", network.id}, :"$2", :_}, [], [{{:"$1", :"$2"}}]}
      ])
      |> Enum.each(fn {_subject, pid} ->
        DynamicSupervisor.terminate_child(Grappa.SessionSupervisor, pid)
      end)
    end)

    started_count =
      Registry.select(Grappa.SessionRegistry, [
        {{{:session, :_, network.id}, :_, :_}, [], [true]}
      ])
      |> length()

    assert started_count <= 1
    assert log =~ "skipped — network cap"
  end
end
```

NB: the obvious-looking shorter form
`Grappa.AuthFixtures.network_with_server(slug: "azzurra")` does NOT
work — `network_with_server/1` requires `:port` (not optional) and
returns `{network, server}` (not `network`). Inline the
`find_or_create_network` + `add_server` pair instead, as above.

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

**Captcha site key plumbing** — read at compile time, NOT runtime.
CLAUDE.md: "`Application.{put,get}_env/2`: boot-time only, runtime banned —
neither read nor written from any GenServer callback, controller, plug
body, or release task." Add a module-attr at the top of
`fallback_controller.ex`:

```elixir
@captcha_site_key Application.compile_env(:grappa, [:admission, :captcha_site_key])
```

(Matches existing patterns: `Admission`'s `@default_max_per_client_per_network`
at line 66, `NetworkCircuit`'s `@window_secs` etc. at lines 64-66, and
`AuthController`'s `@visitor_network_slug` at line 36. The site key is an
operator-set value baked at image build time; runtime mutation is not a
requirement. `Admission.verify_captcha/2`'s runtime `get_env` for
`:captcha_provider` is the *single* documented exception, justified by
Mox-driven test ergonomics — the site key inherits no such exception.)

**FallbackController clauses** — update `@spec` for `call/2` to include the
new atoms, then add the 6 clauses below. NB: `Admission.check_capacity/1`
emits the `{:network_circuit_open, retry_after}` tuple ALWAYS (per the
return-type change in this task); the bare-atom `:network_circuit_open`
shape no longer occurs at runtime, so the bare-atom clause MUST NOT be
added. Including it would be dead code:

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

def call(conn, {:error, {:network_circuit_open, retry_after}}) when is_integer(retry_after) do
  conn
  |> put_resp_header("retry-after", to_string(retry_after))
  |> put_status(:service_unavailable)
  |> json(%{error: "network_unreachable"})
end

def call(conn, {:error, :captcha_required}) do
  conn
  |> put_status(:bad_request)
  |> json(%{error: "captcha_required", site_key: @captcha_site_key})
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

**Admission return-type change.** `Admission.check_capacity/1`'s
`:capacity_error` typespec MUST become:

```elixir
@type capacity_error ::
        :client_cap_exceeded
        | :network_cap_exceeded
        | {:network_circuit_open, non_neg_integer()}
```

`check_circuit/1` updates `{:error, :open, retry_after}` → `{:error,
{:network_circuit_open, retry_after}}` (tuple, was bare atom). This
cascades to every `:network_circuit_open` consumer — search
`grep -rn "network_circuit_open" lib/ test/` and adapt every pattern to
the tuple shape. No test break expected since Plan 1's tests pinned
through `assert {:error, :network_circuit_open} = ...` style; bump those
to `{:error, {:network_circuit_open, _}} = ...` (binding the retry value
or wildcarding it).

**AuthController `action_fallback` wiring + scope-bleed cleanup.**
Commit `a3b70e8` (Task 3 implementer) added inline error-clause mappings
in `AuthController.visitor_login/2` for the 6 atoms, with the WRONG
status-code split (blanket 429 for cap atoms, blanket 403 for captcha
atoms). It did NOT add `action_fallback`. Task 5 must:

  1. Add `action_fallback GrappaWeb.FallbackController` to AuthController.
  2. REMOVE the inline 429/403 error clauses from `visitor_login/2` (and
     any other action that received them) so the FallbackController
     clauses fire.
  3. Verify by running the AuthController test suite — the canonical
     status-code split should now apply: 429 too_many_sessions /
     503 network_busy / 503 network_unreachable+Retry-After /
     400 captcha_required+site_key / 400 captcha_failed /
     503 service_degraded.

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

## Task 6 — `AuthController` + `AuthJSON` integration + `ClientId` plug hoist

**Files:**
- Create: `lib/grappa_web/plugs/client_id.ex`
- Create: `test/grappa_web/plugs/client_id_test.exs`
- Modify: `lib/grappa_web/router.ex` (wire `ClientId` into `:api` pipeline)
- Modify: `lib/grappa_web/plugs/authn.ex` (drop inline `extract_client_id/1`;
  the assign now arrives pre-populated from the upstream `:api` pipeline)
- Modify: `lib/grappa_web/controllers/auth_controller.ex` (drop inline
  `extract_client_id/1`; read `conn.assigns.current_client_id`)
- Modify: `test/grappa_web/controllers/auth_controller_test.exs`
- Modify: `test/grappa_web/plugs/authn_test.exs` (Authn no longer owns
  client_id extraction; assert on the assign produced by the upstream
  `ClientId` plug instead of header → assign within Authn)

### Status of plan-original Step 2 (Login input map threading)

Tasks 3 (`a3b70e8`) + 5 (`1b26a1f`) ALREADY implemented the Login input map
threading + duplicated `extract_client_id/1` inline in `AuthController`
because `/auth/login` is NOT behind `:authn`. Task 6's net new work is:

  1. Add the missing captcha_required wire-shape integration test
     against `AuthController` (plan Step 1).
  2. Hoist `extract_client_id/1` out of both `Plugs.Authn` AND
     `AuthController` into a new `Plugs.ClientId` plug at the `:api`
     pipeline (Option A from sibling decision; alternative Option B was a
     shared `Grappa.Auth.ClientId` helper module called by both — rejected
     because cross-cutting request enrichment via plug is the idiomatic
     Phoenix path and `:api` is the highest pipeline shared by `/auth/login`
     + every authenticated route, so a single plug invocation covers both
     surfaces with zero duplication).
  3. Verify plan Step 2's Login input map shape matches what `visitor_login/3`
     actually does post-hoist (the `conn.assigns[:current_client_id]` reading
     stays; the inline extraction goes).

### Steps

- [ ] **Step 1: Plan-fix-first commit on main** — already landed (this commit).

- [ ] **Step 2: Failing test (TDD)** in
  `test/grappa_web/controllers/auth_controller_test.exs` — assert that
  hitting `POST /auth/login` with input that triggers `:captcha_required`
  from `Visitors.Login` yields 400 with `%{"error" => "captcha_required",
  "site_key" => _}` (use `Map.has_key?(body, "site_key")` since `:captcha_site_key`
  is unwired in test/dev today — Task 13 will wire it via `config/runtime.exs`,
  then the assertion can bump to a value comparison). The test exercises the
  full FallbackController dispatch path through the controller, complementing
  the existing unit test in `test/grappa_web/controllers/fallback_controller_test.exs`
  which calls `FallbackController.call/2` directly.

- [ ] **Step 3: Implement `GrappaWeb.Plugs.ClientId`** at
  `lib/grappa_web/plugs/client_id.ex`. Behaviour: `Plug`. On `call/2`,
  reads `x-grappa-client-id` request header, validates (URL-safe ASCII,
  ≤64 bytes; same `~r/\A[A-Za-z0-9_-]+\z/` regex Plugs.Authn carries
  today), and assigns `:current_client_id` (binary on success, `nil` on
  missing/malformed). NEVER halts — malformed becomes `nil` so the
  downstream admission gates can decide policy (per-client cap requires
  a client_id, but client_id absence is a valid state, e.g., from
  curl/CI). Moduledoc explains why `:api` (covers /auth/login + every
  authenticated route through one invocation) and why nil-on-malformed
  (boundary tolerance — admission policy decides, not the plug).

- [ ] **Step 4: Plug test** at `test/grappa_web/plugs/client_id_test.exs`
  with cases: valid header → assign set; missing header → assign nil; header
  > 64 bytes → assign nil; header containing `/` or `;` → assign nil; empty
  header value → assign nil. Mirror the existing
  `test/grappa_web/plugs/authn_test.exs` client_id describe block (which gets
  retired in Step 6).

- [ ] **Step 5: Wire into router** — in `lib/grappa_web/router.ex`, append
  `plug GrappaWeb.Plugs.ClientId` to the `:api` pipeline. Order: AFTER
  `plug :accepts, ["json"]` (content-type negotiation runs first; client_id
  enrichment is independent, but conventional ordering is "framework
  housekeeping → app concerns").

- [ ] **Step 6: Strip `extract_client_id/1` from `Plugs.Authn`** — remove
  the private `extract_client_id/1` + `valid_client_id?/1` helpers + the
  `@client_id_regex` module attr. Drop the two `assign(:current_client_id,
  extract_client_id(conn))` lines in `assign_subject/2` (both clauses) — the
  assign is already populated by upstream `Plugs.ClientId` in the `:api`
  pipeline, which runs before `:authn`. Update the moduledoc paragraph that
  documents `:current_client_id` to point at `Plugs.ClientId` instead.
  Update `test/grappa_web/plugs/authn_test.exs` describe block: those tests
  assert client_id behaviour on the `:authn` plug today; either delete (now
  redundant with Step 4 plug tests) or convert to integration tests that
  exercise the full pipeline. Delete is preferred — single source of truth
  for behaviour assertion is the new plug's test.

- [ ] **Step 7: Strip inline `extract_client_id/1` from `AuthController`** —
  remove the private `extract_client_id/1` helper + `@client_id_regex` module
  attr. In `visitor_login/3`, change `client_id: extract_client_id(conn)` to
  `client_id: conn.assigns[:current_client_id]`. The assign is now populated
  by `Plugs.ClientId` upstream in the `:api` pipeline (which the `/auth/login`
  scope pipes through). Drop the comment block above the inline extraction
  that referenced the Plugs.Authn mirror — the mirror no longer exists.

- [ ] **Step 8: Verify `visitor_login/3` matches plan-original Step 2 input
  map shape** — should look like:

  ```elixir
  input = %{
    nick: nick,
    password: password,
    ip: format_ip(conn),
    user_agent: user_agent(conn),
    token: extract_bearer(conn),
    captcha_token: conn.params["captcha_token"],
    client_id: conn.assigns[:current_client_id]
  }
  ```

  (Helpers `format_ip/1` + `user_agent/1` already exist in the controller
  and are the canonical replacements for the plan's snippet's
  `format_remote_ip/1` + inline `get_req_header` pipeline. `conn.params` is
  the canonical access for body+query params merged; equivalent to the
  plan's `Map.get(params, "captcha_token")`.)

- [ ] **Step 9: AuthJSON unchanged** — no new render, FallbackController owns
  the captcha-required envelope.

- [ ] **Step 10: Run, expect PASS**

  ```bash
  scripts/test.sh test/grappa_web/plugs/client_id_test.exs \
                  test/grappa_web/plugs/authn_test.exs \
                  test/grappa_web/controllers/auth_controller_test.exs
  scripts/check.sh
  scripts/dialyzer.sh
  ```

- [ ] **Step 11: Commit (single logical change)**

  ```bash
  feat(t31): Plugs.ClientId hoist + AuthController captcha wire-shape test

  Hoists X-Grappa-Client-Id extraction out of Plugs.Authn AND
  AuthController into a single Plugs.ClientId plug wired to the :api
  pipeline. Both prior call sites duplicated the same regex +
  validation; one plug at the highest shared pipeline removes the
  duplication and gives /auth/login (unauthenticated) the same
  :current_client_id assign that authenticated routes get.

  Adds the captcha_required wire-shape integration test through
  AuthController, complementing the existing direct FallbackController
  unit test.

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

  # Registry entry gone — key shape is {:session, subject, network_id}
  # per Grappa.Session.Server.registry_key/2. Use the helper so the
  # test stays in lockstep with the production key construction.
  assert Registry.lookup(
           Grappa.SessionRegistry,
           Grappa.Session.Server.registry_key({:user, user.id}, network.id)
         ) == []
end

test "user logout with multiple bindings stops all of them", %{conn: conn} do
  # Same shape, two networks bound; assert both Session.Server pids stopped.
  ...
end
```

- [ ] **Step 2: Run, expect FAIL**

```bash
scripts/test.sh test/grappa_web/controllers/auth_controller_test.exs
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

@spec stop_all_user_sessions(Ecto.UUID.t()) :: :ok
defp stop_all_user_sessions(user_id) when is_binary(user_id) do
  # Enumerate all (network_id) currently bound to a live Session.Server
  # for this user via Registry.select on the {:session, subject, network_id}
  # 3-tuple key shape per Grappa.Session.Server.registry_key/2 (the
  # canonical shape Admission.count_live_sessions/1 also matches against
  # post-Task-3.5 fix f370709). The match spec literally interpolates
  # {:user, user_id} at construction time so only THIS user's sessions
  # match; :"$1" captures the network_id.
  pattern = {{:session, {:user, user_id}, :"$1"}, :_, :_}
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
scripts/test.sh test/grappa_web/controllers/auth_controller_test.exs
```

- [ ] **Step 5: Commit**

```bash
feat(t31): user logout terminates Session.Server processes (symmetric)

Mirror b809953 (visitor logout) for user sessions. AuthController.logout/2
now scans the Grappa.SessionRegistry for all {:session, {:user, id},
network_id} entries and stops each Session.Server before revoking the
access token.
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

### Background

Three concrete `Grappa.Admission.Captcha` impls now exist (`Disabled`,
`Turnstile`, `HCaptcha`). Tests that exercise the captcha-required →
captcha-passed flow need fine-grained per-call orchestration: rejecting
the first call, accepting the second after the client retries with a
solved token. A Mox-defined mock against the `Grappa.Admission.Captcha`
behaviour is the canonical Elixir pattern for that.

### Files

- **Modify:** `test/test_helper.exs` — add the `Mox.defmock/2` call.
- **Modify:** `test/grappa_web/controllers/auth_controller_test.exs` —
  remove the top-level `RequiresCaptchaFake` defmodule (lines 1–13) and
  port its single test to use `Grappa.Admission.CaptchaMock` via Mox
  expectations. Carryover from Task 6 code-quality reviewer's deferred
  Minor: `RequiresCaptchaFake` was acknowledged as file-local
  scaffolding to be retired once Mox lands.
- **No new file under `test/support/`.** `Mox.defmock/2` is an
  expression that defines a module at runtime, not a `defmodule`-shaped
  source unit — it cannot live inside an `elixirc_paths(:test)` source
  file (would need a wrapping `defmodule`, but `defmock/2` itself
  expands to a top-level `defmodule`, so nesting fails). Canonical
  placement is `test_helper.exs`, which `Code.eval_file/1`s the
  expression at suite startup.

### Step 1 — wire Mox in `test_helper.exs`

Append AFTER the existing `ExUnit.start(...)` and `Sandbox.mode(...)`
lines:

```elixir
Mox.defmock(Grappa.Admission.CaptchaMock, for: Grappa.Admission.Captcha)
```

### Step 2 — replace `RequiresCaptchaFake` in `auth_controller_test.exs`

  1. Delete the entire `defmodule RequiresCaptchaFake do ... end` at the
     top of the file (current lines 1–13).
  2. In the captcha-required wire-shape test (search the file for
     `RequiresCaptchaFake` references), replace the per-test
     `Application.put_env(:grappa, :admission, [..., captcha_provider:
     RequiresCaptchaFake])` setup with a Mox-driven swap:

     ```elixir
     # Inside the test that asserts the 400/captcha_required wire shape:
     original = Application.get_env(:grappa, :admission, [])

     Application.put_env(:grappa, :admission,
       Keyword.put(original, :captcha_provider, Grappa.Admission.CaptchaMock))

     on_exit(fn -> Application.put_env(:grappa, :admission, original) end)

     Mox.expect(Grappa.Admission.CaptchaMock, :verify, fn _, _ ->
       {:error, :captcha_required}
     end)

     Mox.set_mox_global()  # so Login's process can call the mock
     ```

     `Mox.set_mox_global()` is required because `Visitors.Login.login/2`
     runs inside the test process here (synchronous controller action),
     but the captcha verify happens inside `Admission.verify_captcha/2`
     which may be invoked from a spawned task in some flows; global mode
     keeps the mock visible regardless. If it's purely in-process,
     `Mox.expect` alone suffices — verify locally.

     Equivalent shape to the prior fake: every call returns
     `{:error, :captcha_required}`. The one-call expectation maps to the
     test's single login attempt.

  3. The `async: false` constraint on `GrappaWeb.AuthControllerTest`
     stays — Visitors.Login spawns Session.Server processes under the
     singleton supervisor, which is incompatible with `async: true`.
     `set_mox_global` requires `async: false` anyway.

### Step 3 — gate

Run from worktree root:

  * `scripts/test.sh test/grappa_web/controllers/auth_controller_test.exs`
    — same number of tests passing as before the change. The captcha
    test should still assert the 400 + `captcha_required` shape.
  * `scripts/format.sh` then `scripts/format.sh --check` — clean.
  * `scripts/credo.sh` — must contain "found no issues".
  * `scripts/dialyzer.sh` STANDALONE — `Total errors: 0`,
    `passed successfully`.
  * `scripts/test.sh` — full suite, 0 failures. After Tasks 8+9 the
    suite is at 786 tests; this task should leave the count UNCHANGED
    (pure refactor of one existing test) or ±0.

### Step 4 — commit

```
feat(t31): CaptchaMock for Mox-driven Login captcha tests

Define Grappa.Admission.CaptchaMock against the Captcha behaviour in
test/test_helper.exs. Retire the file-local RequiresCaptchaFake from
auth_controller_test.exs in favour of Mox.expect/3 for finer per-call
orchestration of the captcha-required wire-shape test.

No production code touched. Carryover from Task 6 code-quality review
deferred Minor.

Plan 2 of 2.
```

### Watch-outs

  * `Mox.defmock/2` placement in `test_helper.exs` — NOT inside any
    `defmodule`, NOT in a `test/support/*.ex` file. The plan's earlier
    instruction to also create `test/support/captcha_mock.ex` was a
    duplicate-spec typo and is removed in this revision.
  * Don't create a separate `test/support/admission/captcha_fakes.ex`
    file just to host migrated fakes — Mox replaces the fakes entirely.
    The Task 6 reviewer's "migrate to test/support/admission/" guidance
    was conditional on keeping a fake; with Mox in scope, deleting the
    fake is cleaner.
  * If the existing test relies on `Application.put_env` patterns for
    the captcha provider swap, port them all to the same
    `original`/`on_exit` shape used by `TurnstileTest` /
    `HCaptchaTest` (Tasks 8+9) for consistency.

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

- [ ] All 15 tasks landed on `cluster/t31-integration` (Tasks 1–14 + Task 3.5 prereq).
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
