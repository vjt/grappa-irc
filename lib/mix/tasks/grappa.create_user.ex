defmodule Mix.Tasks.Grappa.CreateUser do
  @shortdoc "Creates a Grappa user account (--name + --password, optional --admin)"

  @moduledoc """
  Operator-side user provisioning.

  ## Usage

      scripts/mix.sh grappa.create_user --name vjt --password 'correct horse battery staple'
      scripts/mix.sh grappa.create_user --name vjt --password '…' --admin

  `--name` + `--password` are required; missing either raises `KeyError`.
  `--admin` (optional) grants `is_admin` right after creation via
  `Accounts.update_admin_flags/2` — the one-command first-admin bootstrap
  (Q-FIRST-ADMIN), no `remote-shell` dance needed. The plaintext password
  is hashed with Argon2 before insertion. On success the new user's id is
  printed (with a `[admin]` marker when granted); on changeset error the
  validation errors are written to stderr and the task halts with exit
  status 1 so a wrapping shell script can detect failure.

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
    {opts, _, _} = OptionParser.parse(args, strict: [name: :string, password: :string, admin: :boolean])
    name = Keyword.fetch!(opts, :name)
    password = Keyword.fetch!(opts, :password)
    admin? = Keyword.get(opts, :admin, false)

    Boot.start_app_silent()

    with {:ok, user} <- Grappa.Accounts.create_user(%{name: name, password: password}),
         {:ok, user} <- maybe_grant_admin(user, admin?) do
      suffix = if user.is_admin, do: " [admin]", else: ""
      IO.puts("created user #{user.name} (#{user.id})#{suffix}")
    else
      {:error, changeset} -> Output.halt_changeset("creating user", changeset)
    end
  end

  # `--admin` grants the operator-authorization bit through the canonical
  # guarded path (`Accounts.update_admin_flags/2`) — promotion never trips
  # the last-admin guard, which only blocks demotion. Two clauses, no
  # default-arg footgun.
  defp maybe_grant_admin(user, false), do: {:ok, user}
  defp maybe_grant_admin(user, true), do: Grappa.Accounts.update_admin_flags(user, %{is_admin: true})
end
