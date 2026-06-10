defmodule GrappaWeb.Admin.UploadsControllerTest do
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.Uploads

  setup do
    root =
      Path.join(
        System.tmp_dir!(),
        "grappa_admin_uploads_test_#{System.unique_integer([:positive])}"
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

  describe "GET /admin/uploads — gate" do
    test "401 without bearer", %{conn: conn} do
      conn = get(conn, "/admin/uploads")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "403 for non-admin user", %{conn: conn} do
      {_, session} = user_and_session([])
      conn = conn |> put_bearer(session.id) |> get("/admin/uploads")
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "403 for visitor", %{conn: conn} do
      {_, session} = visitor_and_session([])
      conn = conn |> put_bearer(session.id) |> get("/admin/uploads")
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "GET /admin/uploads — happy" do
    setup do
      {admin, session} = user_and_session(is_admin: true)
      %{admin: admin, session: session}
    end

    test "empty list with capacity info", %{conn: conn, session: session} do
      conn = conn |> put_bearer(session.id) |> get("/admin/uploads")
      body = json_response(conn, 200)
      assert body["uploads"] == []
      assert body["live_bytes_sum"] == 0
      assert is_integer(body["global_cap_bytes"])
    end

    test "lists user + visitor uploads, includes soft-deleted", %{
      conn: conn,
      session: session,
      root: root
    } do
      user = user_fixture([])
      v = visitor_fixture([])
      now = DateTime.add(DateTime.utc_now(), 3600, :second)

      # text/plain passes through MetadataStrip byte-identical, so the
      # live_bytes_sum arithmetic below stays exact (image/video bytes
      # are rewritten by the strip — sizes would be tool-dependent).
      {:ok, u1} =
        Uploads.create("a", %{subject: {:user, user.id}, mime: "text/plain", expires_at: now}, storage_root: root)

      {:ok, u2} =
        Uploads.create("bb", %{subject: {:visitor, v.id}, mime: "text/plain", expires_at: now}, storage_root: root)

      {:ok, _} = Uploads.soft_delete(u2, DateTime.utc_now())

      conn = conn |> put_bearer(session.id) |> get("/admin/uploads")
      body = json_response(conn, 200)
      assert length(body["uploads"]) == 2

      by_slug = Map.new(body["uploads"], &{&1["slug"], &1})
      assert by_slug[u1.slug]["subject_kind"] == "user"
      assert by_slug[u1.slug]["subject_id"] == user.id
      assert by_slug[u1.slug]["mime"] == "text/plain"
      assert by_slug[u1.slug]["deleted_at"] == nil

      assert by_slug[u2.slug]["subject_kind"] == "visitor"
      assert by_slug[u2.slug]["subject_id"] == v.id
      assert by_slug[u2.slug]["deleted_at"] != nil

      assert body["live_bytes_sum"] == 1
    end
  end

  describe "DELETE /admin/uploads/:id — happy" do
    setup do
      {admin, session} = user_and_session(is_admin: true)
      %{admin: admin, session: session}
    end

    test "204 + unlinks file + soft-deletes row", %{conn: conn, session: session, root: root} do
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

      path = Path.join(root, row.slug)
      assert File.exists?(path)

      conn = conn |> put_bearer(session.id) |> delete("/admin/uploads/#{row.id}")
      assert response(conn, 204) == ""

      refute File.exists?(path)

      reloaded = Grappa.Repo.get!(Grappa.Uploads.Upload, row.id)
      refute is_nil(reloaded.deleted_at)
    end

    test "404 on unknown id", %{conn: conn, session: session} do
      bogus = Ecto.UUID.generate()
      conn = conn |> put_bearer(session.id) |> delete("/admin/uploads/#{bogus}")
      assert json_response(conn, 404) == %{"error" => "not_found"}
    end
  end
end
