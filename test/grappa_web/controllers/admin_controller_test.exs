defmodule GrappaWeb.AdminControllerTest do
  @moduledoc """
  `POST /admin/reload` is loopback-gated (only `127.0.0.1` / `::1`)
  and triggers `Phoenix.CodeReloader.reload/1` on success.

  The loopback gate is the load-bearing security check — the test
  exercises both the allow path (default ConnCase remote_ip is
  `127.0.0.1`) and the deny path (manually rewritten remote_ip).

  The reload itself is a no-op against committed code in the test
  sandbox (Mix is loaded, so reload! runs; nothing changed on disk).
  Verifying the controller wires the wrapper correctly is the
  contract under test, not the reload semantics themselves (those
  belong to Phoenix).

  `async: true` — no shared state.
  """
  use GrappaWeb.ConnCase, async: true

  describe "POST /admin/reload — loopback gate" do
    test "allows 127.0.0.1 with 200 ok body", %{conn: conn} do
      conn = post(conn, "/admin/reload")
      assert response(conn, 200) == "ok"
    end

    test "allows ::1 with 200 ok body", %{conn: conn} do
      conn = post(%{conn | remote_ip: {0, 0, 0, 0, 0, 0, 0, 1}}, "/admin/reload")
      assert response(conn, 200) == "ok"
    end

    test "denies non-loopback remote_ip with 403", %{conn: conn} do
      conn = post(%{conn | remote_ip: {192, 168, 1, 100}}, "/admin/reload")
      assert response(conn, 403) =~ "loopback_only"
    end

    test "denies LAN IPv6 with 403", %{conn: conn} do
      conn = post(%{conn | remote_ip: {0xFE80, 0, 0, 0, 0, 0, 0, 1}}, "/admin/reload")
      assert response(conn, 403) =~ "loopback_only"
    end
  end
end
