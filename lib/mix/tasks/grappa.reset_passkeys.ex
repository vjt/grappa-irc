defmodule Mix.Tasks.Grappa.ResetPasskeys do
  @shortdoc "Resets passkeys for a locked-out account"

  @moduledoc """
  Removes all passkeys and recovery codes, restores password login, and
  revokes live sessions for one account.

      scripts/mix.sh grappa.reset_passkeys --user alice
  """
  use Boundary, top_level?: true, deps: [Grappa.Accounts, Mix.Tasks.Grappa.Boot]
  use Mix.Task

  alias Mix.Tasks.Grappa.Boot

  @impl Mix.Task
  def run(args) do
    {opts, _, _} = OptionParser.parse(args, strict: [user: :string])
    name = Keyword.fetch!(opts, :user)
    Boot.start_app_silent()

    case Grappa.Accounts.reset_passkeys(name) do
      {:ok, _} -> IO.puts("reset passkeys and sessions for #{name}")
      {:error, :not_found} -> Mix.raise("account not found: #{name}")
      {:error, :db_unavailable} -> Mix.raise("database unavailable")
    end
  end
end
