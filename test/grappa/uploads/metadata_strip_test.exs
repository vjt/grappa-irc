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
  for name <- [:gps_jpeg, :gps_png, :gps_mp4, :gps_mov, :tagged_webm] do
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
    test "oriented_jpeg: privacy markers die, EXIF Orientation survives the strip" do
      # vjt dogfood 2026-06-11: -all= alone also killed Orientation,
      # so every portrait phone photo rendered sideways (browsers
      # honor the tag via image-orientation: from-image). The strip
      # must wipe the privacy payload and copy the allowlisted
      # presentation tags back.
      input = bytes(:oriented_jpeg)
      assert_markers!(input, :oriented_jpeg)
      assert read_orientation(input) == 6

      assert {:ok, stripped} = MetadataStrip.run(input, "image/jpeg")
      refute_markers!(stripped, :oriented_jpeg)
      assert read_orientation(stripped) == 6
    end

    test "files without Orientation still strip to a fully bare output" do
      # The copy-back must be a no-op when the tag is absent — the
      # gps_jpeg fixture has no Orientation, and its markers include
      # the bare "Exif" string, so this pins that the whitelist does
      # not fabricate an EXIF segment.
      input = bytes(:gps_jpeg)
      assert read_orientation(input) == nil

      assert {:ok, stripped} = MetadataStrip.run(input, "image/jpeg")
      refute_markers!(stripped, :gps_jpeg)
      assert read_orientation(stripped) == nil
    end
  end

  # exiftool read-back: the strip's own tool is the only honest oracle
  # for "is the tag still present" — grepping raw bytes for the 0x0112
  # TIFF tag would re-implement EXIF parsing, badly. `-n` returns the
  # numeric value (6 = Rotate 90 CW); empty output = tag absent.
  defp read_orientation(bytes) do
    path =
      Path.join(
        System.tmp_dir!(),
        "orientation-probe-#{System.unique_integer([:positive])}.jpg"
      )

    File.write!(path, bytes)

    try do
      {out, 0} =
        System.cmd("exiftool", ["-s3", "-n", "-Orientation", path], env: scrubbed_probe_env())

      case String.trim(out) do
        "" -> nil
        value -> String.to_integer(value)
      end
    after
      _ = File.rm(path)
    end
  end

  # Same rationale as MetadataStrip's scrubbed_env/0: exiftool parses
  # file bytes and has an RCE history (CVE-2021-22204) — the probe
  # child keeps PATH only. `{name, nil}` REMOVES the variable.
  defp scrubbed_probe_env do
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
end
