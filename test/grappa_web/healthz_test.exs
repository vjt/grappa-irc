defmodule GrappaWeb.HealthzTest do
  # async: false — these tests mutate the global `Grappa.Health`
  # `:persistent_term` readiness flag. Per-test setup restores the
  # mark_ready/0 state in afterAll. Without async: false a concurrent
  # test reading /healthz would race against the mark_not_ready/0
  # branch.
  use GrappaWeb.ConnCase, async: false

  setup do
    # The Application.start/2 callback runs once per test process at
    # boot; subsequent tests inherit the ready=true flag. Each test
    # explicitly arranges the state it needs.
    Grappa.Health.mark_ready()

    on_exit(fn ->
      # Restore the post-boot state so subsequent test files don't
      # observe a false-503 leak.
      Grappa.Health.mark_ready()
    end)

    :ok
  end

  describe "GET /healthz — happy path (substrate green)" do
    test "returns 200 ok when every check passes", %{conn: conn} do
      conn = get(conn, "/healthz")
      assert response(conn, 200) == "ok"
    end

    test "responds as text/plain (skips JSON content negotiation)", %{conn: conn} do
      conn = get(conn, "/healthz")
      assert [content_type] = get_resp_header(conn, "content-type")
      assert String.starts_with?(content_type, "text/plain")
    end
  end

  describe "GET /healthz — substrate failure surfaces (review H26)" do
    test "503 + JSON failure body when readiness flag is false", %{conn: conn} do
      Grappa.Health.mark_not_ready()
      conn = get(conn, "/healthz")
      assert json = json_response(conn, 503)
      assert json["status"] == "fail"
      assert is_list(json["checks"])

      assert Enum.any?(json["checks"], fn check ->
               check["name"] == "ready"
             end)
    end

    test "ready failure names the specific check + reason", %{conn: conn} do
      Grappa.Health.mark_not_ready()
      conn = get(conn, "/healthz")
      assert %{"checks" => checks} = json_response(conn, 503)
      ready = Enum.find(checks, &(&1["name"] == "ready"))
      assert ready["reason"] =~ "boot not complete"
    end
  end
end
