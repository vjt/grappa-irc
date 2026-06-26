defmodule Grappa.Session.DirectoryTest do
  @moduledoc """
  Channel directory (#84) refresh-trigger tests for `Grappa.Session.Server`.

  Exercises the `Grappa.Session.refresh_directory/2` facade end-to-end
  against the `Grappa.IRCServer` in-process TCP fake (CLAUDE.md "Mock at
  boundaries, real dependencies inside"): the LIST send, the in-flight
  guard, and the watchdog-timeout → `directory_failed` broadcast (the
  merged C4 leg). The streamed 321/322/323 capture is a later task — these
  tests stop at "LIST is on the wire" and "the timer has a handler."

  `async: false` for the same reason as `Grappa.Session.ServerTest`:
  `SessionRegistry` / `SessionSupervisor` / `PubSub` are singletons.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{IRCServer, PubSub.Topic, Session}
  alias Grappa.Networks.{Credentials, SessionPlan}

  defp passthrough_handler, do: fn state, _ -> {:reply, nil, state} end

  defp start_server do
    {:ok, server} = IRCServer.start_link(passthrough_handler())
    {server, IRCServer.port(server)}
  end

  defp setup_user_and_network(port) do
    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")

    {network, _} =
      network_with_server(port: port, slug: "test-#{System.unique_integer([:positive])}")

    credential = credential_fixture(user, network, %{})
    {user, network, credential}
  end

  defp await_handshake(server) do
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"), 1_000)
    :ok
  end

  test "refresh issues LIST upstream" do
    {server, port} = start_server()
    {user, network, _cred} = setup_user_and_network(port)

    _pid = start_session_for(user, network)
    :ok = await_handshake(server)

    assert :ok = Session.refresh_directory({:user, user.id}, network.id)

    assert {:ok, _line} =
             IRCServer.wait_for_line(server, &String.starts_with?(&1, "LIST"), 1_000)
  end

  test "a second refresh while one is in-flight returns {:error, :already_refreshing}" do
    {server, port} = start_server()
    {user, network, _cred} = setup_user_and_network(port)

    _pid = start_session_for(user, network)
    :ok = await_handshake(server)

    assert :ok = Session.refresh_directory({:user, user.id}, network.id)

    assert {:error, :already_refreshing} =
             Session.refresh_directory({:user, user.id}, network.id)
  end

  test "a refresh that never sees 323 times out, clears state, emits directory_failed" do
    {server, port} = start_server()
    {user, network, _cred} = setup_user_and_network(port)

    # `start_session_for/2` resolves the plan and spawns with the boot-time
    # 60s timeout — too long for a test. Replicate it with an injected short
    # timeout so the watchdog fires deterministically. Matches the exact
    # accessor (`Credentials.get_credential!/2`) + producer (`SessionPlan`)
    # the fixture uses.
    credential = Credentials.get_credential!(user, network)
    {:ok, plan} = SessionPlan.resolve(credential)
    plan = Map.put(plan, :directory_refresh_timeout_ms, 50)
    {:ok, pid} = Session.start_session({:user, user.id}, network.id, plan)

    on_exit(fn ->
      _ = DynamicSupervisor.terminate_child(Grappa.SessionSupervisor, pid)
    end)

    :ok = await_handshake(server)

    # Subscribe BEFORE triggering so the (50ms-out) failed ping can't race
    # the subscribe. `subject_label` for a user session is `user.name`.
    :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

    assert :ok = Session.refresh_directory({:user, user.id}, network.id)

    assert_receive %Phoenix.Socket.Broadcast{
                     event: "event",
                     payload: %{kind: :directory_failed, network: network_slug, reason: "timeout"}
                   },
                   1_000

    assert network_slug == network.slug
    # `:sys.get_state` serializes AFTER the timeout handler returns, so the
    # in-flight tracker is guaranteed cleared by the time we read it.
    assert :sys.get_state(pid).directory_refresh == nil
  end
end
