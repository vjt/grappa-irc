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
    test "user subject: 201 with slug + url + expires_at", %{conn: conn} do
      {_, session} = user_and_session([])

      upload = %Plug.Upload{
        path: png_fixture(),
        filename: "shot.png",
        content_type: "image/png"
      }

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

      upload = %Plug.Upload{
        path: png_fixture(),
        filename: "v.png",
        content_type: "image/png"
      }

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/api/uploads", %{"file" => upload})

      assert %{"slug" => slug} = json_response(conn, 201)
      assert Uploads.valid_slug?(slug)
    end

    test "default TTL is 24h when expire omitted", %{conn: conn} do
      {_, session} = user_and_session([])

      upload = %Plug.Upload{
        path: png_fixture(),
        filename: "t.png",
        content_type: "image/png"
      }

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

      upload = %Plug.Upload{
        path: png_fixture(),
        filename: "evil.exe",
        content_type: "application/octet-stream"
      }

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/api/uploads", %{"file" => upload})

      assert json_response(conn, 415) == %{"error" => "unsupported_media_type"}
    end

    test "400 for bad expire value", %{conn: conn} do
      {_, session} = user_and_session([])

      upload = %Plug.Upload{
        path: png_fixture(),
        filename: "t.png",
        content_type: "image/png"
      }

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/api/uploads", %{"file" => upload, "expire" => "9999"})

      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end

    test "413 file_too_large when over per-file cap", %{conn: conn} do
      {_, session} = user_and_session([])

      :ok = ServerSettings.put_upload_per_file_cap_bytes(2)

      upload = %Plug.Upload{
        path: png_fixture(),
        filename: "big.png",
        content_type: "image/png"
      }

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/api/uploads", %{"file" => upload})

      assert %{"error" => "file_too_large", "max_bytes" => 2} = json_response(conn, 413)
    end

    test "507 insufficient_storage when global cap exceeded", %{conn: conn} do
      {_, session} = user_and_session([])

      :ok = ServerSettings.put_upload_global_cap_bytes(2)

      upload = %Plug.Upload{
        path: png_fixture(),
        filename: "t.png",
        content_type: "image/png"
      }

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/api/uploads", %{"file" => upload})

      assert json_response(conn, 507) == %{"error" => "insufficient_storage"}
    end
  end

  describe "GET /uploads/:slug — happy path" do
    test "200 with file bytes when slug exists + alive", %{conn: conn} do
      {_, session} = user_and_session([])

      bytes = "PNGBYTES12345"
      path = Path.join(System.tmp_dir!(), "tmp-up-#{System.unique_integer([:positive])}.png")
      File.write!(path, bytes)

      upload = %Plug.Upload{
        path: path,
        filename: "img.png",
        content_type: "image/png"
      }

      conn1 =
        conn
        |> put_bearer(session.id)
        |> post("/api/uploads", %{"file" => upload})

      %{"slug" => slug} = json_response(conn1, 201)

      # NO auth on GET — fresh conn.
      get_conn = get(Phoenix.ConnTest.build_conn(), "/uploads/" <> slug)

      assert response(get_conn, 200) == bytes
      assert [ct] = get_resp_header(get_conn, "content-type")
      assert ct =~ "image/png"
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
            mime: "image/png",
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
            mime: "image/png",
            expires_at: DateTime.add(DateTime.utc_now(), -1, :second)
          },
          storage_root: root
        )

      conn = get(conn, "/uploads/" <> row.slug)
      assert json_response(conn, 404) == %{"error" => "not_found"}
    end
  end

  # ---- helpers ------------------------------------------------------

  defp png_fixture do
    # Plug.Upload `:path` is consumed via File.read/1 at the
    # controller layer; any valid file works for the unit-test
    # boundary. Real PNG bytes are out of scope here (the cic-side
    # MIME / extension gate is the actual content-validity boundary).
    path = Path.join(System.tmp_dir!(), "png_fixture_#{System.unique_integer([:positive])}.png")
    File.write!(path, "PNG-FAKE-BYTES")
    path
  end
end
