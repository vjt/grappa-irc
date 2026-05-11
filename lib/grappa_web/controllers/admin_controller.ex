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
  unified `scripts/deploy.sh` (B6+B7) auto-detects unsafe diffs via a
  git-diff preflight and refuses to hot-deploy them.

  ## `POST /admin/cic-bundle-changed`

  Re-reads `runtime/cicchetto-dist/index.html` via `Grappa.Cic.Bundle`
  and broadcasts the new hash on every live user-topic. cic mirrors
  this push (B5) by comparing against `bootBundleHash` (the hash baked
  into the page the browser loaded) and surfacing a refresh banner on
  mismatch — click → `window.location.reload()`.

  Returns `200 <hash>` with the broadcast hash on success, or `204`
  when the bundle file is absent (no fan-out happened — nothing to
  compare against). The `scripts/deploy-cic.sh` wrapper (B8) calls
  this after `compose --profile prod run --rm cicchetto-build`
  produces a fresh bundle.
  """
  use GrappaWeb, :controller

  alias Grappa.Cic.Bundle, as: CicBundle
  alias Grappa.PubSub, as: GrappaPubSub
  alias Grappa.PubSub.Topic
  alias Grappa.WSPresence

  @doc "POST /admin/reload → reload all modified modules in the running BEAM."
  @spec reload(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def reload(conn, _) do
    case Phoenix.CodeReloader.reload(GrappaWeb.Endpoint) do
      :ok -> text(conn, "ok")
      {:error, msg} -> conn |> put_status(:internal_server_error) |> text(msg)
    end
  end

  @doc "POST /admin/cic-bundle-changed → re-read bundle hash + broadcast on every user-topic."
  @spec cic_bundle_changed(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def cic_bundle_changed(conn, _) do
    case CicBundle.current_hash() do
      nil ->
        send_resp(conn, :no_content, "")

      hash when is_binary(hash) ->
        payload = %{kind: "bundle_hash", hash: hash}

        for user_name <- WSPresence.list_user_names() do
          GrappaPubSub.broadcast_event(Topic.user(user_name), payload)
        end

        text(conn, hash)
    end
  end
end
