if Mix.env() in [:dev, :test] do
  defmodule GrappaWeb.Admin.TestResetSubjectController do
    @moduledoc """
    Test-only admin endpoint that drains every mutable surface for a
    seed user (delegates to `Grappa.TestSupport.SubjectReset`).
    Compile-gated to `:dev` and `:test` envs; module + route literally
    do not exist in the prod release.

    Wired at `POST /admin/test/reset-subject` under the
    `[:api, :authn, :admin_authn]` pipeline — requires an admin
    bearer token.

    See `docs/superpowers/specs/2026-05-25-e2e-robustness-d-design.md`.
    """
    use GrappaWeb, :controller

    alias Grappa.TestSupport.SubjectReset

    @spec reset(Plug.Conn.t(), map()) :: Plug.Conn.t()
    def reset(conn, %{"user_name" => user_name}) when is_binary(user_name) do
      # Inline dispatch (not action_fallback) — three of four error
      # tuples carry slug/reason payloads only this surface knows
      # about; FallbackController would have to grow test-only clauses
      # for them.
      case SubjectReset.reset!(user_name) do
        :ok ->
          send_resp(conn, 204, "")

        {:error, :user_not_found} ->
          conn |> put_status(:not_found) |> json(%{error: "user_not_found"})

        {:error, {:reconnect_timeout, slug}} ->
          conn
          |> put_status(:gateway_timeout)
          |> json(%{error: "session_reconnect_timeout", network_slug: slug})

        {:error, {:reconnect_failed, slug, reason}} ->
          conn
          |> put_status(:internal_server_error)
          |> json(%{error: "session_reconnect_failed", network_slug: slug, reason: inspect(reason)})

        {:error, {:autojoin_timeout, slug, channels}} ->
          conn
          |> put_status(:gateway_timeout)
          |> json(%{
            error: "autojoin_timeout",
            network_slug: slug,
            missing_channels: channels
          })
      end
    end

    def reset(conn, _) do
      conn |> put_status(:unprocessable_entity) |> json(%{error: "user_name_required"})
    end
  end
end
