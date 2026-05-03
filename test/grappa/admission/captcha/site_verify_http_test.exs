defmodule Grappa.Admission.Captcha.SiteVerifyHttpTest do
  use ExUnit.Case, async: true
  alias Grappa.Admission.Captcha.SiteVerifyHttp

  setup do
    bypass = Bypass.open()
    {:ok, bypass: bypass, endpoint: "http://localhost:#{bypass.port}/siteverify"}
  end

  test "200 + success=true → :ok", %{bypass: bypass, endpoint: endpoint} do
    Bypass.expect(bypass, "POST", "/siteverify", fn conn ->
      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.resp(200, ~s({"success": true}))
    end)

    assert :ok = SiteVerifyHttp.verify(endpoint, "secret", "token", "1.2.3.4")
  end

  test "200 + success=false → {:error, :captcha_failed}", %{bypass: bypass, endpoint: endpoint} do
    Bypass.expect(bypass, "POST", "/siteverify", fn conn ->
      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.resp(200, ~s({"success": false, "error-codes": ["timeout-or-duplicate"]}))
    end)

    assert {:error, :captcha_failed} = SiteVerifyHttp.verify(endpoint, "secret", "token", "1.2.3.4")
  end

  test "5xx → {:error, :captcha_provider_unavailable}", %{bypass: bypass, endpoint: endpoint} do
    Bypass.expect(bypass, "POST", "/siteverify", fn conn ->
      Plug.Conn.resp(conn, 503, "")
    end)

    assert {:error, :captcha_provider_unavailable} =
             SiteVerifyHttp.verify(endpoint, "secret", "token", "1.2.3.4")
  end

  test "connection refused → {:error, :captcha_provider_unavailable}" do
    closed_endpoint = "http://localhost:1/siteverify"

    assert {:error, :captcha_provider_unavailable} =
             SiteVerifyHttp.verify(closed_endpoint, "secret", "token", "1.2.3.4")
  end

  test "remote_ip nil omits remoteip key", %{bypass: bypass, endpoint: endpoint} do
    Bypass.expect(bypass, "POST", "/siteverify", fn conn ->
      {:ok, body, conn} = Plug.Conn.read_body(conn)
      refute body =~ "remoteip"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.resp(200, ~s({"success": true}))
    end)

    assert :ok = SiteVerifyHttp.verify(endpoint, "secret", "token", nil)
  end

  test "POSTs encoded form body with secret + response + remoteip", %{
    bypass: bypass,
    endpoint: endpoint
  } do
    Bypass.expect(bypass, "POST", "/siteverify", fn conn ->
      {:ok, body, conn} = Plug.Conn.read_body(conn)
      assert body =~ "secret=secret"
      assert body =~ "response=token"
      assert body =~ "remoteip=1.2.3.4"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.resp(200, ~s({"success": true}))
    end)

    assert :ok = SiteVerifyHttp.verify(endpoint, "secret", "token", "1.2.3.4")
  end
end
