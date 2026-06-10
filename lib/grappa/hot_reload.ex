defmodule Grappa.HotReload do
  @moduledoc """
  Hot-reload of modified modules in the running BEAM — the context
  behind `POST /admin/reload` (see `GrappaWeb.AdminController` for
  the endpoint story and the why-not-`Phoenix.CodeReloader` history).

  ## soft-purge, never purge

  Erlang keeps at most TWO versions of a module: current and old.
  `:code.load_file/1` shifts current → old and loads the new beam as
  current — which means a module hot-reloaded once already has both
  slots full, and the SECOND hot reload fails `{:error, :not_purged}`
  until the old version is purged. Found live 2026-06-10: the same
  deploy day shipped two hot reloads of `Grappa.Deploy.Preflight`,
  and the second one failed exactly this way (the previous inline
  controller code never purged — while its own doc claimed it did).

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
  Reload every module whose .beam on disk differs from the loaded
  version (`:code.modified_modules/0`). The .beam must already be
  fresh on disk — that's the deploy script's job (see
  `GrappaWeb.AdminController` moduledoc for the per-substrate split).
  """
  @spec reload_modified() :: result()
  def reload_modified do
    reload_modules(:code.modified_modules())
  end

  @doc """
  Reload the given modules from disk. Per module: soft-purge any old
  code (refusing with `:old_code_in_use` when a process still runs
  it), then `:code.load_file/1`.
  """
  @spec reload_modules([module()]) :: result()
  def reload_modules(mods) when is_list(mods) do
    results = Enum.map(mods, &reload_one/1)

    %{
      reloaded: for({mod, :ok} <- results, do: mod),
      failed: for({mod, {:error, reason}} <- results, do: {mod, reason})
    }
  end

  defp reload_one(mod) do
    if :code.soft_purge(mod) do
      case :code.load_file(mod) do
        {:module, ^mod} -> {mod, :ok}
        {:error, reason} -> {mod, {:error, reason}}
      end
    else
      {mod, {:error, :old_code_in_use}}
    end
  end
end
