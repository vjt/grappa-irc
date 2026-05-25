# E2E-ROBUSTNESS Bucket D — Per-Spec Subject Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a compile-gated `POST /admin/test/reset-subject` endpoint that drains all mutable seed-user state in <100ms so Playwright's afterEach gives every spec a clean baseline, eliminating the rotating-victim cascade.

**Architecture:** Thin admin controller → `Grappa.TestSupport.SubjectReset` orchestrator → fan-out to existing context reset helpers (DB rows) + `Session.stop_session` + `SpawnOrchestrator.spawn` with `notify_pid`/`notify_ref` to await `{:session_phase, ref, :session_ready}` (5s hard timeout) + ETS resets. Mirrors the proven `Visitors.Login.preempt_and_respawn/4` shape from `lib/grappa/visitors/login.ex:280`. The endpoint is gated by `if Mix.env() in [:dev, :test]` so the prod release literally cannot route it.

**Tech Stack:** Elixir 1.19 / Phoenix 1.8, Ecto 3 / SQLite, ExUnit + StreamData, Playwright 1.x. Inside the existing docker-compose stack — never run `mix` on the host.

---

## File Structure

**New files:**
- `lib/grappa/test_support/subject_reset.ex` — orchestrator (compile-gated module body)
- `lib/grappa_web/controllers/admin/test_reset_subject_controller.ex` — thin controller
- `test/grappa/test_support/subject_reset_test.exs` — orchestrator unit tests
- `test/grappa_web/controllers/admin/test_reset_subject_controller_test.exs` — controller test
- `docs/superpowers/plans/2026-05-25-e2e-robustness-d.md` (this file)

**Modified files:**
- `lib/grappa_web/router.ex` — compile-gated scope
- `lib/grappa/read_cursor.ex` — add `clear_all_for_user/1`
- `lib/grappa/query_windows.ex` — add `close_all_for_user/1`
- `lib/grappa/push.ex` — add `subscription_clear_all_for_user/1`
- `lib/grappa/user_settings.ex` — add `reset_for_user/1`
- `lib/grappa/uploads.ex` — add `delete_all_for_user/1`
- `cicchetto/e2e/fixtures/grappaApi.ts` — add `resetSubject(adminToken, userName)` helper
- `cicchetto/e2e/tests/m2-irssi-to-chan-defocused.spec.ts` — pilot: wire afterEach reset
- `cicchetto/e2e/tests/cursor-walks-with-scroll.spec.ts` — pilot: wire afterEach reset
- `infra/nginx.conf` — admin allowlist for `/admin/test/reset-subject`
- `cicchetto/e2e/infra/nginx-test.conf` — same allowlist on both `:80` + `:443`

**Reference patterns (read first):**
- `lib/grappa/visitors/login.ex:280-417` — `preempt_and_respawn` + `spawn_and_await` + `wait_for_ready` / `wait_for_connected` / `wait_for_welcomed`
- `lib/grappa/ws_presence.ex:189-191` — Mix-env-gated `reset_for_test/0`
- `lib/grappa_web/router.ex:97-128` — operator-console admin scope shape
- `lib/grappa/spawn_orchestrator.ex:194-203` — `spawn/4` signature

---

## Worktree setup

This work happens on the existing worktree from the spike (`/private/tmp/grappa-e2e-robustness-d` on branch `e2e-robustness-d`). All commands below assume `cd /private/tmp/grappa-e2e-robustness-d`. If the worktree is gone, recreate:

```bash
git checkout main
git worktree add /private/tmp/grappa-e2e-robustness-d -b e2e-robustness-d main
cd /private/tmp/grappa-e2e-robustness-d
git submodule update --init vendor/bats-core cicchetto/e2e/infra
scripts/bun.sh install
```

---

## Task 1: Add `Grappa.ReadCursor.clear_all_for_user/1`

**Files:**
- Modify: `lib/grappa/read_cursor.ex`
- Test: `test/grappa/read_cursor_test.exs`

- [ ] **Step 1: Write the failing test**

Open `test/grappa/read_cursor_test.exs` and add at the end (before the closing `end`):

```elixir
  describe "clear_all_for_user/1" do
    test "deletes every cursor row for the given user_id" do
      user = insert(:user)
      other = insert(:user)
      network = insert(:network)
      msg_a = insert(:message, user: user, network: network, channel: "#a")
      msg_b = insert(:message, user: user, network: network, channel: "#b")
      msg_o = insert(:message, user: other, network: network, channel: "#a")
      :ok = ReadCursor.set(user.id, network.id, "#a", msg_a.id)
      :ok = ReadCursor.set(user.id, network.id, "#b", msg_b.id)
      :ok = ReadCursor.set(other.id, network.id, "#a", msg_o.id)

      assert :ok = ReadCursor.clear_all_for_user(user.id)

      assert ReadCursor.get(user.id, network.id, "#a") == nil
      assert ReadCursor.get(user.id, network.id, "#b") == nil
      assert ReadCursor.get(other.id, network.id, "#a") == msg_o.id
    end

    test "is idempotent when user has no cursors" do
      user = insert(:user)
      assert :ok = ReadCursor.clear_all_for_user(user.id)
    end
  end
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
scripts/test.sh test/grappa/read_cursor_test.exs
```

Expected: failure with `(UndefinedFunctionError) function Grappa.ReadCursor.clear_all_for_user/1 is undefined`.

- [ ] **Step 3: Implement `clear_all_for_user/1`**

