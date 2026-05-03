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
  Three counters: `spawned` + `skipped` + `failed` (M-life-4) — the FK
  from `network_credentials.user_id` to `users.id` makes a "user not in
  DB" scenario unrepresentable.

  `async: false` because `Grappa.SessionSupervisor` and the singleton
  `Grappa.SessionRegistry` are shared across tests; concurrent runs
  would collide on session keys.
  """
  use Grappa.DataCase, async: false

  import ExUnit.CaptureLog
  import Grappa.AuthFixtures

  alias Grappa.{Bootstrap, IRCServer, Networks, Session, Visitors}
  alias Grappa.Networks.{Credentials, Servers}

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

      assert {:ok, %Bootstrap.Result{}} = Bootstrap.run()

      assert is_pid(Session.whereis({:user, vjt.id}, net_a.id))
      assert is_pid(Session.whereis({:user, vjt.id}, net_b.id))
    end

    test "logs structured summary line with spawned/skipped/failed counts" do
      vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      {_, port} = start_server()
      net = bind_db(vjt, "summary-#{System.unique_integer([:positive])}", port)

      on_exit(fn -> stop_session(vjt.id, net.id) end)

      Logger.put_module_level(Grappa.Bootstrap, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Bootstrap) end)

      log = capture_log(fn -> Bootstrap.run() end)

      assert log =~ "bootstrap done"
      assert log =~ "spawned=1"
      assert log =~ "skipped=0"
      assert log =~ "failed=0"
    end
  end

  describe "run/0 with no credentials bound" do
    test "returns :ok, logs warning, no sessions started" do
      Logger.put_module_level(Grappa.Bootstrap, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Bootstrap) end)

      log = capture_log(fn -> assert {:ok, %Bootstrap.Result{}} = Bootstrap.run() end)

      assert log =~ "no credentials bound"
      assert log =~ "running web-only"
    end
  end

  describe "run/0 idempotency on Bootstrap restart" do
    test "second run finds existing sessions and counts them as skipped, not failed" do
      # F3 (S29 carryover) + M-life-4: Bootstrap is `restart: :transient`.
      # On the one allowed restart every previously-spawned session is
      # still alive under the same Registry key, so
      # `Session.start_session/3` returns
      # `{:error, {:already_started, pid}}`. Pre-fix this fell into the
      # catch-all `{:error, reason}` branch and bumped the `failed`
      # counter — operator on call would chase a non-issue every time
      # Bootstrap restarted. Post-M-life-4: routed to `:skipped`
      # (idempotent NO-OP — the session is already up; Bootstrap did
      # not bring this up *now*, so `:spawned` would lie too).
      vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      {_, port} = start_server()
      net = bind_db(vjt, "idem-#{System.unique_integer([:positive])}", port)

      on_exit(fn -> stop_session(vjt.id, net.id) end)

      Logger.put_module_level(Grappa.Bootstrap, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Bootstrap) end)

      assert {:ok, %Bootstrap.Result{spawned: 1, skipped: 0, failed: 0}} = Bootstrap.run()
      pid_after_first = Session.whereis({:user, vjt.id}, net.id)
      assert is_pid(pid_after_first)

      log =
        capture_log(fn ->
          assert {:ok, %Bootstrap.Result{spawned: 0, skipped: 1, failed: 0}} = Bootstrap.run()
        end)

      assert log =~ "spawned=0"
      assert log =~ "skipped=1"
      assert log =~ "failed=0"
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

      log = capture_log(fn -> assert {:ok, %Bootstrap.Result{}} = Bootstrap.run() end)

      assert log =~ "spawned=2"
      assert log =~ "skipped=0"
      assert log =~ "failed=0"
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

      log = capture_log(fn -> assert {:ok, %Bootstrap.Result{}} = Bootstrap.run() end)

      assert is_pid(Session.whereis({:visitor, visitor.id}, network.id))
      assert log =~ "bootstrap visitors done"
      assert log =~ "spawned=1"
      assert log =~ "skipped=0"
      assert log =~ "failed=0"
    end

    test "registered visitor (password set) respawns alongside anon visitors" do
      {_, port} = start_server()
      {visitor, network} = visitor_with_network(port)
      {:ok, _} = Visitors.commit_password(visitor.id, "s3cret")

      on_exit(fn -> stop_visitor_session(visitor.id, network.id) end)

      assert {:ok, %Bootstrap.Result{}} = Bootstrap.run()

      assert is_pid(Session.whereis({:visitor, visitor.id}, network.id))
    end

    test "expired visitor row is skipped (list_active filters)" do
      past = DateTime.add(DateTime.utc_now(), -1, :hour)
      visitor = visitor_fixture(expires_at: past)

      assert {:ok, %Bootstrap.Result{}} = Bootstrap.run()

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
  end

  describe "run/0 W7 hard-error on visitor pinned to unconfigured network" do
    # W7 invariant: every active visitor's `network_slug` must resolve
    # to a configured `Networks.Network` row at boot. A visitor pinned
    # to a slug that the operator has since dropped from the DB is an
    # orphan — `Visitors.Login` and `Visitors.SessionPlan` both trust
    # the slug → network resolution to succeed at runtime, so the only
    # safe thing at boot is to refuse to start the app and tell the
    # operator how to recover. Silent reap would lose user data on a
    # config typo; a noisy raise puts the choice in the operator's
    # hands (restore the network row OR explicitly run
    # `mix grappa.reap_visitors --network=<slug>`).
    test "raises with operator instructions when visitor.network_slug not configured" do
      orphan_slug = "ghosted-#{System.unique_integer([:positive])}"
      _ = visitor_fixture(network_slug: orphan_slug)

      assert_raise RuntimeError, ~r/visitor rows pinned.*#{orphan_slug}.*reap_visitors/, fn ->
        Bootstrap.run()
      end
    end

    test "does not raise when every visitor's network_slug is configured" do
      {_, port} = start_server()
      {visitor, network} = visitor_with_network(port)
      on_exit(fn -> stop_visitor_session(visitor.id, network.id) end)

      assert {:ok, %Bootstrap.Result{}} = Bootstrap.run()
    end
  end

  describe "run/0 network total cap (T31)" do
    # Plan 2 Task 4 — Bootstrap respects per-network total session cap on
    # cold-start. If `networks.max_concurrent_sessions` is lower than the
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
        |> Grappa.Networks.Network.changeset(%{max_concurrent_sessions: 1})
        |> Grappa.Repo.update()

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

      log = capture_log(fn -> assert {:ok, %Bootstrap.Result{}} = Bootstrap.run() end)

      on_exit(fn -> clear_registry_for(network.id) end)

      started_rows =
        Registry.select(Grappa.SessionRegistry, [
          {{{:session, :_, network.id}, :_, :_}, [], [true]}
        ])

      assert length(started_rows) == 1
      assert log =~ "skipped — network cap"
    end

    test "result reports skipped count for cap-rejected sessions, not failed" do
      # M-life-4: cap-rejected rows are policy decisions, NOT failures.
      # Bootstrap returns `{:ok, %Result{spawned: N, failed: 0, skipped: K}}`
      # so an operator dashboard distinguishes "real start error"
      # (`failed > 0` — investigate) from "cap policy tripped"
      # (`skipped > 0` — operator chose this; size cap correctly or it's
      # working as intended). Already-running sessions on a Bootstrap
      # restart also flow into `:skipped` (idempotent no-op, nothing to
      # do), not `:spawned` (Bootstrap did NOT bring this up — it was
      # already alive).
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
        |> Grappa.Networks.Network.changeset(%{max_concurrent_sessions: 2})
        |> Grappa.Repo.update()

      for n <- 1..3 do
        visitor_fixture(network_slug: slug, nick: "v#{n}#{System.unique_integer([:positive])}")
      end

      Logger.put_module_level(Grappa.Bootstrap, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Bootstrap) end)

      :ok = clear_registry_for(network.id)
      on_exit(fn -> clear_registry_for(network.id) end)

      assert {:ok, %Bootstrap.Result{spawned: 2, failed: 0, skipped: 1}} = Bootstrap.run()
    end
  end
end
