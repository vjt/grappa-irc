defmodule Mix.Tasks.Grappa.UnbindNetwork do
  @shortdoc "Unbinds a user from a network: --user --network"

  @moduledoc """
  Removes the per-(user, network) credential. If no other user has a
  credential on the same network, the network row + servers are also
  cascade-deleted (see `Grappa.Networks.Credentials.unbind_credential/2`).

  ## Usage

      scripts/mix.sh grappa.unbind_network --user vjt --network azzurra

  Idempotent: unbinding a non-existent binding still exits 0 with a
  no-op message.
  """
  use Boundary,
    top_level?: true,
    deps: [Grappa.Accounts, Grappa.Networks, Mix.Tasks.Grappa.Boot]

  use Mix.Task

  alias Grappa.{Accounts, Networks}
  alias Grappa.Networks.Credentials
  alias Mix.Tasks.Grappa.Boot

  @impl Mix.Task
  def run(args) do
    {opts, _, _} = OptionParser.parse(args, strict: [user: :string, network: :string])
    user_name = Keyword.fetch!(opts, :user)
    slug = Keyword.fetch!(opts, :network)

    Boot.start_app_silent()

    user = Accounts.get_user_by_name!(user_name)

    case Networks.get_network_by_slug(slug) do
      {:ok, network} ->
        :ok = Credentials.unbind_credential(user, network)
        IO.puts("unbound #{user.name} from #{slug}")

      {:error, :not_found} ->
        IO.puts("network #{slug} not found; nothing to unbind")
    end
  end
end
