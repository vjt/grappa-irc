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

  use Boundary, top_level?: true, deps: [Grappa.Accounts]

  use Mix.Task

  @impl Mix.Task
  def run(args) do
    {opts, _, _} = OptionParser.parse(args, strict: [name: :string, password: :string])
    name = Keyword.fetch!(opts, :name)
    password = Keyword.fetch!(opts, :password)

    # Skip bootstrap: this CLI task only needs Repo + Argon2, never the
    # IRC supervision tree. Booting bootstrap would require grappa.toml
    # to be present and would open real upstream connections — neither
    # makes sense for a one-shot account-provisioning command.
    Application.put_env(:grappa, :start_bootstrap, false)
    {:ok, _} = Application.ensure_all_started(:grappa)

    case Grappa.Accounts.create_user(%{name: name, password: password}) do
      {:ok, user} ->
        IO.puts("created user #{user.name} (#{user.id})")

      {:error, changeset} ->
        IO.puts(:stderr, "error creating user: #{inspect(changeset.errors)}")
        System.halt(1)
    end
  end
end
