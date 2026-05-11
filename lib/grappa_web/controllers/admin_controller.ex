defmodule GrappaWeb.AdminController do
  @moduledoc """
  Operator-facing endpoints gated by `GrappaWeb.Plugs.LoopbackOnly`.

  ## `POST /admin/reload`

  Triggers `Phoenix.CodeReloader.reload/1` against the live endpoint.
  The reloader walks `:code.modified_modules/0` (Erlang built-in:
  modules whose source on disk is newer than the loaded BEAM), purges
  + reloads via Mix's compile-elixir tracker. Live processes
  (`Grappa.Session.Server`, `Grappa.IRC.Client`, etc.) keep their
  GenServer state — Erlang's 2-version code-loading guarantee means
  the next callback runs the new code without restart.

  Returns `200 ok` on success. Failures (compile error in the new
  code, reloader misconfigured) bubble out of the controller; Phoenix's
  fallback rendering takes care of the 500.

  Hot-deploy workflow:

      docker exec grappa curl -fsS -X POST http://localhost:4000/admin/reload

  Module-shape changes that can't be hot-swapped (mix.lock bump,
  supervision tree restructure, struct shape change in long-lived
  GenServer state) require the cold path — `scripts/deploy.sh`. The
  CI image-build pipeline flips the `grappa.hot_deployable=true` label
  to `false` for unsafe images, and `scripts/hot-deploy.sh` (B6) reads
  the label to refuse skipping the cold path.
  """
  use GrappaWeb, :controller

  @doc "POST /admin/reload → reload all modified modules in the running BEAM."
  @spec reload(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def reload(conn, _) do
    case Phoenix.CodeReloader.reload(GrappaWeb.Endpoint) do
      :ok -> text(conn, "ok")
      {:error, msg} -> conn |> put_status(:internal_server_error) |> text(msg)
    end
  end
end