In `lib/grappa/read_cursor.ex`, add this function alongside the existing `set/4` / `get/3` (keep alphabetical order or follow the file's existing arrangement):

```elixir
  @doc """
  Test-support: drains every read-cursor row for `user_id` in a single
  DELETE. Intended for `Grappa.TestSupport.SubjectReset` only — production
  cursor lifecycle is per-channel via `set/4`.
  """
  @spec clear_all_for_user(Ecto.UUID.t()) :: :ok
  def clear_all_for_user(user_id) when is_binary(user_id) do
    import Ecto.Query
    Grappa.Repo.delete_all(from c in Grappa.ReadCursor.Cursor, where: c.user_id == ^user_id)
    :ok
  end
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
scripts/test.sh test/grappa/read_cursor_test.exs
```

Expected: PASS, 0 failures, no warnings.

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/read_cursor.ex test/grappa/read_cursor_test.exs
git commit -m "feat(read_cursor): add clear_all_for_user/1 for test reset

Test-only helper drained in one DELETE. Used by upcoming
SubjectReset orchestrator. Idempotent if user has no cursors."
```

---

## Task 2: Add `Grappa.QueryWindows.close_all_for_user/1`

**Files:**
- Modify: `lib/grappa/query_windows.ex`
- Test: `test/grappa/query_windows_test.exs`

- [ ] **Step 1: Write the failing test**

Add to `test/grappa/query_windows_test.exs`:

```elixir
  describe "close_all_for_user/1" do
    test "deletes every query_window row for the user" do
      user = insert(:user)
      other = insert(:user)
      network = insert(:network)
      {:ok, _} = QueryWindows.open(user.id, network.id, "alice")
      {:ok, _} = QueryWindows.open(user.id, network.id, "bob")
      {:ok, _} = QueryWindows.open(other.id, network.id, "alice")

      assert :ok = QueryWindows.close_all_for_user(user.id)

      assert QueryWindows.list_by_user(user.id) == []
      assert [%{target_nick: "alice"}] = QueryWindows.list_by_user(other.id)
    end

    test "is idempotent when user has no windows" do
      user = insert(:user)
      assert :ok = QueryWindows.close_all_for_user(user.id)
    end
  end
```

(If the existing module uses different verb names — `open_query_window/3`, `list_query_windows/1` — substitute accordingly. Read the file FIRST.)

- [ ] **Step 2: Run the test to verify it fails**

```bash
scripts/test.sh test/grappa/query_windows_test.exs
```

Expected: `function Grappa.QueryWindows.close_all_for_user/1 is undefined`.

- [ ] **Step 3: Implement `close_all_for_user/1`**

In `lib/grappa/query_windows.ex`:

```elixir
  @doc """
  Test-support: drains every query_window row for `user_id`. Used by
  `Grappa.TestSupport.SubjectReset`. Idempotent.
  """
  @spec close_all_for_user(Ecto.UUID.t()) :: :ok
  def close_all_for_user(user_id) when is_binary(user_id) do
    import Ecto.Query
    Grappa.Repo.delete_all(
      from w in Grappa.QueryWindows.Window, where: w.user_id == ^user_id
    )
    :ok
  end
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
scripts/test.sh test/grappa/query_windows_test.exs
```

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/query_windows.ex test/grappa/query_windows_test.exs
git commit -m "feat(query_windows): add close_all_for_user/1 for test reset"
```

---

## Task 3: Add `Grappa.Push.subscription_clear_all_for_user/1`

**Files:**
- Modify: `lib/grappa/push.ex`
- Test: `test/grappa/push_test.exs`

- [ ] **Step 1: Read `lib/grappa/push.ex` first**

The schema is `Grappa.Push.Subscription` per `lib/grappa/push/subscription.ex:68` (`belongs_to :user`). Confirm the public context module name (`Grappa.Push` vs `Grappa.Push.Subscriptions`) by reading the file's `defmodule` declaration before writing the helper. Use whichever name matches the rest of the file.

- [ ] **Step 2: Write the failing test**

Add to the test file (create `test/grappa/push_test.exs` if it does not exist, mirroring `read_cursor_test.exs`'s setup):

```elixir
  describe "subscription_clear_all_for_user/1" do
    test "deletes every push subscription for the user" do
      user = insert(:user)
      other = insert(:user)
      insert(:push_subscription, user: user, endpoint: "https://a")
      insert(:push_subscription, user: user, endpoint: "https://b")
      insert(:push_subscription, user: other, endpoint: "https://c")

      assert :ok = Grappa.Push.subscription_clear_all_for_user(user.id)

      assert Grappa.Push.list_subscriptions_for_user(user.id) == []
      assert [_] = Grappa.Push.list_subscriptions_for_user(other.id)
    end

    test "is idempotent when user has no subscriptions" do
      user = insert(:user)
      assert :ok = Grappa.Push.subscription_clear_all_for_user(user.id)
    end
  end
```

If `:push_subscription` factory or `list_subscriptions_for_user/1` don't exist, use the actual names from the codebase. The test must be sound — DO NOT add a factory just for this test; insert via the existing context function.

- [ ] **Step 3: Run the test to verify it fails**

```bash
scripts/test.sh test/grappa/push_test.exs
```

- [ ] **Step 4: Implement**

```elixir
  @doc """
  Test-support: drains every push_subscription row for `user_id`. Used
  by `Grappa.TestSupport.SubjectReset`. Idempotent.
  """
  @spec subscription_clear_all_for_user(Ecto.UUID.t()) :: :ok
  def subscription_clear_all_for_user(user_id) when is_binary(user_id) do
    import Ecto.Query
    Grappa.Repo.delete_all(
      from s in Grappa.Push.Subscription, where: s.user_id == ^user_id
    )
    :ok
  end
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
scripts/test.sh test/grappa/push_test.exs
```

- [ ] **Step 6: Commit**

```bash
git add lib/grappa/push.ex test/grappa/push_test.exs
git commit -m "feat(push): add subscription_clear_all_for_user/1 for test reset"
```

---

## Task 4: Add `Grappa.UserSettings.reset_for_user/1`

**Files:**
- Modify: `lib/grappa/user_settings.ex`
- Test: `test/grappa/user_settings_test.exs`

- [ ] **Step 1: Write the failing test**

Add to `test/grappa/user_settings_test.exs`:

```elixir
  describe "reset_for_user/1" do
    test "deletes the settings row so subsequent reads return defaults" do
      user = insert(:user)
      other = insert(:user)
      {:ok, _} = UserSettings.update(user.id, %{theme: "dark"})
      {:ok, _} = UserSettings.update(other.id, %{theme: "dark"})

      assert :ok = UserSettings.reset_for_user(user.id)

      assert UserSettings.get(user.id) == UserSettings.defaults()
      assert UserSettings.get(other.id).theme == "dark"
    end

    test "is idempotent when user has no settings row" do
      user = insert(:user)
      assert :ok = UserSettings.reset_for_user(user.id)
    end
  end
```

(Substitute `theme: "dark"` for an actual settable field if needed — read `lib/grappa/user_settings/settings.ex` for the schema's actual columns. Substitute `UserSettings.defaults/0` for the actual default getter — if there isn't one, assert the field falls back to its schema default explicitly.)

- [ ] **Step 2: Run the test to verify it fails**

```bash
scripts/test.sh test/grappa/user_settings_test.exs
```

- [ ] **Step 3: Implement**

```elixir
  @doc """
  Test-support: deletes the user_settings row so subsequent reads return
  defaults. Used by `Grappa.TestSupport.SubjectReset`. Idempotent.
  """
  @spec reset_for_user(Ecto.UUID.t()) :: :ok
  def reset_for_user(user_id) when is_binary(user_id) do
    import Ecto.Query
    Grappa.Repo.delete_all(
      from s in Grappa.UserSettings.Settings, where: s.user_id == ^user_id
    )
    :ok
  end
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
scripts/test.sh test/grappa/user_settings_test.exs
```

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/user_settings.ex test/grappa/user_settings_test.exs
git commit -m "feat(user_settings): add reset_for_user/1 for test reset"
```

---

## Task 5: Add `Grappa.Uploads.delete_all_for_user/1`

**Files:**
- Modify: `lib/grappa/uploads.ex`
- Test: `test/grappa/uploads_test.exs`

- [ ] **Step 1: Read `lib/grappa/uploads/upload.ex` first**

Confirm the schema name (`Grappa.Uploads.Upload`) and whether deleting a row needs to clean up a corresponding file on disk. If yes, the helper MUST call the existing `delete/1` per-row (which presumably handles the file) rather than `delete_all`. Verify before writing the helper.

- [ ] **Step 2: Write the failing test**

```elixir
  describe "delete_all_for_user/1" do
    test "deletes every upload row for the user and removes their files" do
      user = insert(:user)
      other = insert(:user)
      u1 = insert(:upload, user: user)
      u2 = insert(:upload, user: user)
      uo = insert(:upload, user: other)

      assert :ok = Uploads.delete_all_for_user(user.id)

      assert Uploads.list_for_user(user.id) == []
      assert [_] = Uploads.list_for_user(other.id)
      # If on-disk file deletion is expected, assert the files for
      # u1/u2 are gone and uo's is still present.
    end

    test "is idempotent when user has no uploads" do
      user = insert(:user)
      assert :ok = Uploads.delete_all_for_user(user.id)
    end
  end
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
scripts/test.sh test/grappa/uploads_test.exs
```

- [ ] **Step 4: Implement**

If files on disk need cleanup, iterate and call the existing per-row delete:

```elixir
  @doc """
  Test-support: deletes every upload row for `user_id` and removes the
  corresponding files on disk (per-row delete reuses the existing
  cleanup path). Used by `Grappa.TestSupport.SubjectReset`. Idempotent.
  """
  @spec delete_all_for_user(Ecto.UUID.t()) :: :ok
  def delete_all_for_user(user_id) when is_binary(user_id) do
    import Ecto.Query
    Grappa.Repo.all(from u in Grappa.Uploads.Upload, where: u.user_id == ^user_id)
    |> Enum.each(&delete/1)
    :ok
  end
```

If no file cleanup is needed, use a single `delete_all`:

```elixir
  @spec delete_all_for_user(Ecto.UUID.t()) :: :ok
  def delete_all_for_user(user_id) when is_binary(user_id) do
    import Ecto.Query
    Grappa.Repo.delete_all(
      from u in Grappa.Uploads.Upload, where: u.user_id == ^user_id
    )
    :ok
  end
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
scripts/test.sh test/grappa/uploads_test.exs
```

- [ ] **Step 6: Commit**

```bash
git add lib/grappa/uploads.ex test/grappa/uploads_test.exs
git commit -m "feat(uploads): add delete_all_for_user/1 for test reset"
```

---

## Task 6: Add `Grappa.Admission.NetworkCircuit.reset/1` Mix-env guard (if needed)

**Files:**
- Read: `lib/grappa/admission/network_circuit.ex`

- [ ] **Step 1: Check whether `reset/1` is already test-gated**

`lib/grappa/admission/network_circuit.ex:220` already has `def reset(network_id)`. Read the function body and confirm whether it's a production verb (used by existing prod code paths) or already test-only. Two outcomes:

- **If already exists and is prod-callable**: skip this task — `SubjectReset` will call it as-is.
- **If it doesn't exist**: add a Mix-env-gated `reset_for_test/1` mirroring `WSPresence.reset_for_test/0` at `lib/grappa/ws_presence.ex:189-191`.

This task is a 5-minute check; record the outcome in the commit message of the eventual `SubjectReset` orchestrator commit.

- [ ] **Step 2: No commit unless added**

If a new function is added, commit on its own with tests; otherwise this task is informational only.

---

## Task 7: Add `Grappa.WSPresence.reset_for_user/1`

**Files:**
- Modify: `lib/grappa/ws_presence.ex`
- Test: `test/grappa/ws_presence_test.exs`

`reset_for_test/0` exists but wipes ALL state. We need per-user. Add a sibling.

- [ ] **Step 1: Write the failing test**

```elixir
  describe "reset_for_user/1" do
    @tag :tmp_dir
    test "drops the user's entries without touching other users" do
      :ok = WSPresence.register("vjt", self())
      other = spawn(fn -> Process.sleep(1_000) end)
      :ok = WSPresence.register("admin-vjt", other)

      assert :ok = WSPresence.reset_for_user("vjt")
      assert WSPresence.ws_count("vjt") == 0
      assert WSPresence.ws_count("admin-vjt") == 1
    end
  end
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
scripts/test.sh test/grappa/ws_presence_test.exs
```

- [ ] **Step 3: Implement**

In `lib/grappa/ws_presence.ex`, mirror the existing `reset_for_test/0` Mix-env guard pattern (`lib/grappa/ws_presence.ex:189-191`):

```elixir
  if Mix.env() in [:dev, :test] do
    @doc """
    Test-support: drops the given user_name's presence entries.
    Mirrors `reset_for_test/0` but per-user — used by
    `Grappa.TestSupport.SubjectReset`. Not available in prod.
    """
    @spec reset_for_user(String.t()) :: :ok
    def reset_for_user(user_name) when is_binary(user_name) do
      GenServer.call(__MODULE__, {:reset_for_user, user_name})
    end
  end
```

Then add the `handle_call` clause (find the existing `{:reset_for_test ...}` handler around `lib/grappa/ws_presence.ex:275` and add this sibling above or below it):

```elixir
  if Mix.env() in [:dev, :test] do
    @impl GenServer
    def handle_call({:reset_for_user, user_name}, _from, state) do
      # Drop every monitored pid + entry under this user_name. State
      # structure is whatever the existing reset_for_test resets;
      # mirror that surgically for the single user_name.
      new_state =
        state
        |> Map.update(:by_user, %{}, &Map.delete(&1, user_name))
        # Demonitor + remove from the reverse-index map. Read the
        # existing state shape (handle_call({:register, ...}) at
        # ws_presence.ex:206) before writing this — the precise
        # update needs to match.
      {:reply, :ok, new_state}
    end
  end
```

If the WSPresence state shape isn't a simple `%{by_user => %{}}` map, adapt to whatever shape the existing register/handle_call uses. Do NOT introduce a parallel data structure.

- [ ] **Step 4: Run the test to verify it passes**

```bash
scripts/test.sh test/grappa/ws_presence_test.exs
```

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/ws_presence.ex test/grappa/ws_presence_test.exs
git commit -m "feat(ws_presence): add reset_for_user/1 sibling to reset_for_test/0

Drops per-user_name presence entries without touching other users.
Mix-env-gated to dev/test (mirror of reset_for_test/0). Used by
upcoming SubjectReset orchestrator."
```

---

## Task 8: Create `Grappa.TestSupport.SubjectReset` orchestrator

**Files:**
- Create: `lib/grappa/test_support/subject_reset.ex`
- Test: `test/grappa/test_support/subject_reset_test.exs`

This is the bucket's load-bearing module. Mix-env gated so prod release does not compile it.

- [ ] **Step 1: Write the failing test**

Create `test/grappa/test_support/subject_reset_test.exs`:

```elixir
defmodule Grappa.TestSupport.SubjectResetTest do
  use Grappa.DataCase, async: false

  alias Grappa.{Networks, ReadCursor, QueryWindows, UserSettings, TestSupport.SubjectReset}

  setup do
    user = insert(:user, name: "vjt")
    network = insert(:network, slug: "bahamut-test")
    cred = insert(:network_credential, user: user, network: network, nick: "vjt-grappa",
                                       connection_state: :connected, autojoin: ["#bofh"])
    # Seed mutable state on the user
    msg = insert(:message, user: user, network: network, channel: "#bofh")
    :ok = ReadCursor.set(user.id, network.id, "#bofh", msg.id)
    {:ok, _} = QueryWindows.open(user.id, network.id, "alice")
    {:ok, _} = UserSettings.update(user.id, %{theme: "dark"})
    %{user: user, network: network, cred: cred}
  end

  describe "reset!/1" do
    test "drains every mutable DB surface for the user", %{user: user, network: network} do
      assert :ok = SubjectReset.reset!(user.name)

      assert ReadCursor.get(user.id, network.id, "#bofh") == nil
      assert QueryWindows.list_by_user(user.id) == []
      assert UserSettings.get(user.id) == UserSettings.defaults()
    end

    test "does not touch other users", %{network: network} do
      other = insert(:user, name: "admin-vjt")
      msg = insert(:message, user: other, network: network, channel: "#bofh")
      :ok = ReadCursor.set(other.id, network.id, "#bofh", msg.id)

      assert :ok = SubjectReset.reset!("vjt")

      assert ReadCursor.get(other.id, network.id, "#bofh") == msg.id
    end

    test "returns {:error, :user_not_found} for unknown user_name" do
      assert {:error, :user_not_found} = SubjectReset.reset!("ghost-user")
    end

    # Note: the live-Session.Server restart + notify_pid wait is NOT
    # asserted in this unit test (it requires a real upstream IRC and
    # is exercised by the e2e pilot). Unit test scope is DB drain +
    # NOT-FOUND handling.
  end
end
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
scripts/test.sh test/grappa/test_support/subject_reset_test.exs
```

Expected: `(UndefinedFunctionError) function Grappa.TestSupport.SubjectReset.reset!/1 is undefined`.

- [ ] **Step 3: Implement the orchestrator**

Create `lib/grappa/test_support/subject_reset.ex`:

```elixir
if Mix.env() in [:dev, :test] do
  defmodule Grappa.TestSupport.SubjectReset do
    @moduledoc """
    Test-only orchestrator that drains every mutable surface owned by
    a seed user (DB rows + live `Session.Server` state + ETS
    entries), so Playwright's afterEach gives every spec a clean
    baseline. Compile-gated to `:dev` and `:test` Mix envs — the
    module literally does not exist in the prod release.

    Wired via `POST /admin/test/reset-subject`
    (`GrappaWeb.Admin.TestResetSubjectController`), itself
    compile-gated in `lib/grappa_web/router.ex`. See
    `docs/superpowers/specs/2026-05-25-e2e-robustness-d-design.md`
    for the full design + the rotating-victim cascade this fixes.

    The Session.Server restart awaits the existing
    `{:session_phase, ref, :session_ready}` direct message
    (`lib/grappa/session/server.ex:1331`) — same mechanism
    `Visitors.Login.preempt_and_respawn/4` uses
    (`lib/grappa/visitors/login.ex:280-417`). Hard 5s timeout per
    credential → `{:error, {:reconnect_timeout, network_slug}}`. No
    silent retry loops; loud failure surfaces upstream sickness.
    """

    require Logger

    alias Grappa.{
      Accounts,
      Admission.NetworkCircuit,
      Networks,
      Push,
      QueryWindows,
      ReadCursor,
      Session,
      Session.Backoff,
      SpawnOrchestrator,
      Uploads,
      UserSettings,
      WSPresence
    }

    @reset_timeout_ms 5_000

    @type reset_error ::
            :user_not_found
            | {:reconnect_timeout, String.t()}
            | {:reconnect_failed, String.t(), term()}

    @doc """
    Drain every mutable surface for the user identified by `user_name`.

    Returns `:ok` once:
    - every per-user DB row (cursors, query_windows, push_subscriptions,
      user_settings, uploads) has been deleted
    - every `(user, network)` Session.Server has been stopped + respawned
      via SpawnOrchestrator + has fired `{:session_phase, ref, :session_ready}`
    - WSPresence + Backoff + NetworkCircuit entries for the user's
      networks have been reset

    Returns `{:error, reason}` on any failure (no partial silent success).
    """
    @spec reset!(String.t()) :: :ok | {:error, reset_error()}
    def reset!(user_name) when is_binary(user_name) do
      with {:ok, user} <- Accounts.fetch_user_by_name(user_name) do
        do_reset(user)
      else
        {:error, :not_found} -> {:error, :user_not_found}
      end
    end

    defp do_reset(user) do
      :ok = ReadCursor.clear_all_for_user(user.id)
      :ok = QueryWindows.close_all_for_user(user.id)
      :ok = Push.subscription_clear_all_for_user(user.id)
      :ok = UserSettings.reset_for_user(user.id)
      :ok = Uploads.delete_all_for_user(user.id)
      :ok = WSPresence.reset_for_user(user.name)

      credentials = Networks.list_credentials_for_user(user.id)
      respawn_each(user, credentials)
    end

    defp respawn_each(_user, []), do: :ok
    defp respawn_each(user, [%{network_id: network_id, network: %{slug: slug}} = cred | rest]) do
      :ok = NetworkCircuit.reset(network_id)
      :ok = Backoff.reset({:user, user.id}, network_id)
      :ok = Session.stop_session({:user, user.id}, network_id)

      case spawn_and_await(user, cred) do
        :ok -> respawn_each(user, rest)
        {:error, _} = err -> err
      end
    end

    defp spawn_and_await(user, %{network_id: network_id, network: %{slug: slug}} = cred) do
      case Networks.SessionPlan.resolve(cred) do
        {:ok, plan} ->
          ref = make_ref()
          plan_with_notify = Map.merge(plan, %{notify_pid: self(), notify_ref: ref})
          capacity_input = %{flow: :test_reset, client_id: "test-reset"}

          case SpawnOrchestrator.spawn(
                 {:user, user.id},
                 network_id,
                 plan_with_notify,
                 capacity_input
               ) do
            {:ok, _, pid} -> await_ready(pid, ref, slug)
            {:error, reason} -> {:error, {:reconnect_failed, slug, reason}}
          end

        {:error, reason} ->
          {:error, {:reconnect_failed, slug, reason}}
      end
    end

    defp await_ready(pid, ref, slug) do
      monitor_ref = Process.monitor(pid)

      receive do
        {:session_phase, ^ref, :session_ready} ->
          Process.demonitor(monitor_ref, [:flush])
          :ok

        {:DOWN, ^monitor_ref, :process, ^pid, reason} ->
          {:error, {:reconnect_failed, slug, reason}}
      after
        @reset_timeout_ms ->
          Process.demonitor(monitor_ref, [:flush])
          {:error, {:reconnect_timeout, slug}}
      end
    end
  end
end
```

If `Networks.SessionPlan.resolve/1` signature for credentials differs from the visitor variant, read `lib/grappa/networks/session_plan.ex:55` and use the correct argument shape. Same goes for `capacity_input` — read `Admission.check_capacity/1` to see what fields it requires; use a `flow:` value that signals test-reset (introduce it if needed, but only if Admission requires a closed-set value).

If `Accounts.fetch_user_by_name/1` doesn't exist, use whichever lookup helper does — e.g. `Accounts.get_user_by_name/1` then convert `nil → {:error, :user_not_found}`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
scripts/test.sh test/grappa/test_support/subject_reset_test.exs
```

If it fails with a `Networks.SessionPlan.resolve` arity or capacity-input shape mismatch, fix and re-run. The unit test doesn't exercise the spawn path (no real IRC), so only the DB-drain + user-not-found assertions need to pass at this step. Add `mock :spawn` shims ONLY if the test setup tries to spawn — if `list_credentials_for_user` returns the seeded cred and the test would attempt a real spawn, gate the test by setting `connection_state: :parked` so `respawn_each` skips the spawn (or restructure the orchestrator to skip non-connected credentials).

Re-reading: the orchestrator unconditionally calls `Session.stop_session` + `spawn_and_await`. For the unit test, the simplest fix is to make `respawn_each` SKIP credentials when no live pid exists (treat the stop-then-respawn as best-effort: if `Session.whereis/2` returns `nil` AND `connection_state != :connected`, skip the respawn). Adjust accordingly.

Alternative: in `setup`, set `cred.connection_state = :parked`. If the helper iterates regardless of state, gate by state inside `respawn_each`:

```elixir
defp respawn_each(user, [%{connection_state: state} = cred | rest])
     when state != :connected do
  # Parked / failed credential — don't respawn. Wipe Backoff + Circuit
  # for symmetry then move on.
  :ok = NetworkCircuit.reset(cred.network_id)
  :ok = Backoff.reset({:user, user.id}, cred.network_id)
  respawn_each(user, rest)
end
```

- [ ] **Step 5: Commit**

```bash
git add lib/grappa/test_support/subject_reset.ex test/grappa/test_support/subject_reset_test.exs
git commit -m "feat(test_support): add SubjectReset orchestrator (compile-gated)

Drains every mutable surface owned by a seed user — DB rows
(cursors, query_windows, push_subscriptions, user_settings,
uploads), Session.Server in-memory state (stop + respawn with
notify_pid await), WSPresence + Backoff + NetworkCircuit ETS
entries. 5s hard timeout per credential. Mix-env gated; module
absent from prod release.

Mirrors Visitors.Login.preempt_and_respawn/4 shape. Wired into
POST /admin/test/reset-subject in the next commit."
```

---

## Task 9: Create `GrappaWeb.Admin.TestResetSubjectController`

**Files:**
- Create: `lib/grappa_web/controllers/admin/test_reset_subject_controller.ex`
- Test: `test/grappa_web/controllers/admin/test_reset_subject_controller_test.exs`

- [ ] **Step 1: Write the failing test**

Create `test/grappa_web/controllers/admin/test_reset_subject_controller_test.exs`:

```elixir
defmodule GrappaWeb.Admin.TestResetSubjectControllerTest do
  use GrappaWeb.ConnCase, async: false

  alias Grappa.Accounts

  setup do
    admin = insert(:user, name: "admin-vjt", is_admin: true)
    user = insert(:user, name: "vjt", is_admin: false)
    network = insert(:network, slug: "bahamut-test")
    _cred = insert(:network_credential,
      user: user, network: network, nick: "vjt-grappa",
      connection_state: :parked, autojoin: ["#bofh"]
    )
    {:ok, admin_session} = Accounts.create_session({:user, admin.id}, "127.0.0.1", "test", client_id: "test")
    {:ok, user_session} = Accounts.create_session({:user, user.id}, "127.0.0.1", "test", client_id: "test")
    %{admin_token: admin_session.id, user_token: user_session.id, user: user}
  end

  describe "POST /admin/test/reset-subject" do
    test "returns 204 with admin token + valid user_name", %{conn: conn, admin_token: tok} do
      conn =
        conn
        |> put_req_header("authorization", "Bearer " <> tok)
        |> put_req_header("content-type", "application/json")
        |> post(~p"/admin/test/reset-subject", %{"user_name" => "vjt"})

      assert response(conn, 204) == ""
    end

    test "returns 403 with non-admin token", %{conn: conn, user_token: tok} do
      conn =
        conn
        |> put_req_header("authorization", "Bearer " <> tok)
        |> put_req_header("content-type", "application/json")
        |> post(~p"/admin/test/reset-subject", %{"user_name" => "vjt"})

      assert json_response(conn, 403)
    end

    test "returns 401 without bearer", %{conn: conn} do
      conn = post(conn, ~p"/admin/test/reset-subject", %{"user_name" => "vjt"})
      assert json_response(conn, 401)
    end

    test "returns 404 for unknown user_name", %{conn: conn, admin_token: tok} do
      conn =
        conn
        |> put_req_header("authorization", "Bearer " <> tok)
        |> put_req_header("content-type", "application/json")
        |> post(~p"/admin/test/reset-subject", %{"user_name" => "ghost"})

      assert %{"error" => "user_not_found"} = json_response(conn, 404)
    end

    test "returns 422 when user_name missing", %{conn: conn, admin_token: tok} do
      conn =
        conn
        |> put_req_header("authorization", "Bearer " <> tok)
        |> put_req_header("content-type", "application/json")
        |> post(~p"/admin/test/reset-subject", %{})

      assert %{"error" => "user_name_required"} = json_response(conn, 422)
    end
  end
end
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
scripts/test.sh test/grappa_web/controllers/admin/test_reset_subject_controller_test.exs
```

Expected: route not found / module undefined.

- [ ] **Step 3: Implement the controller**

Create `lib/grappa_web/controllers/admin/test_reset_subject_controller.ex`:

```elixir
if Mix.env() in [:dev, :test] do
  defmodule GrappaWeb.Admin.TestResetSubjectController do
    @moduledoc """
    Test-only admin endpoint that drains every mutable surface for a
    seed user. Compile-gated to `:dev` and `:test` envs; the module
    literally does not exist in the prod release.

    See `docs/superpowers/specs/2026-05-25-e2e-robustness-d-design.md`.
    """
    use GrappaWeb, :controller

    alias Grappa.TestSupport.SubjectReset

    @spec reset(Plug.Conn.t(), map()) :: Plug.Conn.t()
    def reset(conn, %{"user_name" => user_name}) when is_binary(user_name) do
      case SubjectReset.reset!(user_name) do
        :ok ->
          send_resp(conn, 204, "")

        {:error, :user_not_found} ->
          conn |> put_status(:not_found) |> json(%{error: "user_not_found"})

        {:error, {:reconnect_timeout, slug}} ->
          conn
          |> put_status(:gateway_timeout)
          |> json(%{error: "session_reconnect_timeout", network_slug: slug})

        {:error, {:reconnect_failed, slug, reason}} ->
          conn
          |> put_status(:internal_server_error)
          |> json(%{error: "session_reconnect_failed", network_slug: slug, reason: inspect(reason)})
      end
    end

    def reset(conn, _) do
      conn |> put_status(:unprocessable_entity) |> json(%{error: "user_name_required"})
    end
  end
end
```

- [ ] **Step 4: Wire the compile-gated route**

In `lib/grappa_web/router.ex`, AFTER the existing operator-console admin scope (around line 128, after the existing `scope "/admin", GrappaWeb.Admin do ... end` block), add:

```elixir
  # E2E-ROBUSTNESS bucket D — test-only subject reset surface.
  # Compile-gated to dev/test Mix env. Prod release literally does
  # not contain the route (the if-block returns nil at compile time
  # so Phoenix's router macro never registers it).
  if Mix.env() in [:dev, :test] do
    scope "/admin/test", GrappaWeb.Admin do
      pipe_through [:api, :authn, :admin_authn]
      post "/reset-subject", TestResetSubjectController, :reset
    end
  end
```

- [ ] **Step 5: Run the controller test to verify it passes**

```bash
scripts/test.sh test/grappa_web/controllers/admin/test_reset_subject_controller_test.exs
```

If the 204 test fails because the test setup didn't make a real spawn possible (the orchestrator tries to respawn the parked cred), confirm Task 8's gating-by-state behavior is in effect. If 204 still fails, this is a real bug; debug before proceeding.

- [ ] **Step 6: Commit**

```bash
git add lib/grappa_web/controllers/admin/test_reset_subject_controller.ex \
        test/grappa_web/controllers/admin/test_reset_subject_controller_test.exs \
        lib/grappa_web/router.ex
git commit -m "feat(admin): add compile-gated POST /admin/test/reset-subject

Test-only HTTP surface that delegates to SubjectReset orchestrator.
Returns 204 on success, 403 for non-admin tokens, 404 for unknown
user, 422 when user_name missing, 504 on Session.Server reconnect
timeout, 500 on spawn failure. Module + route are absent from the
prod release."
```

---

## Task 10: Add nginx allowlist entries for the new admin endpoint

**Files:**
- Modify: `infra/nginx.conf`
- Modify: `cicchetto/e2e/infra/nginx-test.conf`

Per CLAUDE.md "Admin endpoints go through the `:admin_authn` pipeline": **The nginx allowlist (`infra/nginx.conf` + e2e `cicchetto/e2e/nginx-test.conf`) must list the new resource — both the `:80` and `:443` server blocks — or the route 404s at the proxy before reaching Phoenix.**

- [ ] **Step 1: Find existing admin allowlist entries in both files**

```bash
grep -n "/admin/" infra/nginx.conf cicchetto/e2e/infra/nginx-test.conf
```

- [ ] **Step 2: Add `/admin/test/reset-subject` to both files**

In `infra/nginx.conf` AND `cicchetto/e2e/infra/nginx-test.conf`, add a sibling `location` block to the existing `/admin/<resource>` allowlist entries. Pattern from existing entries (substitute the actual proxy_pass + headers used by other admin routes — DO NOT invent a new header set):

```nginx
        location /admin/test/reset-subject {
            # E2E-ROBUSTNESS bucket D — test-only subject reset.
            # Compile-gated server-side; nginx allowlist mirrors the
            # operator-console admin pattern.
            proxy_pass http://grappa:4000;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            # ... whatever other headers the existing admin blocks set
        }
```

For `cicchetto/e2e/infra/nginx-test.conf`, repeat the block in BOTH the `:80` and `:443` server blocks (per CLAUDE.md).

- [ ] **Step 3: Commit**

```bash
git add infra/nginx.conf cicchetto/e2e/infra/nginx-test.conf
git commit -m "ops(nginx): allowlist POST /admin/test/reset-subject

Mirrors the operator-console admin allowlist pattern. Required on
both prod nginx.conf AND e2e nginx-test.conf (both :80 and :443
server blocks) per CLAUDE.md admin-endpoint rule."
```

---

## Task 11: Add `resetSubject` Playwright fixture helper

**Files:**
- Modify: `cicchetto/e2e/fixtures/grappaApi.ts`

- [ ] **Step 1: Add the helper**

At the end of `cicchetto/e2e/fixtures/grappaApi.ts`, before the closing brace:

```typescript
// E2E-ROBUSTNESS bucket D — per-spec subject reset. Drains every
// mutable surface for `userName` (DB rows + Session.Server restart
// + ETS entries) so the next spec begins from a clean baseline.
// Server-side gates: route compile-gated to dev/test Mix env;
// admin_authn requires admin bearer.
//
// Caller MUST pass the seeded ADMIN token (getSeededAdmin().token),
// NOT the user's own token. The endpoint is admin-only.
//
// Throws on non-204 — afterEach treats reset failures as loud
// test failures, never silently ignores.
export async function resetSubject(adminToken: string, userName: string): Promise<void> {
  const base = process.env.E2E_BASE_URL ?? "https://nginx-test";
  const res = await fetch(`${base}/admin/test/reset-subject`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ user_name: userName }),
  });
  if (res.status !== 204) {
    const body = await res.text().catch(() => "<no body>");
    throw new Error(`resetSubject(${userName}) failed: ${res.status} ${body}`);
  }
}
```

- [ ] **Step 2: Type-check the helper**

```bash
scripts/bun.sh run check
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add cicchetto/e2e/fixtures/grappaApi.ts
git commit -m "feat(e2e): add resetSubject() fixture helper

