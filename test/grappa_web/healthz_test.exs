defmodule GrappaWeb.HealthzTest do
  use GrappaWeb.ConnCase, async: true

  test "GET /healthz returns 200 ok", %{conn: conn} do
    conn = get(conn, "/healthz")
    assert response(conn, 200) == "ok"
  end

  test "GET /healthz uses text/plain", %{conn: conn} do
    conn = get(conn, "/healthz")
    assert ["text/plain" <> _] = get_resp_header(conn, "content-type")
  end
end
