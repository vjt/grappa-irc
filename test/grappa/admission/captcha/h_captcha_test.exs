defmodule Grappa.Admission.Captcha.HCaptchaTest do
  # async: false — mutates the shared `:persistent_term` slot for
  # `Grappa.Admission.Config.config/0` (B1.3 migration). The previous
  # `Application.put_env` pattern was also globally racy but only set
  # provider-specific keys; the struct's all-or-nothing snapshot makes
  # the race observable, so we serialise.
  use ExUnit.Case, async: false

  alias Grappa.Admission.Captcha.HCaptcha

  @pt_key {Grappa.Admission.Config, :config}

  setup do
    bypass = Bypass.open()
    original_pt = :persistent_term.get(@pt_key, :__unset__)

    Grappa.Admission.Config.put_test_config(%Grappa.Admission.Config{
      captcha_provider: Grappa.Admission.Captcha.HCaptcha,
      captcha_secret: "test-secret",
      captcha_site_key: "test-site-key",
      turnstile_endpoint: "unused",
      hcaptcha_endpoint: "http://localhost:#{bypass.port}/siteverify"
    })

    on_exit(fn ->
      case original_pt do
        :__unset__ -> :persistent_term.erase(@pt_key)
        cfg -> :persistent_term.put(@pt_key, cfg)
      end
    end)

    {:ok, bypass: bypass}
  end

  test "returns :captcha_required on nil token" do
    assert {:error, :captcha_required} = HCaptcha.verify(nil, "1.2.3.4")
  end

  test "returns :captcha_required on empty-string token" do
    assert {:error, :captcha_required} = HCaptcha.verify("", "1.2.3.4")
  end

  test "delegates to SiteVerifyHttp with hcaptcha_endpoint + captcha_secret",
       %{bypass: bypass} do
    Bypass.expect_once(bypass, "POST", "/siteverify", fn conn ->
      {:ok, body, conn} = Plug.Conn.read_body(conn)
      params = URI.decode_query(body)

      assert params["secret"] == "test-secret"
      assert params["response"] == "real-token"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.resp(200, ~s({"success":true}))
    end)

    assert :ok = HCaptcha.verify("real-token", "1.2.3.4")
  end
end