Hits POST /admin/test/reset-subject with the seeded admin bearer.
Throws on non-204 so afterEach surfaces reset failures loudly."
```

---

## Task 12: Pilot — wire `resetSubject` into `m2-irssi-to-chan-defocused.spec.ts`

**Files:**
- Modify: `cicchetto/e2e/tests/m2-irssi-to-chan-defocused.spec.ts`

- [ ] **Step 1: Add the afterEach**

In `cicchetto/e2e/tests/m2-irssi-to-chan-defocused.spec.ts`, add at the top of the `test(...)` body's enclosing scope (Playwright `test()` calls can use `test.afterEach`):

```typescript
import { test, expect } from "@playwright/test";
import {
  loginAs,
  selectChannel,
  sidebarMessageBadge,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted, resetSubject } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import {
  AUTOJOIN_CHANNELS,
  getSeededAdmin,
  getSeededVjt,
  NETWORK_NICK,
  NETWORK_SLUG,
  VJT_USER,
} from "../fixtures/seedData";

// E2E-ROBUSTNESS bucket D pilot — restore vjt's seed state after
// every test in this file so the next spec in lex order doesn't
// inherit window-state / cursor / Session.Server in-memory drift.
test.afterEach(async () => {
  const admin = getSeededAdmin();
  await resetSubject(admin.token, VJT_USER);
});

