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
    Application.put_env(:grappa, :start_bootstrap, false)

    case Application.ensure_all_started(:grappa) do
      {:ok, _} -> :ok
      {:error, reason} -> Mix.raise("failed to start :grappa — #{inspect(reason)}")
    end
  end
end
