defmodule Grappa.Dcc.ReaperTest do
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures, only: [network_fixture: 0, user_fixture: 0]

  alias Grappa.{Dcc, Repo}
  alias Grappa.Dcc.{Reaper, SpoolFile, Transfer}
  alias Grappa.DccTestSender
  alias Grappa.IRC.DCC.Offer

  @loopback DccTestSender.loopback()

  setup do
    root = Dcc.storage_root()
    :ok = File.mkdir_p!(root)

    # A PRIVATE root for the orphan pass. It enumerates a whole directory,
    # and the shared root also holds the files of every concurrent async
    # test — whose rows live in OTHER sandboxes and so read as untracked
    # from this one.
    private_root = Path.join(System.tmp_dir!(), "dcc-orphans-#{System.unique_integer([:positive])}")
    :ok = File.mkdir_p!(private_root)
    on_exit(fn -> File.rm_rf(private_root) end)

    {:ok, root: root, private_root: private_root, subject: {:user, user_fixture().id}, network_id: network_fixture().id}
  end

  # Writes a real file at the real path so the sweep's unlink is measured
  # rather than assumed — a reaper that deleted rows and left bytes would
  # pass every row-only assertion while failing the whole point of the
  # feature.
  defp spool(ctx, retention_seconds) do
    slug = Dcc.mint_slug()

    {:ok, row} =
      Dcc.store(ctx.subject, ctx.network_id, slug, %{
        peer_nick: "vjt",
        filename: "holiday.tar.gz",
        bytes: 4,
        retention_seconds: retention_seconds
      })

    :ok = File.write!(Dcc.storage_path(slug), "abcd")
    row
  end

  describe "sweep/2" do
    test "removes the BYTES as well as the row", ctx do
      row = spool(ctx, 1)
      path = Dcc.storage_path(row.slug)
      assert File.exists?(path)

      assert {:ok, 1} = Reaper.sweep(ctx.root, DateTime.add(DateTime.utc_now(), 60, :second))

      refute File.exists?(path)
      assert Repo.get(SpoolFile, row.id) == nil
    end

    test "leaves a row that has not expired alone", ctx do
      row = spool(ctx, Dcc.max_retention_seconds())

      assert {:ok, 0} = Reaper.sweep(ctx.root, DateTime.utc_now())

      assert Repo.get(SpoolFile, row.id)
      assert File.exists?(Dcc.storage_path(row.slug))
    end

    test "a row whose file already vanished is still deleted", ctx do
      # ENOENT is success, not a failure: the ROW is the thing that must not
      # survive, and refusing to delete it because the bytes went first
      # would strand it past its retention forever — the one outcome the
      # retention ruling forbids.
      row = spool(ctx, 1)
      File.rm!(Dcc.storage_path(row.slug))

      assert {:ok, 1} = Reaper.sweep(ctx.root, DateTime.add(DateTime.utc_now(), 60, :second))
      assert Repo.get(SpoolFile, row.id) == nil
    end

    test "sweeps every expired row, not just the first", ctx do
      rows = for _ <- 1..3, do: spool(ctx, 1)

      assert {:ok, 3} = Reaper.sweep(ctx.root, DateTime.add(DateTime.utc_now(), 60, :second))

      for row <- rows do
        refute File.exists?(Dcc.storage_path(row.slug))
        assert Repo.get(SpoolFile, row.id) == nil
      end
    end

    test "an empty spool sweeps nothing and says so", ctx do
      assert {:ok, 0} = Reaper.sweep(ctx.root, DateTime.utc_now())
    end
  end

  describe "sweep_orphans/2 — issue 2404, bytes no row points at" do
    # Through a real transfer against a real loopback sender, NOT through
    # a real session: `Grappa.Dcc.Policy` refuses a loopback offer before
    # any socket is opened (the SSRF property), so no offer this test
    # could serve ever reaches `Session.Server`'s transfer task — the
    # limit `Grappa.Session.DccConsentTest` documents. `start_transfer/4`
    # is that task's body, and the "session" is the pid it reports to.
    test "the session dies mid-transfer: the bytes nobody recorded are swept once stale", ctx do
      slug = Dcc.mint_slug()
      path = Path.join(ctx.private_root, slug)
      {first, rest} = {:binary.copy("A", 1_024), :binary.copy("B", 3_072)}
      {port, sender} = held_sender(first, rest)
      session = spawn(fn -> Process.sleep(:infinity) end)
      session_ref = Process.monitor(session)

      task = start_transfer(path, slug, loopback_offer(port, byte_size(first <> rest)), session)
      assert_receive {:sender_holding, ^sender}, 5_000

      # The session goes while the rest of the file is still owed.
      Process.exit(session, :kill)
      assert_receive {:DOWN, ^session_ref, :process, ^session, :killed}, 5_000
      send(sender, :go)
      assert_receive {:DOWN, _, :process, ^task, :normal}, 5_000

      # The defect, measured: the transfer COMPLETED, its report went to a
      # dead pid without an error, and nothing recorded the bytes.
      assert File.read!(path) == first <> rest
      assert Dcc.untracked_slugs([slug]) == [slug]

      # Fresh, it is indistinguishable from a transfer in flight — kept.
      assert {:ok, 0} = Reaper.sweep_orphans(ctx.private_root, DateTime.utc_now())
      assert File.exists?(path)

      assert {:ok, 1} = Reaper.sweep_orphans(ctx.private_root, past_grace())
      refute File.exists?(path)
    end

    test "a transfer killed mid-drain leaves a partial its failure arm never removed", ctx do
      # The case no session-side cure reaches: a restart or a crash kills
      # the task where it stands, so `Transfer`'s inline cleanup never
      # runs and nobody is left to report anything to.
      slug = Dcc.mint_slug()
      path = Path.join(ctx.private_root, slug)
      first = :binary.copy("A", 1_024)
      {port, sender} = held_sender(first, :binary.copy("B", 3_072))

      task = start_transfer(path, slug, loopback_offer(port, 4_096), self())
      assert_receive {:sender_holding, ^sender}, 5_000
      eventually_size(path, byte_size(first))

      Process.exit(task, :kill)
      assert_receive {:DOWN, _, :process, ^task, :killed}, 5_000
      assert File.stat!(path).size == byte_size(first)

      assert {:ok, 1} = Reaper.sweep_orphans(ctx.private_root, past_grace())
      refute File.exists?(path)

      send(sender, :go)
    end

    test "a file a row points at is never an orphan, however old", ctx do
      slug = Dcc.mint_slug()

      {:ok, _} =
        Dcc.store(ctx.subject, ctx.network_id, slug, %{
          peer_nick: "vjt",
          filename: "holiday.tar.gz",
          bytes: 4,
          retention_seconds: Dcc.max_retention_seconds()
        })

      path = Path.join(ctx.private_root, slug)
      :ok = File.write!(path, "abcd")

      assert {:ok, 0} = Reaper.sweep_orphans(ctx.private_root, past_grace())
      assert File.exists?(path)
    end

    test "a name that is not a minted slug is not ours to remove, however old", ctx do
      path = Path.join(ctx.private_root, "README")
      :ok = File.write!(path, "operator notes")

      assert {:ok, 0} = Reaper.sweep_orphans(ctx.private_root, past_grace())
      assert File.exists?(path)
    end
  end

  describe "the GenServer" do
    test "init mkdir_p's its root, so a fresh deploy needs no bootstrap step", ctx do
      fresh = Path.join(ctx.root, "fresh-#{System.unique_integer([:positive])}")
      refute File.exists?(fresh)

      pid = start_supervised!({Reaper, storage_root: fresh, interval_ms: 60_000, name: nil})

      assert File.dir?(fresh)
      assert Process.alive?(pid)
      File.rm_rf!(fresh)
    end

    test "a tick reschedules from the INJECTED interval, not the module default", ctx do
      # The bug this pins is a rebuild-from-literals reset: a tick that
      # rescheduled off the 60s default would make an injected short
      # interval fire exactly once, turning a deterministic test into a
      # rare red and an operator's configured cadence into a lie.
      pid = start_supervised!({Reaper, storage_root: ctx.private_root, interval_ms: 12_345, name: nil})
      # The tick sweeps, and a sweep queries — the Reaper is a separate
      # process, so it needs the sandbox connection explicitly.
      Ecto.Adapters.SQL.Sandbox.allow(Grappa.Repo, self(), pid)

      send(pid, :tick)
      assert %{interval_ms: 12_345} = :sys.get_state(pid)
    end

    test "a tick sweeps orphans too, not only expired rows", ctx do
      # Pins the WIRING: `sweep_orphans/2` green on its own proves nothing
      # if the tick never calls it. The file is aged on disk because the
      # tick reads the real clock and `now` cannot be injected here.
      path = Path.join(ctx.private_root, Dcc.mint_slug())
      :ok = File.write!(path, "abcd")
      :ok = File.touch!(path, System.os_time(:second) - Dcc.orphan_grace_seconds() - 60)

      pid = start_supervised!({Reaper, storage_root: ctx.private_root, interval_ms: 60_000, name: nil})
      Ecto.Adapters.SQL.Sandbox.allow(Grappa.Repo, self(), pid)

      send(pid, :tick)
      _ = :sys.get_state(pid)

      refute File.exists?(path)
    end
  end

  defp past_grace, do: DateTime.add(DateTime.utc_now(), Dcc.orphan_grace_seconds() + 60, :second)

  defp loopback_offer(port, size), do: %Offer{filename: "x.bin", ip: @loopback, port: port, size: size}

  # `Session.Server.start_dcc_transfer/2`'s task, spelled out: detached on
  # `Grappa.TaskSupervisor`, linked to nothing, reporting with one `send`.
  defp start_transfer(path, slug, offer, session) do
    {:ok, task} =
      Task.Supervisor.start_child(Grappa.TaskSupervisor, fn ->
        result = Transfer.run(offer, path, Dcc.transfer_opts())
        send(session, {:dcc_transfer_done, slug, "alice", offer.filename, result})
      end)

    _ = Process.monitor(task)
    task
  end

  # A loopback DCC sender that sends `first` at once, tells the test it is
  # holding, and sends `rest` only on `:go` — the window in which the test
  # decides what dies. Half-closes after the payload and drains before
  # closing (see `Grappa.DccTestSender`). The sends after `:go` are
  # best-effort because the receiver may already be dead, which is the
  # point.
  defp held_sender(first, rest) do
    {listen, port} = DccTestSender.listen()
    test = self()

    sender =
      spawn_link(fn ->
        {:ok, socket} = :gen_tcp.accept(listen, 5_000)
        :ok = :gen_tcp.send(socket, first)
        send(test, {:sender_holding, self()})

        receive do
          :go -> :ok
        end

        _ = :gen_tcp.send(socket, rest)
        _ = :gen_tcp.shutdown(socket, :write)
        DccTestSender.drain_until_closed(socket)
        _ = :gen_tcp.close(socket)
        :gen_tcp.close(listen)
      end)

    {port, sender}
  end

  defp eventually_size(path, want), do: eventually_size(path, want, 250)

  defp eventually_size(path, want, 0) do
    flunk("#{path} never reached #{want} bytes; stat: #{inspect(File.stat(path))}")
  end

  defp eventually_size(path, want, tries) do
    case File.stat(path) do
      {:ok, %File.Stat{size: ^want}} ->
        :ok

      _ ->
        Process.sleep(20)
        eventually_size(path, want, tries - 1)
    end
  end
end
