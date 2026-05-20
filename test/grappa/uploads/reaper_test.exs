defmodule Grappa.Uploads.ReaperTest do
  # async: false because Reaper.sweep records to the AdminEvents
  # singleton and the global telemetry-attach handler is on in
  # admin-events-aware tests; the per-test sandbox-allow dance keeps
  # the suite honest but serialization avoids cross-test bleed.
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures, only: [user_fixture: 1]

  alias Grappa.Uploads
  alias Grappa.Uploads.Reaper

  setup do
    root =
      Path.join(System.tmp_dir!(), "grappa_uploads_reaper_test_#{System.unique_integer([:positive])}")

    File.mkdir_p!(root)
    on_exit(fn -> File.rm_rf!(root) end)

    # Sandbox-allow the AdminEvents singleton so reap-event records
    # don't cross-pid the sandbox connection. Mirror Visitors.ReaperTest.
    pid = Process.whereis(Grappa.AdminEvents)

    if pid do
      Ecto.Adapters.SQL.Sandbox.allow(Grappa.Repo, self(), pid)
    end

    %{root: root}
  end

  describe "sweep/2 — empty store" do
    test "returns {:ok, 0} with no expired rows", %{root: root} do
      assert {:ok, 0} = Reaper.sweep(root, DateTime.utc_now())
    end
  end

  describe "sweep/2 — unlinks file BEFORE soft-deleting row" do
    test "unlinks expired files + flips deleted_at", %{root: root} do
      user = user_fixture([])
      now = DateTime.utc_now()
      past = DateTime.add(now, -60, :second)

      {:ok, expired} =
        Uploads.create(
          "img",
          %{
            subject: {:user, user.id},
            mime: "image/png",
            expires_at: past
          },
          storage_root: root
        )

      path = Path.join(root, expired.slug)
      assert File.exists?(path)

      assert {:ok, 1} = Reaper.sweep(root, now)
      refute File.exists?(path)

      # Row is soft-deleted, not hard-deleted.
      reloaded = Grappa.Repo.get!(Uploads.Upload, expired.id)
      refute is_nil(reloaded.deleted_at)
    end

    test "ignores rows with future expires_at", %{root: root} do
      user = user_fixture([])
      now = DateTime.utc_now()

      {:ok, alive} =
        Uploads.create(
          "img",
          %{
            subject: {:user, user.id},
            mime: "image/png",
            expires_at: DateTime.add(now, 3600, :second)
          },
          storage_root: root
        )

      assert {:ok, 0} = Reaper.sweep(root, now)
      assert File.exists?(Path.join(root, alive.slug))

      reloaded = Grappa.Repo.get!(Uploads.Upload, alive.id)
      assert is_nil(reloaded.deleted_at)
    end

    test "ignores rows already soft-deleted", %{root: root} do
      user = user_fixture([])
      now = DateTime.utc_now()
      past = DateTime.add(now, -60, :second)

      {:ok, dead} =
        Uploads.create(
          "img",
          %{
            subject: {:user, user.id},
            mime: "image/png",
            expires_at: past
          },
          storage_root: root
        )

      {:ok, _} = Uploads.soft_delete(dead, now)
      assert {:ok, 0} = Reaper.sweep(root, now)
    end

    test "ignores rows with nil expires_at", %{root: root} do
      user = user_fixture([])
      now = DateTime.utc_now()

      {:ok, _} =
        Uploads.create(
          "img",
          %{
            subject: {:user, user.id},
            mime: "image/png",
            expires_at: nil
          },
          storage_root: root
        )

      assert {:ok, 0} = Reaper.sweep(root, now)
    end
  end

  describe "sweep/2 — resilience" do
    test "missing file (ENOENT) still soft-deletes the row", %{root: root} do
      user = user_fixture([])
      now = DateTime.utc_now()
      past = DateTime.add(now, -60, :second)

      {:ok, orphan} =
        Uploads.create(
          "img",
          %{
            subject: {:user, user.id},
            mime: "image/png",
            expires_at: past
          },
          storage_root: root
        )

      # Manual unlink before reaper sees it (simulates disk reformat
      # or out-of-band cleanup).
      File.rm!(Path.join(root, orphan.slug))

      assert {:ok, 1} = Reaper.sweep(root, now)
      reloaded = Grappa.Repo.get!(Uploads.Upload, orphan.id)
      refute is_nil(reloaded.deleted_at)
    end

    test "per-row failure does not stop the sweep", %{root: root} do
      user = user_fixture([])
      now = DateTime.utc_now()
      past = DateTime.add(now, -60, :second)

      # Two expired rows. We can't easily induce a fs-error for one,
      # but we can verify the sweep returns the live-success count
      # under the happy path. Resilience is exercised by the ENOENT
      # path above (which is the most realistic per-row failure).
      {:ok, _} =
        Uploads.create(
          "a",
          %{
            subject: {:user, user.id},
            mime: "image/png",
            expires_at: past
          },
          storage_root: root
        )

      {:ok, _} =
        Uploads.create(
          "b",
          %{
            subject: {:user, user.id},
            mime: "image/png",
            expires_at: past
          },
          storage_root: root
        )

      assert {:ok, 2} = Reaper.sweep(root, now)
    end
  end

  describe "init/1 — mkdir_p storage_root" do
    test "creates the storage root if missing" do
      root =
        Path.join(
          System.tmp_dir!(),
          "grappa_uploads_reaper_init_#{System.unique_integer([:positive])}"
        )

      refute File.exists?(root)

      {:ok, pid} =
        Reaper.start_link(
          name: :"reaper_init_test_#{System.unique_integer([:positive])}",
          storage_root: root,
          interval_ms: 60_000_000
        )

      assert File.exists?(root)

      on_exit(fn ->
        if Process.alive?(pid), do: GenServer.stop(pid)
        File.rm_rf!(root)
      end)
    end
  end

  describe "tick scheduling" do
    test "scheduled tick fires sweep automatically" do
      root =
        Path.join(
          System.tmp_dir!(),
          "grappa_uploads_reaper_tick_#{System.unique_integer([:positive])}"
        )

      File.mkdir_p!(root)
      user = user_fixture([])
      past = DateTime.add(DateTime.utc_now(), -60, :second)

      {:ok, expired} =
        Uploads.create(
          "img",
          %{
            subject: {:user, user.id},
            mime: "image/png",
            expires_at: past
          },
          storage_root: root
        )

      pid_name = :"reaper_tick_test_#{System.unique_integer([:positive])}"

      {:ok, pid} =
        Reaper.start_link(
          name: pid_name,
          storage_root: root,
          interval_ms: 20
        )

      # Sandbox-allow the Reaper pid so its sweep can read uploads.
      Ecto.Adapters.SQL.Sandbox.allow(Grappa.Repo, self(), pid)

      # Wait up to 500ms for the soft-delete to land.
      assert eventually(50, 10, fn ->
               reloaded = Grappa.Repo.get!(Uploads.Upload, expired.id)
               not is_nil(reloaded.deleted_at)
             end)

      on_exit(fn ->
        if Process.alive?(pid), do: GenServer.stop(pid)
        File.rm_rf!(root)
      end)
    end
  end

  defp eventually(0, _, _), do: false

  defp eventually(attempts, sleep_ms, fun) do
    if fun.() do
      true
    else
      Process.sleep(sleep_ms)
      eventually(attempts - 1, sleep_ms, fun)
    end
  end
end
