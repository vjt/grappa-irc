defmodule Grappa.BootstrapTest do
  @moduledoc """
  Tests for `Grappa.Bootstrap` — the module that reads `grappa.toml` at
  app boot and spawns one `Grappa.Session` per `(user, network)`.

  Tests invoke `Bootstrap.run/1` synchronously rather than going through
  `start_link/1` — the production wrapper exists only for supervision-
  tree placement; the testable surface is the synchronous `run/1`.

  ## Sub-task 2g — TOML-as-spawn-list, DB-as-source-of-truth

  Bootstrap reads TOML for the `(user_name, network_slug)` pairs to
  spawn at boot. Everything else (host / port / nick / password /
  auth_method / autojoin) lives in the DB — `Networks.bind_credential/3`
  + `Networks.add_server/2` must have run before Bootstrap can boot a
  session for a given pair. Tests pre-bind those rows in setup; the
  TOML's per-network credential fields are read-but-ignored.

  `async: false` because `Grappa.SessionSupervisor` and the singleton
  `Grappa.SessionRegistry` are shared across tests; concurrent runs
  would collide on session keys.
  """
  use Grappa.DataCase, async: false

  import ExUnit.CaptureLog
  import Grappa.AuthFixtures

  alias Grappa.{Bootstrap, IRCServer, Networks, Session}

  setup do
    # Bootstrap reads TOML user "vjt"; Phase 2 made user identity
    # DB-backed (FK on messages.user_id). Pre-insert the row so
    # Bootstrap finds it instead of logging "user not in DB" and
    # skipping every network.
    vjt = user_fixture(name: "vjt")
    %{vjt: vjt}
  end

  defp passthrough_handler, do: fn state, _ -> {:reply, nil, state} end

  defp start_server do
    {:ok, server} = IRCServer.start_link(passthrough_handler())
    {server, IRCServer.port(server)}
  end

  defp write_config(toml) do
    path =
      Path.join(System.tmp_dir!(), "grappa_bootstrap_test_#{System.unique_integer([:positive])}.toml")

    :ok = File.write!(path, toml)
    on_exit(fn -> File.rm(path) end)
    path
  end

  # Bind a DB credential + server for `(user, slug)` so Session.Server.init
  # can resolve them at boot. `port` is the IRCServer fake's listening port.
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

  describe "run/1 with valid config" do
    test "spawns one session per (user, network) entry", %{vjt: vjt} do
      {_, port_a} = start_server()
      {_, port_b} = start_server()

      net_a = bind_db(vjt, "neta", port_a)
      net_b = bind_db(vjt, "netb", port_b)

      toml = """
      [server]
      listen = "127.0.0.1:4000"

      [[users]]
      name = "vjt"

      [[users.networks]]
      id = "neta"
      host = "127.0.0.1"
      port = #{port_a}
      tls = false
      nick = "vjt"

      [[users.networks]]
      id = "netb"
      host = "127.0.0.1"
      port = #{port_b}
      tls = false
      nick = "vjt"
      """

      path = write_config(toml)
      on_exit(fn -> stop_session(vjt.id, net_a.id) end)
      on_exit(fn -> stop_session(vjt.id, net_b.id) end)

      assert :ok = Bootstrap.run(config_path: path)

      assert is_pid(Session.whereis(vjt.id, net_a.id))
      assert is_pid(Session.whereis(vjt.id, net_b.id))
    end

    test "logs structured summary line with started/failed counts", %{vjt: vjt} do
      {_, port} = start_server()
      net = bind_db(vjt, "summary_net", port)

      toml = """
      [server]
      listen = "127.0.0.1:4000"

      [[users]]
      name = "vjt"

      [[users.networks]]
      id = "summary_net"
      host = "127.0.0.1"
      port = #{port}
      tls = false
      nick = "vjt"
      """

      path = write_config(toml)
      on_exit(fn -> stop_session(vjt.id, net.id) end)

      Logger.put_module_level(Grappa.Bootstrap, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Bootstrap) end)

      log = capture_log(fn -> Bootstrap.run(config_path: path) end)

      assert log =~ "bootstrap done"
      assert log =~ "started=1"
      assert log =~ "failed=0"
    end
  end

  describe "run/1 failure modes (boot web-only)" do
    test "missing config file: returns :ok, logs warning, no sessions started" do
      missing_path =
        Path.join(System.tmp_dir!(), "definitely_not_here_#{System.unique_integer([:positive])}.toml")

      log = capture_log(fn -> assert :ok = Bootstrap.run(config_path: missing_path) end)

      assert log =~ "bootstrap"
      assert log =~ "running web-only"
    end

    test "malformed toml: returns :ok, logs warning, no crash" do
      path = write_config("this is not valid [toml")

      log = capture_log(fn -> assert :ok = Bootstrap.run(config_path: path) end)

      assert log =~ "bootstrap"
      assert log =~ "running web-only"
    end

    test "valid toml missing required field: returns :ok, logs warning" do
      path =
        write_config("""
        [server]
        listen = "127.0.0.1:4000"

        [[users]]
        name = "vjt"

        [[users.networks]]
        id = "incomplete"
        # missing host, port, tls, nick
        """)

      log = capture_log(fn -> assert :ok = Bootstrap.run(config_path: path) end)

      assert log =~ "bootstrap"
      assert log =~ "running web-only"
    end
  end

  describe "run/1 with TOML user not in DB" do
    test "skips that user's networks, logs skipped count, does NOT count as failed", %{vjt: vjt} do
      # TOML names a user with no DB row. Bootstrap logs `skipped=N`
      # separately from `failed=N` so the operator can tell "I forgot
      # to seed a user" apart from "the IRC network is down."
      {_, port} = start_server()
      good_net = bind_db(vjt, "good_net", port)

      ghost_name = "ghost-#{System.unique_integer([:positive])}"

      toml = """
      [server]
      listen = "127.0.0.1:4000"

      [[users]]
      name = "vjt"

      [[users.networks]]
      id = "good_net"
      host = "127.0.0.1"
      port = #{port}
      tls = false
      nick = "vjt"

      [[users]]
      name = "#{ghost_name}"

      [[users.networks]]
      id = "ghost_net_a"
      host = "127.0.0.1"
      port = #{port}
      tls = false
      nick = "ghost"

      [[users.networks]]
      id = "ghost_net_b"
      host = "127.0.0.1"
      port = #{port}
      tls = false
      nick = "ghost"
      """

      path = write_config(toml)
      on_exit(fn -> stop_session(vjt.id, good_net.id) end)

      Logger.put_module_level(Grappa.Bootstrap, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Bootstrap) end)

      log = capture_log(fn -> assert :ok = Bootstrap.run(config_path: path) end)

      assert log =~ "started=1"
      assert log =~ "failed=0"
      assert log =~ "skipped=2"
      assert log =~ "user not in DB, skipping"
    end
  end

  describe "run/1 partial failure" do
    test "some sessions start, some fail — summary reflects both", %{vjt: vjt} do
      {_, port_ok} = start_server()
      # 1 is a privileged port; connect from container as non-root will fail.
      port_bad = 1

      ok_net = bind_db(vjt, "ok_net", port_ok)
      bad_net = bind_db(vjt, "bad_net", port_bad)

      toml = """
      [server]
      listen = "127.0.0.1:4000"

      [[users]]
      name = "vjt"

      [[users.networks]]
      id = "ok_net"
      host = "127.0.0.1"
      port = #{port_ok}
      tls = false
      nick = "vjt"

      [[users.networks]]
      id = "bad_net"
      host = "127.0.0.1"
      port = #{port_bad}
      tls = false
      nick = "vjt"
      """

      path = write_config(toml)
      on_exit(fn -> stop_session(vjt.id, ok_net.id) end)
      on_exit(fn -> stop_session(vjt.id, bad_net.id) end)

      Logger.put_module_level(Grappa.Bootstrap, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Bootstrap) end)

      log = capture_log(fn -> assert :ok = Bootstrap.run(config_path: path) end)

      assert log =~ "started=1"
      assert log =~ "failed=1"
      assert is_pid(Session.whereis(vjt.id, ok_net.id))
      assert Session.whereis(vjt.id, bad_net.id) == nil
    end

    test "missing DB credential: counted as failed (no implicit bind)", %{vjt: _vjt} do
      # Sub-task 2g contract: TOML names a (user, network) pair but the
      # DB has no Credential row for it. Session.Server.init crashes,
      # the start_session call returns {:error, _}, and Bootstrap
      # counts this on the `failed` counter — operator action is
      # `mix grappa.bind_network`, distinct from "DB user missing"
      # (which counts as `skipped`).
      {_, port} = start_server()

      toml = """
      [server]
      listen = "127.0.0.1:4000"

      [[users]]
      name = "vjt"

      [[users.networks]]
      id = "unbound_net"
      host = "127.0.0.1"
      port = #{port}
      tls = false
      nick = "vjt"
      """

      path = write_config(toml)

      Logger.put_module_level(Grappa.Bootstrap, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Bootstrap) end)

      log = capture_log(fn -> assert :ok = Bootstrap.run(config_path: path) end)

      assert log =~ "started=0"
      assert log =~ "failed=1"
      assert log =~ "skipped=0"
      assert log =~ "session start failed"
    end
  end
end
