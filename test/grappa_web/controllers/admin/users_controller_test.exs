defmodule GrappaWeb.Admin.UsersControllerTest do
  @moduledoc """
  `GET /admin/users` + `PATCH /admin/users/:id` — admin-gated user
  inventory + is_admin toggle (M-cluster M-6). Behind `:admin_authn`
  (M-2): visitor + non-admin user collapse to 403 upstream; admin
  user reaches the controller.

  ## Why three-class parity matrix is N/A

  Per `feedback_e2e_user_class_parity_matrix` (vjt 2026-05-16
  STRONG): every USER-FACING IRC function must ship ONE
  parameterized e2e spec across visitor / nickserv / registered
  user. This endpoint is OPERATOR-FACING — admin-gated; visitor +
  non-admin user behavior is exactly "403 forbidden, no action
  runs". M-2's `MeControllerTest` covers the gate. Same shape as
  M-3/M-4/M-5 admin controller tests.

  ## Test isolation

  `async: false` because the GET success path scans the singleton
  `Grappa.SessionRegistry`. `AdmissionStateHelpers.reset_session_supervisor/0`
  in setup so the live_session_count starts from a known-empty
  registry.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{Accounts, AdminEvents, AdmissionStateHelpers}
  alias Grappa.PubSub.Topic
  alias GrappaWeb.UserSocket

  setup do
    AdmissionStateHelpers.reset_session_supervisor()
    # Bucket 4: reset the AdminEvents ring buffer per-test so the
    # snapshot-assertion path (head-of-buffer check) isn't polluted
    # by prior tests. Same pattern as NetworksControllerTest.
    :sys.replace_state(AdminEvents, fn _ -> %AdminEvents{buffer: []} end)
    :ok
  end

  defp admin_session do
    {user, session} = user_and_session()
    {:ok, _} = Accounts.update_admin_flags(user, %{is_admin: true})
    session
  end

  describe "GET /admin/users — auth gate" do
    test "no bearer returns 401 (Authn upstream)", %{conn: conn} do
      conn = get(conn, "/admin/users")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "visitor subject returns 403", %{conn: conn} do
      {_, session} = visitor_and_session()
      conn = conn |> put_bearer(session.id) |> get("/admin/users")
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "non-admin user returns 403", %{conn: conn} do
      {_, session} = user_and_session()
      conn = conn |> put_bearer(session.id) |> get("/admin/users")
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "GET /admin/users — admin user" do
    test "200 + every user row with is_admin + live_session_count", %{conn: conn} do
      _ = user_fixture(name: "alice-#{System.unique_integer([:positive])}")

      session = admin_session()
      conn = conn |> put_bearer(session.id) |> get("/admin/users")

      body = json_response(conn, 200)
      assert is_list(body["users"])

      # Every row carries the operator-visible fields, never
      # credential material.
      Enum.each(body["users"], fn row ->
        assert Map.has_key?(row, "id")
        assert Map.has_key?(row, "name")
        assert Map.has_key?(row, "is_admin")
        assert Map.has_key?(row, "live_session_count")
        refute Map.has_key?(row, "password")
        refute Map.has_key?(row, "password_hash")
      end)
    end
  end

  describe "PATCH /admin/users/:id — auth gate" do
    test "non-admin user returns 403", %{conn: conn} do
      {target, _} = user_and_session()
      {_, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/users/#{target.id}", Jason.encode!(%{is_admin: true}))

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "PATCH /admin/users/:id — admin user" do
    test "200 + toggles is_admin true + reflects in DB", %{conn: conn} do
      target = user_fixture(name: "target-#{System.unique_integer([:positive])}")
      assert target.is_admin == false

      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/users/#{target.id}", Jason.encode!(%{is_admin: true}))

      body = json_response(conn, 200)
      assert body["id"] == target.id
      assert body["is_admin"] == true

      reload = Accounts.get_user!(target.id)
      assert reload.is_admin == true
    end

    test "200 + toggles is_admin false (round-trip)", %{conn: conn} do
      target = user_fixture(name: "rt-#{System.unique_integer([:positive])}")
      {:ok, _} = Accounts.update_admin_flags(target, %{is_admin: true})

      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/users/#{target.id}", Jason.encode!(%{is_admin: false}))

      body = json_response(conn, 200)
      assert body["is_admin"] == false
    end

    test "S27: demotion broadcasts disconnect on the target's socket topic", %{conn: conn} do
      target = user_fixture(name: "demote-#{System.unique_integer([:positive])}")
      {:ok, promoted} = Accounts.update_admin_flags(target, %{is_admin: true})
      :ok = GrappaWeb.Endpoint.subscribe(UserSocket.id_for_subject({:user, promoted}))

      session = admin_session()

      conn
      |> put_bearer(session.id)
      |> put_req_header("content-type", "application/json")
      |> patch("/admin/users/#{target.id}", Jason.encode!(%{is_admin: false}))
      |> json_response(200)

      assert_receive %Phoenix.Socket.Broadcast{event: "disconnect"}, 500
    end

    test "S27: promotion does NOT disconnect the socket", %{conn: conn} do
      target = user_fixture(name: "promote-#{System.unique_integer([:positive])}")
      :ok = GrappaWeb.Endpoint.subscribe(UserSocket.id_for_subject({:user, target}))

      session = admin_session()

      conn
      |> put_bearer(session.id)
      |> put_req_header("content-type", "application/json")
      |> patch("/admin/users/#{target.id}", Jason.encode!(%{is_admin: true}))
      |> json_response(200)

      refute_receive %Phoenix.Socket.Broadcast{event: "disconnect"}, 200
    end

    test "404 on unknown id", %{conn: conn} do
      session = admin_session()
      bogus = Ecto.UUID.generate()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/users/#{bogus}", Jason.encode!(%{is_admin: true}))

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "400 on whitelist breach — name", %{conn: conn} do
      target = user_fixture(name: "wb-#{System.unique_integer([:positive])}")
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/users/#{target.id}", Jason.encode!(%{name: "x"}))

      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end

    test "400 on whitelist breach — password", %{conn: conn} do
      target = user_fixture(name: "wbp-#{System.unique_integer([:positive])}")
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/users/#{target.id}", Jason.encode!(%{password: "rotated"}))

      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end
  end

  describe "POST /admin/users — admin-panel bucket 2" do
    test "401 without bearer", %{conn: conn} do
      conn = post(conn, "/admin/users", %{})
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "403 for non-admin user", %{conn: conn} do
      {_, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post("/admin/users", Jason.encode!(%{name: "x", password: "y"}))

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "201 + body for a fresh user, no password leaked", %{conn: conn} do
      session = admin_session()
      name = "create-#{System.unique_integer([:positive])}"

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post("/admin/users", Jason.encode!(%{name: name, password: "valid password here"}))

      body = json_response(conn, 201)
      assert body["name"] == name
      assert body["is_admin"] == false
      assert is_binary(body["id"])
      refute Map.has_key?(body, "password")
      refute Map.has_key?(body, "password_hash")
    end

    test "201 with is_admin: true creates an admin", %{conn: conn} do
      session = admin_session()
      name = "create-admin-#{System.unique_integer([:positive])}"

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post(
          "/admin/users",
          Jason.encode!(%{name: name, password: "valid password here", is_admin: true})
        )

      body = json_response(conn, 201)
      assert body["is_admin"] == true
    end

    test "422 on validation failure (short password)", %{conn: conn} do
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post("/admin/users", Jason.encode!(%{name: "n", password: "short"}))

      assert json_response(conn, 422)["error"] == "validation_failed"
    end

    test "400 on extra keys (whitelist breach)", %{conn: conn} do
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post(
          "/admin/users",
          Jason.encode!(%{name: "n", password: "valid password here", evil: "x"})
        )

      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end
  end

  describe "PUT /admin/users/:id/password — admin-panel bucket 2" do
    test "401 without bearer", %{conn: conn} do
      conn = put(conn, "/admin/users/some-id/password", %{password: "x"})
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "403 for non-admin user", %{conn: conn} do
      {target, _} = user_and_session()
      {_, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> put("/admin/users/#{target.id}/password", Jason.encode!(%{password: "x"}))

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "200 + rotates the password AND revokes the target's sessions (S8)", %{conn: conn} do
      {target, target_session} = user_and_session()
      admin_sess = admin_session()

      # The target's bearer authenticates BEFORE the rotation.
      assert {:ok, _} = Accounts.authenticate(target_session.id)

      conn =
        conn
        |> put_bearer(admin_sess.id)
        |> put_req_header("content-type", "application/json")
        |> put(
          "/admin/users/#{target.id}/password",
          Jason.encode!(%{password: "rotated horse staple"})
        )

      body = json_response(conn, 200)
      assert body["id"] == target.id
      refute Map.has_key?(body, "password_hash")

      reloaded = Accounts.get_user!(target.id)
      assert Argon2.verify_pass("rotated horse staple", reloaded.password_hash)

      # S8: every previously-minted bearer for the target is now revoked —
      # the point of a forced reset (evict a compromised account).
      assert {:error, :revoked} = Accounts.authenticate(target_session.id)
    end

    test "PUT /password closes the target's live WebSocket (S8)", %{conn: conn} do
      target = user_fixture(name: "wspw-#{System.unique_integer([:positive])}")
      topic = "user_socket:" <> target.name
      :ok = GrappaWeb.Endpoint.subscribe(topic)

      admin_sess = admin_session()

      conn =
        conn
        |> put_bearer(admin_sess.id)
        |> put_req_header("content-type", "application/json")
        |> put(
          "/admin/users/#{target.id}/password",
          Jason.encode!(%{password: "rotated horse staple"})
        )

      assert json_response(conn, 200)
      assert_receive %Phoenix.Socket.Broadcast{topic: ^topic, event: "disconnect"}, 500
    end

    test "rotating another user's password leaves the acting admin's session valid (S8)",
         %{conn: conn} do
      {target, _} = user_and_session()
      admin_sess = admin_session()

      conn =
        conn
        |> put_bearer(admin_sess.id)
        |> put_req_header("content-type", "application/json")
        |> put(
          "/admin/users/#{target.id}/password",
          Jason.encode!(%{password: "rotated horse staple"})
        )

      assert json_response(conn, 200)
      # Only the TARGET's sessions are revoked — the admin acted on
      # another account and keeps their own bearer.
      assert {:ok, _} = Accounts.authenticate(admin_sess.id)
    end

    test "404 on unknown id", %{conn: conn} do
      session = admin_session()
      bogus_id = Ecto.UUID.generate()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> put("/admin/users/#{bogus_id}/password", Jason.encode!(%{password: "valid pw 123"}))

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "422 on short password", %{conn: conn} do
      {target, _} = user_and_session()
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> put("/admin/users/#{target.id}/password", Jason.encode!(%{password: "short"}))

      assert json_response(conn, 422)["error"] == "validation_failed"
    end
  end

  describe "DELETE /admin/users/:id — admin-panel bucket 2" do
    test "401 without bearer", %{conn: conn} do
      conn = delete(conn, "/admin/users/some-id")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "403 for non-admin user", %{conn: conn} do
      {target, _} = user_and_session()
      {_, session} = user_and_session()
      conn = conn |> put_bearer(session.id) |> delete("/admin/users/#{target.id}")
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "204 on success, cascades auth sessions via FK", %{conn: conn} do
      {target, target_session} = user_and_session()
      session = admin_session()

      conn = conn |> put_bearer(session.id) |> delete("/admin/users/#{target.id}")
      assert response(conn, 204) == ""
      assert Accounts.get_user(target.id) == nil
      assert {:error, :not_found} = Accounts.authenticate(target_session.id)
    end

    test "204 closes the target's live WebSocket (S7)", %{conn: conn} do
      target = user_fixture(name: "wsdel-#{System.unique_integer([:positive])}")
      topic = "user_socket:" <> target.name
      :ok = GrappaWeb.Endpoint.subscribe(topic)

      session = admin_session()
      conn = conn |> put_bearer(session.id) |> delete("/admin/users/#{target.id}")
      assert response(conn, 204) == ""

      # Mid-flight WS enforcement: without the disconnect the deleted
      # user's socket keeps receiving PubSub fan-out until it reconnects.
      assert_receive %Phoenix.Socket.Broadcast{topic: ^topic, event: "disconnect"}, 500
    end

    test "422 last_admin when target is the sole admin", %{conn: conn} do
      # Set up two admins, then delete one so the remaining is the sole.
      {actor, actor_session} = user_and_session()
      {:ok, _} = Accounts.update_admin_flags(actor, %{is_admin: true})

      # Actor is the sole admin — delete attempts on self must refuse.
      conn = conn |> put_bearer(actor_session.id) |> delete("/admin/users/#{actor.id}")
      assert json_response(conn, 422) == %{"error" => "last_admin"}
      assert Accounts.get_user(actor.id) != nil
    end

    test "404 on unknown id", %{conn: conn} do
      session = admin_session()
      bogus_id = Ecto.UUID.generate()

      conn = conn |> put_bearer(session.id) |> delete("/admin/users/#{bogus_id}")
      assert json_response(conn, 404) == %{"error" => "not_found"}
    end
  end

  describe "admin event emission (bucket 4)" do
    test "POST emits :user_created with actor + is_admin flag", %{conn: conn} do
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.admin_events())

      session = admin_session()
      name = "evt-create-#{System.unique_integer([:positive])}"

      _ =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post(
          "/admin/users",
          Jason.encode!(%{name: name, password: String.duplicate("x", 20)})
        )

      assert_receive %Phoenix.Socket.Broadcast{
                       topic: "grappa:admin:events",
                       event: "event",
                       payload: %{
                         kind: :user_created,
                         user_name: ^name,
                         is_admin: false,
                         actor_user_id: actor_id,
                         actor_user_name: actor_name
                       }
                     },
                     500

      assert is_binary(actor_id)
      assert is_binary(actor_name)
    end

    test "POST with is_admin: true emits :user_created with is_admin true", %{conn: conn} do
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.admin_events())

      session = admin_session()
      name = "evt-cadmin-#{System.unique_integer([:positive])}"

      _ =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post(
          "/admin/users",
          Jason.encode!(%{name: name, password: String.duplicate("x", 20), is_admin: true})
        )

      assert_receive %Phoenix.Socket.Broadcast{
                       topic: "grappa:admin:events",
                       event: "event",
                       payload: %{kind: :user_created, user_name: ^name, is_admin: true}
                     },
                     500
    end

    test "PATCH emits :user_updated only when is_admin actually changes", %{conn: conn} do
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.admin_events())

      session = admin_session()

      {:ok, target} =
        Accounts.create_user(%{
          name: "evt-up-#{System.unique_integer([:positive])}",
          password: String.duplicate("x", 20)
        })

      target_id = target.id

      _ =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/users/#{target.id}", Jason.encode!(%{is_admin: true}))

      assert_receive %Phoenix.Socket.Broadcast{
                       topic: "grappa:admin:events",
                       event: "event",
                       payload: %{kind: :user_updated, user_id: ^target_id, is_admin: true}
                     },
                     500

      # No-op PATCH (same value) does NOT emit a second event.
      _ =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/users/#{target.id}", Jason.encode!(%{is_admin: true}))

      refute_receive %Phoenix.Socket.Broadcast{
                       topic: "grappa:admin:events",
                       payload: %{kind: :user_updated}
                     },
                     100
    end

    test "PUT /password emits :user_password_changed (no password in payload)", %{conn: conn} do
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.admin_events())

      session = admin_session()

      {:ok, target} =
        Accounts.create_user(%{
          name: "evt-pw-#{System.unique_integer([:positive])}",
          password: String.duplicate("x", 20)
        })

      target_id = target.id

      _ =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> put(
          "/admin/users/#{target.id}/password",
          Jason.encode!(%{password: String.duplicate("y", 22)})
        )

      assert_receive %Phoenix.Socket.Broadcast{
                       topic: "grappa:admin:events",
                       event: "event",
                       payload: payload
                     },
                     500

      assert payload.kind == :user_password_changed
      assert payload.user_id == target_id
      refute Map.has_key?(payload, :password)
    end

    test "DELETE emits :user_deleted with actor", %{conn: conn} do
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.admin_events())

      session = admin_session()

      {:ok, target} =
        Accounts.create_user(%{
          name: "evt-del-#{System.unique_integer([:positive])}",
          password: String.duplicate("x", 20)
        })

      target_id = target.id
      target_name = target.name

      _ = conn |> put_bearer(session.id) |> delete("/admin/users/#{target.id}")

      assert_receive %Phoenix.Socket.Broadcast{
                       topic: "grappa:admin:events",
                       event: "event",
                       payload: %{
                         kind: :user_deleted,
                         user_id: ^target_id,
                         user_name: ^target_name
                       }
                     },
                     500
    end
  end
end
