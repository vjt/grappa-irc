defmodule Grappa.Admission.Captcha.CaptchaProviderSmokeTest do
  # async: false rationale lives in `Grappa.AdmissionCaptchaTestHelper`
  # (single-home: both providers share the global `:persistent_term`
  # config slot).
  use ExUnit.Case, async: false

  alias Grappa.Admission.Captcha.{HCaptcha, Turnstile}
  alias Grappa.AdmissionCaptchaTestHelper

  # Provider routing matrix. Each entry pairs a `Grappa.Admission.Captcha`
  # implementation with the `Grappa.Admission.Config` field its `verify/2`
  # reads. Adding a new provider is one line here + the helper handles
  # the rest.
  @providers [
    {Turnstile, :turnstile_endpoint},
    {HCaptcha, :hcaptcha_endpoint}
  ]

  for {provider, endpoint_key} <- @providers do
    describe "#{inspect(provider)}.verify/2" do
      setup do
        AdmissionCaptchaTestHelper.setup_provider(unquote(provider), unquote(endpoint_key))
      end

      test "returns :captcha_required on nil token" do
        assert {:error, :captcha_required} = unquote(provider).verify(nil, "1.2.3.4")
      end

      test "returns :captcha_required on empty-string token" do
        assert {:error, :captcha_required} = unquote(provider).verify("", "1.2.3.4")
      end

      test "delegates to SiteVerifyHttp routing secret + token + remoteip to #{endpoint_key}",
           %{bypass: bypass} do
        Bypass.expect_once(bypass, "POST", "/siteverify", fn conn ->
          {:ok, body, conn} = Plug.Conn.read_body(conn)
          params = URI.decode_query(body)

          assert params["secret"] == "test-secret"
          assert params["response"] == "real-token"
          assert params["remoteip"] == "1.2.3.4"

          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.resp(200, ~s({"success":true}))
        end)

        assert :ok = unquote(provider).verify("real-token", "1.2.3.4")
      end
    end
  end
end
