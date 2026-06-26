defmodule Grappa.Session.DirectoryTest do
  @moduledoc """
  Channel directory (#84) refresh-trigger tests for `Grappa.Session.Server`.

  Exercises the `Grappa.Session.refresh_directory/2` facade end-to-end
  against the `Grappa.IRCServer` in-process TCP fake (CLAUDE.md "Mock at
  boundaries, real dependencies inside"): the LIST send, the in-flight
  guard, and the watchdog-timeout → `directory_failed` broadcast (the
  merged C4 leg), and the streamed 321/322/323 capture → batched ingest +
  `directory_progress` / `directory_complete` pings (C3).

  `async: false` for the same reason as `Grappa.Session.ServerTest`:
  `SessionRegistry` / `SessionSupervisor` / `PubSub` are singletons.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{ChannelDirectory, IRCServer, PubSub.Topic, Session}
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
    {user, network, _} = setup_user_and_network(port)

    _ = start_session_for(user, network)
    :ok = await_handshake(server)

    assert :ok = Session.refresh_directory({:user, user.id}, network.id)

    assert {:ok, _} =
             IRCServer.wait_for_line(server, &String.starts_with?(&1, "LIST"), 1_000)
  end

  test "a second refresh while one is in-flight returns {:error, :already_refreshing}" do
    {server, port} = start_server()
    {user, network, _} = setup_user_and_network(port)

    _ = start_session_for(user, network)
    :ok = await_handshake(server)

    assert :ok = Session.refresh_directory({:user, user.id}, network.id)

    assert {:error, :already_refreshing} =
             Session.refresh_directory({:user, user.id}, network.id)
  end

  test "a refresh that never sees 323 times out, clears state, emits directory_failed" do
    {server, port} = start_server()
    {user, network, _} = setup_user_and_network(port)

    # `start_session_for/2` resolves the plan and spawns with the boot-time
    # 60s timeout — too long for a test. Replicate it with an injected short
    # timeout so the watchdog fires deterministically. Matches the exact
    # accessor (`Credentials.get_credential!/2`) + producer (`SessionPlan`)
    # the fixture uses.
    credential = Credentials.get_credential!(user, network)
    {:ok, base_plan} = SessionPlan.resolve(credential)
    plan = Map.put(base_plan, :directory_refresh_timeout_ms, 50)
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

  test "a 322/323 burst fills and finalizes the snapshot" do
    {server, port} = start_server()
    {user, network, _} = setup_user_and_network(port)

    _ = start_session_for(user, network)
    :ok = await_handshake(server)

    # Subscribe before triggering so the `directory_complete` ping can't race
    # the subscribe. The broadcast (323 processed) is the sync point — once it
    # lands, every preceding 321/322 has been folded into the snapshot.
    :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

    assert :ok = Session.refresh_directory({:user, user.id}, network.id)

    # Numerics carry the client-nick echo as params[0] (parser convention).
    IRCServer.feed(server, ":irc.test 321 nick Channel :Users Name\r\n")
    IRCServer.feed(server, ":irc.test 322 nick #elixir 1200 :The Elixir channel\r\n")
    IRCServer.feed(server, ":irc.test 322 nick #ruby 800 :Ruby\r\n")
    IRCServer.feed(server, ":irc.test 323 nick :End of /LIST\r\n")

    assert_receive %Phoenix.Socket.Broadcast{
                     event: "event",
                     payload: %{kind: :directory_complete, network: network_slug, total: 2}
                   },
                   1_000

    assert network_slug == network.slug

    # The broadcast proves 323 was processed; NOW the snapshot is durable.
    page = ChannelDirectory.list({:user, user.id}, network.id, ttl_ms: 1_000)
    assert page.status == :fresh
    assert page.total == 2
    # Default sort is user_count DESC (1200 > 800), so #elixir precedes #ruby.
    # NB: list/3 always re-sorts — this asserts the sort, not insertion order.
    assert Enum.map(page.entries, & &1.name) == ["#elixir", "#ruby"]
  end

  test "emits at least one directory_progress before completing" do
    {server, port} = start_server()
    {user, network, _} = setup_user_and_network(port)

    # Inject a 0ms progress throttle so EVERY 322 emits a ping (the default
    # 1s throttle would swallow both rows of a tiny burst). Same custom-plan
    # injection idiom as the watchdog-timeout test above.
    credential = Credentials.get_credential!(user, network)
    {:ok, base_plan} = SessionPlan.resolve(credential)
    plan = Map.put(base_plan, :directory_progress_throttle_ms, 0)
    {:ok, pid} = Session.start_session({:user, user.id}, network.id, plan)

    on_exit(fn ->
      _ = DynamicSupervisor.terminate_child(Grappa.SessionSupervisor, pid)
    end)

    :ok = await_handshake(server)
    :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(user.name))

    assert :ok = Session.refresh_directory({:user, user.id}, network.id)

    IRCServer.feed(server, ":irc.test 322 nick #elixir 1200 :The Elixir channel\r\n")
    IRCServer.feed(server, ":irc.test 322 nick #ruby 800 :Ruby\r\n")
    IRCServer.feed(server, ":irc.test 323 nick :End of /LIST\r\n")

    assert_receive %Phoenix.Socket.Broadcast{
                     event: "event",
                     payload: %{kind: :directory_progress, network: network_slug, count: count}
                   },
                   1_000

    assert network_slug == network.slug
    assert is_integer(count) and count > 0

    # Completion still lands after the progress ping(s) — selective receive
    # skips the second `directory_progress` left in the mailbox.
    assert_receive %Phoenix.Socket.Broadcast{
                     event: "event",
                     payload: %{kind: :directory_complete, total: 2}
                   },
                   1_000
  end
end
