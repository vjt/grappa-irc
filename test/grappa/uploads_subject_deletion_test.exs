defmodule Grappa.UploadsSubjectDeletionTest do
  # `async: false`: these exercise the PRODUCTION chokepoints, which read the
  # storage root from `:persistent_term` (`Uploads.boot/1`) rather than from a
  # per-call `:storage_root` opt. Booting a per-test root is global state, so
  # this module cannot share the scheduler with anything that reads it — the
  # same posture `GrappaWeb.Admin.UploadsControllerTest` already takes.
  use Grappa.DataCase, async: false

  import ExUnit.CaptureLog
  import Grappa.AuthFixtures, only: [user_fixture: 1, visitor_fixture: 1]

  alias Grappa.{Accounts, ServerSettings, Uploads, Visitors}

  setup do
    root =
      Path.join(
        System.tmp_dir!(),
        "grappa_subject_deletion_test_#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(root)

    original_root = Uploads.storage_root()
    :ok = Uploads.boot(root)

    on_exit(fn ->
      :ok = Uploads.boot(original_root)
      File.rm_rf!(root)
    end)

    %{root: root}
  end

  defp upload_for(subject, root) do
    {:ok, row} =
      Uploads.create(
        "bytes-that-must-not-survive-#{System.unique_integer([:positive])}",
        %{
          subject: subject,
          mime: "text/plain",
          expires_at: DateTime.add(DateTime.utc_now(), 3600, :second)
        },
        ServerSettings.upload_caps(),
        storage_root: root
      )

    {row, Uploads.storage_path(root, row.slug)}
  end

  describe "Accounts.delete_user/1 — the user chokepoint" do
    test "the bytes are gone from the disk, not merely the row", %{root: root} do
      user = user_fixture([])
      {row, path} = upload_for({:user, user.id}, root)

      # Pre-state asserted before the gesture: without this the post-assert
      # would pass on a file that was never written.
      assert File.exists?(path)

      assert :ok = Accounts.delete_user(user)

      refute File.exists?(path)
      assert Uploads.get_by_id(row.id) == {:error, :not_found}
    end

    test "another user's bytes are untouched", %{root: root} do
      user = user_fixture([])
      other = user_fixture([])
      {_, path} = upload_for({:user, user.id}, root)
      {other_row, other_path} = upload_for({:user, other.id}, root)

      assert :ok = Accounts.delete_user(user)

      refute File.exists?(path)
      assert File.exists?(other_path)
      assert {:ok, _} = Uploads.get_by_id(other_row.id)
    end

    test "a user with no uploads deletes cleanly" do
      user = user_fixture([])
      assert :ok = Accounts.delete_user(user)
    end
  end

  describe "Visitors.delete/1 — the visitor chokepoint" do
    test "the bytes are gone from the disk", %{root: root} do
      visitor = visitor_fixture([])
      {row, path} = upload_for({:visitor, visitor.id}, root)

      assert File.exists?(path)

      assert :ok = Visitors.delete(visitor.id)

      refute File.exists?(path)
      assert Uploads.get_by_id(row.id) == {:error, :not_found}
    end
  end

  describe "a failing unlink" do
    # The failure is forced by putting a DIRECTORY where the file belongs:
    # `File.rm/1` refuses on every platform we run on. The errno differs
    # (BSD `:eperm`, Linux `:eisdir`), so nothing here asserts WHICH — the
    # production arm treats every non-`:enoent` reason the same way, and
    # pinning the errno would make this red on the other kernel.
    #
    # Read-only-parent (`chmod`) was rejected: CI runs the container as root,
    # and root ignores the permission bits, so that setup would pass the test
    # vacuously on exactly the platform that gates the merge.
    defp break_unlink!(path) do
      File.rm!(path)
      File.mkdir!(path)
      assert {:error, _} = File.rm(path)
    end

    test "does not stop the account deletion", %{root: root} do
      user = user_fixture([])
      {row, path} = upload_for({:user, user.id}, root)
      break_unlink!(path)

      capture_log(fn -> assert :ok = Accounts.delete_user(user) end)

      # The account is gone even though its bytes could not be unlinked —
      # a read-only disk must not hold someone's deletion hostage.
      assert Accounts.get_user(user.id) == nil
      assert Uploads.get_by_id(row.id) == {:error, :not_found}
    end

    test "says so in the log, with the slug that leaked", %{root: root} do
      user = user_fixture([])
      {row, path} = upload_for({:user, user.id}, root)
      break_unlink!(path)

      log = capture_log(fn -> assert :ok = Accounts.delete_user(user) end)

      # The row is the reaper's retry token and it is about to be destroyed,
      # so this line is the ONLY surviving record of which bytes leaked. It
      # has to carry the slug, or it names no file.
      assert log =~ "upload orphaned"
      assert log =~ row.slug
    end

    test "an already-missing file is NOT reported as a failure", %{root: root} do
      user = user_fixture([])
      {_, path} = upload_for({:user, user.id}, root)
      File.rm!(path)

      log = capture_log(fn -> assert :ok = Accounts.delete_user(user) end)

      # `:enoent` is the expected idempotent case (the reaper got there
      # first, or a prior partial run did). Logging it as a failure would
      # drown the signal the test above depends on.
      refute log =~ "upload orphaned"
    end
  end
end
