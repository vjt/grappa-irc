defmodule GrappaWeb.Admin.NetworksControllerTest do
  @moduledoc """
  `GET /admin/networks` + `PATCH /admin/networks/:slug` — admin-gated
  network inventory + cap editor (M-cluster M-5). Behind the
  `:admin_authn` pipeline (M-2): visitor + non-admin user collapse
  to 403 upstream of the action; admin user reaches the controller.

  ## Why three-class parity matrix is N/A

  Per `feedback_e2e_user_class_parity_matrix` (vjt 2026-05-16
  STRONG): every USER-FACING IRC function must ship ONE
  parameterized e2e spec across visitor / nickserv / registered
  user. This endpoint is OPERATOR-FACING — admin-gated by
  `:admin_authn`. Visitor + non-admin user behavior is exactly
  "403 forbidden, no action runs"; M-2's `MeControllerTest`
  covers the gate. Same shape as the M-3 + M-4 admin controller
  tests.

  ## Test isolation

  `async: false` because the GET path enumerates
  `Grappa.Admission.NetworkCircuit`'s singleton ETS table.
  `AdmissionStateHelpers.reset_network_circuit/0` in setup so
  each test starts from a clean circuit-state table.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{Accounts, AdminEvents, AdmissionStateHelpers, Networks}
  alias Grappa.Admission.NetworkCircuit
  alias Grappa.PubSub.Topic

  setup do
    AdmissionStateHelpers.reset_network_circuit()
    # MED-1: PATCH emits :network_caps_updated via AdminEvents.record/1
    # (singleton GenServer started by Grappa.Application). Reset the
    # ring buffer per-test so cross-test contamination doesn't pollute
    # the assertion. Same pattern as Grappa.AdminEventsTest.
    :sys.replace_state(AdminEvents, fn _ -> %AdminEvents{buffer: []} end)
    :ok
  end

  defp admin_session do
    {user, session} = user_and_session()
    {:ok, _} = Accounts.update_admin_flags(user, %{is_admin: true})
    session
  end

  describe "GET /admin/networks — auth gate" do
    test "no bearer returns 401 (Authn upstream)", %{conn: conn} do
      conn = get(conn, "/admin/networks")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "visitor subject returns 403", %{conn: conn} do
      {_, session} = visitor_and_session()
      conn = conn |> put_bearer(session.id) |> get("/admin/networks")
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "non-admin user returns 403", %{conn: conn} do
      {_, session} = user_and_session()
      conn = conn |> put_bearer(session.id) |> get("/admin/networks")
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "GET /admin/networks — admin user" do
    test "200 + every networks row with caps and circuit_state nil when clean", %{conn: conn} do
      slug = "g-clean-#{System.unique_integer([:positive])}"
      {:ok, _} = Networks.find_or_create_network(%{slug: slug})

      session = admin_session()
      conn = conn |> put_bearer(session.id) |> get("/admin/networks")

      body = json_response(conn, 200)
      assert is_list(body["networks"])

      row = Enum.find(body["networks"], &(&1["slug"] == slug))
      assert row != nil
      assert Map.has_key?(row, "max_concurrent_visitor_sessions")
      assert Map.has_key?(row, "max_concurrent_user_sessions")
      assert Map.has_key?(row, "max_per_client")
      assert row["circuit_state"] == nil
      # U-3 (UD4): live_counts projection always present; structural
      # shape assertion (map with two non-negative integer fields)
      # rather than exact zeros. SessionRegistry is process-global
      # and async tests elsewhere can leave entries against the
      # same auto-increment id sqlite hands back inside each sandbox
      # connection (sqlite reuses id=1 across per-test sandboxes).
      # The unit-level `live_counts_for_network/1` + `live_counts_by_network/0`
      # tests use synthetic high ids to assert exact counts — this
      # controller test uses real REST round-trip with a real Network
      # row, so we settle for shape + type. Per
      # `Grappa.Admission.live_counts/0` wire shape — never nil.
      live = row["live_counts"]
      assert is_map(live)
      assert is_integer(live["visitors"]) and live["visitors"] >= 0
      assert is_integer(live["users"]) and live["users"] >= 0
    end

    test "200 + circuit_state populated when circuit is open", %{conn: conn} do
      slug = "g-dirty-#{System.unique_integer([:positive])}"
      {:ok, net} = Networks.find_or_create_network(%{slug: slug})

      for _ <- 1..NetworkCircuit.threshold() do
        :ok = NetworkCircuit.record_failure(net.id)
      end

      _ = :sys.get_state(NetworkCircuit)

      session = admin_session()
      conn = conn |> put_bearer(session.id) |> get("/admin/networks")

      body = json_response(conn, 200)
      row = Enum.find(body["networks"], &(&1["slug"] == slug))
      assert row != nil

      circuit = row["circuit_state"]
      assert circuit["state"] == "open"
      assert circuit["failure_count"] == NetworkCircuit.threshold()
      assert is_integer(circuit["retry_after_seconds"])
      assert circuit["retry_after_seconds"] > 0
    end
  end

  describe "PATCH /admin/networks/:slug — auth gate" do
    test "non-admin user returns 403", %{conn: conn} do
      {_, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/networks/azzurra", Jason.encode!(%{max_concurrent_visitor_sessions: 5}))

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "PATCH /admin/networks/:slug — admin user" do
    test "200 + persists updated caps + returns same shape as GET", %{conn: conn} do
      slug = "p-edit-#{System.unique_integer([:positive])}"
      {:ok, _} = Networks.find_or_create_network(%{slug: slug})

      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/networks/#{slug}", Jason.encode!(%{max_concurrent_visitor_sessions: 7, max_per_client: 2}))

      body = json_response(conn, 200)
      assert body["slug"] == slug
      assert body["max_concurrent_visitor_sessions"] == 7
      assert body["max_per_client"] == 2
      assert Map.has_key?(body, "circuit_state")
      # U-3 (UD4): PATCH response carries the same live_counts shape
      # as GET — operator's post-Save table render stays in sync
      # without a second round-trip. Structural assertion (map + two
      # non-negative integer fields) rather than exact zeros, per the
      # same SessionRegistry cross-sandbox-residue rationale documented
      # at the GET test above.
      live = body["live_counts"]
      assert is_map(live)
      assert is_integer(live["visitors"]) and live["visitors"] >= 0
      assert is_integer(live["users"]) and live["users"] >= 0

      # Verify DB was updated (subsequent GET reflects the change).
      {:ok, reload} = Networks.get_network_by_slug(slug)
      assert reload.max_concurrent_visitor_sessions == 7
      assert reload.max_per_client == 2
    end

    test "200 + persists max_concurrent_user_sessions (U-1 new cap)", %{conn: conn} do
      slug = "p-user-#{System.unique_integer([:positive])}"
      {:ok, _} = Networks.find_or_create_network(%{slug: slug})

      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/networks/#{slug}", Jason.encode!(%{max_concurrent_user_sessions: 9}))

      body = json_response(conn, 200)
      assert body["slug"] == slug
      assert body["max_concurrent_user_sessions"] == 9

      {:ok, reload} = Networks.get_network_by_slug(slug)
      assert reload.max_concurrent_user_sessions == 9
    end

    test "PATCH emits :network_caps_updated admin event with all three caps", %{conn: conn} do
      # MED-1: lock controller → AdminEvents emission boundary so a
      # silent-drop in `emit_network_caps_updated/2` (missing cap arg,
      # wrong actor, dropped broadcast) red-flags here, not in a smoke
      # test post-deploy.
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.admin_events())

      slug = "p-emit-#{System.unique_integer([:positive])}"
      {:ok, net} = Networks.find_or_create_network(%{slug: slug})
      net_id = net.id

      session = admin_session()

      _ =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch(
          "/admin/networks/#{slug}",
          Jason.encode!(%{
            max_concurrent_visitor_sessions: 11,
            max_concurrent_user_sessions: 4,
            max_per_client: 2
          })
        )

      assert_receive %Phoenix.Socket.Broadcast{
                       topic: "grappa:admin:events",
                       event: "event",
                       payload: %{
                         kind: :network_caps_updated,
                         network_id: ^net_id,
                         network_slug: ^slug,
                         max_concurrent_visitor_sessions: 11,
                         max_concurrent_user_sessions: 4,
                         max_per_client: 2,
                         actor_user_id: actor_id,
                         actor_user_name: actor_name
                       }
                     },
                     500

      assert is_binary(actor_id)
      assert is_binary(actor_name)

      # Force mailbox drain + ring-buffer assertion (controller path
      # routes through AdminEvents singleton, so post-broadcast the
      # event is in the buffer too).
      [head | _] = AdminEvents.snapshot()
      assert head.kind == :network_caps_updated
      assert head.max_concurrent_user_sessions == 4
    end

    test "200 + nil clears the cap (unlimited)", %{conn: conn} do
      slug = "p-clear-#{System.unique_integer([:positive])}"
      {:ok, net} = Networks.find_or_create_network(%{slug: slug})
      {:ok, _} = Networks.update_network_caps(net, %{max_concurrent_visitor_sessions: 3})

      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/networks/#{slug}", Jason.encode!(%{max_concurrent_visitor_sessions: nil}))

      body = json_response(conn, 200)
      assert body["max_concurrent_visitor_sessions"] == nil
    end

    test "404 on unknown slug", %{conn: conn} do
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch(
          "/admin/networks/nonesuch-#{System.unique_integer([:positive])}",
          Jason.encode!(%{max_concurrent_visitor_sessions: 5})
        )

      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "422 on negative cap value", %{conn: conn} do
      slug = "p-neg-#{System.unique_integer([:positive])}"
      {:ok, _} = Networks.find_or_create_network(%{slug: slug})

      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/networks/#{slug}", Jason.encode!(%{max_concurrent_visitor_sessions: -1}))

      body = json_response(conn, 422)
      assert body["error"] == "validation_failed"
      assert Map.has_key?(body["field_errors"], "max_concurrent_visitor_sessions")
    end

    test "400 on unknown body key (whitelist)", %{conn: conn} do
      slug = "p-unk-#{System.unique_integer([:positive])}"
      {:ok, _} = Networks.find_or_create_network(%{slug: slug})

      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/admin/networks/#{slug}", Jason.encode!(%{foo: "bar"}))

      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end
  end

  describe "POST /admin/networks — admin-panel bucket 1" do
    test "401 without bearer", %{conn: conn} do
      conn = post(conn, "/admin/networks", %{slug: "x"})
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "403 for non-admin user", %{conn: conn} do
      {_, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post("/admin/networks", Jason.encode!(%{slug: "x"}))

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "201 + body for a fresh slug", %{conn: conn} do
      session = admin_session()
      slug = "create-#{System.unique_integer([:positive])}"

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post("/admin/networks", Jason.encode!(%{slug: slug, max_per_client: 3}))

      body = json_response(conn, 201)
      assert body["slug"] == slug
      assert body["max_per_client"] == 3
      assert is_integer(body["id"])
    end

    test "409 already_exists on duplicate slug", %{conn: conn} do
      session = admin_session()
      slug = "dup-#{System.unique_integer([:positive])}"
      {:ok, _} = Networks.find_or_create_network(%{slug: slug})

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post("/admin/networks", Jason.encode!(%{slug: slug}))

      assert json_response(conn, 409) == %{"error" => "already_exists"}
    end

    test "422 on invalid slug", %{conn: conn} do
      session = admin_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post("/admin/networks", Jason.encode!(%{slug: "Bad Slug!"}))

      body = json_response(conn, 422)
      assert body["error"] == "validation_failed"
      assert Map.has_key?(body["field_errors"], "slug")
    end

    # Bucket 4 — POST emits :network_created with operator attribution
    test "POST emits :network_created admin event with actor", %{conn: conn} do
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.admin_events())

      slug = "emit-create-#{System.unique_integer([:positive])}"
      session = admin_session()

      _ =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> post("/admin/networks", Jason.encode!(%{slug: slug}))

      assert_receive %Phoenix.Socket.Broadcast{
                       topic: "grappa:admin:events",
                       event: "event",
                       payload: %{
                         kind: :network_created,
                         network_slug: ^slug,
                         actor_user_id: actor_id,
                         actor_user_name: actor_name
                       }
                     },
                     500

      assert is_binary(actor_id)
      assert is_binary(actor_name)
    end
  end

  describe "DELETE /admin/networks/:id — admin-panel bucket 1" do
    test "401 without bearer", %{conn: conn} do
      conn = delete(conn, "/admin/networks/999999")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "403 for non-admin user", %{conn: conn} do
      {_, session} = user_and_session()
      conn = conn |> put_bearer(session.id) |> delete("/admin/networks/999999")
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "404 for unknown id", %{conn: conn} do
      session = admin_session()
      conn = conn |> put_bearer(session.id) |> delete("/admin/networks/999999999")
      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "204 on empty network (no credentials, no scrollback)", %{conn: conn} do
      slug = "del-empty-#{System.unique_integer([:positive])}"
      {:ok, net} = Networks.find_or_create_network(%{slug: slug})
      session = admin_session()

      conn = conn |> put_bearer(session.id) |> delete("/admin/networks/#{net.id}")
      assert response(conn, 204) == ""
      assert Networks.get_network(net.id) == nil
    end

    test "409 credentials_present with count when bound credentials exist", %{conn: conn} do
      slug = "del-bound-#{System.unique_integer([:positive])}"
      {:ok, net} = Networks.find_or_create_network(%{slug: slug})

      {:ok, target_user} =
        Accounts.create_user(%{
          name: "target-#{System.unique_integer([:positive])}",
          password: String.duplicate("x", 20)
        })

      {:ok, _} =
        Grappa.Networks.Credentials.bind_credential(target_user, net, %{
          nick: "n",
          auth_method: :none
        })

      session = admin_session()
      conn = conn |> put_bearer(session.id) |> delete("/admin/networks/#{net.id}")
      body = json_response(conn, 409)
      assert body["error"] == "credentials_present"
      assert body["credential_count"] == 1
    end

    # Bucket 4 — DELETE emits :network_deleted with operator attribution
    test "DELETE emits :network_deleted admin event with actor", %{conn: conn} do
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.admin_events())

      slug = "emit-del-#{System.unique_integer([:positive])}"
      {:ok, net} = Networks.find_or_create_network(%{slug: slug})
      net_id = net.id
      session = admin_session()

      _ = conn |> put_bearer(session.id) |> delete("/admin/networks/#{net.id}")

      assert_receive %Phoenix.Socket.Broadcast{
                       topic: "grappa:admin:events",
                       event: "event",
                       payload: %{
                         kind: :network_deleted,
                         network_id: ^net_id,
                         network_slug: ^slug,
                         actor_user_id: actor_id,
                         actor_user_name: actor_name
                       }
                     },
                     500

      assert is_binary(actor_id)
      assert is_binary(actor_name)
    end
  end
end