// ... rest of the file unchanged
```

- [ ] **Step 2: Run the pilot spec in isolation 5×**

```bash
scripts/integration.sh --project chromium --repeat-each 5 -- tests/m2-irssi-to-chan-defocused.spec.ts
```

Expected: 5/5 ✓. (Per `feedback_bisect_sample_size_required` — single iso is not enough.)

- [ ] **Step 3: Commit**

```bash
git add cicchetto/e2e/tests/m2-irssi-to-chan-defocused.spec.ts
git commit -m "test(m2): pilot afterEach reset (E2E-ROBUSTNESS bucket D)

Wires resetSubject() afterEach so m2 leaves no Session.Server
in-memory drift for downstream specs to inherit. Pilot for
the cluster's per-spec reset rollout — see todo.md cluster brief."
```

---

## Task 13: Pilot — wire `resetSubject` into `cursor-walks-with-scroll.spec.ts`

**Files:**
- Modify: `cicchetto/e2e/tests/cursor-walks-with-scroll.spec.ts`

Mirror Task 12 for the cursor spec. The existing `afterAll` `restoreReadCursorToTail` from cp48 STAYS (defense-in-depth — becomes a no-op after reset but documents intent).

- [ ] **Step 1: Add the afterEach**

```typescript
import { getSeededAdmin, VJT_USER } from "../fixtures/seedData";
import { resetSubject } from "../fixtures/grappaApi";

