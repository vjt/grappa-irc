defmodule GrappaWeb.Admin.TestSubjectControllerTest do
  @moduledoc """
  Request-shape coverage for `POST /admin/test/subject`: what the
  parser lets through to `SubjectProvision` and what it answers 422.

  Every body here names a network that does not exist, which is the
  lever that keeps an upstream out of it: a body the parser ACCEPTS
  reaches the provisioning verb and comes back 404 `network_not_found`
  before anything is created, so 404 versus 422 is exactly "parsed"
  versus "refused". The happy path ends in a live session and is the
  e2e suite's.

  The bodies go over the wire as JSON, so a value reaches the parser
  the way the Playwright fixture's would — `1.5` as a float and `"100"`
  as a string, not as whatever an Elixir literal would have been.
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  setup do
    admin = user_fixture(name: "admin-subj-#{System.unique_integer([:positive])}", is_admin: true)
    %{admin_token: session_fixture(admin).id}
  end

  defp create_body(seed_entry) do
    %{
      "name" => "s#{System.unique_integer([:positive])}",
      "password" => "test-password-not-secret",
      "network_slug" => "no-such-net-#{System.unique_integer([:positive])}",
      "nick" => "subjnick",
      "autojoin_channels" => ["#bofh"],
      "seed" => [seed_entry]
    }
  end

  defp seed_entry(gap_fields) do
    Map.merge(%{"name" => "#bofh", "seed_count" => 200, "seed_sender" => "seed-bot"}, gap_fields)
  end

  defp post_create(conn, token, body) do
    conn
    |> put_req_header("authorization", "Bearer " <> token)
    |> put_req_header("content-type", "application/json")
    |> post("/admin/test/subject", Jason.encode!(body))
  end

  describe "POST /admin/test/subject — seed_gap_ms (#2311)" do
    test "a positive integer gap is parsed and the request reaches provisioning", %{
      conn: conn,
      admin_token: token
    } do
      body = create_body(seed_entry(%{"seed_gap_ms" => 100}))

      assert %{"error" => "network_not_found", "network_slug" => slug} =
               conn |> post_create(token, body) |> json_response(404)

      assert slug == body["network_slug"]
    end

    test "a seed entry without seed_gap_ms is refused 422, not seeded at a default", %{
      conn: conn,
      admin_token: token
    } do
      body = create_body(seed_entry(%{}))

      assert conn |> post_create(token, body) |> json_response(422) == %{"error" => "invalid_params"}
    end

    for {label, gap} <- [zero: 0, negative: -100, float: 1.5, string: "100", null: nil] do
      test "a #{label} seed_gap_ms is refused 422", %{conn: conn, admin_token: token} do
        body = create_body(seed_entry(%{"seed_gap_ms" => unquote(gap)}))

        assert conn |> post_create(token, body) |> json_response(422) == %{"error" => "invalid_params"}
      end
    end
  end
end
