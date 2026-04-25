defmodule GrappaWeb.HealthzTest do
  use GrappaWeb.ConnCase, async: true

  test "GET /healthz returns 200 ok", %{conn: conn} do
    conn = get(conn, "/healthz")
    assert response(conn, 200) == "ok"
  end

  test "GET /healthz responds as text/plain (skips JSON content negotiation)", %{conn: conn} do
    conn = get(conn, "/healthz")
    assert [content_type] = get_resp_header(conn, "content-type")
    assert String.starts_with?(content_type, "text/plain")
  end
end
