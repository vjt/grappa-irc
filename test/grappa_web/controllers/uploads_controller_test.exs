defmodule GrappaWeb.UploadsControllerTest do
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{ServerSettings, Uploads}

  # Per-test isolated storage dir. ConnCase already owns the sandbox
  # setup; we layer on top to swap the persistent_term storage_root
  # so each test gets its own tmp dir + the dev-config-driven root
  # is restored on_exit.
  setup do
    root =
      Path.join(
        System.tmp_dir!(),
        "grappa_uploads_controller_test_#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(root)

    original_root = Grappa.Uploads.storage_root()
    :ok = Grappa.Uploads.boot(root)

    on_exit(fn ->
      :ok = Grappa.Uploads.boot(original_root)
      File.rm_rf!(root)
    end)

    %{root: root}
  end

  describe "POST /api/uploads — happy path" do
    # Success paths reach Uploads.create → MetadataStrip, which
    # fail-closes on garbage — so any upload that should land a 201
    # carries REAL bytes (Grappa.UploadFixtures or passthrough
    # text/plain). Tests that reject BEFORE create (cap / TTL / mime
    # boundary checks) keep cheap fake bytes.
    test "user subject: 201 with slug + url + expires_at", %{conn: conn} do
      {_, session} = user_and_session([])

      upload =
        upload_fixture("shot.png", "image/png", Grappa.UploadFixtures.bytes(:gps_png))

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/api/uploads", %{"file" => upload, "expire" => "3600"})

      assert %{
               "slug" => slug,
               "url" => url,
               "expires_at" => expires_at
             } = json_response(conn, 201)

      assert is_binary(slug)
      assert Uploads.valid_slug?(slug)
      assert String.ends_with?(url, "/uploads/" <> slug)
      assert {:ok, _, _} = DateTime.from_iso8601(expires_at)
    end

    test "visitor subject: 201", %{conn: conn} do
      {_, session} = visitor_and_session([])

      upload = upload_fixture("v.png", "image/png", Grappa.UploadFixtures.bytes(:gps_png))

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/api/uploads", %{"file" => upload})

      assert %{"slug" => slug} = json_response(conn, 201)
      assert Uploads.valid_slug?(slug)
    end

    test "POST /api/uploads accepts a >8MB file (Plug.Parsers :length regression)",
         %{conn: conn} do
      {_, session} = user_and_session([])

      # 9MB < the 10MB document cap, but > Plug.Parsers' 8MB multipart
      # default. Must go through the REAL multipart parser: ConnTest
      # map-params bypass Plug.Parsers, so build a raw multipart body.
      # text/plain: the regression under test is the parser length
      # limit, not media handling — and 9MB of zeros is not a png the
      # strip would accept.
      bytes = :binary.copy(<<0>>, 9 * 1024 * 1024)
      boundary = "plugparsersregression"

      body =
        "--#{boundary}\r\n" <>
          ~s(Content-Disposition: form-data; name="file"; filename="big.txt"\r\n) <>
          "Content-Type: text/plain\r\n\r\n" <>
          bytes <> "\r\n--#{boundary}--\r\n"

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "multipart/form-data; boundary=#{boundary}")
        |> post("/api/uploads", body)

      assert %{"slug" => _} = json_response(conn, 201)
    end

    test "default TTL is 24h when expire omitted", %{conn: conn} do
      {_, session} = user_and_session([])

      upload = upload_fixture("t.png", "image/png", Grappa.UploadFixtures.bytes(:gps_png))

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/api/uploads", %{"file" => upload})

      %{"expires_at" => iso} = json_response(conn, 201)
      {:ok, dt, _} = DateTime.from_iso8601(iso)
      diff = DateTime.diff(dt, DateTime.utc_now(), :second)
      assert diff in (86_400 - 5)..(86_400 + 5)
    end
  end

  describe "POST /api/uploads — metadata strip at the door (#39)" do
    test "stored image is the stripped rewrite — GPS markers never reach disk",
         %{conn: conn, root: root} do
      {_, session} = user_and_session([])
      input = Grappa.UploadFixtures.bytes(:gps_jpeg)

      upload = upload_fixture("geo.jpg", "image/jpeg", input)

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/api/uploads", %{"file" => upload})

      assert %{"slug" => slug} = json_response(conn, 201)

      stored = File.read!(Uploads.storage_path(root, slug))
      refute stored == input
      Grappa.UploadFixtures.refute_markers!(stored, :gps_jpeg)
    end

    test "422 metadata_strip_failed for garbage labeled as image", %{conn: conn} do
      {_, session} = user_and_session([])

      upload = upload_fixture("fake.jpg", "image/jpeg", "JPG-FAKE-BYTES")

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/api/uploads", %{"file" => upload})

      assert json_response(conn, 422) == %{"error" => "metadata_strip_failed"}
    end
  end

  describe "POST /api/uploads — validation failures" do
    test "401 without bearer", %{conn: conn} do
      conn = post(conn, "/api/uploads", %{})
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "400 when file missing", %{conn: conn} do
      {_, session} = user_and_session([])
      conn = conn |> put_bearer(session.id) |> post("/api/uploads", %{})
      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end

    test "415 unsupported_media_type for non-image mime", %{conn: conn} do
      {_, session} = user_and_session([])

      upload = upload_fixture("evil.exe", "application/octet-stream", "PNG-FAKE-BYTES")

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/api/uploads", %{"file" => upload})

      assert json_response(conn, 415) == %{"error" => "unsupported_media_type"}
    end

    test "400 for bad expire value", %{conn: conn} do
      {_, session} = user_and_session([])

      upload = upload_fixture("t.png", "image/png", "PNG-FAKE-BYTES")

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/api/uploads", %{"file" => upload, "expire" => "9999"})

      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end

    test "413 file_too_large when over per-file cap", %{conn: conn} do
      {_, session} = user_and_session([])

      :ok = ServerSettings.put_upload_per_file_cap_bytes(:image, 2)

      upload = upload_fixture("big.png", "image/png", "PNG-FAKE-BYTES")

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/api/uploads", %{"file" => upload})

      assert %{"error" => "file_too_large", "max_bytes" => 2} = json_response(conn, 413)
    end

    test "507 insufficient_storage when global cap exceeded", %{conn: conn} do
      {_, session} = user_and_session([])

      :ok = ServerSettings.put_upload_global_cap_bytes(2)

      upload = upload_fixture("t.png", "image/png", "PNG-FAKE-BYTES")

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/api/uploads", %{"file" => upload})

      assert json_response(conn, 507) == %{"error" => "insufficient_storage"}
    end
  end

  describe "POST /api/uploads — per-category MIMEs + caps" do
    test "201 for a video/mp4 bigger than a squeezed image cap (video cap applies)",
         %{conn: conn} do
      {_, session} = user_and_session([])

      # The category derived from the MIME picks WHICH cap applies.
      # Squeeze the image cap below the fixture size: if the
      # controller wrongly applied the image cap to video, this would
      # 413. (Pre-strip this test used 11MB of zeros against the
      # default caps — garbage can't pass the fail-closed strip, and
      # a real 11MB committed fixture is not worth the repo weight.)
      :ok = ServerSettings.put_upload_per_file_cap_bytes(:image, 2)

      upload = upload_fixture("clip.mp4", "video/mp4", Grappa.UploadFixtures.bytes(:gps_mp4))

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/api/uploads", %{"file" => upload})

      assert %{"slug" => slug} = json_response(conn, 201)
      assert Uploads.valid_slug?(slug)
    end

    test "413 file_too_large for an 11MB image/png (image cap is 10MiB)", %{conn: conn} do
      {_, session} = user_and_session([])

      upload = upload_fixture("huge.png", "image/png", :binary.copy(<<0>>, 11 * 1024 * 1024))

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/api/uploads", %{"file" => upload})

      assert %{"error" => "file_too_large", "max_bytes" => max_bytes} = json_response(conn, 413)
      assert max_bytes == 10 * 1024 * 1024
    end

    test "201 for application/pdf", %{conn: conn} do
      {_, session} = user_and_session([])

      upload = upload_fixture("doc.pdf", "application/pdf", "%PDF-FAKE")

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/api/uploads", %{"file" => upload})

      assert %{"slug" => slug} = json_response(conn, 201)
      assert Uploads.valid_slug?(slug)
    end

    test "201 for text/plain", %{conn: conn} do
      {_, session} = user_and_session([])

      upload = upload_fixture("notes.txt", "text/plain", "plain text body")

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/api/uploads", %{"file" => upload})

      assert %{"slug" => slug} = json_response(conn, 201)
      assert Uploads.valid_slug?(slug)
    end

    test "201 for video/quicktime", %{conn: conn} do
      {_, session} = user_and_session([])

      upload =
        upload_fixture("clip.mov", "video/quicktime", Grappa.UploadFixtures.bytes(:gps_mov))

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/api/uploads", %{"file" => upload})

      assert %{"slug" => slug} = json_response(conn, 201)
      assert Uploads.valid_slug?(slug)
    end

    test "415 unsupported_media_type for unknown MIME", %{conn: conn} do
      {_, session} = user_and_session([])

      upload = upload_fixture("evil.exe", "application/x-msdownload", "MZ-FAKE")

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/api/uploads", %{"file" => upload})

      assert json_response(conn, 415) == %{"error" => "unsupported_media_type"}
    end

    test "201 for audio/mpeg (mp3) — passthrough, no metadata strip", %{conn: conn} do
      {_, session} = user_and_session([])

      upload = upload_fixture("clip.mp3", "audio/mpeg", "ID3-FAKE-MP3-BYTES")

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/api/uploads", %{"file" => upload})

      assert %{"slug" => slug} = json_response(conn, 201)
      assert Uploads.valid_slug?(slug)
    end

    test "201 for audio/mp4 (m4a)", %{conn: conn} do
      {_, session} = user_and_session([])

      upload = upload_fixture("clip.m4a", "audio/mp4", "M4A-FAKE-BYTES")

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/api/uploads", %{"file" => upload})

      assert %{"slug" => slug} = json_response(conn, 201)
      assert Uploads.valid_slug?(slug)
    end

    test "octet-stream .m4a is normalized to audio/mp4 — 201 + served as audio/mp4",
         %{conn: conn} do
      # iOS/macOS mislabels .m4a as application/octet-stream. The audio
      # extension-sniff rescue normalizes to the canonical audio MIME so
      # the STORED (and therefore SERVED) Content-Type is one the browser
      # plays, not octet-stream (vjt: "ensure grappa emits the right mime").
      {_, session} = user_and_session([])

      upload = upload_fixture("voice.m4a", "application/octet-stream", "M4A-FAKE-BYTES")

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/api/uploads", %{"file" => upload})

      assert %{"slug" => slug} = json_response(conn, 201)

      get_conn = get(Phoenix.ConnTest.build_conn(), "/uploads/" <> slug)
      assert response(get_conn, 200)
      assert [ct] = get_resp_header(get_conn, "content-type")
      assert ct =~ "audio/mp4"
    end

    test "415 for unknown audio MIME audio/ogg (opus/ogg deferred OUT)", %{conn: conn} do
      {_, session} = user_and_session([])

      upload = upload_fixture("voice.ogg", "audio/ogg", "OGG-FAKE-BYTES")

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/api/uploads", %{"file" => upload})

      assert json_response(conn, 415) == %{"error" => "unsupported_media_type"}
    end

    test "octet-stream .ogg stays 415 — extension-sniff is scoped to the audio set",
         %{conn: conn} do
      {_, session} = user_and_session([])

      upload = upload_fixture("voice.ogg", "application/octet-stream", "OGG-FAKE-BYTES")

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/api/uploads", %{"file" => upload})

      assert json_response(conn, 415) == %{"error" => "unsupported_media_type"}
    end
  end

  describe "GET /uploads/:slug — happy path" do
    test "200 serves the STRIPPED image bytes with the row's content-type",
         %{conn: conn, root: root} do
      input = Grappa.UploadFixtures.bytes(:gps_png)
      slug = uploaded_slug(conn, "img.png", "image/png", input)

      # NO auth on GET — fresh conn.
      get_conn = get(Phoenix.ConnTest.build_conn(), "/uploads/" <> slug)

      assert response(get_conn, 200) == File.read!(Uploads.storage_path(root, slug))
      assert [ct] = get_resp_header(get_conn, "content-type")
      assert ct =~ "image/png"
      Grappa.UploadFixtures.refute_markers!(response(get_conn, 200), :gps_png)
    end
  end

  describe "GET /uploads/:slug — Range requests (iOS video playback needs 206)" do
    # 16 known bytes so content-range arithmetic is assertable by eye.
    # text/plain: Range serving is mime-agnostic (send_file on stored
    # bytes), and the strip rewrites image/video bytes so exact-offset
    # assertions need a passthrough type. The realistic
    # video-through-Range path is pinned by the real-mp4 test below.
    @range_bytes "0123456789ABCDEF"

    test "bytes=0-3 → 206 with the first four bytes", %{conn: conn} do
      slug = uploaded_slug(conn, "doc.txt", "text/plain", @range_bytes)

      conn = ranged_get(slug, "bytes=0-3")

      assert response(conn, 206) == "0123"
      assert get_resp_header(conn, "content-range") == ["bytes 0-3/16"]
      assert get_resp_header(conn, "accept-ranges") == ["bytes"]
    end

    test "open-ended bytes=4- → 206 to EOF", %{conn: conn} do
      slug = uploaded_slug(conn, "doc.txt", "text/plain", @range_bytes)

      conn = ranged_get(slug, "bytes=4-")

      assert response(conn, 206) == "456789ABCDEF"
      assert get_resp_header(conn, "content-range") == ["bytes 4-15/16"]
    end

    test "suffix bytes=-5 → 206 with the last five bytes", %{conn: conn} do
      slug = uploaded_slug(conn, "doc.txt", "text/plain", @range_bytes)

      conn = ranged_get(slug, "bytes=-5")

      assert response(conn, 206) == "BCDEF"
      assert get_resp_header(conn, "content-range") == ["bytes 11-15/16"]
    end

    test "last-byte-pos beyond EOF clamps", %{conn: conn} do
      slug = uploaded_slug(conn, "doc.txt", "text/plain", @range_bytes)

      conn = ranged_get(slug, "bytes=8-999")

      assert response(conn, 206) == "89ABCDEF"
      assert get_resp_header(conn, "content-range") == ["bytes 8-15/16"]
    end

    test "first-byte-pos beyond EOF → 416 with bytes */total", %{conn: conn} do
      slug = uploaded_slug(conn, "doc.txt", "text/plain", @range_bytes)

      conn = ranged_get(slug, "bytes=99-")

      assert response(conn, 416) == ""
      assert get_resp_header(conn, "content-range") == ["bytes */16"]
      # A 416 with public freshness would let a shared cache pin the
      # bare URL dead for an hour.
      assert get_resp_header(conn, "cache-control") == []
    end

    test "malformed Range → 200 full body", %{conn: conn} do
      slug = uploaded_slug(conn, "doc.txt", "text/plain", @range_bytes)

      conn = ranged_get(slug, "bananas")

      assert response(conn, 200) == @range_bytes
    end

    test "multi-range → 200 full body (we may ignore per RFC 9110)", %{conn: conn} do
      slug = uploaded_slug(conn, "doc.txt", "text/plain", @range_bytes)

      conn = ranged_get(slug, "bytes=0-1,3-4")

      assert response(conn, 200) == @range_bytes
    end

    test "zero-size on-disk file + Range → empty 200, not a crash", %{conn: conn, root: root} do
      slug = uploaded_slug(conn, "doc.txt", "text/plain", @range_bytes)

      # DB row says bytes > 0; disk diverged (truncation drift). The
      # public surface must stay no-oracle — a 500 here would leak
      # "row exists, file empty".
      File.write!(Uploads.storage_path(root, slug), "")

      conn = ranged_get(slug, "bytes=0-1")

      assert response(conn, 200) == ""
    end

    test "plain GET advertises accept-ranges: bytes", %{conn: conn} do
      slug = uploaded_slug(conn, "doc.txt", "text/plain", @range_bytes)

      conn = get(Phoenix.ConnTest.build_conn(), "/uploads/" <> slug)

      assert response(conn, 200) == @range_bytes
      assert get_resp_header(conn, "accept-ranges") == ["bytes"]
    end

    test "real stripped mp4 through Range → 206 slice consistent with stored size",
         %{conn: conn, root: root} do
      # The production consumer of this path is a <video> element
      # fetching a stored (stripped) mp4 — pin it end-to-end: upload
      # real video bytes, range-read the stripped artifact.
      slug = uploaded_slug(conn, "clip.mp4", "video/mp4", Grappa.UploadFixtures.bytes(:gps_mp4))

      stored = File.read!(Uploads.storage_path(root, slug))
      total = byte_size(stored)
      assert total > 4

      conn = ranged_get(slug, "bytes=0-3")

      assert response(conn, 206) == binary_part(stored, 0, 4)
      assert get_resp_header(conn, "content-range") == ["bytes 0-3/#{total}"]
      assert [ct] = get_resp_header(conn, "content-type")
      assert ct =~ "video/mp4"
    end
  end

  describe "GET /uploads/:slug — failure modes (no oracle)" do
    test "404 for invalid slug shape", %{conn: conn} do
      conn = get(conn, "/uploads/" <> "..")
      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "404 for unknown slug", %{conn: conn} do
      conn = get(conn, "/uploads/" <> String.duplicate("a", 26))
      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "404 for soft-deleted row", %{conn: conn, root: root} do
      {user, _} = user_and_session([])

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

      {:ok, _} = Uploads.soft_delete(row, DateTime.utc_now())

      conn = get(conn, "/uploads/" <> row.slug)
      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "404 for expired row", %{conn: conn, root: root} do
      {user, _} = user_and_session([])

      {:ok, row} =
        Uploads.create(
          "x",
          %{
            subject: {:user, user.id},
            mime: "text/plain",
            expires_at: DateTime.add(DateTime.utc_now(), -1, :second)
          },
          storage_root: root
        )

      conn = get(conn, "/uploads/" <> row.slug)
      assert json_response(conn, 404) == %{"error" => "not_found"}
    end
  end

  # ---- helpers ------------------------------------------------------

  # Uploads `bytes` as an authenticated user, returns the public slug.
  defp uploaded_slug(conn, filename, mime, bytes) do
    {_, session} = user_and_session([])

    upload = upload_fixture(filename, mime, bytes)

    conn =
      conn
      |> put_bearer(session.id)
      |> post("/api/uploads", %{"file" => upload})

    %{"slug" => slug} = json_response(conn, 201)
    slug
  end

  # NO auth on GET — fresh conn, like a browser following the link.
  defp ranged_get(slug, range_header) do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("range", range_header)
    |> get("/uploads/" <> slug)
  end

  # ConnTest map-params bypass Plug.Parsers, so a %Plug.Upload{} built
  # by hand exercises the controller's own validation path directly.
  # Byte content MATTERS for image/video uploads that should succeed:
  # they reach MetadataStrip, which fail-closes on garbage — use
  # Grappa.UploadFixtures bytes there. Fake bytes are fine only for
  # requests rejected BEFORE Uploads.create (mime / TTL / cap checks).
  defp upload_fixture(filename, content_type, bytes) do
    path =
      Path.join(System.tmp_dir!(), "upload_fixture_#{System.unique_integer([:positive])}")

    File.write!(path, bytes)
    %Plug.Upload{path: path, filename: filename, content_type: content_type}
  end
end
