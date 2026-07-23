defmodule GrappaWeb.AdminController do
  @moduledoc """
  Operator-facing endpoints gated by `GrappaWeb.Plugs.LoopbackOnly`.

  ## `POST /admin/reload`

  Delegates to `Grappa.HotReload.reload_modified/0`: walks the app's
  own `ebin` dir by absolute path and, per `.beam` file, reloads it
  if it's new (module never loaded) or changed (on-disk md5 differs
  from the loaded version's `module_info(:md5)`) via
  `:code.soft_purge/1` + `:code.load_abs/1` — see that module's
  moduledoc for why NOT `:code.modified_modules/0` +
  `:code.load_file/1` (both were tried first and both have live-repro'd
  blind spots: `modified_modules/0` never sees a module that's brand
  new, and OTP's cached code path is blind to files added after boot),
  and for why soft-purge (the 2026-06-10 double-hot-deploy
  `:not_purged` live repro, and why hard purge would drop IRC
  sessions). Returns `200 OK` with JSON
  `%{"reloaded" => ["Elixir.Mod.Name", ...], "failed" => [%{"module" =>
  ..., "reason" => ...}, ...]}` — both empty when nothing changed;
  a non-empty `failed` is NOT itself surfaced as a non-200 status, so
  callers (deploy scripts) MUST inspect the body, not just the HTTP
  status.

  ### Why not `Phoenix.CodeReloader`

  `Phoenix.CodeReloader.reload/1` returns `:ok` in prod but does
  NOT recompile or reload anything: it requires Mix (which is
  available in `mix phx.server` but NOT in `mix release` artifacts)
  and the dev-only `code_reloader: true` config-flag plumbing. The
  jail uses release boot (`bin/grappa daemon`) so Mix is absent;
  Docker prod also runs `MIX_ENV=prod` where the reloader silently
  no-ops. The previous shape "POST → :ok → trust it" hid the
  failure (see `feedback_hot_deploy_silent_noop_prod`).

  `Grappa.HotReload`'s own md5-walk is release-friendly by
  construction — no Mix dependency, no compile-time config
  requirement, and (unlike `:code.modified_modules/0`) it also
  catches brand-new modules. Works identically in dev, Docker prod,
  the FreeBSD jail, and this substrate's systemd unit.

  ### Hot-deploy responsibilities split

  This endpoint reloads modules WHOSE .BEAM ON DISK IS ALREADY
  FRESH. Making the .beam fresh is the caller's responsibility:

    * Docker (mix phx.server): `docker exec grappa mix compile`
      writes new .beam to `_build/${MIX_ENV}/lib/grappa/ebin/`.
    * FreeBSD jail (release) and native Linux/systemd (release): both
      run `mix release --overwrite`, writing new .beam to
      `_build/prod/rel/grappa/lib/grappa-X.Y/ebin/` (the path that
      the daemon's `code:get_path/0` includes).

  Either path → POST /admin/reload → live BEAM picks up the new
  .beam. Sessions (Session.Server, IRC.Client, etc.) keep state
  thanks to Erlang's 2-version code-loading guarantee.

  Hot-deploy workflow:

      # Docker
      docker exec grappa mix compile
      docker exec grappa curl -fsS -X POST http://localhost:4000/admin/reload

      # Bastille jail
      sudo bastille cmd grappa /home/grappa/grappa/infra/freebsd/deploy.sh

      # Native Linux/systemd
      infra/linux/deploy.sh

  Module-shape changes that can't be hot-swapped (mix.lock bump,
  supervision tree restructure, struct shape change in long-lived
  GenServer state) require the cold path —
  `scripts/deploy.sh` (Docker), `infra/freebsd/deploy.sh --force-cold`
  (jail), or `infra/linux/deploy.sh` (Linux — always cold when the
  diff needs it, no force flag exists yet on this substrate). All
  three auto-detect unsafe diffs via the shared
  `Grappa.Deploy.Preflight` classifier.

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
  alias Grappa.Cic.Wire, as: CicWire
  alias Grappa.PubSub, as: GrappaPubSub
  alias Grappa.PubSub.Topic
  alias Grappa.WSPresence

  @doc "POST /admin/reload → reload all modified modules in the running BEAM."
  @spec reload(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def reload(conn, _) do
    %{reloaded: reloaded, failed: failed} = Grappa.HotReload.reload_modified()

    json(conn, %{
      reloaded: Enum.map(reloaded, &Atom.to_string/1),
      failed:
        for {mod, reason} <- failed do
          %{module: Atom.to_string(mod), reason: inspect(reason)}
        end
    })
  end

  @doc "POST /admin/cic-bundle-changed → re-read bundle hash + broadcast on every user-topic."
  @spec cic_bundle_changed(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def cic_bundle_changed(conn, _) do
    case CicBundle.current_hash() do
      nil ->
        send_resp(conn, :no_content, "")

      hash when is_binary(hash) ->
        payload = CicWire.bundle_hash(hash, CicBundle.current_version())
        user_names = WSPresence.list_user_names()
        attempted = length(user_names)

        # HIGH-17 (no-silent-drops B6.9a 2026-05-14): per-target
        # accounting via fan-out telemetry. Pre-fix the for-comprehension
        # discarded `broadcast_event/2`'s `:ok | {:error, _}` return — the
        # operator's `scripts/deploy-cic.sh` would print "ok <hash>" with
        # no signal that 0 of N targets received the push. Now a single
        # summary event documents attempted/succeeded/failed so a
        # downstream PromEx alarm can fire on `failed > 0`.
        succeeded =
          Enum.count(user_names, fn user_name ->
            GrappaPubSub.broadcast_event(Topic.user(user_name), payload) == :ok
          end)

        :telemetry.execute(
          [:grappa, :admin, :cic_bundle_fanout],
          %{attempted: attempted, succeeded: succeeded, failed: attempted - succeeded},
          %{hash: hash}
        )

        text(conn, hash)
    end
  end
end
