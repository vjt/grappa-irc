defmodule Grappa.Themes.BackgroundImageTest do
  use Grappa.DataCase, async: true

  import Mox
  import Grappa.AuthFixtures, only: [user_fixture: 0]
  import Grappa.UploadFixtures, only: [bytes: 1]

  alias Grappa.Themes.BackgroundImage
  alias Grappa.Uploads

  @png_magic <<137, 80, 78, 71, 13, 10, 26, 10>>

  setup :verify_on_exit!

  setup do
    user = user_fixture()
    {:ok, subject: {:user, user.id}, png: bytes(:gps_png)}
  end

  defp upload(bytes, content_type) do
    path = Path.join(System.tmp_dir!(), "bgtest-" <> Uploads.mint_slug())
    File.write!(path, bytes)
    on_exit(fn -> File.rm(path) end)
    %Plug.Upload{path: path, content_type: content_type, filename: "x"}
  end

  defp stored_bytes(slug) do
    File.read!(Uploads.storage_path(Uploads.storage_root(), slug))
  end

  test "upload path re-encodes to a stored PNG and returns a slug", ctx do
    assert {:ok, slug} =
             BackgroundImage.process_and_store(ctx.subject, {:upload, upload(ctx.png, "image/png")})

    assert slug =~ ~r/\A[a-z2-7]{26}\z/
    assert <<@png_magic, _::binary>> = stored_bytes(slug)
  end

  test "upload path normalises a content-type with parameters", ctx do
    assert {:ok, slug} =
             BackgroundImage.process_and_store(
               ctx.subject,
               {:upload, upload(ctx.png, "image/png; charset=binary")}
             )

    assert <<@png_magic, _::binary>> = stored_bytes(slug)
  end

  test "upload path rejects a non-raster content-type", ctx do
    assert {:error, :not_raster} =
             BackgroundImage.process_and_store(ctx.subject, {:upload, upload("hi", "text/plain")})
  end

  test "upload path rejects an SVG (scriptable, not raster)", ctx do
    assert {:error, :not_raster} =
             BackgroundImage.process_and_store(
               ctx.subject,
               {:upload, upload("<svg/>", "image/svg+xml")}
             )
  end

  test "upload path rejects bytes that ffmpeg cannot decode", ctx do
    assert {:error, :image_reencode_failed} =
             BackgroundImage.process_and_store(
               ctx.subject,
               {:upload, upload("not an image at all", "image/png")}
             )
  end

  test "upload path rejects an oversized file", ctx do
    big = :binary.copy(<<0>>, 9 * 1024 * 1024)

    assert {:error, :too_large} =
             BackgroundImage.process_and_store(ctx.subject, {:upload, upload(big, "image/png")})
  end

  test "url path delegates to the injected fetcher, re-encodes, and stores", ctx do
    expect(Grappa.Themes.ImageFetcherMock, :fetch, fn "http://host/bg.png" ->
      {:ok, ctx.png, "image/png"}
    end)

    assert {:ok, slug} =
             BackgroundImage.process_and_store(ctx.subject, {:url, "http://host/bg.png"})

    assert <<@png_magic, _::binary>> = stored_bytes(slug)
  end

  test "url path propagates an SSRF block from the fetcher", ctx do
    expect(Grappa.Themes.ImageFetcherMock, :fetch, fn _ -> {:error, :ssrf_blocked} end)

    assert {:error, :ssrf_blocked} =
             BackgroundImage.process_and_store(ctx.subject, {:url, "http://10.0.0.1/x"})
  end

  test "url path propagates a fetch failure from the fetcher", ctx do
    expect(Grappa.Themes.ImageFetcherMock, :fetch, fn _ -> {:error, :fetch_failed} end)

    assert {:error, :fetch_failed} =
             BackgroundImage.process_and_store(ctx.subject, {:url, "http://host/gone"})
  end
end
