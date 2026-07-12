defmodule Grappa.BootstrapTest do
  @moduledoc """
  Tests for `Grappa.Bootstrap` — the module that enumerates every
  bound `(user, network)` credential at boot and spawns one
  `Grappa.Session.Server` per row under `Grappa.SessionSupervisor`.

  Tests invoke `Bootstrap.run/0` synchronously rather than going
  through `start_link/1` — the production wrapper exists only for
  supervision-tree placement; the testable surface is the synchronous
  `run/0`.

  Operator door for binding a `(user, network)`: `mix grappa.create_user`
  + `mix grappa.bind_network --auth ...`. Bootstrap re-enumerates
  credentials on every boot via `Credentials.list_credentials_for_all_users/0`.
  Five counters (U-2 honest-log split): `spawned` + `already_running` +
  `capacity_rejected` + `network_failed` + `plan_failed` — the FK
  from `network_credentials.user_id` to `users.id` makes a "user not in
  DB" scenario unrepresentable.

  `async: false` because `Grappa.SessionSupervisor` and the singleton
  `Grappa.SessionRegistry` are shared across tests; concurrent runs
  would collide on session keys.
  """
  use Grappa.DataCase, async: false

  import ExUnit.CaptureLog
  import Grappa.AuthFixtures

  alias Grappa.{AdmissionStateHelpers, Bootstrap, IRCServer, Networks, Repo, Session, Visitors}
  alias Grappa.Bootstrap.Result
  alias Grappa.Networks.{Credentials, Network, Servers}

  # NetworkCircuit + Backoff are ETS-backed application singletons that
  # outlive the Ecto sandbox AND the container's `mix test` boundary
  # (the table is reborn on supervisor restart but stale rows from a
  # prior container can collide with the next test's auto-increment
  # network_id). Without this reset, tests intermittently fail with
  # `{:network_circuit_open, _}` whose surface line/file does not predict
  # the offending pair (memory `project_network_circuit_ets_leak`).
  setup do
    AdmissionStateHelpers.reset_all()
    :ok
  end

  defp passthrough_handler, do: fn state, _ -> {:reply, nil, state} end

  defp start_server do
    {:ok, server} = IRCServer.start_link(passthrough_handler())
    {server, IRCServer.port(server)}
  end

  # Bind a DB credential + server for `(user, slug)` so
  # Session.Server.init can resolve them at boot. `port` is the
  # IRCServer fake's listening port.
  defp bind_db(user, slug, port) do
    {:ok, network} = Networks.find_or_create_network(%{slug: slug})

    {:ok, _} = Servers.add_server(network, %{host: "127.0.0.1", port: port, tls: false})

    {:ok, _} =
      Credentials.bind_credential(user, network, %{
        nick: "vjt",
        auth_method: :none,
        autojoin_channels: []
      })

    network
  end

  defp stop_session(user_id, network_id) when is_integer(network_id) do
    case Session.whereis({:user, user_id}, network_id) do
      nil -> :ok
      pid -> DynamicSupervisor.terminate_child(Grappa.SessionSupervisor, pid)
    end
  end

  defp stop_visitor_session(visitor_id, network_id) when is_integer(network_id) do
    case Session.whereis({:visitor, visitor_id}, network_id) do
      nil -> :ok
      pid -> DynamicSupervisor.terminate_child(Grappa.SessionSupervisor, pid)
    end
  end

  # Terminates every Session.Server in `Grappa.SessionRegistry` whose key
  # points at `network_id`, then waits until `Registry.count_select/2`
  # observes the cleanup. Used by the cap test to neutralize zombie
  # sessions that other tests' DB-sandbox rollbacks make possible:
  # sqlite reuses rowids after rollback, so a `network.id` minted by the
  # cap test can collide with a stale Session.Server registered under
  # the same integer by an earlier test that started a session and
  # didn't (or couldn't synchronously) reach Registry-cleanup before
  # bootstrap_test ran. The Session.Server processes outlive the DB
  # rollback because Registry + SessionSupervisor are application-wide
  # singletons; the test contract here is "Bootstrap counts live
  # sessions against the per-network cap" so we MUST start from a
  # registry that's clean for THIS network.id, not the one inherited
  # from whichever ID-recycled session wandered in.
  @clear_registry_attempts 100
  @clear_registry_poll_ms 5
  defp clear_registry_for(network_id) when is_integer(network_id) do
    pids =
      Registry.select(Grappa.SessionRegistry, [
        {{{:session, :_, network_id}, :"$1", :_}, [], [:"$1"]}
      ])

    Enum.each(pids, fn pid ->
      ref = Process.monitor(pid)
      _ = DynamicSupervisor.terminate_child(Grappa.SessionSupervisor, pid)

      receive do
        {:DOWN, ^ref, :process, ^pid, _} -> :ok
      after
        500 -> Process.demonitor(ref, [:flush])
      end
    end)

    wait_until_registry_clear(network_id, @clear_registry_attempts)
  end

  defp wait_until_registry_clear(_, 0), do: :ok

  defp wait_until_registry_clear(network_id, attempts) do
    count =
      Registry.count_select(Grappa.SessionRegistry, [
        {{{:session, :_, network_id}, :_, :_}, [], [true]}
      ])

    if count == 0 do
      :ok
    else
      Process.sleep(@clear_registry_poll_ms)
      wait_until_registry_clear(network_id, attempts - 1)
    end
  end

  describe "run/0 with bound credentials" do
    test "spawns one session per Credential row" do
      vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      {_, port_a} = start_server()
      {_, port_b} = start_server()

      net_a = bind_db(vjt, "neta-#{System.unique_integer([:positive])}", port_a)
      net_b = bind_db(vjt, "netb-#{System.unique_integer([:positive])}", port_b)

      on_exit(fn -> stop_session(vjt.id, net_a.id) end)
      on_exit(fn -> stop_session(vjt.id, net_b.id) end)

      assert {:ok, %Result{}} = Bootstrap.run()

      assert is_pid(Session.whereis({:user, vjt.id}, net_a.id))
      assert is_pid(Session.whereis({:user, vjt.id}, net_b.id))
    end

    test "logs structured summary line with 5-bucket honest counts" do
      vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      {_, port} = start_server()
      net = bind_db(vjt, "summary-#{System.unique_integer([:positive])}", port)

      on_exit(fn -> stop_session(vjt.id, net.id) end)

      Logger.put_module_level(Grappa.Bootstrap, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Bootstrap) end)

      log = capture_log(fn -> Bootstrap.run() end)

      # U-2 (feedback_log_honesty): retire the overloaded `skipped` +
      # `failed` buckets in favor of 5 honest, separable buckets so the
      # operator dashboard can tell capacity policy from upstream-fault
      # from idempotent restart.
      assert log =~ "bootstrap done"
      assert log =~ "spawned=1"
      assert log =~ "already_running=0"
      assert log =~ "capacity_rejected=0"
      assert log =~ "network_failed=0"
      assert log =~ "plan_failed=0"
    end

    test "U-2 honest log: distinguishes capacity_rejected from network_failed in summary" do
      # U-2 (feedback_log_honesty): pre-U-2 every admission error EXCEPT
      # :network_cap_exceeded fell into the "session start failed"
      # catch-all + the `:failed` counter; same for circuit-open, which
      # is an upstream-degradation policy decision, not a row-level
      # fault. Post-U-2 the summary line carries explicit
      # `capacity_rejected=N` so operator dashboards distinguish
      # "this row didn't run because capacity policy tripped" from
      # "this row tried to connect and the upstream refused."
      vjt = user_fixture(name: "uhl-#{System.unique_integer([:positive])}")
      {_, port} = start_server()
      net = bind_db(vjt, "uhl-#{System.unique_integer([:positive])}", port)

      {:ok, _} =
        net
        |> Network.changeset(%{max_concurrent_user_sessions: 0})
        |> Repo.update()

      on_exit(fn -> stop_session(vjt.id, net.id) end)

      Logger.put_module_level(Grappa.Bootstrap, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Bootstrap) end)

      log = capture_log(fn -> Bootstrap.run() end)

      assert log =~ "bootstrap done"
      assert log =~ "capacity_rejected=1"
      assert log =~ "network_failed=0"
    end
  end

  describe "run/0 with no credentials bound" do
    test "returns :ok, logs honest 'no credentials bound' warning when DB is empty" do
      Logger.put_module_level(Grappa.Bootstrap, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Bootstrap) end)

      log = capture_log(fn -> assert {:ok, %Result{}} = Bootstrap.run() end)

      assert log =~ "no credentials bound"
      assert log =~ "running web-only"
    end

    test "T-4 honest log: surfaces parked + failed counts when zero are :connected" do
      # Pre-T-4, this scenario silently logged "no credentials bound"
      # because list_credentials_for_all_users/0 filters :connected-only.
      # Operator saw "DB is empty" lie + chased the wrong root cause.
      # Post-T-4, count_by_state/0 surfaces the truth.
      vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      {_, port} = start_server()

      net_parked = bind_db(vjt, "park-#{System.unique_integer([:positive])}", port)
      net_failed = bind_db(vjt, "fail-#{System.unique_integer([:positive])}", port)

      {:ok, _} =
        vjt
        |> Credentials.get_credential!(net_parked)
        |> Ecto.Changeset.change(connection_state: :parked, connection_state_reason: "test")
        |> Repo.update()

      {:ok, _} =
        vjt
        |> Credentials.get_credential!(net_failed)
        |> Ecto.Changeset.change(connection_state: :failed, connection_state_reason: "test")
        |> Repo.update()

      Logger.put_module_level(Grappa.Bootstrap, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Bootstrap) end)

      log = capture_log(fn -> assert {:ok, %Result{}} = Bootstrap.run() end)

      assert log =~ "0 credentials in :connected state"
      assert log =~ "1 parked"
      assert log =~ "1 failed"
      assert log =~ "bin/grappa list-credentials"
      refute log =~ "no credentials bound"
    end
  end

  describe "run/0 idempotency on Bootstrap restart" do
    test "second run finds existing sessions and counts them as already_running, not failed" do
      # F3 (S29 carryover) + M-life-4 + U-2 (feedback_log_honesty):
      # Bootstrap is `restart: :transient`. On the one allowed restart
      # every previously-spawned session is still alive under the same
      # Registry key, so `Session.start_session/3` returns
      # `{:error, {:already_started, pid}}`. Pre-fix this fell into the
      # catch-all `{:error, reason}` branch and bumped the `failed`
      # counter — operator on call would chase a non-issue every time
      # Bootstrap restarted. Post-M-life-4: routed to the `:skipped`
      # counter. Post-U-2: `:skipped` retired in favor of the 5-bucket
      # honest split; idempotent restarts now land in `:already_running`
      # (distinct from `:capacity_rejected` which is the policy-tripped
      # bucket the legacy `:skipped` also collapsed into).
      vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      {_, port} = start_server()
      net = bind_db(vjt, "idem-#{System.unique_integer([:positive])}", port)

      on_exit(fn -> stop_session(vjt.id, net.id) end)

      Logger.put_module_level(Grappa.Bootstrap, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Bootstrap) end)

      assert {:ok,
              %Result{
                spawned: 1,
                already_running: 0,
                capacity_rejected: 0,
                network_failed: 0,
                plan_failed: 0
              }} =
               Bootstrap.run()

      pid_after_first = Session.whereis({:user, vjt.id}, net.id)
      assert is_pid(pid_after_first)

      log =
        capture_log(fn ->
          assert {:ok,
                  %Result{
                    spawned: 0,
                    already_running: 1,
                    capacity_rejected: 0,
                    network_failed: 0,
                    plan_failed: 0
                  }} = Bootstrap.run()
        end)

      assert log =~ "spawned=0"
      assert log =~ "already_running=1"
      assert log =~ "capacity_rejected=0"
      assert log =~ "network_failed=0"
      assert log =~ "plan_failed=0"
      assert Session.whereis({:user, vjt.id}, net.id) == pid_after_first
    end
  end

  describe "run/0 partial failure" do
    test "all sessions counted as spawned; upstream-connect failures surface async (C2)" do
      # Pre-C2 `Session.Server.init/1` called `Client.start_link/1`
      # synchronously, so a refused upstream returned `{:error, _}` from
      # `Session.start_session/3` and Bootstrap incremented `failed`.
      # Post-C2 the Client connect lives in `handle_continue(:connect, _)`
      # — `init/1` returns `{:ok, state, {:continue, _}}` regardless of
      # upstream reachability, so Bootstrap counts every credential row
      # as `spawned`. Connect refusals surface asynchronously: the
      # Session crashes with `{:connect_failed, _}`, the per-session
      # `:transient` policy retries up to `max_restarts: 3`, then the
      # `DynamicSupervisor` terminates the child. The contract assertion
      # here is "Bootstrap returned `{:ok, %Result{}}` and reported all
      # sessions spawned"; per-session async health is observed via
      # Logger.error at session-crash time (operators grep
      # `session start failed` under the new semantic, plus
      # `(stop) {:connect_failed, _}` from the Session GenServer
      # terminate path).
      vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      {_, port_ok} = start_server()
      # 1 is a privileged port; connect from container as non-root will fail.
      port_bad = 1

      ok_net = bind_db(vjt, "ok-#{System.unique_integer([:positive])}", port_ok)
      bad_net = bind_db(vjt, "bad-#{System.unique_integer([:positive])}", port_bad)

      on_exit(fn -> stop_session(vjt.id, ok_net.id) end)
      on_exit(fn -> stop_session(vjt.id, bad_net.id) end)

      Logger.put_module_level(Grappa.Bootstrap, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Bootstrap) end)

      log = capture_log(fn -> assert {:ok, %Result{}} = Bootstrap.run() end)

      assert log =~ "spawned=2"
      assert log =~ "already_running=0"
      assert log =~ "capacity_rejected=0"
      assert log =~ "network_failed=0"
      assert log =~ "plan_failed=0"
      assert is_pid(Session.whereis({:user, vjt.id}, ok_net.id))
    end
  end

  describe "run/0 with active visitors" do
    test "spawns Session.Server per active visitor row" do
      {_, port} = start_server()
      {visitor, network} = visitor_with_network(port)

      on_exit(fn -> stop_visitor_session(visitor.id, network.id) end)

      Logger.put_module_level(Grappa.Bootstrap, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Bootstrap) end)

      log = capture_log(fn -> assert {:ok, %Result{}} = Bootstrap.run() end)

      assert is_pid(Session.whereis({:visitor, visitor.id}, network.id))
      assert log =~ "bootstrap visitors done"
      assert log =~ "spawned=1"
      assert log =~ "already_running=0"
      assert log =~ "capacity_rejected=0"
      assert log =~ "network_failed=0"
      assert log =~ "plan_failed=0"
    end

    test "registered visitor (password set) respawns alongside anon visitors" do
      {_, port} = start_server()
      {visitor, network} = visitor_with_network(port)
      {:ok, _} = Visitors.commit_password(visitor.id, network.id, "s3cret")

      on_exit(fn -> stop_visitor_session(visitor.id, network.id) end)

      assert {:ok, %Result{}} = Bootstrap.run()

      assert is_pid(Session.whereis({:visitor, visitor.id}, network.id))
    end

    test "#211 phase 4c — a multi-network visitor respawns ONE session PER credential" do
      # A single visitor identity with credentials on TWO networks
      # (post-accretion). Bootstrap must restore BOTH sessions, not just the
      # primary network_slug.
      {_, port_a} = start_server()
      {visitor, net_a} = visitor_with_network(port_a)

      {_, port_b} = start_server()
      {net_b, _} = network_with_server(port: port_b, slug: "beta", visitor_enabled: true)

      # Accrete B: attach a (visitor_id, net_b) credential to the SAME
      # identity (the credential-write choke point the accretion verb uses).
      {:ok, rep} = Credentials.representative_visitor_credential(visitor.id)

      {:ok, _} =
        Credentials.upsert_visitor_credential(visitor.id, net_b.id, %{
          nick: rep.nick,
          sasl_user: rep.nick,
          auth_method: :none
        })

      on_exit(fn ->
        stop_visitor_session(visitor.id, net_a.id)
        stop_visitor_session(visitor.id, net_b.id)
      end)

      assert {:ok, %Result{}} = Bootstrap.run()

      # BOTH networks live for the one identity.
      assert is_pid(Session.whereis({:visitor, visitor.id}, net_a.id))
      assert is_pid(Session.whereis({:visitor, visitor.id}, net_b.id))
    end

    test "#211 phase 6 — a PARKED visitor credential is NOT respawned (persistent park, ruling D)" do
      # A multi-network visitor: network A connected, network B PARKED
      # (the visitor /disconnected B before the reboot). Bootstrap must
      # restore A but SKIP B — visitor per-network disconnect persists
      # across reboot (vjt: "of course cazzo").
      {_, port_a} = start_server()
      {visitor, net_a} = visitor_with_network(port_a)

      {_, port_b} = start_server()
      {net_b, _} = network_with_server(port: port_b, slug: "beta", visitor_enabled: true)

      {:ok, rep} = Credentials.representative_visitor_credential(visitor.id)

      {:ok, cred_b} =
        Credentials.upsert_visitor_credential(visitor.id, net_b.id, %{
          nick: rep.nick,
          sasl_user: rep.nick,
          auth_method: :none
        })

      # Park B's credential (what `PATCH /networks/B {parked}` persists).
      {:ok, _} =
        cred_b
        |> Ecto.Changeset.change(connection_state: :parked, connection_state_reason: "user-disconnect")
        |> Repo.update()

      on_exit(fn ->
        stop_visitor_session(visitor.id, net_a.id)
        stop_visitor_session(visitor.id, net_b.id)
      end)

      Logger.put_module_level(Grappa.Bootstrap, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Bootstrap) end)

      log = capture_log(fn -> assert {:ok, %Result{}} = Bootstrap.run() end)

      # A came back; B stayed parked (NOT respawned).
      assert is_pid(Session.whereis({:visitor, visitor.id}, net_a.id))
      assert is_nil(Session.whereis({:visitor, visitor.id}, net_b.id))
      assert log =~ "skipping parked visitor credential"
    end

    test "expired visitor row is skipped (list_active filters)" do
      past = DateTime.add(DateTime.utc_now(), -1, :hour)
      visitor = visitor_fixture(expires_at: past)

      assert {:ok, %Result{}} = Bootstrap.run()

      # No session row should exist for an expired visitor regardless
      # of which network they were pinned to. Match against the
      # Registry key shape from `Server.registry_key/2`:
      # `{:session, subject, network_id}`.
      keys =
        Registry.select(Grappa.SessionRegistry, [
          {{{:session, {:visitor, :"$1"}, :_}, :_, :_}, [{:==, :"$1", visitor.id}], [:"$_"]}
        ])

      assert keys == []
    end

    # #211 regression: a backfilled visitor Credential (user_id IS NULL,
    # connection_state :connected) MUST NOT be picked up by the
    # user-credential spawn path. Pre-fix, `list_credentials_for_all_users/0`
    # had no subject guard, so it returned the visitor row; Bootstrap fed
    # it to `SessionPlan.resolve/1` which called `Accounts.get_user!(nil)`
    # → `Repo.get!(User, nil)` raised `ArgumentError` (NOT the rescued
    # `Ecto.NoResultsError`), crash-looping Bootstrap into app
    # termination on the boot after the visitor backfill.
    test "backfilled visitor credential is NOT spawned via the user path (no crash)" do
      {_, port} = start_server()
      # `visitor_with_network` already provisions the visitor's per-network
      # credential (the phase-3 write-through) — the same shape the phase-1
      # backfill migration produced. No manual insert needed.
      {visitor, network} = visitor_with_network(port)

      on_exit(fn -> stop_visitor_session(visitor.id, network.id) end)

      # Must return cleanly — no ArgumentError from get_user!(nil).
      assert {:ok, %Result{}} = Bootstrap.run()

      # The user-credential spawn path must never have touched the
      # visitor row: no `{:user, nil}` session, and the visitor is
      # spawned only via its own `spawn_visitors/1` path.
      assert is_pid(Session.whereis({:visitor, visitor.id}, network.id))
    end

    test "list_credentials_for_all_users/0 excludes visitor credentials" do
      {_, port} = start_server()
      # `visitor_with_network` provisions the visitor's credential.
      {visitor, network} = visitor_with_network(port)
      user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      {:ok, _} = Credentials.bind_credential(user, network, %{nick: "vjt", auth_method: :none})

      on_exit(fn -> stop_visitor_session(visitor.id, network.id) end)

      rows = Credentials.list_credentials_for_all_users()
      assert Enum.all?(rows, &(not is_nil(&1.user_id)))
      assert Enum.any?(rows, &(&1.user_id == user.id))
      refute Enum.any?(rows, &(&1.visitor_id == visitor.id))
    end
  end

  describe "run/0 visitor network resolution (#211 phase 7)" do
    # #211 phase 7 — the W7 "raise on orphan visitor.network_slug" invariant
    # was RETIRED: a visitor's networks come from its `network_credentials`
    # (FK `ON DELETE RESTRICT` to `networks`), so an orphan "visitor pinned
    # to a dropped network" is structurally impossible — the DB FK is the
    # guard. The old test that seeded a `visitor_fixture(network_slug:
    # <orphan>)` and asserted a RuntimeError is DELETED: post-phase-7 that
    # slug simply doesn't resolve, no credential is created, and Bootstrap
    # skips the credential-less visitor (logged, non-fatal).
    test "does not raise when a visitor's network is configured" do
      {_, port} = start_server()
      {visitor, network} = visitor_with_network(port)
      on_exit(fn -> stop_visitor_session(visitor.id, network.id) end)

      assert {:ok, %Result{}} = Bootstrap.run()
    end
  end

  describe "run/0 hard-error on network without enabled server" do
    # Servers-bound invariant: every distinct network referenced by a
    # bound credential or active visitor must have at least one enabled
    # server in `network_servers`. A network with zero (or all-disabled)
    # servers is silently broken in BOTH directions:
    #
    #   - Bootstrap's per-row `SessionPlan.resolve/1` returns
    #     `{:error, :no_server}` and bumps the `failed` counter, but the
    #     supervision tree comes up healthy and the operator only sees
    #     the misconfig via `grep "session start failed"`.
    #   - Every subsequent `POST /auth/login` for that network exercises
    #     the same resolve path; the controller's catch-all maps the
    #     unknown reason to `{:error, :internal}` → opaque 500 with no
    #     actionable wire signal.
    #
    # The honest signal is to refuse to boot. Mirrors the W7
    # visitor-network bias — operator misconfig is loud, never silent.
    test "raises with operator instructions when credential's network has no server" do
      vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      slug = "noserver-#{System.unique_integer([:positive])}"
      {:ok, network} = Networks.find_or_create_network(%{slug: slug})

      {:ok, _} =
        Credentials.bind_credential(vjt, network, %{
          nick: "vjt",
          auth_method: :none,
          autojoin_channels: []
        })

      assert_raise RuntimeError, ~r/no enabled server.*#{slug}.*add_server/, fn ->
        Bootstrap.run()
      end
    end

    test "raises when visitor's network exists but has no server" do
      slug = "vnoserver-#{System.unique_integer([:positive])}"
      {:ok, _} = Networks.find_or_create_network(%{slug: slug})
      _ = visitor_fixture(network_slug: slug)

      assert_raise RuntimeError, ~r/no enabled server.*#{slug}.*add_server/, fn ->
        Bootstrap.run()
      end
    end

    test "raises when only enabled-flag is false on every server" do
      vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      slug = "disabled-#{System.unique_integer([:positive])}"
      {:ok, network} = Networks.find_or_create_network(%{slug: slug})

      {:ok, server} =
        Servers.add_server(network, %{host: "127.0.0.1", port: 6667, tls: false})

      {:ok, _} =
        server
        |> Ecto.Changeset.change(enabled: false)
        |> Repo.update()

      {:ok, _} =
        Credentials.bind_credential(vjt, network, %{
          nick: "vjt",
          auth_method: :none,
          autojoin_channels: []
        })

      assert_raise RuntimeError, ~r/no enabled server.*#{slug}/, fn ->
        Bootstrap.run()
      end
    end

    test "does not raise when every referenced network has an enabled server" do
      vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      {_, port} = start_server()
      net = bind_db(vjt, "ok-#{System.unique_integer([:positive])}", port)
      on_exit(fn -> stop_session(vjt.id, net.id) end)

      assert {:ok, %Result{}} = Bootstrap.run()
    end
  end

  describe "run/0 network total cap (T31)" do
    # Plan 2 Task 4 — Bootstrap respects per-network total session cap on
    # cold-start. If `networks.max_concurrent_visitor_sessions` is lower than the
    # number of credential/visitor rows pointing at that network, the
    # over-cap rows are skipped + warned. No queue, no retry — clean
    # skip-and-log per the Bootstrap moduledoc's best-effort contract.
    test "respawn skips visitors over network cap" do
      {_, port} = start_server()
      slug = "azzurra-#{System.unique_integer([:positive])}"
      {:ok, fresh_network} = Networks.find_or_create_network(%{slug: slug})

      {:ok, _} =
        Grappa.Networks.Servers.add_server(fresh_network, %{
          host: "127.0.0.1",
          port: port,
          tls: false
        })

      {:ok, network} =
        fresh_network
        |> Network.changeset(%{max_concurrent_visitor_sessions: 1})
        |> Repo.update()

      for n <- 1..3 do
        visitor_fixture(network_slug: slug, nick: "v#{n}#{System.unique_integer([:positive])}")
      end

      Logger.put_module_level(Grappa.Bootstrap, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Bootstrap) end)

      # Neutralize zombies inherited via sqlite rowid reuse — see
      # `clear_registry_for/1` doc above. Must run AFTER the network
      # row exists (so we know its id) and BEFORE `Bootstrap.run/0`
      # (so the cap calculation starts from `live = 0` for this id).
      :ok = clear_registry_for(network.id)

      log = capture_log(fn -> assert {:ok, %Result{}} = Bootstrap.run() end)

      on_exit(fn -> clear_registry_for(network.id) end)

      started_rows =
        Registry.select(Grappa.SessionRegistry, [
          {{{:session, :_, network.id}, :_, :_}, [], [true]}
        ])

      assert length(started_rows) == 1
      assert log =~ "skipped — capacity rejected"
    end

    test "result reports capacity_rejected count for cap-rejected sessions, not network_failed" do
      # M-life-4 + U-2 (feedback_log_honesty): cap-rejected rows are
      # policy decisions, NOT faults. Bootstrap returns
      # `{:ok, %Result{spawned: N, capacity_rejected: K, network_failed: 0, ...}}`
      # so an operator dashboard distinguishes "real start error"
      # (`network_failed > 0` — investigate) from "cap policy tripped"
      # (`capacity_rejected > 0` — operator chose this; size cap
      # correctly or it's working as intended). Pre-U-2 both shared the
      # `:skipped` bucket alongside `:already_running` (idempotent
      # no-op); the honest 5-bucket split separates all three so the
      # operator dashboard surfaces the right action per condition.
      {_, port} = start_server()
      slug = "tri-#{System.unique_integer([:positive])}"
      {:ok, fresh_network} = Networks.find_or_create_network(%{slug: slug})

      {:ok, _} =
        Grappa.Networks.Servers.add_server(fresh_network, %{
          host: "127.0.0.1",
          port: port,
          tls: false
        })

      {:ok, network} =
        fresh_network
        |> Network.changeset(%{max_concurrent_visitor_sessions: 2})
        |> Repo.update()

      for n <- 1..3 do
        visitor_fixture(network_slug: slug, nick: "v#{n}#{System.unique_integer([:positive])}")
      end

      Logger.put_module_level(Grappa.Bootstrap, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Bootstrap) end)

      :ok = clear_registry_for(network.id)
      on_exit(fn -> clear_registry_for(network.id) end)

      assert {:ok,
              %Result{
                spawned: 2,
                capacity_rejected: 1,
                already_running: 0,
                network_failed: 0,
                plan_failed: 0
              }} =
               Bootstrap.run()
    end
  end

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
      vjt = user_fixture(name: "pool-#{System.unique_integer([:positive])}")
      {_, port} = start_server()

      slug = "pool-#{System.unique_integer([:positive])}"
      {:ok, network} = Networks.find_or_create_network(%{slug: slug})

      {:ok, _} =
        Servers.add_server(network, %{
          host: "127.0.0.1",
          port: port,
          tls: false,
          source_address: "2a03:4000:2:33c::9000"
        })

      {:ok, _} =
        Credentials.bind_credential(vjt, network, %{
          nick: "vjt",
          auth_method: :none,
          autojoin_channels: []
        })

      on_exit(fn -> stop_session(vjt.id, network.id) end)

      Logger.put_module_level(Grappa.Bootstrap, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Bootstrap) end)

      log = capture_log(fn -> assert {:ok, %Result{}} = Bootstrap.run() end)

      # Excluded from the effective pool — pick can no longer return it.
      assert Grappa.OutboundV6Pool.effective_pool() == []
      assert log =~ "outbound pool"
      assert log =~ "1 excluded"
    end

    test "a dedicated source not in the pool is reported as not-in-pool, pool unchanged" do
      # source_address that is NOT a member of the configured pool (the
      # setup pool is 2a03:4000:2:33c::9000) — the normal dedicated-IP case.
      vjt = user_fixture(name: "pool-#{System.unique_integer([:positive])}")
      {_, port} = start_server()

      slug = "pool-#{System.unique_integer([:positive])}"
      {:ok, network} = Networks.find_or_create_network(%{slug: slug})

      {:ok, _} =
        Servers.add_server(network, %{
          host: "127.0.0.1",
          port: port,
          tls: false,
          source_address: "2001:db8::1"
        })

      {:ok, _} =
        Credentials.bind_credential(vjt, network, %{
          nick: "vjt",
          auth_method: :none,
          autojoin_channels: []
        })

      on_exit(fn -> stop_session(vjt.id, network.id) end)

      Logger.put_module_level(Grappa.Bootstrap, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Bootstrap) end)

      log = capture_log(fn -> assert {:ok, %Result{}} = Bootstrap.run() end)

      # pool keeps its single member (nothing overlapped → nothing removed)
      assert Grappa.OutboundV6Pool.effective_pool() == [
               {0x2A03, 0x4000, 0x2, 0x33C, 0, 0, 0, 0x9000}
             ]

      assert log =~ "0 excluded"
      assert log =~ "1 dedicated, not in pool"
    end
  end

  describe "classify_outcome/3 (REV-H H7 — closed-set + catch-all)" do
    # Direct unit tests on the testable seam. The dispatch is
    # tested via every documented success/failure shape, plus an
    # explicit catch-all for any future SpawnOrchestrator failure
    # tag so a 5th capacity-class atom added to
    # `Admission.capacity_error_atoms/0` does not crash-loop
    # Bootstrap.

    setup do
      %{acc: %Result{}, log_keys: [test: :ok]}
    end

    test "{:ok, :spawned} → +1 spawned", %{acc: acc, log_keys: lk} do
      assert %Result{spawned: 1} = Bootstrap.classify_outcome({:ok, :spawned, self()}, lk, acc)
    end

    test "{:ok, :already_started} → +1 already_running", %{acc: acc, log_keys: lk} do
      assert %Result{already_running: 1} =
               Bootstrap.classify_outcome({:ok, :already_started, self()}, lk, acc)
    end

    test "{:ok, :ignored} → +1 subject_row_gone", %{acc: acc, log_keys: lk} do
      assert %Result{subject_row_gone: 1, spawned: 0, network_failed: 0} =
               Bootstrap.classify_outcome({:ok, :ignored}, lk, acc)
    end

    test "every Admission.capacity_error_atoms/0 atom routes to a known bucket",
         %{acc: acc, log_keys: lk} do
      # Source-of-truth iteration: the closed set lives in
      # `Admission`. Any new atom landing in that list MUST be
      # handled explicitly here or fall into the catch-all
      # (network_failed). Test fails loudly if a new atom is added
      # without classifying — the dashboard counter must be a
      # known field.
      for atom <- Grappa.Admission.capacity_error_atoms() do
        outcome =
          case atom do
            :network_circuit_open -> {:error, {:network_circuit_open, %{}}}
            other -> {:error, other}
          end

        result = Bootstrap.classify_outcome(outcome, lk, acc)
        assert result.spawned == 0
        assert result.already_running == 0
        assert result.plan_failed == 0

        # Every CURRENT capacity atom maps to :capacity_rejected.
        # A future atom can legally route to :network_failed via
        # the catch-all — the test below pins that contract.
        assert result.capacity_rejected + result.network_failed == 1
      end
    end

    test "{:error, {:start_failed, reason}} → +1 network_failed", %{acc: acc, log_keys: lk} do
      assert %Result{network_failed: 1} =
               Bootstrap.classify_outcome({:error, {:start_failed, :econnrefused}}, lk, acc)
    end

    test "{:error, unknown_atom} catch-all → +1 network_failed (REV-H H7)",
         %{acc: acc, log_keys: lk} do
      # Concrete regression test for the catch-all. A novel
      # error tag (e.g. a future 5th capacity atom that hasn't
      # been wired through the dispatch yet, OR an entirely new
      # SpawnOrchestrator failure shape) MUST land in
      # network_failed and emit Logger.error — never crash.
      assert %Result{network_failed: 1, capacity_rejected: 0} =
               Bootstrap.classify_outcome({:error, :brand_new_failure_tag}, lk, acc)
    end

    test "{:error, unknown_tuple} catch-all → +1 network_failed",
         %{acc: acc, log_keys: lk} do
      assert %Result{network_failed: 1} =
               Bootstrap.classify_outcome({:error, {:weird, "tuple"}}, lk, acc)
    end
  end
end
