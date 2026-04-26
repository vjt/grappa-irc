defmodule Mix.Tasks.Grappa.CreateUser do
  @shortdoc "Creates a Grappa user account from --name + --password"

  @moduledoc """
  Operator-side user provisioning.

  ## Usage

      scripts/mix.sh grappa.create_user --name vjt --password 'correct horse battery staple'

  Both flags are required; missing one raises `KeyError`. The plaintext
  password is hashed with Argon2 before insertion. On success the new
  user's id is printed; on changeset error the validation errors are
  written to stderr and the task halts with exit status 1 so a wrapping
  shell script can detect failure.

  Mix tasks declare their own top-level Boundary (every module must),
  with `Grappa.Accounts` as the only inbound dep — this task is a
  shell-driven CLI surface, not a runtime caller of anything else.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Accounts, Mix.Tasks.Grappa.Boot, Mix.Tasks.Grappa.Output]

  use Mix.Task

  alias Mix.Tasks.Grappa.{Boot, Output}

  @impl Mix.Task
  def run(args) do
    {opts, _, _} = OptionParser.parse(args, strict: [name: :string, password: :string])
    name = Keyword.fetch!(opts, :name)
    password = Keyword.fetch!(opts, :password)

    Boot.start_app_silent()

    case Grappa.Accounts.create_user(%{name: name, password: password}) do
      {:ok, user} -> IO.puts("created user #{user.name} (#{user.id})")
      {:error, changeset} -> Output.halt_changeset("creating user", changeset)
    end
  end
end