test.afterEach(async () => {
  const admin = getSeededAdmin();
  await resetSubject(admin.token, VJT_USER);
});
```

(Place near the top of the `describe`/`test.describe` block, alongside the existing `afterAll`.)

- [ ] **Step 2: Run iso 5×**

```bash
scripts/integration.sh --project chromium --repeat-each 5 -- tests/cursor-walks-with-scroll.spec.ts
```

Expected: 5/5 ✓.

- [ ] **Step 3: Commit**

```bash
git add cicchetto/e2e/tests/cursor-walks-with-scroll.spec.ts
git commit -m "test(cursor-walks): pilot afterEach reset (E2E-ROBUSTNESS bucket D)

Sibling pilot to m2. Existing cp48 afterAll
restoreReadCursorToTail stays as defense-in-depth — becomes
a no-op after reset, documents intent."
```

---

## Task 14: Decision gate — measure cascade elimination

- [ ] **Step 1: Run full chromium suite 5× in a row**

```bash
for i in 1 2 3 4 5; do
  echo "===== RUN $i ====="
  scripts/integration.sh --project chromium 2>&1 | tee /tmp/e2e-d-run-$i.log | tail -20
done
```

Count failing specs per run. Compare against pre-Task-12 baseline
(documented in cp48 S2: 3-4 ✘ per run with rotating victim set).

- [ ] **Step 2: Apply decision rule**

- **Cascade eliminated (≤ 1 rotating victim across the 5 runs)**: scale to all specs (Task 15). Record the per-run failure counts in the next commit message + cp49.
- **Cascade unchanged (≥ 2 rotating victims per run, set rotating)**: STOP. Roll back Tasks 12-13 with `git revert`. Return to systematic-debugging Phase 1: the reset doesn't drain the actual leak class. New hypothesis needed. Document the negative result in cp49 and do NOT proceed to Task 15.

This is a HARD gate. Do not proceed to Task 15 without explicit pass.

---

## Task 15: Scale — wire reset into a shared afterEach for all vjt-touching specs

**Files:**
- Create: `cicchetto/e2e/fixtures/globalAfterEach.ts` (or modify `cicchettoPage.ts`)
- Modify: per-spec imports if a shared helper export is used

The simplest scale: factor the afterEach into a `setupSubjectReset(test)` helper in `cicchettoPage.ts`, called once at the top of every spec.

- [ ] **Step 1: Add the helper to `cicchettoPage.ts`**

```typescript
// E2E-ROBUSTNESS bucket D — per-spec subject reset. Specs using
// the seeded vjt user MUST call this at file top-level (before
// any test) so every test in the file ends with a clean grappa-
// side state.
//
// Why a helper not a global setup: not every spec uses vjt
// (admin specs use admin-vjt; m9b specs use their own users).
// Opt-in via explicit call keeps the wire deterministic and
// avoids resetting users a spec never touched.
import type { TestType } from "@playwright/test";
import { getSeededAdmin, VJT_USER } from "./seedData";
import { resetSubject } from "./grappaApi";

