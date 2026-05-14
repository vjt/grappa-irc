defmodule GrappaWeb.PushSubscriptionControllerTest do
  @moduledoc """
  REST surface for `Grappa.Push` — push notifications cluster B1.

  Coverage:
    * 401 without bearer (handled by Plugs.Authn upstream — assertion
      mostly there to pin the contract).
    * 403 visitor — visitors cannot subscribe (user-only verb).
    * POST happy path: 201 + persisted row.
    * POST validation: missing endpoint / missing keys / bad body shape → 400 / 422.
    * POST duplicate (user_id, endpoint) → 422 (changeset error).
    * GET happy path: returns user's subscriptions, scoped.
    * GET visitor → 403.
    * DELETE happy path: 204.
    * DELETE cross-user → 404 (probing protection).
    * DELETE unknown ID → 404.
    * user_agent header is captured + persisted on POST.
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Push

  defp uniq, do: System.unique_integer([:positive])

  defp valid_body(opts \\ []) do
    %{
      "endpoint" =>
        Keyword.get(
          opts,
          :endpoint,
          "https://fcm.googleapis.com/wp/abc#{uniq()}"
        ),
      "keys" => %{
        "p256dh" =>
          Keyword.get(
            opts,
            :p256dh,
            "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM="
          ),
        "auth" => Keyword.get(opts, :auth, "tBHItJI5svbpez7KI4CCXg==")
      }
    }
  end

  describe "POST /push/subscriptions — auth gating" do
    test "401 without bearer", %{conn: conn} do
      conn = post(conn, "/push/subscriptions", valid_body())
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "403 for a visitor subject", %{conn: conn} do
      {_, session} = visitor_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/push/subscriptions", valid_body())

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "POST /push/subscriptions — happy path" do
    setup %{conn: conn} do
      {user, session} = user_and_session()
      {:ok, conn: put_bearer(conn, session.id), user: user}
    end

    test "201 + persisted subscription with id + created_at", %{conn: conn, user: user} do
      conn =
        conn
        |> put_req_header("user-agent", "Mozilla/5.0 e2e-test")
        |> post("/push/subscriptions", valid_body(endpoint: "https://example.com/push/happy"))

      assert %{"id" => id, "created_at" => created_at} = json_response(conn, 201)
      assert is_binary(id)
      assert is_binary(created_at)

      [stored] = Push.list_for_subject({:user, user.id})
      assert stored.id == id
      assert stored.endpoint == "https://example.com/push/happy"
      assert stored.user_agent == "Mozilla/5.0 e2e-test"
    end

    test "user_agent is nil when header is absent", %{conn: conn, user: user} do
      conn = post(conn, "/push/subscriptions", valid_body())
      assert json_response(conn, 201)
      [stored] = Push.list_for_subject({:user, user.id})
      assert stored.user_agent == nil
    end
  end

  describe "POST /push/subscriptions — validation" do
    setup %{conn: conn} do
      {_, session} = user_and_session()
      {:ok, conn: put_bearer(conn, session.id)}
    end

    test "400 on missing endpoint key", %{conn: conn} do
      conn = post(conn, "/push/subscriptions", %{"keys" => %{"p256dh" => "x", "auth" => "y"}})
      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end

    test "400 on missing keys", %{conn: conn} do
      conn = post(conn, "/push/subscriptions", %{"endpoint" => "https://example.com/push/x"})
      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end

    test "400 on missing keys.p256dh", %{conn: conn} do
      conn =
        post(conn, "/push/subscriptions", %{
          "endpoint" => "https://example.com/push/x",
          "keys" => %{"auth" => "y"}
        })

      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end

    test "422 on duplicate (user_id, endpoint) — error keyed on :endpoint", %{conn: conn} do
      body = valid_body(endpoint: "https://example.com/push/dupe")
      _ = post(conn, "/push/subscriptions", body)

      conn = post(conn, "/push/subscriptions", body)
      assert %{"error" => "validation_failed", "field_errors" => fe} = json_response(conn, 422)
      # `error_key: :endpoint` on the schema's unique_constraint
      # routes the changeset error to the field cic actually cares
      # about — surfaces as `field_errors.endpoint` in the wire body.
      assert ["has already been taken"] = fe["endpoint"]
    end
  end

  describe "GET /push/subscriptions" do
    test "401 without bearer", %{conn: conn} do
      conn = get(conn, "/push/subscriptions")
      assert json_response(conn, 401)
    end

    test "403 for visitors", %{conn: conn} do
      {_, session} = visitor_and_session()
      conn = conn |> put_bearer(session.id) |> get("/push/subscriptions")
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "returns the user's subscriptions newest-first", %{conn: conn} do
      {user, session} = user_and_session()

      {:ok, _} =
        Push.create({:user, user.id}, %{
          endpoint: "https://example.com/push/list-1",
          p256dh_key: "k1",
          auth_key: "a1",
          user_agent: "ua-1"
        })

      Process.sleep(2)

      {:ok, second} =
        Push.create({:user, user.id}, %{
          endpoint: "https://example.com/push/list-2",
          p256dh_key: "k2",
          auth_key: "a2",
          user_agent: "ua-2"
        })

      conn = conn |> put_bearer(session.id) |> get("/push/subscriptions")

      assert %{"subscriptions" => [a, b]} = json_response(conn, 200)
      assert a["id"] == second.id
      assert a["user_agent"] == "ua-2"
      assert b["user_agent"] == "ua-1"
      # endpoints / keys NOT exposed in the list shape
      refute Map.has_key?(a, "endpoint")
      refute Map.has_key?(a, "p256dh_key")
    end

    test "scopes to the requesting user", %{conn: conn} do
      {alice, alice_session} = user_and_session()
      {bob, _} = user_and_session()

      {:ok, _} =
        Push.create({:user, alice.id}, %{
          endpoint: "https://example.com/push/alice",
          p256dh_key: "k",
          auth_key: "a"
        })

      {:ok, _} =
        Push.create({:user, bob.id}, %{
          endpoint: "https://example.com/push/bob",
          p256dh_key: "k",
          auth_key: "a"
        })

      conn = conn |> put_bearer(alice_session.id) |> get("/push/subscriptions")
      assert %{"subscriptions" => [only]} = json_response(conn, 200)
      assert only["user_agent"] == nil
      # cross-user leak check: Bob's row should not appear
      [stored_alice] = Push.list_for_subject({:user, alice.id})
      assert only["id"] == stored_alice.id
    end
  end

  describe "DELETE /push/subscriptions/:id" do
    test "401 without bearer", %{conn: conn} do
      conn = delete(conn, "/push/subscriptions/#{Ecto.UUID.generate()}")
      assert json_response(conn, 401)
    end

    test "403 for visitors", %{conn: conn} do
      {_, session} = visitor_and_session()
      conn = conn |> put_bearer(session.id) |> delete("/push/subscriptions/#{Ecto.UUID.generate()}")
      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "204 on success and the row is gone", %{conn: conn} do
      {user, session} = user_and_session()

      {:ok, sub} =
        Push.create({:user, user.id}, %{
          endpoint: "https://example.com/push/del",
          p256dh_key: "k",
          auth_key: "a"
        })

      conn = conn |> put_bearer(session.id) |> delete("/push/subscriptions/#{sub.id}")
      assert response(conn, 204) == ""
      assert Push.list_for_subject({:user, user.id}) == []
    end

    test "404 on cross-user delete (probing protection)", %{conn: conn} do
      {alice, _} = user_and_session()
      {_, bob_session} = user_and_session()

      {:ok, alice_sub} =
        Push.create({:user, alice.id}, %{
          endpoint: "https://example.com/push/cross",
          p256dh_key: "k",
          auth_key: "a"
        })

      conn = conn |> put_bearer(bob_session.id) |> delete("/push/subscriptions/#{alice_sub.id}")
      assert json_response(conn, 404) == %{"error" => "not_found"}
      # Alice's row still there
      assert [_] = Push.list_for_subject({:user, alice.id})
    end

    test "404 on unknown UUID", %{conn: conn} do
      {_, session} = user_and_session()
      conn = conn |> put_bearer(session.id) |> delete("/push/subscriptions/#{Ecto.UUID.generate()}")
      assert json_response(conn, 404) == %{"error" => "not_found"}
    end
  end
end
