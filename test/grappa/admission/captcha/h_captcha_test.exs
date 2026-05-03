defmodule Grappa.Admission.Captcha.HCaptchaTest do
  use ExUnit.Case, async: true

  alias Grappa.Admission.Captcha.HCaptcha

  setup do
    bypass = Bypass.open()
    original = Application.get_env(:grappa, :admission, [])

    Application.put_env(
      :grappa,
      :admission,
      original
      |> Keyword.put(:captcha_secret, "test-secret")
      |> Keyword.put(:hcaptcha_endpoint, "http://localhost:#{bypass.port}/siteverify")
    )

    on_exit(fn -> Application.put_env(:grappa, :admission, original) end)

    {:ok, bypass: bypass}
  end

  test "returns :ok on success: true", %{bypass: bypass} do
    Bypass.expect_once(bypass, "POST", "/siteverify", fn conn ->
      conn |> Plug.Conn.put_resp_content_type("application/json") |> Plug.Conn.resp(200, ~s({"success":true}))
    end)

    assert :ok = HCaptcha.verify("real-token", "1.2.3.4")
  end

  test "returns :captcha_failed on success: false", %{bypass: bypass} do
    Bypass.expect_once(bypass, "POST", "/siteverify", fn conn ->
      Plug.Conn.resp(conn, 200, ~s({"success":false,"error-codes":["timeout-or-duplicate"]}))
    end)

    assert {:error, :captcha_failed} = HCaptcha.verify("expired-token", "1.2.3.4")
  end

  test "returns :captcha_required on nil token" do
    assert {:error, :captcha_required} = HCaptcha.verify(nil, "1.2.3.4")
  end

  test "returns :captcha_provider_unavailable on 5xx", %{bypass: bypass} do
    Bypass.expect_once(bypass, fn conn -> Plug.Conn.resp(conn, 500, "") end)
    assert {:error, :captcha_provider_unavailable} = HCaptcha.verify("token", "1.2.3.4")
  end

  test "returns :captcha_provider_unavailable on connect failure", %{bypass: bypass} do
    Bypass.down(bypass)
    assert {:error, :captcha_provider_unavailable} = HCaptcha.verify("token", "1.2.3.4")
  end
end