export function setupSubjectReset(test: TestType<any, any>): void {
  test.afterEach(async () => {
    const admin = getSeededAdmin();
    await resetSubject(admin.token, VJT_USER);
  });
}
```

- [ ] **Step 2: Wire into every vjt-touching spec**

Find every spec that imports `getSeededVjt`:

```bash
grep -l "getSeededVjt" cicchetto/e2e/tests/*.spec.ts
```

For each, add at the file top (after imports, before describes):

```typescript
import { setupSubjectReset } from "../fixtures/cicchettoPage";

setupSubjectReset(test);
```

Remove the pilot inline `test.afterEach(...)` blocks added in Tasks 12-13 — they're now covered by the helper.

- [ ] **Step 3: Type-check**

```bash
scripts/bun.sh run check
```

- [ ] **Step 4: Run full chromium 5×**

```bash
for i in 1 2 3 4 5; do
  echo "===== RUN $i ====="
  scripts/integration.sh --project chromium 2>&1 | tail -20
done
```

Expected per the gate's threshold: ≤ 1 rotating victim across 5 runs.

- [ ] **Step 5: Commit**

```bash
git add cicchetto/e2e/fixtures/cicchettoPage.ts cicchetto/e2e/tests/*.spec.ts
git commit -m "test(e2e): scale per-spec subject reset to all vjt specs

Factors the pilot afterEach into setupSubjectReset(test) helper
in cicchettoPage.ts; every vjt-touching spec opts in via a single
line at file top. Cascade elimination verified by 5x full chromium
runs (see commit body for per-run counts)."
```

---

## Task 16: Run full check.sh and confirm green

- [ ] **Step 1: Full gate run**

```bash
scripts/check.sh
```

Expected: format ✓, credo ✓, mix test 2455+ ✓, dialyzer ✓, sobelow ✓, deps.audit / hex.audit ✓, doctor ✓, bun check ✓, bun test 1641+ ✓, bats 1..24 ✓.

- [ ] **Step 2: Webkit-iphone-15 suite (regression-canary)**

```bash
scripts/integration.sh --project webkit-iphone-15
```

Expected: 59/59 ✓ (BUGHUNT-3 D Switch/Match baseline).

- [ ] **Step 3: If any gate is red, fix root cause first**

Per CLAUDE.md "Fix root causes, not examples." Don't merge with a red gate.

---

## Task 17: Update docs and merge

**Files:**
- Modify: `docs/checkpoints/2026-05-25-cp49.md`
- Modify: `docs/todo.md`
- Modify: `docs/TESTING.md`
- Modify: `README.md` (if the admin surface section enumerates routes)

- [ ] **Step 1: Document in cp49**

Add a "Bucket D — CLOSED" block to cp49 with the per-run failure counts + the design-doc + plan links. Carry the verbatim commit shas.

- [ ] **Step 2: Update todo.md**

Move the E2E-ROBUSTNESS bucket D line from Immediate → cp49 closed block. Leave A/B/C/E/Z open in Immediate.

- [ ] **Step 3: Update docs/TESTING.md**

Add a short section under e2e tooling describing `setupSubjectReset(test)` + the `/admin/test/reset-subject` contract, so future test authors find the pattern.

- [ ] **Step 4: Commit docs**

```bash
git add docs/checkpoints/2026-05-25-cp49.md docs/todo.md docs/TESTING.md README.md
git commit -m "docs: E2E-ROBUSTNESS bucket D CLOSED — cp49 + todo + TESTING

Per-spec subject reset endpoint shipped; cascade eliminated
(see commit body for verification counts). Bucket A/B/C/E/Z
remain open per cluster brief."
```

- [ ] **Step 5: Rebase + merge to main**

```bash
git rebase main
git checkout main
git merge --ff-only e2e-robustness-d
```

- [ ] **Step 6: Deploy**

```bash
scripts/deploy.sh
scripts/healthcheck.sh
```

Per CLAUDE.md hot-vs-cold rules: this change touches `lib/grappa/application.ex`? No. Touches state shape of long-lived modules? No. Adds migrations? No. Adds nginx changes — `infra/nginx.conf` IS in the cold-required list per CLAUDE.md. The deploy preflight will force COLD; if it doesn't, override with `--force-cold` because nginx config changes need a container restart.

- [ ] **Step 7: Push**

```bash
git push origin main
```

- [ ] **Step 8: Mark task #2 complete**

```bash
# In the orchestrator's TaskUpdate
# (this happens in the Claude conversation, not as a shell command)
```

---

## Self-Review

**Spec coverage (against `docs/superpowers/specs/2026-05-25-e2e-robustness-d-design.md`):**
- "Drain DB rows for user_id" — Tasks 1-5 cover cursors / query_windows / push / user_settings / uploads. ✓ Scrollback messages intentionally skipped per spec ("specs don't read tail-relative"). ✓
- "Restart Session.Server with notify_pid mechanism" — Task 8 implements the orchestrator using `Session.stop_session` + `SpawnOrchestrator.spawn` + `await_ready` mirroring `Visitors.Login.preempt_and_respawn`. ✓
- "Reset ETS: NetworkCircuit, WSPresence, Session.Backoff" — Task 6 (NetworkCircuit confirmation), Task 7 (new WSPresence.reset_for_user/1), and existing `Backoff.reset/2` are all called from Task 8's orchestrator. ✓
- "Compile-gated HTTP endpoint" — Task 8 + Task 9 both `if Mix.env() in [:dev, :test]`. Task 9 wires the route under the same guard. ✓
- "Hard 5s timeout, 504 on timeout" — `@reset_timeout_ms 5_000` in Task 8; controller maps `{:reconnect_timeout, slug}` → 504. ✓
- "Subject MUST be passed explicitly, never default" — controller accepts `%{"user_name" => ...}` only; `422` when missing. ✓
- "Pilot first, then scale" — Task 12 (m2) + Task 13 (cursor) + Task 14 (gate) + Task 15 (scale). ✓
- "Boundary annotation for TestSupport" — NOT explicitly added in the plan. Adding here: Task 8 should include a `use Boundary, top_level?: true, deps: [Grappa.Accounts, Grappa.Networks, ...]` line if the project uses Boundary on every context module. Read `lib/grappa/networks.ex` to see if Boundary is used here; if yes, add the annotation; if it's only on top-level apps, skip.

**Placeholder scan:** No "TBD", no "implement later," every code block contains executable code, every command has a concrete expected output description.

**Type consistency:** `SubjectReset.reset!/1` returns `:ok | {:error, reset_error()}` in Task 8; controller matches that exact shape in Task 9. `resetSubject(adminToken, userName)` signature consistent in Task 11 + Tasks 12/13/15.

**Open verification flagged inline in tasks:**
- Task 2: confirm `QueryWindows` actual public API verb names
- Task 3: confirm `Grappa.Push` module name vs `Grappa.Push.Subscriptions`
- Task 4: confirm `UserSettings.defaults/0` existence
- Task 5: confirm whether `Uploads.delete/1` cleans up on-disk files
- Task 6: confirm `NetworkCircuit.reset/1` is prod-callable (likely yes per file read)
- Task 8: confirm `Networks.SessionPlan.resolve/1` argument shape for credential variant; `Accounts.fetch_user_by_name/1` exact name; `Admission.check_capacity/1` required fields
- Task 10: nginx admin allowlist exact `location` block format from existing entries
- Task 15: prune the pilot inline afterEach blocks added in 12/13

These are intentional read-and-confirm steps — the implementing engineer fixes the actual call sites in the same task.
