defmodule Grappa.Visitors.ReaperTest do
  @moduledoc """
  Tests for `Grappa.Visitors.Reaper` — the GenServer that periodically
  sweeps `expires_at <= now()` visitors out of the DB.

  `async: false` because:
    1. `Grappa.DataCase` flips the sandbox into shared mode when
       `async: false` (`shared: not tags[:async]`); the spawned Reaper
       under test sees the test's inserts via the shared connection.
    2. The "GenServer ticks every interval" case spawns a process that
       performs DB writes — without shared mode it would not see the
       expired visitor row the test prepared.
  """
  use Grappa.DataCase, async: false

  import ExUnit.CaptureLog
  import Grappa.AuthFixtures, only: [network_fixture: 1, start_visitor_session_for: 2, visitor_with_network: 2]

  alias Grappa.{
    AdmissionStateHelpers,
    IRCServer,
    Push,
    QueryWindows,
    ReadCursor,
    Session,
    SessionStateHelpers,
    Subject,
    UserSettings,
    Visitors,
    WSPresence
  }

  alias Grappa.Networks.Credentials
  alias Grappa.Repo.BusyRetry
  alias Grappa.Visitors.{Reaper, Visitor}

  setup do
    AdmissionStateHelpers.reset_all()
    :ok
  end

  defp expire(visitor) do
    query = from(v in Visitor, where: v.id == ^visitor.id)
    Repo.update_all(query, set: [expires_at: DateTime.add(DateTime.utc_now(), -1, :hour)])
  end

  describe "sweep/0" do
    test "deletes expired visitors and leaves live ones alone" do
      slug = "azzurra-#{System.unique_integer([:positive])}"
      _ = network_fixture(slug: slug)
      {:ok, alive} = Visitors.find_or_provision_anon("alive", slug, nil)
      {:ok, dead} = Visitors.find_or_provision_anon("dead", slug, nil)
      expire(dead)

      assert {:ok, 1} = Reaper.sweep()
      assert Repo.reload(alive)
      refute Repo.reload(dead)
    end

    test "returns {:ok, 0} when nothing to reap" do
      assert {:ok, 0} = Reaper.sweep()
    end

    # #590 — a sustained SQLITE_BUSY on a visitor delete must be a best-effort
    # DROP: the per-row failure logs + continues, the sweep survives (returns
    # `{:ok, 0}` — nothing was actually deleted), and crucially the row is LEFT
    # for the next tick. `sweep/0` runs in the test process, so the
    # process-dictionary fault seam reaches `destroy_visitor/1`'s BusyRetry
    # directly. The DROP must be OBSERVABLE (row survives + logged), not just
    # "did not crash".
    test "sustained DB busy → best-effort drop: sweep survives, logs, leaves the visitor row" do
      slug = "azzurra-#{System.unique_integer([:positive])}"
      _ = network_fixture(slug: slug)
      {:ok, dead} = Visitors.find_or_provision_anon("dead", slug, nil)
      expire(dead)

      log =
        capture_log(fn ->
          BusyRetry.inject_transient_faults(10_000)
          assert {:ok, 0} = Reaper.sweep()
          BusyRetry.inject_transient_faults(0)
        end)

      # The visitor was NOT deleted — the write degraded rather than landing.
      assert Repo.reload(dead)
      assert log =~ "unavailable"
    end

    test "terminates live Session.Server before deleting expired visitor row" do
      {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {visitor, network} = visitor_with_network(port, [])
      pid = start_visitor_session_for(visitor, network)
      :ok = IRCServer.await_handshake(server, 1_000)
      # Issue 2728: the reaper's QUIT is refused before 001, so register first.
      :ok = IRCServer.register(server, pid |> SessionStateHelpers.fetch() |> SessionStateHelpers.nick(), 1_000)
      ref = Process.monitor(pid)

      assert Process.alive?(pid)
      assert Session.whereis({:visitor, visitor.id}, network.id) == pid

      expire(visitor)

      assert {:ok, 1} = Reaper.sweep()
      assert_receive {:DOWN, ^ref, :process, ^pid, _}
      assert Session.whereis({:visitor, visitor.id}, network.id) == nil
      refute Repo.reload(visitor)

      assert {:ok, _} =
               IRCServer.wait_for_line(
                 server,
                 &(&1 == "QUIT :visitor session expired\r\n"),
                 1_000
               )
    end

    test "registered visitor (holds a NickServ credential) survives sweep — derived-registration guard" do
      # #211 phase 7 — registration is DERIVED from the credentials
      # (`Credentials.visitor_registered?/1` — holds ≥1 committed NickServ
      # secret). `commit_password/3` does NOT clear `expires_at` anymore, so
      # a registered visitor keeps its anon-shaped TTL; `list_expired/0`
      # excludes it via `v.id NOT IN (registered credential visitor_ids)`.
      # Without that guard the Reaper would delete every registered visitor.
      slug = "azzurra-#{System.unique_integer([:positive])}"
      network = network_fixture(slug: slug)
      {:ok, anon} = Visitors.find_or_provision_anon("identified", slug, nil)
      {:ok, _} = Visitors.commit_password(anon.id, network.id, "s3cret")
      identified = Repo.reload(anon)
      assert Grappa.Networks.Credentials.visitor_registered?(identified.id)
      # Force its TTL into the past — a registered visitor must survive the
      # sweep DESPITE an elapsed expires_at (registration, not the TTL, is
      # the reap discriminator now).
      expire(identified)

      assert {:ok, 0} = Reaper.sweep()
      assert Repo.reload(identified)
    end

    test "cascade-wipes all five visitor-owned tables on sweep" do
      network = network_fixture(slug: "azzurra-reap-#{System.unique_integer([:positive])}")
      {:ok, visitor} = Visitors.find_or_provision_anon("doomed", network.slug, nil)
      subject = {:visitor, visitor.id}

      {:ok, _} = QueryWindows.open(subject, network.id, "alice", "visitor:#{visitor.id}")

      {:ok, _} =
        Push.create(subject, %{
          endpoint: "https://example.com/push/reap",
          p256dh_key: "k",
          auth_key: "a"
        })

      {:ok, _} = UserSettings.set_highlight_patterns(subject, ["foo"])

      msg =
        scrollback_message_fixture(visitor: visitor, network: network, channel: "#chan")

      {:ok, _} = ReadCursor.set(subject, network.id, "#chan", msg.id)

      assert count_for_visitor("messages", visitor.id) == 1
      assert count_for_visitor("query_windows", visitor.id) == 1
      assert count_for_visitor("push_subscriptions", visitor.id) == 1
      assert count_for_visitor("user_settings", visitor.id) == 1
      assert count_for_visitor("read_cursors", visitor.id) == 1

      expire(visitor)

      assert {:ok, 1} = Reaper.sweep()
      refute Enum.any?(Visitors.list_active(), &(&1.id == visitor.id))

      assert count_for_visitor("messages", visitor.id) == 0
      assert count_for_visitor("query_windows", visitor.id) == 0
      assert count_for_visitor("push_subscriptions", visitor.id) == 0
      assert count_for_visitor("user_settings", visitor.id) == 0
      assert count_for_visitor("read_cursors", visitor.id) == 0
    end
  end

  describe "incognito linger reconcile (#363)" do
    test "does NOT reap a CONNECTED incognito visitor past its TTL — reconcile slides it forward" do
      slug = "azzurra-#{System.unique_integer([:positive])}"
      _ = network_fixture(slug: slug)
      {:ok, ghost} = Visitors.find_or_provision_anon("ghost", slug, nil, true)
      # wind the linger into the past — a disconnected incognito would be reaped
      expire(ghost)

      # …but this one has a live browser socket, so the reconcile refreshes it
      :ok = Grappa.WSPresence.register("visitor:#{ghost.id}", self())

      assert {:ok, 0} = Reaper.sweep()
      assert reloaded = Repo.reload(ghost)
      assert DateTime.compare(reloaded.expires_at, DateTime.utc_now()) == :gt
    end

    test "reaps a DISCONNECTED incognito visitor past its TTL (no live socket)" do
      slug = "azzurra-#{System.unique_integer([:positive])}"
      _ = network_fixture(slug: slug)
      {:ok, ghost} = Visitors.find_or_provision_anon("ghost", slug, nil, true)
      expire(ghost)

      assert {:ok, 1} = Reaper.sweep()
      refute Repo.reload(ghost)
    end
  end

  describe "incognito fast close (#1770)" do
    test "no socket left → CLOSED: the IRC session quits and the row is gone" do
      {server, port} = IRCServer.start_server(IRCServer.passthrough_handler())
      {visitor, network} = visitor_with_network(port, incognito: true)
      pid = start_visitor_session_for(visitor, network)
      :ok = IRCServer.await_handshake(server, 1_000)
      # Issue 2728: the reaper's QUIT is refused before 001, so register first.
      :ok = IRCServer.register(server, pid |> SessionStateHelpers.fetch() |> SessionStateHelpers.nick(), 1_000)
      ref = Process.monitor(pid)

      assert visitor.incognito
      assert Session.whereis({:visitor, visitor.id}, network.id) == pid

      assert :closed = Reaper.close_incognito(visitor.id)

      assert_receive {:DOWN, ^ref, :process, ^pid, _}
      assert Session.whereis({:visitor, visitor.id}, network.id) == nil
      refute Repo.reload(visitor)

      # The user-visible contract is a /quit, and the reason names what was
      # observed — the client closed, the TTL did not elapse.
      assert {:ok, _} =
               IRCServer.wait_for_line(server, &(&1 == "QUIT :session closed\r\n"), 1_000)
    end

    test "a socket is still registered → RECONNECTED, the row survives (the reload case)" do
      # The discriminator this whole slice turns on. Measured in a standalone
      # chromium/webkit bench: a RELOAD fires `pagehide` with
      # `persisted === false` — byte-identical to a genuine close — and lands
      # a NEW socket 2-3ms later. So the client's teardown report can never be
      # the gate on its own; "is anybody still connected when the grace
      # elapses" is.
      slug = "azzurra-#{System.unique_integer([:positive])}"
      _ = network_fixture(slug: slug)
      {:ok, ghost} = Visitors.find_or_provision_anon("ghost", slug, nil, true)
      :ok = WSPresence.register(Subject.label({:visitor, ghost.id}), self())

      assert :reconnected = Reaper.close_incognito(ghost.id)
      assert Repo.reload(ghost)
    end

    test "a NON-incognito visitor is untouched — the away-only behaviour is correct for it" do
      slug = "azzurra-#{System.unique_integer([:positive])}"
      _ = network_fixture(slug: slug)
      {:ok, plain} = Visitors.find_or_provision_anon("plain", slug, nil, false)

      assert :not_incognito = Reaper.close_incognito(plain.id)
      assert Repo.reload(plain)
    end

    test "a REGISTERED incognito visitor is untouched — same scope as list_expired/0" do
      # The fast path may only ACCELERATE the linger, never widen it.
      # `Visitors.list_expired/0` excludes registered visitors, so the 1h
      # fallback would never delete this row; deleting it here would not be an
      # acceleration but a new destruction.
      slug = "azzurra-#{System.unique_integer([:positive])}"
      network = network_fixture(slug: slug)
      {:ok, ghost} = Visitors.find_or_provision_anon("identified-ghost", slug, nil, true)
      {:ok, _} = Visitors.commit_password(ghost.id, network.id, "s3cret")
      assert Credentials.visitor_registered?(ghost.id)

      assert :registered = Reaper.close_incognito(ghost.id)
      assert Repo.reload(ghost)
    end

    test "an unknown id is GONE, not a crash — pagehide and beforeunload both arm" do
      assert :gone = Reaper.close_incognito(Ecto.UUID.generate())
    end

    # The `:failed` arm, and the only one where an unhandled error would take
    # the Reaper down and the 1h linger with it. It is the #590 sweep twin
    # ("sustained DB busy → best-effort drop") re-run through the fast door:
    # the same `reap_one/2` degrades the same way, so the fast path must reach
    # the same best-effort DROP rather than a crash or a half-wipe.
    #
    # The second half is the load-bearing one. `:failed` is only honest if it
    # leaves the row exactly as the fallback expects to find it — so the test
    # does not stop at the degraded return, it lifts the fault and shows the
    # SAME row still collectable. A degrade that stranded the row would pass
    # the first three assertions and fail here.
    #
    # `close_incognito/1` runs in the test process (it is the synchronous verb
    # the timer calls), so the process-dictionary fault seam reaches
    # `Visitors.delete/1`'s BusyRetry directly — the property the sweep twin
    # relies on too.
    test "sustained DB busy → best-effort drop: FAILED, row kept, and the fallback still collects it" do
      slug = "azzurra-#{System.unique_integer([:positive])}"
      _ = network_fixture(slug: slug)
      {:ok, ghost} = Visitors.find_or_provision_anon("saturated", slug, nil, true)

      log =
        capture_log(fn ->
          BusyRetry.inject_transient_faults(10_000)
          assert :failed = Reaper.close_incognito(ghost.id)
          BusyRetry.inject_transient_faults(0)
        end)

      # The wipe degraded rather than landing — the row is LEFT for the linger.
      assert Repo.reload(ghost)
      # No silent-swallow: the operator sees the fast door's own line, not the
      # sweep's, and the transient classification that produced it.
      assert log =~ "incognito close failed"
      assert log =~ "unavailable"

      # …and the safety net it was left for still works on it, unchanged.
      expire(ghost)
      assert {:ok, 1} = Reaper.sweep()
      refute Repo.reload(ghost)
    end

    test "client_closing/1 arms the grace and the row is gone once it elapses" do
      slug = "azzurra-#{System.unique_integer([:positive])}"
      _ = network_fixture(slug: slug)
      {:ok, ghost} = Visitors.find_or_provision_anon("armed", slug, nil, true)

      # The ambient Reaper is the one the channel casts to; grant it the
      # shared sandbox connection so its delete lands on this test's DB.
      Ecto.Adapters.SQL.Sandbox.allow(Repo, self(), Process.whereis(Reaper))

      assert :ok = Reaper.client_closing(ghost.id)

      # Poll, never sleep blind: the grace is config-driven and the assertion
      # is "it happened", not "it happened at N ms".
      assert wait_until(fn -> Repo.reload(ghost) == nil end)
    end
  end

  describe "GenServer tick" do
    test "scheduled tick fires sweep" do
      slug = "azzurra-#{System.unique_integer([:positive])}"
      _ = network_fixture(slug: slug)
      {:ok, dead} = Visitors.find_or_provision_anon("dead", slug, nil)
      expire(dead)

      pid = start_supervised!({Reaper, [interval_ms: 50, name: :"reaper_test_#{System.unique_integer([:positive])}"]})

      # Allow the spawned process to share the test sandbox connection
      # (shared mode is enabled by `async: false` above, but the Reaper
      # PID still has to be granted; without this it sees an empty DB).
      Ecto.Adapters.SQL.Sandbox.allow(Repo, self(), pid)

      Process.sleep(150)

      refute Repo.reload(dead)
    end
  end

  # Poll a predicate to a deadline instead of sleeping past a guessed grace.
  # The grace is config-driven (`:incognito_close_grace_ms`), so a fixed sleep
  # would either be a flake or a hardcoded twin of the config.
  defp wait_until(fun) do
    deadline = System.monotonic_time(:millisecond) + 2_000
    poll_until(fun, deadline)
  end

  defp poll_until(fun, deadline) do
    cond do
      fun.() ->
        true

      System.monotonic_time(:millisecond) >= deadline ->
        false

      true ->
        Process.sleep(10)
        poll_until(fun, deadline)
    end
  end

  defp count_for_visitor(table, visitor_id) do
    {:ok, %{rows: [[count]]}} =
      Repo.query(
        "SELECT COUNT(*) FROM #{table} WHERE visitor_id = ?",
        [visitor_id]
      )

    count
  end

  defp scrollback_message_fixture(opts) do
    visitor = Keyword.fetch!(opts, :visitor)
    network = Keyword.fetch!(opts, :network)
    channel = Keyword.fetch!(opts, :channel)

    attrs = %{
      visitor_id: visitor.id,
      network_id: network.id,
      channel: channel,
      server_time: System.os_time(:millisecond),
      kind: :privmsg,
      sender: "tester",
      body: "hi",
      meta: %{}
    }

    {:ok, msg} =
      %Grappa.Scrollback.Message{}
      |> Grappa.Scrollback.Message.changeset(attrs)
      |> Repo.insert()

    msg
  end
end
