defmodule Grappa.DccTest do
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures, only: [network_fixture: 0, user_fixture: 0, visitor_fixture: 0]

  alias Grappa.{Dcc, Repo, UserSettings}
  alias Grappa.Dcc.SpoolFile

  setup do
    user = user_fixture()
    {:ok, subject: {:user, user.id}, network_id: network_fixture().id}
  end

  defp meta(over \\ %{}) do
    Map.merge(
      %{
        peer_nick: "vjt",
        filename: "holiday.tar.gz",
        bytes: 4096,
        retention_seconds: Dcc.max_retention_seconds()
      },
      over
    )
  end

  describe "retention_seconds/1 — vjt's hard cap wins, nil included" do
    test "a subject who never set an upload TTL gets the hard cap, NOT 'never'" do
      # This is the whole ruling in one assertion. `get_upload_ttl_seconds/1`
      # answers nil for the DEFAULT state, and in the uploads model a null
      # `expires_at` means NEVER EXPIRES — so reusing that TTL literally
      # would have left a stranger's bytes on disk forever for the average
      # user, which is the inverse of what issue 2089 requires.
      assert Dcc.retention_seconds(nil) == Dcc.max_retention_seconds()
    end

    test "a subject's own shorter TTL is honoured — the cap is a ceiling, not a floor" do
      assert Dcc.retention_seconds(3600) == 3600
    end

    test "a subject's LONGER TTL is clamped, and the clamp is not decorative" do
      # Measured against the real ceiling of the setting rather than an
      # invented number: `UserSettings.put_upload_ttl_seconds/2` accepts up
      # to a year, so a subject really can ask for one and really is cut
      # down to the spool's cap here.
      a_year = 31_536_000
      assert Dcc.retention_seconds(a_year) == Dcc.max_retention_seconds()
      assert Dcc.max_retention_seconds() < a_year
    end

    test "the setting that feeds it really does answer nil by default", ctx do
      # The premise the ruling rests on, asserted against production code
      # rather than quoted from the issue. If this ever stops being nil,
      # the nil arm above becomes dead and someone must know.
      assert UserSettings.get_upload_ttl_seconds(ctx.subject) == nil
    end

    test "the cap is the longest rung of the upload TTL ladder" do
      # The number is OURS, not ruled — but it is derived, not invented:
      # three days is the longest retention this deployment offers a user
      # for their OWN content, and stranger-pushed bytes must not outlive
      # that. Pinned so a change to either side is a deliberate one.
      assert Dcc.max_retention_seconds() == 259_200
    end
  end

  describe "store/4" do
    test "records an accepted file with a NON-NULL expiry", ctx do
      assert {:ok, %SpoolFile{} = row} =
               Dcc.store(ctx.subject, ctx.network_id, Dcc.mint_slug(), meta())

      # The column is NOT NULL in DDL precisely so this cannot drift.
      assert row.expires_at
      assert DateTime.compare(row.expires_at, DateTime.utc_now()) == :gt
    end

    test "a zero-byte file is storable — an empty file is a legal DCC SEND", ctx do
      # `IRC.DCC.parse/1` admits `size == 0` deliberately. Rejecting it HERE
      # — after the offer was accepted, the socket dialled and the transfer
      # completed — would strand the bytes on disk with no row for any
      # sweeper to find them by.
      assert {:ok, %SpoolFile{bytes: 0}} =
               Dcc.store(ctx.subject, ctx.network_id, Dcc.mint_slug(), meta(%{bytes: 0}))
    end

    test "a visitor owns a spool file exactly as a user does", ctx do
      visitor = visitor_fixture()

      assert {:ok, %SpoolFile{visitor_id: vid, user_id: nil}} =
               Dcc.store({:visitor, visitor.id}, ctx.network_id, Dcc.mint_slug(), meta())

      assert vid == visitor.id
    end

    test "the subject XOR is enforced", ctx do
      # Not a theoretical constraint: the DB carries `dcc_files_subject_xor`
      # and the changeset carries `Subject.validate_xor/1`, and a row owned
      # by nobody would be invisible to every subject-scoped read below.
      attrs = %{
        slug: Dcc.mint_slug(),
        network_id: ctx.network_id,
        peer_nick: "vjt",
        filename: "f.bin",
        bytes: 1,
        expires_at: DateTime.utc_now()
      }

      refute %SpoolFile{} |> SpoolFile.insert_changeset(attrs) |> Map.fetch!(:valid?)
    end
  end

  describe "get_by_slug/3 — scoped to the subject AND the network" do
    setup ctx do
      slug = Dcc.mint_slug()
      {:ok, row} = Dcc.store(ctx.subject, ctx.network_id, slug, meta())
      {:ok, slug: slug, row: row}
    end

    test "finds the owner's own live row", ctx do
      assert {:ok, %SpoolFile{id: id}} = Dcc.get_by_slug(ctx.subject, ctx.network_id, ctx.slug)
      assert id == ctx.row.id
    end

    test "another subject cannot read it, even holding the slug", ctx do
      # The conjunct that matters most in this context: unlike a cached
      # avatar, these bytes were sent TO a person.
      other = {:user, user_fixture().id}
      assert {:error, :not_found} = Dcc.get_by_slug(other, ctx.network_id, ctx.slug)
    end

    test "another network cannot read it", ctx do
      # `ResolveNetwork` proves a credential on the network in the PATH and
      # nothing beyond it, so a slug-only lookup would grant more than the
      # route's own gate establishes.
      assert {:error, :not_found} = Dcc.get_by_slug(ctx.subject, network_fixture().id, ctx.slug)
    end

    test "an expired row is not found — the retention rule holds at the READ too", ctx do
      past = DateTime.add(DateTime.utc_now(), -60, :second)
      Repo.update_all(SpoolFile, set: [expires_at: past])

      assert {:error, :not_found} = Dcc.get_by_slug(ctx.subject, ctx.network_id, ctx.slug)
    end

    test "a slug that is not the minted shape is refused before it reaches a query", ctx do
      for bad <- ["../../etc/passwd", "", "SHOUTING", String.duplicate("a", 25)] do
        assert {:error, :not_found} = Dcc.get_by_slug(ctx.subject, ctx.network_id, bad)
      end
    end

    test "a missing slug collapses to the same error — no oracle", ctx do
      assert {:error, :not_found} = Dcc.get_by_slug(ctx.subject, ctx.network_id, Dcc.mint_slug())
    end
  end

  describe "list_expired/1 + delete/1 — the reaper's two verbs" do
    test "only rows past their expiry are enumerated", ctx do
      {:ok, live} = Dcc.store(ctx.subject, ctx.network_id, Dcc.mint_slug(), meta())

      {:ok, stale} =
        Dcc.store(ctx.subject, ctx.network_id, Dcc.mint_slug(), meta(%{retention_seconds: 1}))

      later = DateTime.add(DateTime.utc_now(), 60, :second)
      ids = later |> Dcc.list_expired() |> Enum.map(& &1.id)

      assert stale.id in ids
      refute live.id in ids
    end

    test "delete/1 hard-deletes — there is no soft-delete tombstone here", ctx do
      {:ok, row} = Dcc.store(ctx.subject, ctx.network_id, Dcc.mint_slug(), meta())

      assert :ok = Dcc.delete(row)
      assert Repo.get(SpoolFile, row.id) == nil
    end
  end

  describe "the disk budget" do
    test "an empty spool has room", _ctx do
      assert Dcc.budget_available?()
    end

    test "it reserves the CEILING, not the offer's claimed size", ctx do
      # The reservation is deliberately pessimistic: the claim belongs to
      # the peer, and a sender who declares low to slip under the budget is
      # exactly who this check exists for. Fill to within less than one
      # ceiling of the cap and the answer must be no, even though the rows
      # themselves are well under it.
      headroom = Dcc.global_cap_bytes() - Dcc.max_transfer_bytes() + 1

      {:ok, _} =
        Dcc.store(ctx.subject, ctx.network_id, Dcc.mint_slug(), meta(%{bytes: headroom}))

      refute Dcc.budget_available?()
    end

    test "the per-transfer ceiling is well under the whole budget" do
      # A ceiling at or above the budget would make the budget check
      # unsatisfiable from the first byte.
      assert Dcc.max_transfer_bytes() < Dcc.global_cap_bytes()
      assert Dcc.max_transfer_bytes() == 10 * 1024 * 1024
      assert Dcc.global_cap_bytes() == 1024 * 1024 * 1024
    end
  end

  describe "slugs and paths" do
    test "a minted slug is 26 lower-case base32 chars" do
      assert Dcc.mint_slug() =~ ~r/\A[a-z2-7]{26}\z/
    end

    test "two mints differ" do
      assert Dcc.mint_slug() != Dcc.mint_slug()
    end

    test "storage_path/1 raises on anything that is not a minted slug" do
      # This value reaches `File.read/1`. The guard is what makes the
      # peer's own filename structurally unable to get here — it is stored
      # as display metadata and is never a path.
      for bad <- ["../../etc/passwd", "a/b", "", "Slug"] do
        assert_raise ArgumentError, fn -> Dcc.storage_path(bad) end
      end
    end

    test "storage_path/1 joins a real slug under the configured root" do
      slug = Dcc.mint_slug()
      assert Dcc.storage_path(slug) == Path.join(Dcc.storage_root(), slug)
    end
  end
end
