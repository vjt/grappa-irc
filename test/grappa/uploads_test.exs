defmodule Grappa.UploadsTest do
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures, only: [user_fixture: 1, visitor_fixture: 1]

  alias Grappa.Uploads
  alias Grappa.Uploads.Upload

  # Per-test temp storage dir — cleaned via on_exit. Tests inject
  # into `Uploads.create/3` via the `:storage_root` opt + use it
  # directly for storage_path/2 assertions.
  setup do
    root = Path.join(System.tmp_dir!(), "grappa_uploads_test_#{System.unique_integer([:positive])}")
    File.mkdir_p!(root)
    on_exit(fn -> File.rm_rf!(root) end)
    %{root: root}
  end

  describe "mint_slug/0" do
    test "returns 26 chars of lowercase base32" do
      slug = Uploads.mint_slug()
      assert byte_size(slug) == 26
      assert Regex.match?(~r/\A[a-z2-7]{26}\z/, slug)
    end

    test "two consecutive calls return different slugs" do
      refute Uploads.mint_slug() == Uploads.mint_slug()
    end
  end

  describe "valid_slug?/1" do
    test "accepts a freshly minted slug" do
      assert Uploads.valid_slug?(Uploads.mint_slug())
    end

    test "rejects uppercase" do
      refute Uploads.valid_slug?(String.upcase(Uploads.mint_slug()))
    end

    test "rejects path-traversal attempts" do
      refute Uploads.valid_slug?("..")
      refute Uploads.valid_slug?("a/b")
      refute Uploads.valid_slug?("../../etc/passwd")
    end

    test "rejects wrong length" do
      refute Uploads.valid_slug?(String.duplicate("a", 25))
      refute Uploads.valid_slug?(String.duplicate("a", 27))
    end

    test "rejects non-base32 chars" do
      # `1` and `8` and `9` and `0` are NOT in base32 alphabet
      refute Uploads.valid_slug?(String.duplicate("1", 26))
      refute Uploads.valid_slug?(String.duplicate("0", 26))
    end

    test "rejects non-string input" do
      refute Uploads.valid_slug?(nil)
      refute Uploads.valid_slug?(42)
      refute Uploads.valid_slug?(["abc"])
    end
  end

  describe "storage_path/2" do
    test "joins root + slug for a valid slug", %{root: root} do
      slug = Uploads.mint_slug()
      assert Uploads.storage_path(root, slug) == Path.join(root, slug)
    end

    test "raises on invalid slug shape" do
      assert_raise ArgumentError, fn ->
        Uploads.storage_path("/tmp", "../etc/passwd")
      end
    end
  end

  describe "create/3 — happy path" do
    # Lifecycle + byte-arithmetic tests use text/plain: MetadataStrip
    # passes documents through byte-identical, so File.read!/byte_size
    # assertions stay exact. Image/video bytes are REWRITTEN by the
    # strip — those paths are pinned in "create/3 — metadata strip".
    test "writes file + inserts row for user subject", %{root: root} do
      user = user_fixture([])
      bytes = "PLAIN-TEXT-BYTES"

      attrs = %{
        subject: {:user, user.id},
        mime: "text/plain",
        original_filename: "notes.txt",
        expires_at: DateTime.add(DateTime.utc_now(), 3600, :second)
      }

      assert {:ok, %Upload{} = row} =
               Uploads.create(bytes, attrs, storage_root: root, slug: "aaaaaaaaaaaaaaaaaaaaaaaaaa")

      assert row.slug == "aaaaaaaaaaaaaaaaaaaaaaaaaa"
      assert row.user_id == user.id
      assert is_nil(row.visitor_id)
      assert row.mime == "text/plain"
      assert row.bytes == byte_size(bytes)
      assert row.original_filename == "notes.txt"
      assert File.read!(Path.join(root, row.slug)) == bytes
    end

    test "writes file + inserts row for visitor subject", %{root: root} do
      v = visitor_fixture([])
      bytes = "VISITOR-BYTES"

      attrs = %{
        subject: {:visitor, v.id},
        mime: "text/plain",
        expires_at: DateTime.add(DateTime.utc_now(), 3600, :second)
      }

      assert {:ok, %Upload{} = row} = Uploads.create(bytes, attrs, storage_root: root)

      assert row.visitor_id == v.id
      assert is_nil(row.user_id)
      assert row.mime == "text/plain"
      assert row.bytes == byte_size(bytes)
      assert File.exists?(Path.join(root, row.slug))
    end

    test "mints a slug when not supplied", %{root: root} do
      user = user_fixture([])

      attrs = %{
        subject: {:user, user.id},
        mime: "text/plain",
        expires_at: DateTime.add(DateTime.utc_now(), 3600, :second)
      }

      {:ok, row} = Uploads.create("x", attrs, storage_root: root)
      assert Uploads.valid_slug?(row.slug)
    end

    test "sanitizes original_filename — strips path separators", %{root: root} do
      user = user_fixture([])

      attrs = %{
        subject: {:user, user.id},
        mime: "text/plain",
        original_filename: "../../etc/passwd",
        expires_at: DateTime.add(DateTime.utc_now(), 3600, :second)
      }

      {:ok, row} = Uploads.create("x", attrs, storage_root: root)
      # Path separators are the injection vector when the filename is
      # echoed into Content-Disposition; literal ".." chars are harmless
      # without a separator. Sanitizer strips `/` + `\`.
      refute String.contains?(row.original_filename, "/")
      refute String.contains?(row.original_filename, "\\")
    end
  end

  describe "create/3 — failure rollback" do
    test "rolls back the file write when the row insert fails", %{root: root} do
      # Visitor with a fake (non-existent) FK → assoc_constraint
      # fails at insert time. File must NOT remain on disk.
      # sqlite's FK driver doesn't surface the constraint name so
      # Ecto raises ConstraintError instead of returning the
      # changeset — Uploads.create rm's the orphan file before
      # re-raising, so the rollback invariant still holds.
      bogus_visitor_id = Ecto.UUID.generate()

      attrs = %{
        subject: {:visitor, bogus_visitor_id},
        mime: "text/plain",
        expires_at: DateTime.add(DateTime.utc_now(), 3600, :second)
      }

      slug = "bbbbbbbbbbbbbbbbbbbbbbbbbb"

      assert_raise Ecto.ConstraintError, fn ->
        Uploads.create("x", attrs, storage_root: root, slug: slug)
      end

      refute File.exists?(Path.join(root, slug))
    end

    test "rejects unknown subject shape via validate_subject_xor", %{root: root} do
      attrs = %{
        subject: nil,
        mime: "text/plain",
        expires_at: DateTime.add(DateTime.utc_now(), 3600, :second)
      }

      # `Subject.put_subject_id/2` doesn't have a `nil` clause → raises.
      assert_raise FunctionClauseError, fn ->
        Uploads.create("x", attrs, storage_root: root)
      end
    end
  end

  describe "get_by_slug/2" do
    setup %{root: root} do
      user = user_fixture([])
      bytes = "img"

      {:ok, row} =
        Uploads.create(
          bytes,
          %{
            subject: {:user, user.id},
            mime: "text/plain",
            expires_at: DateTime.add(DateTime.utc_now(), 3600, :second)
          },
          storage_root: root
        )

      %{row: row}
    end

    test "returns the row when slug exists + not deleted + not expired", %{row: row} do
      assert {:ok, %Upload{}} = Uploads.get_by_slug(row.slug, DateTime.utc_now())
    end

    test "returns :not_found for bad slug shape" do
      assert {:error, :not_found} = Uploads.get_by_slug("../etc/passwd", DateTime.utc_now())
    end

    test "returns :not_found for unknown slug" do
      assert {:error, :not_found} =
               Uploads.get_by_slug("zzzzzzzzzzzzzzzzzzzzzzzzzz", DateTime.utc_now())
    end

    test "returns :not_found when soft-deleted", %{row: row} do
      {:ok, _} = Uploads.soft_delete(row, DateTime.utc_now())
      assert {:error, :not_found} = Uploads.get_by_slug(row.slug, DateTime.utc_now())
    end

    test "returns :not_found when expired" do
      user = user_fixture([])
      past = DateTime.add(DateTime.utc_now(), -3600, :second)

      {:ok, row} =
        Uploads.create(
          "x",
          %{subject: {:user, user.id}, mime: "text/plain", expires_at: past},
          storage_root: Path.join(System.tmp_dir!(), "grappa_uploads_get_expired_#{System.unique_integer([:positive])}")
        )

      assert {:error, :not_found} = Uploads.get_by_slug(row.slug, DateTime.utc_now())
    end
  end

  describe "live_bytes_sum/0" do
    test "returns 0 when no rows" do
      assert Uploads.live_bytes_sum() == 0
    end

    test "sums bytes across live rows", %{root: root} do
      user = user_fixture([])

      Enum.each(["aaa", "bbbb", "ccccc"], fn b ->
        {:ok, _} =
          Uploads.create(
            b,
            %{
              subject: {:user, user.id},
              mime: "text/plain",
              expires_at: DateTime.add(DateTime.utc_now(), 3600, :second)
            },
            storage_root: root
          )
      end)

      assert Uploads.live_bytes_sum() == 3 + 4 + 5
    end

    test "excludes soft-deleted rows", %{root: root} do
      user = user_fixture([])

      {:ok, _} =
        Uploads.create(
          "ten-chars-",
          %{
            subject: {:user, user.id},
            mime: "text/plain",
            expires_at: DateTime.add(DateTime.utc_now(), 3600, :second)
          },
          storage_root: root
        )

      {:ok, killed} =
        Uploads.create(
          "five5",
          %{
            subject: {:user, user.id},
            mime: "text/plain",
            expires_at: DateTime.add(DateTime.utc_now(), 3600, :second)
          },
          storage_root: root
        )

      {:ok, _} = Uploads.soft_delete(killed, DateTime.utc_now())

      # Only the live row counts: 10 bytes for "ten-chars-".
      assert Uploads.live_bytes_sum() == 10
    end
  end

  describe "list_expired/1" do
    test "returns rows whose expires_at <= now AND not soft-deleted", %{root: root} do
      user = user_fixture([])
      now = DateTime.utc_now()

      {:ok, expired} =
        Uploads.create(
          "a",
          %{
            subject: {:user, user.id},
            mime: "text/plain",
            expires_at: DateTime.add(now, -100, :second)
          },
          storage_root: root
        )

      {:ok, _} =
        Uploads.create(
          "b",
          %{
            subject: {:user, user.id},
            mime: "text/plain",
            expires_at: DateTime.add(now, 3600, :second)
          },
          storage_root: root
        )

      {:ok, already_killed} =
        Uploads.create(
          "c",
          %{
            subject: {:user, user.id},
            mime: "text/plain",
            expires_at: DateTime.add(now, -100, :second)
          },
          storage_root: root
        )

      {:ok, _} = Uploads.soft_delete(already_killed, now)

      slugs = Enum.map(Uploads.list_expired(now), & &1.slug)
      assert slugs == [expired.slug]
    end
  end

  describe "check_caps/3 — the global ceiling" do
    # These two are the rewritten `check_global_cap/2` pair (issue 2175
    # folded that function into `check_caps/3`). The global ceiling is
    # unchanged behaviour and stays asserted: the per-subject cap is an
    # ADDITIONAL floor to clear, never a replacement.
    test "returns :ok when incoming + live_sum fits", %{root: root} do
      user = user_fixture([])
      store(root, {:user, user.id}, 4)

      assert Uploads.check_caps({:user, user.id}, 10, caps(global: 100)) == :ok
    end

    test "returns :insufficient_storage when exceeded", %{root: root} do
      user = user_fixture([])
      store(root, {:user, user.id}, 50)

      assert Uploads.check_caps({:user, user.id}, 60, caps(global: 100)) ==
               {:error, :insufficient_storage}
    end

    test "the global ceiling counts EVERY subject's bytes, not just the caller's",
         %{root: root} do
      hog = user_fixture([])
      me = user_fixture([])
      store(root, {:user, hog.id}, 90)

      # My own per-user room is untouched (0 of 1000 used), but the
      # instance budget is gone. Global must still refuse.
      assert Uploads.check_caps({:user, me.id}, 20, caps(global: 100, user: 1000)) ==
               {:error, :insufficient_storage}
    end
  end

  describe "check_caps/3 — the per-subject ceiling (issue 2175)" do
    test "refuses a user over their own cap while the global budget is wide open",
         %{root: root} do
      user = user_fixture([])
      store(root, {:user, user.id}, 50)

      assert Uploads.check_caps({:user, user.id}, 60, caps(global: 1_000_000, user: 100)) ==
               {:error, :insufficient_storage}
    end

    test "admits a user UNDER their own cap (negative control)", %{root: root} do
      user = user_fixture([])
      store(root, {:user, user.id}, 50)

      assert Uploads.check_caps({:user, user.id}, 10, caps(global: 1_000_000, user: 100)) == :ok
    end

    test "refuses a visitor over their own cap", %{root: root} do
      visitor = visitor_fixture([])
      store(root, {:visitor, visitor.id}, 50)

      assert Uploads.check_caps({:visitor, visitor.id}, 60, caps(global: 1_000_000, visitor: 100)) ==
               {:error, :insufficient_storage}
    end

    test "admits a visitor UNDER their own cap (negative control)", %{root: root} do
      visitor = visitor_fixture([])
      store(root, {:visitor, visitor.id}, 50)

      assert Uploads.check_caps({:visitor, visitor.id}, 10, caps(global: 1_000_000, visitor: 100)) ==
               :ok
    end

    test "another subject's bytes do NOT count against mine", %{root: root} do
      hog = user_fixture([])
      me = user_fixture([])
      store(root, {:user, hog.id}, 90)

      # 90 bytes exist, but none of them are mine: with a 100-byte
      # per-user cap I still have 100 to spend. This is the whole point
      # of the quota being per-subject rather than shared.
      assert Uploads.check_caps({:user, me.id}, 90, caps(global: 1_000_000, user: 100)) == :ok
    end

    test "a user is measured against the USER cap, not the visitor one", %{root: root} do
      user = user_fixture([])
      store(root, {:user, user.id}, 50)

      # Discriminating control: 60 incoming busts the 100-byte VISITOR
      # ceiling but fits the 1000-byte USER one. Reading the wrong key
      # off the subject flips this assert.
      assert Uploads.check_caps({:user, user.id}, 60, caps(global: 1_000_000, user: 1000, visitor: 100)) ==
               :ok
    end

    test "a visitor is measured against the VISITOR cap, not the user one", %{root: root} do
      visitor = visitor_fixture([])
      store(root, {:visitor, visitor.id}, 50)

      assert Uploads.check_caps(
               {:visitor, visitor.id},
               60,
               caps(global: 1_000_000, user: 1000, visitor: 100)
             ) == {:error, :insufficient_storage}
    end

    test "soft-deleted rows stop counting — the quota frees itself when the reaper collects",
         %{root: root} do
      user = user_fixture([])
      row = store(root, {:user, user.id}, 90)

      assert Uploads.check_caps({:user, user.id}, 50, caps(global: 1_000_000, user: 100)) ==
               {:error, :insufficient_storage}

      {:ok, _} = Uploads.soft_delete(row, DateTime.utc_now())

      # No parallel accounting to keep in sync: the sum is computed live
      # off `deleted_at IS NULL`, so reaping is what returns the room.
      assert Uploads.check_caps({:user, user.id}, 50, caps(global: 1_000_000, user: 100)) == :ok
    end

    test "the boundary is EXCLUSIVE: landing exactly ON the cap is admitted", %{root: root} do
      user = user_fixture([])
      store(root, {:user, user.id}, 40)

      assert Uploads.check_caps({:user, user.id}, 60, caps(global: 1_000_000, user: 100)) == :ok

      assert Uploads.check_caps({:user, user.id}, 61, caps(global: 1_000_000, user: 100)) ==
               {:error, :insufficient_storage}
    end
  end

  describe "soft_delete/2" do
    test "idempotent on an already-deleted row", %{root: root} do
      user = user_fixture([])

      {:ok, row} =
        Uploads.create(
          "x",
          %{
            subject: {:user, user.id},
            mime: "text/plain",
            expires_at: DateTime.add(DateTime.utc_now(), 3600, :second)
          },
          storage_root: root
        )

      now = DateTime.utc_now()
      {:ok, deleted_once} = Uploads.soft_delete(row, now)
      {:ok, deleted_twice} = Uploads.soft_delete(deleted_once, now)
      assert deleted_once.deleted_at == deleted_twice.deleted_at
    end
  end

  describe "delete_all_for_subject/1" do
    test "deletes every uploads row for the user AND removes their files", %{root: root} do
      user = user_fixture([])
      other = user_fixture([])
      bytes = "test-bytes-for-upload"
      future = DateTime.add(DateTime.utc_now(), 3600, :second)

      {:ok, u1} =
        Uploads.create(
          bytes,
          %{subject: {:user, user.id}, mime: "text/plain", expires_at: future},
          storage_root: root
        )

      {:ok, u2} =
        Uploads.create(
          bytes,
          %{subject: {:user, user.id}, mime: "text/plain", expires_at: future},
          storage_root: root
        )

      {:ok, uo} =
        Uploads.create(
          bytes,
          %{subject: {:user, other.id}, mime: "text/plain", expires_at: future},
          storage_root: root
        )

      u1_path = Uploads.storage_path(root, u1.slug)
      u2_path = Uploads.storage_path(root, u2.slug)
      uo_path = Uploads.storage_path(root, uo.slug)

      # Pre-condition: all three files exist
      assert File.exists?(u1_path)
      assert File.exists?(u2_path)
      assert File.exists?(uo_path)

      # NOTE: production helper reads storage_root from :persistent_term
      # (boot-time injection), not from per-test :storage_root opt. Tests
      # set the persistent_term root to the per-test temp dir so the
      # File.rm sweep targets the same files create/3 wrote. Restore on
      # exit to avoid leaking the per-test path into sibling tests.
      original_root = Uploads.storage_root()
      :ok = Uploads.boot(root)
      on_exit(fn -> :ok = Uploads.boot(original_root) end)

      assert :ok = Uploads.delete_all_for_subject({:user, user.id})

      # Rows for user gone; other user's row + file preserved
      assert Uploads.get_by_id(u1.id) == {:error, :not_found}
      assert Uploads.get_by_id(u2.id) == {:error, :not_found}
      assert {:ok, _} = Uploads.get_by_id(uo.id)

      # Files for user gone; other user's file preserved
      refute File.exists?(u1_path)
      refute File.exists?(u2_path)
      assert File.exists?(uo_path)
    end

    test "is idempotent when the subject has no uploads" do
      user = user_fixture([])
      assert :ok = Uploads.delete_all_for_subject({:user, user.id})
    end
  end

  describe "create/3 — metadata strip (#39)" do
    # The strip mechanics (per-format markers, fail-closed dispatch)
    # are pinned in Grappa.Uploads.MetadataStripTest; these tests pin
    # the INTEGRATION: what create/3 stores is the stripped bytes,
    # the row reflects the stored size, and a strip failure leaves
    # neither file nor row behind.
    import Grappa.UploadFixtures, only: [bytes: 1, refute_markers!: 2]

    test "stores a GPS-tagged jpeg stripped — markers gone, row.bytes = stored size",
         %{root: root} do
      user = user_fixture([])
      input = bytes(:gps_jpeg)

      attrs = %{
        subject: {:user, user.id},
        mime: "image/jpeg",
        expires_at: DateTime.add(DateTime.utc_now(), 3600, :second)
      }

      assert {:ok, row} = Uploads.create(input, attrs, storage_root: root)

      stored = File.read!(Path.join(root, row.slug))
      refute stored == input
      assert row.bytes == byte_size(stored)
      refute_markers!(stored, :gps_jpeg)
    end

    test "stores a GPS-tagged mp4 stripped", %{root: root} do
      user = user_fixture([])
      input = bytes(:gps_mp4)

      attrs = %{
        subject: {:user, user.id},
        mime: "video/mp4",
        expires_at: DateTime.add(DateTime.utc_now(), 3600, :second)
      }

      assert {:ok, row} = Uploads.create(input, attrs, storage_root: root)

      stored = File.read!(Path.join(root, row.slug))
      refute_markers!(stored, :gps_mp4)
    end

    test "strip failure rejects the upload — no file, no row", %{root: root} do
      user = user_fixture([])
      slug = "dddddddddddddddddddddddddd"

      attrs = %{
        subject: {:user, user.id},
        mime: "image/jpeg",
        expires_at: DateTime.add(DateTime.utc_now(), 3600, :second)
      }

      assert {:error, {:metadata_strip, _}} =
               Uploads.create("not actually a jpeg", attrs, storage_root: root, slug: slug)

      refute File.exists?(Path.join(root, slug))
      assert Uploads.list_all() == []
    end
  end

  # #379 (P0, 2026-07-22) — `uploads.visitor_id` is a `ON DELETE CASCADE`
  # child of `visitors` but shipped WITHOUT an index on the column
  # (`20260520215304_create_uploads_and_server_settings.exs`). Every
  # visitor delete (the Reaper's per-row reap CASCADEs across ~13 tables)
  # therefore full-scans `uploads` to enforce that FK. The index turns
  # the enforcement lookup into a seek.
  describe "#379 — uploads.visitor_id cascade-FK index" do
    test "the FK-enforcement lookup seeks uploads_visitor_id_index, not SCAN" do
      # Mirrors the child-key lookup SQLite runs to enforce the
      # `ON DELETE CASCADE` when a visitor row is deleted.
      %Exqlite.Result{rows: rows} =
        Repo.query!(
          "EXPLAIN QUERY PLAN SELECT 1 FROM uploads WHERE visitor_id = ? LIMIT 1",
          [Ecto.UUID.generate()]
        )

      plan = Enum.map_join(rows, "\n", fn [_, _, _, detail] -> detail end)

      assert plan =~ "uploads_visitor_id_index",
             """
             Expected EXPLAIN QUERY PLAN to SEARCH via uploads_visitor_id_index
             (not SCAN uploads), got:
             #{plan}
             """
    end
  end

  # #380 (2026-07-26) — `uploads.user_id` is the XOR sibling of #379's
  # `uploads.visitor_id`: an `ON DELETE CASCADE` child of `users` that also
  # shipped WITHOUT an index (`20260520215304_create_uploads_and_server_
  # settings.exs`). A manual user-delete admin op therefore full-scans
  # `uploads` to enforce the FK — the identical bug class as #379, scoped
  # out of that P0 because it's the rare op (not the 60s Reaper sweep).
  # This closes the root-cause class.
  describe "#380 — uploads.user_id cascade-FK index" do
    test "the FK-enforcement lookup seeks uploads_user_id_index, not SCAN" do
      # Mirrors the child-key lookup SQLite runs to enforce the
      # `ON DELETE CASCADE` when a user row is deleted.
      %Exqlite.Result{rows: rows} =
        Repo.query!(
          "EXPLAIN QUERY PLAN SELECT 1 FROM uploads WHERE user_id = ? LIMIT 1",
          [Ecto.UUID.generate()]
        )

      plan = Enum.map_join(rows, "\n", fn [_, _, _, detail] -> detail end)

      assert plan =~ "uploads_user_id_index",
             """
             Expected EXPLAIN QUERY PLAN to SEARCH via uploads_user_id_index
             (not SCAN uploads), got:
             #{plan}
             """
    end
  end

  # ------------------------------------------------------------------
  # Helpers — issue 2175
  # ------------------------------------------------------------------

  # A ceiling no test deliberately bumps into. Every `caps/1` key the
  # caller does NOT name is set here, so exactly ONE ceiling can be the
  # reason a given assert refuses: a test that names `user:` and fails
  # has failed on the user cap, never on a global default that happened
  # to be tighter.
  @unreachable_cap 1_000_000_000

  defp caps(overrides) do
    Enum.into(overrides, %{
      global: @unreachable_cap,
      user: @unreachable_cap,
      visitor: @unreachable_cap
    })
  end

  # Stores `byte_count` live bytes owned by `subject` and returns the row.
  # `text/plain` passes `MetadataStrip` through untouched, so the stored
  # size is exactly the requested one and the cap arithmetic in the
  # asserts is readable.
  defp store(root, subject, byte_count) do
    {:ok, row} =
      Uploads.create(
        String.duplicate("a", byte_count),
        %{
          subject: subject,
          mime: "text/plain",
          expires_at: DateTime.add(DateTime.utc_now(), 3600, :second)
        },
        storage_root: root
      )

    row
  end
end
