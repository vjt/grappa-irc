defmodule GrappaWeb.HealthController do
  @moduledoc """
  Liveness probe. Returns `200 ok` as soon as the supervision tree is
  up; deeper readiness checks (Repo round-trip, IRC session count) belong
  in a future `/readyz` surface added by Phase 5 hardening.
  """
  use GrappaWeb, :controller

  @doc "GET /healthz → 200 text/plain `ok` once the supervision tree is up."
  @spec show(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show(conn, _), do: text(conn, "ok")
end
