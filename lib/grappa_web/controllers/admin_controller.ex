defmodule GrappaWeb.AdminController do
  @moduledoc """
  Operator-facing endpoints gated by `GrappaWeb.Plugs.LoopbackOnly`.

  ## `POST /admin/reload`

  Delegates to `Grappa.HotReload.migrate_and_reload/0`, which applies
  pending migrations on the already-open `Grappa.Repo` pool and only
  THEN reloads modules (GH #41 — see that function for why the order is
  load-bearing and why it refuses a pending contract migration). Three
  outcomes join the pre-#41 one:

    * `409` `%{"error" => "contract_migrations_pending", "migrations" =>
      [path, ...]}` — a pending migration is contract; nothing ran, the
      live BEAM is untouched, and the operator's next move is a cold
      deploy. NOTE `curl -f` (every substrate's `substrate_reload`)
      suppresses this body, so the deploy script can only report that
      the POST failed, not why — `infra/lib/deploy_common.sh` names both
      possibilities rather than guessing one.
    * `409` `%{"error" => "duplicate_migration_versions", "duplicates" =>
      [%{"version" => v, "files" => [...], "applied" => bool}, ...]}` —
      two files claim one version (#1348); nothing ran. Same status, but
      the OPPOSITE next move: a cold deploy migrates through the same
      defect, so the repo has to be fixed first.
    * `409` `%{"error" => "stale_code_path", "booted" => vsn, "built" =>
      vsn | null, "code_path" => dir}` — the fresh beams landed in a lib
      directory this node does not read (#1850); nothing ran. A cold
      deploy is the fix, as with the contract arm. This one is checked
      BEFORE the migration audit, and it is a DETECTION rather than a
      prevention: `Grappa.Deploy.Preflight` already classifies a `VERSION`
      diff COLD, but `--force-hot` skips preflight and a reload that walks
      the stale tree answers `{"reloaded":[],"failed":[]}` — the silence
      that served old code for ~6.5h on 2026-08-13.
    * a raising migration is NOT rescued: it 5xxes, the transaction
      rolls back, and no module is reloaded.

  On success the JSON gains a `"migrated"` key (the applied versions,
  `[]` when there was nothing pending) alongside the pre-existing
  `"reloaded"` / `"failed"`.

  The reload half walks the app's
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
  `%{"migrated" => [version, ...], "reloaded" => ["Elixir.Mod.Name",
  ...], "failed" => [%{"module" => ..., "reason" => ...}, ...]}` — all
  empty when nothing changed; a non-empty `failed` is NOT itself
  surfaced as a non-200 status, so callers (deploy scripts) MUST inspect
  the body, not just the HTTP status.

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
  GenServer state, a CONTRACT migration) require the cold path —
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

  @doc "POST /admin/reload → migrate, then reload every modified module."
  @spec reload(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def reload(conn, _) do
    case Grappa.HotReload.migrate_and_reload() do
      {:ok, %{migrated: migrated, reloaded: reloaded, failed: failed}} ->
        json(conn, %{
          migrated: migrated,
          reloaded: Enum.map(reloaded, &Atom.to_string/1),
          failed:
            for {mod, reason} <- failed do
              %{module: Atom.to_string(mod), reason: inspect(reason)}
            end
        })

      {:error, {:contract_migrations, files}} ->
        # 409, not 500: nothing failed and nothing is broken — the
        # request is simply not satisfiable hot. The operator's next
        # move is a cold deploy, and the body names the files that
        # decided it.
        conn
        |> put_status(:conflict)
        |> json(%{error: "contract_migrations_pending", migrations: files})

      {:error, {:duplicate_migration_versions, duplicates}} ->
        # Also 409, and also nothing ran — but the operator's next move
        # is the OPPOSITE one (#1348). A cold deploy walks straight back
        # into a version claimed by two files, so the body names them
        # and the deploy script's printed hint says so out loud.
        conn
        |> put_status(:conflict)
        |> json(%{error: "duplicate_migration_versions", duplicates: duplicates})

      {:error, {:stale_code_path, drift}} ->
        # 409 a third time, nothing ran again — and nothing in the repo is
        # wrong (#1850). The build wrote its beams into a lib directory
        # this node does not read, so a reload could only ever have loaded
        # stale code and reported `{"reloaded":[],"failed":[]}` doing it.
        # A cold deploy IS the fix (it boots the new vsn), same as the
        # contract-migration arm and unlike the duplicate-version one —
        # the body names both numbers so the operator can see which tree
        # the node is on and which one the build produced.
        conn
        |> put_status(:conflict)
        |> json(%{
          error: "stale_code_path",
          booted: drift.booted,
          built: drift.built,
          code_path: drift.lib_dir
        })
    end
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
