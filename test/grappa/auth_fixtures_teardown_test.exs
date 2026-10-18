defmodule Grappa.AuthFixturesTeardownTest do
  @moduledoc """
  #1551 — the teardown `Grappa.AuthFixtures` registers for every session
  it spawns must free the registry KEY, not one pid.

  `Session.Server` is `restart: :transient` and the fake `IRCServer` a
  test connects to dies with the test pid, so an abnormal Client exit at
  end-of-test is the routine case, not the exotic one. The supervisor
  restarts the child, the successor re-registers the SAME key, and a
  teardown holding the pid it spawned tears down nothing: the respawned
  session outlives the test and keeps emitting lifecycle telemetry into
  whichever suite runs next. That is the leak #1551 reported.

  The callback under test runs AFTER the test body, so no assertion
  inside the body can observe it. `ExUnit` runs `on_exit` callbacks in
  REVERSE order of registration, which is the vantage point this test
  uses: an assertion registered BEFORE the fixture spawns runs AFTER the
  fixture's own teardown, and so reads the state that teardown left
  behind. Nothing else in the suite can see that state — a leaked session
  only shows up later, as an unattributable failure in another file.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{IRCServer, Session}

  @respawn_attempts 400
  @respawn_retry_ms 5

  test "the teardown the fixture registers frees a key a :transient restart refilled" do
    {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
    {visitor, network} = visitor_with_network(port)
    subject = {:visitor, visitor.id}

    # Registered BEFORE the fixture registers its own, so ExUnit's
    # reverse order runs this one LAST — after the teardown it is judging.
    on_exit(fn ->
      assert Session.whereis(subject, network.id) == nil,
             "the session outlived the teardown AuthFixtures registered for it: the key " <>
               "#{inspect(subject)}/#{network.id} is still held by a live process, which is " <>
               "free to write into whichever suite runs next (#1551)"
    end)

    spawned = start_visitor_session_for(visitor, network)
    :ok = IRCServer.await_handshake(server, 5_000)
    # Let the session finish its start-up work before the kill: it sweeps
    # the offline queue as soon as it starts (issue 2430), a DB read, and a
    # process killed while it holds the sandbox's shared connection takes
    # that connection down with it (logged as "client … exited"). Measured:
    # red 3 in 8 runs, on the `terminate_child` positive control, and green
    # 5 of 5 with the sweep removed; how the dropped connection reaches the
    # supervisor's restart is inferred, not observed (probes moved the
    # timing and never reproduced it). The state read is queued behind the
    # sweep, so once it answers the session holds no connection.
    _ = :sys.get_state(spawned)

    # The pre-state: without it a teardown that never had anything to do
    # would read as a teardown that worked.
    assert Session.whereis(subject, network.id) == spawned

    Process.exit(spawned, :kill)
    successor = await_respawn(subject, network.id, spawned, @respawn_attempts)

    refute Process.alive?(spawned)
    assert successor != spawned

    # Positive control for the scenario itself: the gesture the fixture
    # used to register is a no-op against the dead predecessor, and the
    # key stays taken by the successor it never saw. If this ever starts
    # freeing the key, the `on_exit` assertion above has stopped meaning
    # anything.
    assert {:error, :not_found} =
             DynamicSupervisor.terminate_child(Grappa.SessionSupervisor, spawned)

    assert Session.whereis(subject, network.id) == successor
  end

  defp await_respawn(subject, network_id, spawned, 0) do
    flunk(
      "no :transient restart took over #{inspect(subject)}/#{network_id} within " <>
        "#{@respawn_attempts * @respawn_retry_ms}ms of killing #{inspect(spawned)} — " <>
        "the scenario this test is about never happened"
    )
  end

  defp await_respawn(subject, network_id, spawned, attempts) do
    case Session.whereis(subject, network_id) do
      pid when is_pid(pid) and pid != spawned ->
        pid

      _ ->
        Process.sleep(@respawn_retry_ms)
        await_respawn(subject, network_id, spawned, attempts - 1)
    end
  end
end
