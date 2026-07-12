defmodule GrappaWeb.ShareTokenControllerTest do
  @moduledoc """
  `POST /me/share-token` and `POST /auth/share/consume`.

  Mint side (`/me/share-token`):
    * visitor subject → 200 + signed token + expires_at
    * user subject → 403 forbidden
    * missing Bearer → 401 unauthorized

  Consume side (`/auth/share/consume`):
    * valid token + visitor exists → 200 + new bearer + visitor envelope
    * unsigned/invalid token → 401 unauthorized
    * expired token (past TTL) → 410 gone
    * already-consumed token (second redemption) → 410 gone
    * visitor row deleted between mint and consume → 404 not_found
    * missing token param → 400 bad_request

  Wire shape (mint):
    %{token: "<signed>", expires_at: "<ISO8601 UTC>"}

  Wire shape (consume success):
    %{token: "<bearer-uuid>", subject: %{kind: "visitor", id, nick, network_slug}}

  `async: true` — sandbox per test. Touches `Grappa.Visitors.ShareTokens`
  but consume tests use distinct token strings so the suite-wide ETS
  table never collides.
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Visitors.ShareTokens

  @max_age_seconds 600
  @salt "visitor-share-v1"

  describe "POST /me/share-token — mint" do
    test "visitor subject returns 200 + signed token + expires_at", %{conn: conn} do
      visitor = visitor_fixture()
      session = visitor_session_fixture(visitor)

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/me/share-token")

      body = json_response(conn, 200)
      assert is_binary(body["token"])
      assert body["token"] != ""

      # Token verifies back to the visitor's id with the salt + max_age
      # contract. The endpoint passes its own context to Phoenix.Token.
      assert {:ok, visitor_id} =
               Phoenix.Token.verify(GrappaWeb.Endpoint, @salt, body["token"], max_age: @max_age_seconds)

      assert visitor_id == visitor.id

      # ISO8601 UTC string ~600s in the future (allow ±2s for clock skew
      # within the test).
      assert {:ok, expires_at, 0} = DateTime.from_iso8601(body["expires_at"])
      delta = DateTime.diff(expires_at, DateTime.utc_now())
      assert delta >= @max_age_seconds - 2
      assert delta <= @max_age_seconds + 2
    end

    test "user subject returns 403 forbidden", %{conn: conn} do
      {_, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/me/share-token")

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "missing Bearer returns 401 unauthorized", %{conn: conn} do
      conn = post(conn, "/me/share-token")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end
  end

  describe "POST /auth/share/consume — consume" do
    setup do
      # Each test gets its own visitor (ShareTokens ETS is suite-wide
      # but consume tests partition by the token string itself; distinct
      # signed payloads → distinct ETS keys).
      visitor = visitor_fixture()
      token = Phoenix.Token.sign(GrappaWeb.Endpoint, @salt, visitor.id)
      {:ok, visitor: visitor, token: token}
    end

    test "valid token + visitor exists returns 200 + bearer + subject envelope", %{
      conn: conn,
      visitor: visitor,
      token: token
    } do
      conn = post(conn, "/auth/share/consume", %{"token" => token})

      body = json_response(conn, 200)
      assert is_binary(body["token"])
      assert body["token"] != ""
      assert body["subject"]["kind"] == "visitor"
      assert body["subject"]["id"] == visitor.id
      assert body["subject"]["nick"] == visitor.nick
      # #211 phase 6 — the singular subject `network_slug` is off the wire
      # (visitors are multi-network; per-network attachment on GET /networks).
      refute Map.has_key?(body["subject"], "network_slug")
    end

    test "consumed token authenticates as the SAME visitor (multi-device share)", %{
      conn: conn,
      visitor: visitor,
      token: token
    } do
      body = conn |> post("/auth/share/consume", %{"token" => token}) |> json_response(200)

      # Hit /me with the new bearer — confirms a real accounts_sessions
      # row was minted for the SAME visitor row.
      fresh_conn =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(body["token"])
        |> get("/me")

      me = json_response(fresh_conn, 200)
      assert me["kind"] == "visitor"
      assert me["id"] == visitor.id
    end

    test "unsigned / invalid token returns 401 unauthorized", %{conn: conn} do
      conn = post(conn, "/auth/share/consume", %{"token" => "not-a-signed-token"})
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "expired token (TTL elapsed) returns 410 gone", %{conn: conn, visitor: visitor} do
      # Sign with a baseline now, then verify with max_age that already
      # elapsed by passing a `signed_at` parameter that's older than TTL.
      old_signed_at = System.system_time(:second) - @max_age_seconds - 60
      token = Phoenix.Token.sign(GrappaWeb.Endpoint, @salt, visitor.id, signed_at: old_signed_at)

      conn = post(conn, "/auth/share/consume", %{"token" => token})
      assert json_response(conn, 410) == %{"error" => "share_token_expired"}
    end

    test "already-consumed token returns 410 gone on second call", %{conn: conn, token: token} do
      conn1 = post(conn, "/auth/share/consume", %{"token" => token})
      assert json_response(conn1, 200)

      fresh_conn = post(Phoenix.ConnTest.build_conn(), "/auth/share/consume", %{"token" => token})
      assert json_response(fresh_conn, 410) == %{"error" => "share_token_consumed"}
    end

    test "visitor deleted between mint and consume returns 404", %{
      conn: conn,
      visitor: visitor,
      token: token
    } do
      :ok = Grappa.Visitors.delete(visitor.id)

      conn = post(conn, "/auth/share/consume", %{"token" => token})
      assert json_response(conn, 404) == %{"error" => "not_found"}
    end

    test "missing token param returns 400 bad_request", %{conn: conn} do
      conn = post(conn, "/auth/share/consume", %{})
      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end
  end

  describe "ShareTokens module ETS sanity" do
    test "table_name is reachable from the test harness" do
      assert ShareTokens.table_name() == :visitor_share_tokens_used
    end
  end

  describe "telemetry" do
    setup do
      handler = "share-token-telemetry-#{System.unique_integer([:positive])}"
      parent = self()

      :ok =
        :telemetry.attach_many(
          handler,
          [
            [:grappa, :visitor, :share_token, :minted],
            [:grappa, :visitor, :share_token, :consumed],
            [:grappa, :visitor, :share_token, :rejected]
          ],
          fn event, measurements, metadata, _ ->
            send(parent, {:telemetry, event, measurements, metadata})
          end,
          nil
        )

      on_exit(fn -> :telemetry.detach(handler) end)
      :ok
    end

    test "mint emits :minted with visitor_id metadata", %{conn: conn} do
      visitor = visitor_fixture()
      session = visitor_session_fixture(visitor)

      conn |> put_bearer(session.id) |> post("/me/share-token") |> json_response(200)

      assert_receive {:telemetry, [:grappa, :visitor, :share_token, :minted], %{count: 1}, %{visitor_id: vid}}

      assert vid == visitor.id
    end

    test "consume happy path emits :consumed with visitor_id metadata", %{conn: conn} do
      visitor = visitor_fixture()
      token = Phoenix.Token.sign(GrappaWeb.Endpoint, @salt, visitor.id)

      conn |> post("/auth/share/consume", %{"token" => token}) |> json_response(200)

      assert_receive {:telemetry, [:grappa, :visitor, :share_token, :consumed], %{count: 1}, %{visitor_id: vid}}

      assert vid == visitor.id
    end

    test "consume rejects emit :rejected with :reason metadata", %{conn: conn} do
      # invalid signature → :unauthorized
      conn |> post("/auth/share/consume", %{"token" => "bogus"}) |> json_response(401)

      assert_receive {:telemetry, [:grappa, :visitor, :share_token, :rejected], %{count: 1}, %{reason: :unauthorized}}

      # expired
      visitor = visitor_fixture()

      expired_token =
        Phoenix.Token.sign(GrappaWeb.Endpoint, @salt, visitor.id,
          signed_at: System.system_time(:second) - @max_age_seconds - 60
        )

      conn |> post("/auth/share/consume", %{"token" => expired_token}) |> json_response(410)

      assert_receive {:telemetry, [:grappa, :visitor, :share_token, :rejected], %{count: 1},
                      %{reason: :share_token_expired}}
    end
  end
end
