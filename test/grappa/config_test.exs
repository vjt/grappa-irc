defmodule Grappa.ConfigTest do
  use ExUnit.Case, async: true

  alias Grappa.Config

  defp write_toml(contents) do
    path = Path.join(System.tmp_dir!(), "grappa-#{System.unique_integer([:positive])}.toml")
    File.write!(path, contents)
    on_exit(fn -> File.rm(path) end)
    path
  end

  test "parses a minimal config with one user and one network" do
    path =
      write_toml("""
      [server]
      listen = "127.0.0.1:4000"

      [[users]]
      name = "vjt"

      [[users.networks]]
      id = "azzurra"
      host = "irc.azzurra.chat"
      port = 6697
      tls = true
      nick = "vjt-claude"
      """)

    assert {:ok, %Config{} = cfg} = Config.load(path)
    assert cfg.server.listen == "127.0.0.1:4000"
    assert [user] = cfg.users
    assert user.name == "vjt"
    assert [net] = user.networks
    assert net.id == "azzurra"
    assert net.host == "irc.azzurra.chat"
    assert net.port == 6697
    assert net.tls == true
    assert net.nick == "vjt-claude"
    assert net.sasl_password == nil
    assert net.autojoin == []
  end

  test "rejects a [[users]] entry missing the name field" do
    path =
      write_toml("""
      [server]
      listen = "127.0.0.1:4000"

      [[users]]
      nickname = "wrong-key"
      """)

    assert {:error, msg} = Config.load(path)
    assert msg =~ "name"
  end

  test "rejects an empty users array" do
    path =
      write_toml("""
      [server]
      listen = "127.0.0.1:4000"
      """)

    assert {:error, msg} = Config.load(path)
    assert msg =~ "users"
  end

  test "supports autojoin + sasl_password optional fields" do
    path =
      write_toml("""
      [server]
      listen = "127.0.0.1:4000"

      [[users]]
      name = "vjt"

      [[users.networks]]
      id = "azzurra"
      host = "irc.azzurra.chat"
      port = 6697
      tls = true
      nick = "vjt-claude"
      sasl_password = "hunter2"
      autojoin = ["#sniffo", "#it-opers"]
      """)

    assert {:ok, cfg} = Config.load(path)
    [%{networks: [net]}] = cfg.users
    assert net.sasl_password == "hunter2"
    assert net.autojoin == ["#sniffo", "#it-opers"]
  end
end
