defmodule Grappa.Session.IgnoresSpawnTest do
  @moduledoc """
  #162 — the ignore list reaches a session at the SPAWN BOUNDARY
  (`Grappa.Session.start_session/3`), compiled, and is re-synced compiled on
  `ignores_changed/3`. Pinned end-to-end against the `Grappa.IRCServer` fake
  because the wiring is one `Map.put_new_lazy` beside two siblings that had
  no pin of their own — and because the first CI run showed what an
  init-time read costs (`JoinSeedCostTest`): the assertion here is on the
  spawned process's state, which is the same whether the read happened in
  `init/1` or at the boundary, so a second assertion pins the boundary
  itself — a caller-supplied `:ignores` wins, exactly as `auto_away_debounce_ms`
  does.

  `async: false` for the same reason as `Grappa.Session.ServerTest`:
  `SessionRegistry` / `SessionSupervisor` are singletons.
  """
  use Grappa.DataCase, async: false
  import Grappa.AuthFixtures

  alias Grappa.IRC.{Ignore, Mask}
  alias Grappa.{IRCServer, Session, UserSettings}
  alias Grappa.Networks.{Credentials, SessionPlan}

  defp setup_user_and_network(port) do
    user = user_fixture(name: "ign-#{System.unique_integer([:positive])}")

    {network, _} =
      network_with_server(port: port, slug: "ign-#{System.unique_integer([:positive])}")

    credential = credential_fixture(user, network, %{})
    {user, network, credential}
  end

  test "a spawned session carries its stored entries, compiled, from the first line" do
    {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
    {user, network, _} = setup_user_and_network(port)
    subject = {:user, user.id}
    {:ok, :added, _, _} = UserSettings.add_ignore(subject, network.slug, "SpamBot", nil, :ascii)

    pid = start_session_for(user, network)
    :ok = IRCServer.await_handshake(server, 1_000)

    assert [
             %Ignore.Compiled{
               mask: %Mask{source: "spambot!*@*", user: :any, host: :any},
               text: nil
             }
           ] = :sys.get_state(pid).ignores
  end

  # issue 2294 — the text half survives the SAME boundary. A stored pattern
  # that arrived uncompiled would be a per-line regex build on the inbound
  # hot path, which is exactly what #1984 took out of this feature.
  test "a stored text pattern arrives compiled too" do
    {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
    {user, network, _} = setup_user_and_network(port)
    subject = {:user, user.id}

    {:ok, :added, _, _} =
      UserSettings.add_ignore(subject, network.slug, "relay", "<SomeNick>*", :ascii)

    pid = start_session_for(user, network)
    :ok = IRCServer.await_handshake(server, 1_000)

    assert [%Ignore.Compiled{mask: %Mask{source: "relay!*@*"}, text: %Regex{}}] =
             :sys.get_state(pid).ignores
  end

  test "a caller-supplied :ignores wins at the boundary, like its two siblings" do
    {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
    {user, network, _} = setup_user_and_network(port)
    subject = {:user, user.id}
    {:ok, :added, _, _} = UserSettings.add_ignore(subject, network.slug, "stored", nil, :ascii)

    {:ok, given} = Ignore.normalize("given!*@*", nil, :ascii)
    {:ok, plan} = SessionPlan.resolve(Credentials.get_credential!(user, network))
    {:ok, pid} = Session.start_session(subject, network.id, Map.put(plan, :ignores, [given]))
    on_exit(fn -> Session.stop_session(subject, network.id) end)
    :ok = IRCServer.await_handshake(server, 1_000)

    assert [%Ignore.Compiled{mask: %Mask{source: "given!*@*"}}] = :sys.get_state(pid).ignores
  end

  test "ignores_changed/3 re-syncs the live session with the list compiled" do
    {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
    {user, network, _} = setup_user_and_network(port)
    subject = {:user, user.id}

    pid = start_session_for(user, network)
    :ok = IRCServer.await_handshake(server, 1_000)
    assert [] = :sys.get_state(pid).ignores

    {:ok, entry} = Ignore.normalize("*!*@evil.example", nil, :ascii)
    :ok = Session.ignores_changed(subject, network.id, [entry])

    assert [
             %Ignore.Compiled{
               mask: %Mask{source: "*!*@evil.example", nick: :any, user: :any, host: %Regex{}},
               text: nil
             }
           ] = :sys.get_state(pid).ignores
  end
end
