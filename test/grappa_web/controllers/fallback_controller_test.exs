defmodule GrappaWeb.FallbackControllerTest do
  @moduledoc """
  Direct-dispatch tests for `GrappaWeb.FallbackController.call/2` covering
  the T31 admission error mappings. We exercise the fallback at the
  controller-module level (no router, no AuthController) so a single
  `{:error, atom}` input maps deterministically to status + body
  regardless of which action surfaced it.

  Why direct-dispatch: the captcha error atoms (`:captcha_required`,
  `:captcha_failed`, `:captcha_provider_unavailable`) cannot be reached
  from the test config (`Captcha.Disabled` provider always returns `:ok`).
  Direct-dispatch isolates the wire-shape contract from Login plumbing
  and keeps the test from depending on which production code path emits
  each atom.
  """
  use GrappaWeb.ConnCase, async: true

  alias GrappaWeb.FallbackController

  defp build_conn_for_call do
    Phoenix.ConnTest.build_conn()
  end

  describe "T31 admission capacity errors" do
    test "{:error, :client_cap_exceeded} → 429 too_many_sessions" do
      conn = FallbackController.call(build_conn_for_call(), {:error, :client_cap_exceeded})

      assert conn.status == 429
      assert Jason.decode!(conn.resp_body) == %{"error" => "too_many_sessions"}
    end

    test "{:error, :network_cap_exceeded} → 503 network_busy" do
      conn = FallbackController.call(build_conn_for_call(), {:error, :network_cap_exceeded})

      assert conn.status == 503
      assert Jason.decode!(conn.resp_body) == %{"error" => "network_busy"}
    end

    test "{:error, {:network_circuit_open, retry_after}} → 503 network_unreachable + Retry-After" do
      conn =
        FallbackController.call(
          build_conn_for_call(),
          {:error, {:network_circuit_open, 42}}
        )

      assert conn.status == 503
      assert Jason.decode!(conn.resp_body) == %{"error" => "network_unreachable"}
      assert Plug.Conn.get_resp_header(conn, "retry-after") == ["42"]
    end
  end

  describe "T31 captcha errors" do
    test "{:error, :captcha_required} → 400 captcha_required + site_key + provider" do
      prior = Application.get_env(:grappa, :admission)

      Application.put_env(:grappa, :admission,
        captcha_provider: Grappa.Admission.Captcha.Turnstile,
        captcha_site_key: "test-site-key-123"
      )

      on_exit(fn -> Application.put_env(:grappa, :admission, prior) end)

      conn = FallbackController.call(build_conn_for_call(), {:error, :captcha_required})
      body = json_response(conn, 400)
      assert body["error"] == "captcha_required"
      assert body["site_key"] == "test-site-key-123"
      assert body["provider"] == "turnstile"
    end

    test "{:error, :captcha_failed} → 400 captcha_failed" do
      conn = FallbackController.call(build_conn_for_call(), {:error, :captcha_failed})

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body) == %{"error" => "captcha_failed"}
    end

    test "{:error, :captcha_provider_unavailable} → 503 service_degraded" do
      conn =
        FallbackController.call(build_conn_for_call(), {:error, :captcha_provider_unavailable})

      assert conn.status == 503
      assert Jason.decode!(conn.resp_body) == %{"error" => "service_degraded"}
    end
  end
end
