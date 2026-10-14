defmodule Grappa.DccTest do
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures, only: [network_fixture: 0, user_fixture: 0, visitor_fixture: 0]

  alias Grappa.{Dcc, Repo, ServerSettings, Uploads, UserSettings}
  alias Grappa.Dcc.{Report, SpoolFile}

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

  describe "get_by_slug/1 — the slug alone, because the slug IS the credential" do
    setup ctx do
      slug = Dcc.mint_slug()
      {:ok, row} = Dcc.store(ctx.subject, ctx.network_id, slug, meta())
      {:ok, slug: slug, row: row}
    end

    test "finds the live row", ctx do
      assert {:ok, %SpoolFile{id: id}} = Dcc.get_by_slug(ctx.slug)
      assert id == ctx.row.id
    end

    # This describe used to pin a subject conjunct AND a network conjunct
    # ("another subject cannot read it, even holding the slug"). Issue 2127
    # retired both with the gate they matched, so those two tests are gone
    # rather than weakened — the arity IS the statement here, and a
    # duplicate of the happy path asserting "someone else also gets it"
    # would be a mirror, not a test. The posture is observable at the
    # ROUTE, so it is pinned there instead: see
    # `GrappaWeb.DccControllerTest`, "a request with NO bearer at all is
    # served".

    test "an expired row is not found — the ONLY revocation there is", ctx do
      # Load-bearing since the route was ungated: `expires_at` is now the
      # whole of what stops a leaked URL, so this is not a tidy edge case.
      past = DateTime.add(DateTime.utc_now(), -60, :second)
      Repo.update_all(SpoolFile, set: [expires_at: past])

      assert {:error, :not_found} = Dcc.get_by_slug(ctx.slug)
    end

    test "a slug that is not the minted shape is refused before it reaches a query" do
      for bad <- ["../../etc/passwd", "", "SHOUTING", String.duplicate("a", 25)] do
        assert {:error, :not_found} = Dcc.get_by_slug(bad)
      end
    end

    test "a missing slug collapses to the same error — no oracle" do
      assert {:error, :not_found} = Dcc.get_by_slug(Dcc.mint_slug())
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
      assert Dcc.max_transfer_bytes() == 100 * 1024 * 1024
      assert Dcc.global_cap_bytes() == 10 * 1024 * 1024 * 1024
    end

    # issue 2185 — both ceilings are operator settings now. The accessors
    # are `Grappa.Dcc`'s one door onto them, so a caller that reads the
    # context reads the operator's value and never a compile-time ghost.
    test "both accessors follow the operator setting", _ctx do
      :ok = ServerSettings.put_dcc_max_transfer_bytes(7 * 1024 * 1024)
      :ok = ServerSettings.put_dcc_global_cap_bytes(3 * 1024 * 1024 * 1024)

      assert Dcc.max_transfer_bytes() == 7 * 1024 * 1024
      assert Dcc.global_cap_bytes() == 3 * 1024 * 1024 * 1024
    end

    test "budget_available?/0 reads BOTH settings, never one against a constant", ctx do
      # The half-lever this issue exists to close: with only one of the two
      # runtime, an operator raising the per-transfer ceiling could not
      # raise the budget to fit it, and vice versa. Each direction is
      # exercised on its own so a regression that froze EITHER side is
      # caught by the assertion for that side.
      {:ok, _} =
        Dcc.store(ctx.subject, ctx.network_id, Dcc.mint_slug(), meta(%{bytes: 500 * 1024 * 1024}))

      # Budget moves: the same spool and the same ceiling, two answers.
      :ok = ServerSettings.put_dcc_max_transfer_bytes(100 * 1024 * 1024)
      :ok = ServerSettings.put_dcc_global_cap_bytes(1024 * 1024 * 1024)
      assert Dcc.budget_available?()

      :ok = ServerSettings.put_dcc_global_cap_bytes(550 * 1024 * 1024)
      refute Dcc.budget_available?()

      # Ceiling moves: the same spool and the same budget, two answers.
      :ok = ServerSettings.put_dcc_max_transfer_bytes(10 * 1024 * 1024)
      assert Dcc.budget_available?()
    end
  end

  describe "the transfer budgets and the orphan grace — one source (issue 2405)" do
    test "no live transfer can leave its file unwritten for as long as the orphan grace" do
      # The reaper tells an orphan from a transfer in flight by the file's
      # mtime, so the grace must outlast the longest a LIVE transfer can go
      # without writing: the dial plus one idle wait before the first
      # chunk, one idle wait between any two. If a budget grows past the
      # grace, the reaper unlinks a file a transfer is still writing.
      opts = Dcc.transfer_opts()

      assert Dcc.orphan_grace_seconds() * 1_000 > opts[:connect_timeout_ms] + opts[:idle_timeout_ms]
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

  describe "public_url/2 — the hostile half: an extension off the peer's filename" do
    # These come FIRST on purpose. The extension's only source is a
    # `DCC SEND` filename, which is attacker-controlled text, and the URL
    # it decorates is published into somebody's scrollback. The whitelist
    # is what stops the peer from grafting structure onto that URL.
    setup do
      {:ok, slug: Dcc.mint_slug()}
    end

    test "a filename whose tail is not pure ASCII alphanumeric yields NO extension", ctx do
      hostile = [
        # Path structure: the peer must not be able to add a segment.
        {"../../etc/passwd", "traversal"},
        {"evil.tar/../../root", "slash in the tail"},
        # URL structure: query, fragment, percent-escape, scheme colon.
        {"clip.mp4?token=steal", "query string"},
        {"clip.mp4#tracking", "fragment"},
        {"clip.%2e%2e", "percent escape"},
        {"clip.mp 4", "whitespace"},
        # Control bytes are BUILT, never written as literals: a literal
        # NUL or CRLF in a source file is invisible in review and one
        # editor away from silently vanishing.
        {"clip.mp" <> <<9>> <> "4", "tab"},
        {"clip.mp4" <> <<0>>, "NUL byte"},
        {"clip.mp4" <> <<13, 10>> <> "X-Evil: 1", "CRLF injection"},
        {"clip.mp4 ", "trailing space"},
        # Shape: empty, absent, over-long, non-ASCII.
        {"trailing.", "empty extension"},
        {"no_extension_at_all", "no dot at all"},
        {".", "a lone dot"},
        {"..", "two dots and nothing else"},
        {"clip." <> String.duplicate("a", 200), "a 200-char tail"},
        {"clip." <> String.duplicate("a", 9), "one char past the cap"},
        {"clip." <> <<0xD0, 0xBC, 0xD0, 0xBF>> <> "4", "cyrillic extension"},
        {"clip.m" <> <<0xC3, 0xA9>> <> "p4", "accented latin-1"}
      ]

      for {filename, why} <- hostile do
        assert Dcc.public_url(ctx.slug, filename) ==
                 Uploads.base_url() <> "/dcc_files/" <> ctx.slug,
               "#{why}: #{inspect(filename)} must mint a BARE url, not an extension"
      end
    end

    test "no rejected filename can ever change the URL's structure", ctx do
      # The property behind the table above, stated once: whatever the
      # peer names the file, the minted URL is the bare one plus at most a
      # dot and 8 ASCII alphanumerics. Nothing can introduce a second
      # path segment, a query or a fragment.
      bare = Uploads.base_url() <> "/dcc_files/" <> ctx.slug

      for filename <- ["a.b/c", "a.b?c", "a.b#c", "a.b%2f", "a.b:c", "a.b\\c", "a.b&c=d"] do
        url = Dcc.public_url(ctx.slug, filename)
        assert url == bare, "#{inspect(filename)} leaked structure into #{inspect(url)}"
      end
    end

    test "the cap is measured against the extension the house itself mints" do
      # Derived, not invented: 8 is twice the longest extension
      # `Grappa.Uploads.MimeExt` can produce, so every type this
      # deployment already knows how to name fits with room to spare.
      longest_minted =
        ["png", "jpeg", "webp", "webm", "flac", "opus", "apng"]
        |> Enum.map(&byte_size/1)
        |> Enum.max()

      slug = Dcc.mint_slug()
      assert longest_minted <= 8

      # And the boundary is exactly where it says it is.
      assert Dcc.public_url(slug, "f." <> String.duplicate("a", 8)) =~
               "." <> String.duplicate("a", 8)

      assert Dcc.public_url(slug, "f." <> String.duplicate("a", 9)) ==
               Uploads.base_url() <> "/dcc_files/" <> slug
    end
  end

  describe "public_url/2 — the shape it mints when the filename behaves" do
    setup do
      {:ok, slug: Dcc.mint_slug()}
    end

    test "absolute, on the deployment's own base URL — the whole of defect 1", ctx do
      # The relative `/networks/1/dcc_files/<slug>` matched neither of
      # linkify's alternatives (no scheme, no `host.tld/`) and rendered as
      # dead text. Asserted against the SAME accessor `Uploads.public_url/2`
      # builds on, not a literal.
      url = Dcc.public_url(ctx.slug, "holiday.jpg")

      assert String.starts_with?(url, Uploads.base_url())
      assert url == Uploads.base_url() <> "/dcc_files/" <> ctx.slug <> ".jpg"
    end

    test "no network id in the path — the route carries none any more", ctx do
      refute Dcc.public_url(ctx.slug, "holiday.jpg") =~ "/networks/"
    end

    test "the LAST dot-segment wins, so a double extension keeps the real one", ctx do
      assert Dcc.public_url(ctx.slug, "holiday.tar.gz") =~ ".gz"
      refute Dcc.public_url(ctx.slug, "holiday.tar.gz") =~ ".tar"
    end

    test "an extension is lowercased, and only after it is admitted", ctx do
      # Validate-then-fold, never fold-then-validate: `String.downcase/1`
      # is Unicode and would turn `İ` into two code points, smuggling a
      # combining mark past a check that ran before it.
      assert Dcc.public_url(ctx.slug, "HOLIDAY.JPG") =~ ".jpg"
      assert Dcc.public_url(ctx.slug, "clip.Mp4") =~ ".mp4"
      assert Dcc.public_url(ctx.slug, "clip.İ") == Uploads.base_url() <> "/dcc_files/" <> ctx.slug
    end

    test "the extension never reaches the lookup — the slug still keys the row", ctx do
      # The rule the route depends on, asserted where the URL is minted:
      # the 26 characters between the last `/` and the first `.` are the
      # slug the controller will look up.
      url = Dcc.public_url(ctx.slug, "Deadpool.e.Wolverine.2024.mp4")

      addressed =
        url |> String.split("/") |> List.last() |> GrappaWeb.Validation.slug_from_path()

      assert addressed == ctx.slug
      assert {:error, :not_found} = Dcc.get_by_slug(addressed)
    end

    test "the raw filename is the source, NOT the truncated display name", ctx do
      # `Report.display_filename/1` caps at 120 bytes and appends `…`, so
      # feeding it here would eat the extension off a long name — and
      # could make the last dot-segment something the peer never wrote.
      long = String.duplicate("a", 200) <> ".mp4"

      assert Dcc.public_url(ctx.slug, long) =~ ".mp4"
      refute Report.display_filename(long) =~ ".mp4"
    end
  end
end
