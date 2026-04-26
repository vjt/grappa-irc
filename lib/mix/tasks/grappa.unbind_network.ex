defmodule Mix.Tasks.Grappa.UnbindNetwork do
  @shortdoc "Unbinds a user from a network: --user --network"

  @moduledoc """
  Removes the per-(user, network) credential. If no other user has a
  credential on the same network, the network row + servers are also
  cascade-deleted (see `Grappa.Networks.unbind_credential/2`).

  ## Usage

      scripts/mix.sh grappa.unbind_network --user vjt --network azzurra

  Idempotent: unbinding a non-existent binding still exits 0 with a
  no-op message.
  """
  use Boundary, top_level?: true, deps: [Grappa.Accounts, Grappa.Networks, Grappa.Repo]

  use Mix.Task

  alias Grappa.{Accounts, Networks, Repo}
  alias Grappa.Networks.Network

  @impl Mix.Task
  def run(args) do
    {opts, _, _} = OptionParser.parse(args, strict: [user: :string, network: :string])
    user_name = Keyword.fetch!(opts, :user)
    slug = Keyword.fetch!(opts, :network)

    Application.put_env(:grappa, :start_bootstrap, false)
    {:ok, _} = Application.ensure_all_started(:grappa)

    user = Accounts.get_user_by_name!(user_name)

    case Repo.get_by(Network, slug: slug) do
      %Network{} = network ->
        :ok = Networks.unbind_credential(user, network)
        IO.puts("unbound #{user.name} from #{slug}")

      nil ->
        IO.puts("network #{slug} not found; nothing to unbind")
    end
  end
end
