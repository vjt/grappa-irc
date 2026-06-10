defmodule Grappa.HotReload do
  @moduledoc """
  Hot-reload of the app's modules in the running BEAM — the context
  behind `POST /admin/reload` (see `GrappaWeb.AdminController` for
  the endpoint story and the why-not-`Phoenix.CodeReloader` history).

  ## One uniform walk, by absolute path

  `reload_modified/0` walks the grappa app's ebin directory and, per
  beam file: loads it if the module was never loaded; soft-purges +
  reloads it if the on-disk md5 differs from the loaded version's
  `module_info(:md5)`; skips it otherwise. Dependencies are
  deliberately out of scope — a dep change means `mix.lock` changed,
  and the deploy preflight forces COLD for that class, so the app's
  own ebin is the complete hot-reload surface.

  Loading goes through `:code.load_abs/1` with the explicit beam
  path, never `:code.load_file/1`. Three live repros (2026-06-10)
  drove this design:

  * `:code.modified_modules/0` only compares LOADED beams against
    disk — a hot deploy that ADDS a module is invisible to it, and
    releases run embedded mode (no lazy loading), so the first call
    into the new module crashed `:undef`.
  * The OTP 26+ cached code path does not see files added to a
    directory after boot — `:code.load_file/1` returned `:nofile`
    for a beam demonstrably sitting in a path-member dir. This bites
    FOREVER (until cold restart) for any module first hot-deployed
    post-boot, including this module's own first update.
  * md5 comparison replaces `:code.modified_modules/0` because the
    latter resolves through the same cached path.

  ## soft-purge, never purge

  Erlang keeps at most TWO versions of a module: current and old.
  Loading shifts current → old — which means a module hot-reloaded
  once already has both slots full, and the SECOND hot reload fails
  `{:error, :not_purged}` until the old version is purged (also hit
  live 2026-06-10, while the endpoint's own doc claimed it purged).

  The purge MUST be `:code.soft_purge/1`, not `:code.purge/1`: hard
  purge KILLS every process still executing old code — on an
  always-on bouncer that's dropped IRC sessions, silently, from an
  endpoint whose whole purpose is to avoid restarts. soft_purge
  refuses instead, and the refusal is surfaced as
  `{mod, :old_code_in_use}` in `failed` so the operator decides
  (usually: wait for the process to make a fully-qualified call and
  retry, or schedule a cold window).
  """

  use Boundary, top_level?: true, deps: [], exports: []

  @typedoc "Per-module failure: soft-purge refusal or load error."
  @type failure :: {module(), :old_code_in_use | term()}

  @type result :: %{reloaded: [module()], failed: [failure()]}

  @doc """
  Walk the grappa app's ebin and reload every new or changed module.
  The .beam files must already be fresh on disk — that's the deploy
  script's job (see `GrappaWeb.AdminController` moduledoc for the
  per-substrate split).
  """
  @spec reload_modified() :: result()
  def reload_modified do
    :grappa |> :code.lib_dir() |> to_string() |> Path.join("ebin") |> reload_from()
  end

  @doc """
  Reload every beam under `ebin_dir` that is new (module not loaded)
  or changed (on-disk md5 differs from the loaded version). Unchanged
  modules are untouched.
  """
  @spec reload_from(Path.t()) :: result()
  def reload_from(ebin_dir) do
    results =
      for beam <- Path.wildcard(Path.join(ebin_dir, "*.beam")),
          mod = beam |> Path.basename(".beam") |> String.to_atom(),
          new_or_changed?(mod, beam) do
        reload_one(mod, beam)
      end

    %{
      reloaded: for({mod, :ok} <- results, do: mod),
      failed: for({mod, {:error, reason}} <- results, do: {mod, reason})
    }
  end

  defp new_or_changed?(mod, beam) do
    case :code.is_loaded(mod) do
      false ->
        true

      {:file, _} ->
        case :beam_lib.md5(String.to_charlist(beam)) do
          {:ok, {^mod, disk_md5}} -> disk_md5 != apply(mod, :module_info, [:md5])
          # Unreadable/mismatched beam: surface via the load attempt
          # rather than silently skipping a file that claims to be
          # this module.
          _ -> true
        end
    end
  end

  defp reload_one(mod, beam) do
    if :code.soft_purge(mod) do
      # load_abs wants the path sans ".beam" extension. Never
      # :code.load_file/1 here — see moduledoc (cached code path is
      # blind to post-boot files).
      beam_sans_ext = beam |> Path.rootname() |> String.to_charlist()

      case :code.load_abs(beam_sans_ext) do
        {:module, ^mod} -> {mod, :ok}
        {:error, reason} -> {mod, {:error, reason}}
      end
    else
      {mod, {:error, :old_code_in_use}}
    end
  end
end
