defmodule GrappaWeb.HealthController do
  @moduledoc """
  Liveness + substrate-readiness probe at `GET /healthz` (review H26).

  Pre-REV-C returned 200 unconditionally — the BEAM answering was the
  only signal. A wedged supervision tree where Phoenix.Endpoint still
  answered (the canonical hot-deploy shape-mismatch crash-loop)
  passed healthy. Docker HEALTHCHECK suffered the same blindness.

  H26 runs three substrate checks via `Grappa.Health.check/0`:

    * `:ready` — supervision tree completed its first-pass boot
    * `:repo` — `Repo.query("SELECT 1")` succeeds
    * `:ets` — long-lived singleton ETS tables present

  On any check fail: `503 service unavailable` with a JSON body
  naming the failing check(s) — operator can grep `/healthz` failure
  logs for the specific wedge. Per `feedback_silent_retry_anti_pattern`:
  surface the wedge, don't paper over it.

  Docker HEALTHCHECK + nginx healthcheck both probe `/healthz` so
  they inherit the deepened check for free.
  """
  use GrappaWeb, :controller

  @doc """
  `GET /healthz` — 200 `ok` if every substrate check passes; 503
  with `{"status": "fail", "checks": [{"name": "...", "reason": "..."}]}`
  on any failure.
  """
  @spec show(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show(conn, _) do
    case Grappa.Health.check() do
      :ok ->
        text(conn, "ok")

      {:fail, failures} ->
        conn
        |> put_status(503)
        |> json(%{
          status: "fail",
          checks:
            Enum.map(failures, fn {name, reason} ->
              %{name: name, reason: reason}
            end)
        })
    end
  end
end
