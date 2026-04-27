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
  credentials on every boot via `Networks.list_credentials_for_all_users/0`.
  Two counters: `started` + `failed` — the FK from
  `network_credentials.user_id` to `users.id` makes a "user not in DB"
  scenario unrepresentable.

  `async: false` because `Grappa.SessionSupervisor` and the singleton
  `Grappa.SessionRegistry` are shared across tests; concurrent runs
  would collide on session keys.
  """
  use Grappa.DataCase, async: false

  import ExUnit.CaptureLog
  import Grappa.AuthFixtures

  alias Grappa.{Bootstrap, IRCServer, Networks, Session}

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

    {:ok, _} = Networks.add_server(network, %{host: "127.0.0.1", port: port, tls: false})

    {:ok, _} =
      Networks.bind_credential(user, network, %{
        nick: "vjt",
        auth_method: :none,
        autojoin_channels: []
      })

    network
  end

  defp stop_session(user_id, network_id) when is_integer(network_id) do
    case Session.whereis(user_id, network_id) do
      nil -> :ok
      pid -> DynamicSupervisor.terminate_child(Grappa.SessionSupervisor, pid)
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

      assert :ok = Bootstrap.run()

      assert is_pid(Session.whereis(vjt.id, net_a.id))
      assert is_pid(Session.whereis(vjt.id, net_b.id))
    end

    test "logs structured summary line with started/failed counts" do
      vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      {_, port} = start_server()
      net = bind_db(vjt, "summary-#{System.unique_integer([:positive])}", port)

      on_exit(fn -> stop_session(vjt.id, net.id) end)

      Logger.put_module_level(Grappa.Bootstrap, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Bootstrap) end)

      log = capture_log(fn -> Bootstrap.run() end)

      assert log =~ "bootstrap done"
      assert log =~ "started=1"
      assert log =~ "failed=0"
    end
  end

  describe "run/0 with no credentials bound" do
    test "returns :ok, logs warning, no sessions started" do
      Logger.put_module_level(Grappa.Bootstrap, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Bootstrap) end)

      log = capture_log(fn -> assert :ok = Bootstrap.run() end)

      assert log =~ "no credentials bound"
      assert log =~ "running web-only"
    end
  end

  describe "run/0 idempotency on Bootstrap restart" do
    test "second run finds existing sessions and counts them as started, not failed" do
      # F3 (S29 carryover): Bootstrap is `restart: :transient`. On the
      # one allowed restart every previously-spawned session is still
      # alive under the same Registry key, so `Session.start_session/3`
      # returns `{:error, {:already_started, pid}}`. Pre-fix this fell
      # into the catch-all `{:error, reason}` branch and bumped the
      # `failed` counter — operator on call would chase a non-issue
      # every time Bootstrap restarted. Now the `:already_started`
      # case is recognized as idempotent success.
      vjt = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")
      {_, port} = start_server()
      net = bind_db(vjt, "idem-#{System.unique_integer([:positive])}", port)

      on_exit(fn -> stop_session(vjt.id, net.id) end)

      Logger.put_module_level(Grappa.Bootstrap, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Bootstrap) end)

      assert :ok = Bootstrap.run()
      pid_after_first = Session.whereis(vjt.id, net.id)
      assert is_pid(pid_after_first)

      log = capture_log(fn -> assert :ok = Bootstrap.run() end)

      assert log =~ "started=1"
      assert log =~ "failed=0"
      assert Session.whereis(vjt.id, net.id) == pid_after_first
    end
  end

  describe "run/0 partial failure" do
    test "all sessions counted as started; upstream-connect failures surface async (C2)" do
      # Pre-C2 `Session.Server.init/1` called `Client.start_link/1`
      # synchronously, so a refused upstream returned `{:error, _}` from
      # `Session.start_session/3` and Bootstrap incremented `failed`.
      # Post-C2 the Client connect lives in `handle_continue(:connect, _)`
      # — `init/1` returns `{:ok, state, {:continue, _}}` regardless of
      # upstream reachability, so Bootstrap counts every credential row
      # as `started`. Connect refusals surface asynchronously: the
      # Session crashes with `{:connect_failed, _}`, the per-session
      # `:transient` policy retries up to `max_restarts: 3`, then the
      # `DynamicSupervisor` terminates the child. The contract assertion
      # here is "Bootstrap returned :ok and reported all sessions
      # started"; per-session async health is observed via Logger.error
      # at session-crash time (operators grep `session start failed`
      # under the new semantic, plus `(stop) {:connect_failed, _}` from
      # the Session GenServer terminate path).
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

      log = capture_log(fn -> assert :ok = Bootstrap.run() end)

      assert log =~ "started=2"
      assert log =~ "failed=0"
      assert is_pid(Session.whereis(vjt.id, ok_net.id))
    end
  end
end
