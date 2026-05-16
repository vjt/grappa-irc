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
  # async: false — the captcha_required test mutates the shared
  # `:persistent_term` slot for `Grappa.Admission.Config.config/0` to
  # exercise the Turnstile wire shape (B1.3 migration).
  use GrappaWeb.ConnCase, async: false

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

    test "{:error, :visitor_cap_exceeded} → 503 network_busy" do
      conn = FallbackController.call(build_conn_for_call(), {:error, :visitor_cap_exceeded})

      assert conn.status == 503
      assert Jason.decode!(conn.resp_body) == %{"error" => "network_busy"}
    end

    test "{:error, :user_cap_exceeded} → 503 network_busy" do
      conn = FallbackController.call(build_conn_for_call(), {:error, :user_cap_exceeded})

      assert conn.status == 503
      assert Jason.decode!(conn.resp_body) == %{"error" => "network_busy"}
    end

    test "{:error, :connect_timeout} → 503 connect_timeout + Retry-After 30" do
      conn = FallbackController.call(build_conn_for_call(), {:error, :connect_timeout})

      assert conn.status == 503
      assert Jason.decode!(conn.resp_body) == %{"error" => "connect_timeout"}
      assert Plug.Conn.get_resp_header(conn, "retry-after") == ["30"]
    end

    test "{:error, :welcome_timeout} → 503 welcome_timeout + Retry-After 60" do
      conn = FallbackController.call(build_conn_for_call(), {:error, :welcome_timeout})

      assert conn.status == 503
      assert Jason.decode!(conn.resp_body) == %{"error" => "welcome_timeout"}
      assert Plug.Conn.get_resp_header(conn, "retry-after") == ["60"]
    end

    test "{:error, :probe_timeout} → 500 probe_timeout (programmer assertion)" do
      conn = FallbackController.call(build_conn_for_call(), {:error, :probe_timeout})

      assert conn.status == 500
      assert Jason.decode!(conn.resp_body) == %{"error" => "probe_timeout"}
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
      pt_key = {Grappa.Admission.Config, :config}
      original_pt = :persistent_term.get(pt_key, :__unset__)

      Grappa.Admission.Config.put_test_config(%Grappa.Admission.Config{
        captcha_provider: Grappa.Admission.Captcha.Turnstile,
        captcha_secret: "test-secret",
        captcha_site_key: "test-site-key-123",
        turnstile_endpoint: "unused",
        hcaptcha_endpoint: "unused"
      })

      on_exit(fn ->
        case original_pt do
          :__unset__ -> :persistent_term.erase(pt_key)
          cfg -> :persistent_term.put(pt_key, cfg)
        end
      end)

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

  # L-web-1: AuthController error envelopes that previously bypassed
  # the FallbackController via inline `send_error/3`. Routed here to
  # keep the wire-shape contract in one module.
  describe "AuthController error envelopes (L-web-1)" do
    test "{:error, :malformed_nick} → 400 malformed_nick" do
      conn = FallbackController.call(build_conn_for_call(), {:error, :malformed_nick})

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body) == %{"error" => "malformed_nick"}
    end

    test "{:error, :password_required} → 401 password_required" do
      conn = FallbackController.call(build_conn_for_call(), {:error, :password_required})

      assert conn.status == 401
      assert Jason.decode!(conn.resp_body) == %{"error" => "password_required"}
    end

    test "{:error, :password_mismatch} → 401 password_mismatch" do
      conn = FallbackController.call(build_conn_for_call(), {:error, :password_mismatch})

      assert conn.status == 401
      assert Jason.decode!(conn.resp_body) == %{"error" => "password_mismatch"}
    end

    test "{:error, :upstream_unreachable} → 502 upstream_unreachable" do
      conn = FallbackController.call(build_conn_for_call(), {:error, :upstream_unreachable})

      assert conn.status == 502
      assert Jason.decode!(conn.resp_body) == %{"error" => "upstream_unreachable"}
    end

    test "{:error, :internal} → 500 internal" do
      conn = FallbackController.call(build_conn_for_call(), {:error, :internal})

      assert conn.status == 500
      assert Jason.decode!(conn.resp_body) == %{"error" => "internal"}
    end

    test "{:error, {:anon_collision, retry_after}} → 409 anon_collision + Retry-After" do
      conn =
        FallbackController.call(build_conn_for_call(), {:error, {:anon_collision, 1234}})

      assert conn.status == 409
      assert Jason.decode!(conn.resp_body) == %{"error" => "anon_collision"}
      assert Plug.Conn.get_resp_header(conn, "retry-after") == ["1234"]
    end
  end

  # Bucket G H2+U4 (codebase-review-2026-05-12): unified
  # `{error, field_errors}` envelope for 422 changeset failures.
  #
  # Pre-bucket-G: 422 emitted `%{errors: %{field => [msg]}}` — no
  # `error` discriminator, so cic's `readError` fell through to
  # `body.errors.detail` (Phoenix default-error shape, NOT Ecto
  # changeset shape) and from there to `res.statusText`. Every 422
  # collapsed to "Unprocessable Entity" client-side, losing
  # field-level error info to the operator.
  #
  # Post-fix: 422 emits `%{error: "validation_failed", field_errors:
  # %{field => [msg]}}`. The discriminator follows the snake_case
  # convention of every other arm (line 9 moduledoc); the
  # field-level errors live as a top-level `field_errors` key
  # alongside the existing `site_key`/`provider`/`retry_after`
  # convention (cic's `ApiError.info` already reads body's top-level
  # keys directly — see `Login.tsx`'s `err.info.provider` access).
  describe "validation errors (H2+U4 unified envelope)" do
    test "{:error, %Ecto.Changeset{}} → 422 validation_failed + field_errors" do
      changeset =
        {%{}, %{nick: :string, body: :string}}
        |> Ecto.Changeset.cast(%{}, [:nick, :body])
        |> Ecto.Changeset.validate_required([:nick, :body])

      conn = FallbackController.call(build_conn_for_call(), {:error, changeset})

      body = json_response(conn, 422)
      assert body["error"] == "validation_failed"
      assert body["field_errors"]["nick"] == ["can't be blank"]
      assert body["field_errors"]["body"] == ["can't be blank"]
    end

    test "field_errors traverses substitution opts (e.g. {%{count}})" do
      changeset =
        {%{}, %{nick: :string}}
        |> Ecto.Changeset.cast(%{nick: "x"}, [:nick])
        |> Ecto.Changeset.validate_length(:nick, min: 3)

      conn = FallbackController.call(build_conn_for_call(), {:error, changeset})

      body = json_response(conn, 422)
      assert body["error"] == "validation_failed"
      [msg] = body["field_errors"]["nick"]
      assert msg =~ "should be at least 3"
    end
  end
end
