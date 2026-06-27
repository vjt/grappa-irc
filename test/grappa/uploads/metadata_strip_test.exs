defmodule Grappa.Uploads.MetadataStripTest do
  use ExUnit.Case, async: true

  import Grappa.UploadFixtures,
    only: [assert_markers!: 2, bytes: 1, mime: 1, refute_markers!: 2]

  alias Grappa.Uploads.MetadataStrip

  # Every metadata-bearing fixture: strip succeeds, output is a
  # non-empty binary that differs from the input, and every marker
  # that proves metadata presence in the fixture is gone. The
  # marker-IS-present pre-assertion guards against fixture rot — a
  # regenerated fixture that lost its metadata would otherwise make
  # the absence assertion pass while validating nothing.
  # :oriented_jpeg participates: its markers deliberately exclude the
  # bare "Exif" string (a minimal APP1 with the whitelisted Orientation
  # legitimately survives), so the loop's absence assertions hold.
  for name <- [:gps_jpeg, :gps_png, :gps_mp4, :gps_mov, :tagged_webm, :oriented_jpeg] do
    test "#{name}: strips every metadata marker" do
      name = unquote(name)
      input = bytes(name)
      assert_markers!(input, name)

      assert {:ok, stripped} = MetadataStrip.run(input, mime(name))
      assert is_binary(stripped)
      assert byte_size(stripped) > 0
      refute stripped == input
      refute_markers!(stripped, name)
    end
  end

  test "mp4 strip preserves moov-before-mdat (faststart) atom order" do
    # iOS Safari starts playback from a progressive download only when
    # moov precedes mdat; cic's transcode emits faststart output. A
    # strip that reordered atoms would silently break playback.
    assert {:ok, stripped} = MetadataStrip.run(bytes(:gps_mp4), "video/mp4")

    {moov, _} = :binary.match(stripped, "moov")
    {mdat, _} = :binary.match(stripped, "mdat")
    assert moov < mdat
  end

  describe "presentation-critical tag whitelist (#39 round 2)" do
    test "oriented_jpeg: EXIF Orientation survives the strip, GPS does not" do
      # vjt dogfood 2026-06-11: -all= alone also killed Orientation,
      # so every portrait phone photo rendered sideways (browsers
      # honor the tag via image-orientation: from-image). Marker
      # strings can't see EXIF GPS (binary rationals), so the GPS
      # absence is probed through exiftool — the oracle that would
      # catch a copy-back widened beyond the allowlist (e.g. a group
      # copy dragging the GPS IFD along with Orientation).
      input = bytes(:oriented_jpeg)
      assert read_tag(input, "Orientation") == "6"
      assert read_tag(input, "GPSLatitude") != nil

      assert {:ok, stripped} = MetadataStrip.run(input, mime(:oriented_jpeg))
      assert read_tag(stripped, "Orientation") == "6"
      assert read_tag(stripped, "GPSLatitude") == nil
    end

    test "files without Orientation still strip to a fully bare output" do
      # The copy-back must be a no-op when the tag is absent — the
      # gps_jpeg fixture has no Orientation, and its markers include
      # the bare "Exif" string, so this pins that the whitelist does
      # not fabricate an EXIF segment.
      input = bytes(:gps_jpeg)
      assert read_tag(input, "Orientation") == nil

      assert {:ok, stripped} = MetadataStrip.run(input, mime(:gps_jpeg))
      refute_markers!(stripped, :gps_jpeg)
      assert read_tag(stripped, "Orientation") == nil
    end
  end

  # exiftool read-back: the strip's own tool is the only honest oracle
  # for "is the tag still present" — grepping raw bytes would
  # re-implement EXIF parsing, badly. `-n` returns raw values as
  # strings ("6" = Rotate 90 CW); nil = tag absent. Probe filename
  # uses mint_slug like production strip_via/4 — unique_integer is
  # only unique within one BEAM VM, and /tmp may be shared.
  defp read_tag(bytes, tag) do
    path = Path.join(System.tmp_dir!(), "tag-probe-#{Grappa.Uploads.mint_slug()}.jpg")
    File.write!(path, bytes)

    try do
      {out, 0} = System.cmd("exiftool", ["-s3", "-n", "-#{tag}", path], env: probe_env())

      case String.trim(out) do
        "" -> nil
        value -> value
      end
    after
      _ = File.rm(path)
    end
  end

  # Satisfies credo's LeakyEnvironment check on System.cmd. This is
  # NOT production's scrubbed_env/0 hostile-bytes rationale — the
  # probe parses committed fixtures and the strip's own output, and
  # the test env holds no deployment secrets — so PATH-only is plain
  # hygiene, deliberately not a parallel copy of prod's @kept_env.
  defp probe_env do
    for {name, _} <- System.get_env(), name != "PATH", do: {name, nil}
  end

  test "garbage bytes labeled image/jpeg are rejected, not stored" do
    assert {:error, {:metadata_strip, reason}} =
             MetadataStrip.run("not actually a jpeg", "image/jpeg")

    assert is_binary(reason)
    assert reason != ""
  end

  test "garbage bytes labeled video/webm are rejected via the ffmpeg path" do
    assert {:error, {:metadata_strip, _}} =
             MetadataStrip.run("not actually matroska", "video/webm")
  end

  test "image mime without a strip mapping fails closed" do
    # A new image/* type added to the controller allowlist without a
    # strip mapping must reject — storing the original would leak.
    assert {:error, {:metadata_strip, reason}} = MetadataStrip.run("II*\0", "image/tiff")
    assert reason =~ "image/tiff"
  end

  test "video mime without a strip mapping fails closed" do
    assert {:error, {:metadata_strip, _}} = MetadataStrip.run(<<0>>, "video/x-matroska")
  end

  test "every allowlisted image/video mime has a strip mapping (controller lockstep)" do
    # The two maps are maintained separately by design (web layer owns
    # the boundary categories, context owns the tool dispatch) — this
    # test is the lockstep guard: an allowlist addition without a
    # strip mapping would 422 every upload of that type in prod.
    for {mime, category} <- GrappaWeb.UploadsController.mime_categories(),
        category in [:image, :video] do
      assert MetadataStrip.strippable?(mime),
             "#{mime} is in the upload allowlist but has no strip mapping"
    end
  end

  test "document mimes pass through byte-identical" do
    # vjt 2026-06-10: strip scope is images + videos. Documents keep
    # their bytes verbatim — byte-size arithmetic elsewhere (caps,
    # live_bytes_sum) relies on this.
    pdf = "%PDF-1.4 fake document body"
    assert {:ok, ^pdf} = MetadataStrip.run(pdf, "application/pdf")
    assert {:ok, "plain text"} = MetadataStrip.run("plain text", "text/plain")
  end

  test "audio mimes pass through byte-identical (GH #115, accepted ID3/iTunes-tag leak)" do
    # Audio (GH #115) is NOT stripped in v1: it rides the generic
    # run_unmapped pass-through, same as documents. This pins that
    # deliberate decision — audio carries ID3/iTunes tags (artist/album,
    # sometimes device/recording metadata); accepting that leak is the
    # documented v1 scope (exiftool can strip m4a/mp3/flac later). A
    # future "strip audio too" change must consciously update this test,
    # not silently inherit pass-through.
    mp3 = "ID3 fake mp3 body"
    assert {:ok, ^mp3} = MetadataStrip.run(mp3, "audio/mpeg")
    assert {:ok, "fake m4a"} = MetadataStrip.run("fake m4a", "audio/mp4")
    assert {:ok, "fake flac"} = MetadataStrip.run("fake flac", "audio/flac")

    # strippable?/1 returns false for audio — pass-through, not a mapped
    # tool — yet the lockstep stays green because it only pins
    # category in [:image, :video].
    refute MetadataStrip.strippable?("audio/mpeg")
  end
end
