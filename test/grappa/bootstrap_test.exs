defmodule Grappa.BootstrapTest do
  @moduledoc """
  Tests for `Grappa.Bootstrap` — the module that reads `grappa.toml` at
  app boot and spawns one `Grappa.Session` per `(user, network)`.

  Tests invoke `Bootstrap.run/1` synchronously rather than going through
  `start_link/1` — the production wrapper exists only for supervision-
  tree placement; the testable surface is the synchronous `run/1`.

  `async: false` because `Grappa.SessionSupervisor` and the singleton
  `Grappa.SessionRegistry` are shared across tests; concurrent runs
  would collide on session keys.
  """
  use Grappa.DataCase, async: false

  import ExUnit.CaptureLog
  import Grappa.AuthFixtures

  alias Grappa.{Bootstrap, IRCServer, Session}

  setup do
    # Bootstrap reads TOML user "vjt"; Phase 2 made user identity
    # DB-backed (FK on messages.user_id). Pre-insert the row so
    # Bootstrap finds it instead of logging "user not in DB" and
    # skipping every network.
    user_fixture(name: "vjt")
    :ok
  end

  defp passthrough_handler, do: fn state, _ -> {:reply, nil, state} end

  defp start_server do
    {:ok, server} = IRCServer.start_link(passthrough_handler())
    {server, IRCServer.port(server)}
  end

  defp write_config(toml) do
    path = Path.join(System.tmp_dir!(), "grappa_bootstrap_test_#{System.unique_integer([:positive])}.toml")
    :ok = File.write!(path, toml)
    on_exit(fn -> File.rm(path) end)
    path
  end

  defp stop_session(user, network) do
    case Session.whereis(user, network) do
      nil -> :ok
      pid -> DynamicSupervisor.terminate_child(Grappa.SessionSupervisor, pid)
    end
  end

  describe "run/1 with valid config" do
    test "spawns one session per (user, network) entry" do
      {_, port_a} = start_server()
      {_, port_b} = start_server()

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
      on_exit(fn -> stop_session("vjt", "neta") end)
      on_exit(fn -> stop_session("vjt", "netb") end)

      assert :ok = Bootstrap.run(config_path: path)

      assert is_pid(Session.whereis("vjt", "neta"))
      assert is_pid(Session.whereis("vjt", "netb"))
    end

    test "logs structured summary line with started/failed counts" do
      {_, port} = start_server()

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
      on_exit(fn -> stop_session("vjt", "summary_net") end)

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
      missing_path = Path.join(System.tmp_dir!(), "definitely_not_here_#{System.unique_integer([:positive])}.toml")

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

  describe "run/1 partial failure" do
    test "some sessions start, some fail — summary reflects both" do
      {_, port_ok} = start_server()
      # 1 is a privileged port; connect from container as non-root will fail.
      port_bad = 1

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
      on_exit(fn -> stop_session("vjt", "ok_net") end)
      on_exit(fn -> stop_session("vjt", "bad_net") end)

      Logger.put_module_level(Grappa.Bootstrap, :info)
      on_exit(fn -> Logger.delete_module_level(Grappa.Bootstrap) end)

      log = capture_log(fn -> assert :ok = Bootstrap.run(config_path: path) end)

      assert log =~ "started=1"
      assert log =~ "failed=1"
      assert is_pid(Session.whereis("vjt", "ok_net"))
      assert Session.whereis("vjt", "bad_net") == nil
    end
  end
end
