defmodule Mix.Tasks.Grappa.Boot do
  @moduledoc """
  Shared boot helper for the `grappa.*` operator mix tasks.

  Operator-side CLI tasks need the `:grappa` OTP application's
  Repo + Vault + supervised processes started, but they explicitly
  do NOT want `Grappa.Bootstrap` to run — that would open real
  upstream IRC connections to every bound network for what is
  meant to be a one-shot account/credential mutation. Pre-A11/M12
  every task duplicated the same two-line dance:

      Application.put_env(:grappa, :start_bootstrap, false)
      {:ok, _} = Application.ensure_all_started(:grappa)

  Six grappa.* tasks repeated this verbatim (`grappa.gen_encryption_key`
  is the lone exception — pure crypto, no Repo). Centralising it
  here means the bootstrap-suppression contract has one home; the
  tasks call `start_app_silent/0` and stay focused on their domain
  work.

  See `Grappa.Application.bootstrap_child/0` for the
  `:start_bootstrap` flag's contract.
  """
  use Boundary, top_level?: true

  @doc """
  Starts the `:grappa` application with the Bootstrap supervisor
  child suppressed, so the IRC supervision tree boots empty (no
  upstream connections). Returns `:ok` on success.

  Runs `mix app.config` first — found live 2026-07-22 (native Linux
  systemd deploy, first `MIX_ENV=prod` install): a bare
  `Application.ensure_all_started/1`, unlike `mix run`/`mix
  phx.server`, does NOT evaluate `config/runtime.exs` on its own. This
  was invisible under Docker's default `MIX_ENV=dev` (where
  `config/dev.exs` hardcodes `uploads_storage_root`/`database_path`,
  no runtime.exs needed for those), but under `MIX_ENV=prod` — where
  those values exist ONLY in runtime.exs — every one of the six
  `grappa.*` operator tasks that call this function
  (`create_user` included) crashed with `Application.fetch_env!/2`
  raising "configuration ... was not set", not a Grappa bug in the
  fetched key itself. `mix app.config` is Mix's own task for
  "load app config, including runtime.exs, without starting the app"
  — exactly what was missing. Idempotent within a single `mix`
  invocation (`Mix.Task.run/2` only runs a given task once unless
  `Mix.Task.rerun/2` is used), so this is safe even if a caller
  already triggered it some other way.

  The list of started applications from
  `Application.ensure_all_started/1` is discarded — operator tasks
  don't act on it. Returning `:ok` (instead of `[Application.app()]`)
  also lines up with Dialyzer's `:unmatched_returns` flag so the
  six call sites stay one-liners without `_ =` prefixes.

  Raises `Mix.Error` on boot failure so the task exit is loud and
  the operator sees the underlying reason rather than a cryptic
  match-clause crash on the surrounding `{:ok, _} = ...` pattern.
  """
  @spec start_app_silent() :: :ok
  def start_app_silent do
    Mix.Task.run("app.config")
    Application.put_env(:grappa, :start_bootstrap, false)

    case Application.ensure_all_started(:grappa) do
      {:ok, _} -> :ok
      {:error, reason} -> Mix.raise("failed to start :grappa — #{inspect(reason)}")
    end
  end
end
