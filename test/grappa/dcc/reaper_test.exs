defmodule Grappa.Dcc.ReaperTest do
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures, only: [network_fixture: 0, user_fixture: 0]

  alias Grappa.{Dcc, Repo}
  alias Grappa.Dcc.{Reaper, SpoolFile}

  setup do
    root = Dcc.storage_root()
    :ok = File.mkdir_p!(root)
    {:ok, root: root, subject: {:user, user_fixture().id}, network_id: network_fixture().id}
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
      pid = start_supervised!({Reaper, storage_root: ctx.root, interval_ms: 12_345, name: nil})
      # The tick sweeps, and a sweep queries — the Reaper is a separate
      # process, so it needs the sandbox connection explicitly.
      Ecto.Adapters.SQL.Sandbox.allow(Grappa.Repo, self(), pid)

      send(pid, :tick)
      assert %{interval_ms: 12_345} = :sys.get_state(pid)
    end
  end
end
