defmodule Mix.Tasks.Grappa.UpdateNetworkCredential do
  @shortdoc "Updates a per-(user, network) credential: --user --network [--nick --password --auth --autojoin --realname --sasl-user]"

  @moduledoc """
  Mutates an existing credential row. Pass only the flags you want
  to change — every other field stays at its current value. Use
  `grappa.bind_network` to create a binding; this task only updates.

  ## Usage

      scripts/mix.sh grappa.update_network_credential \\
        --user vjt --network azzurra \\
        --nick new-nick \\
        --password 'new NickServ password' \\
        --auth nickserv_identify

  `--autojoin` REPLACES the channel list (comma-separated). To keep
  the existing list, omit the flag.
  """
  use Boundary,
    top_level?: true,
    deps: [
      Grappa.Accounts,
      Grappa.Networks,
      Mix.Tasks.Grappa.Boot,
      Mix.Tasks.Grappa.OptionParsing,
      Mix.Tasks.Grappa.Output
    ]

  use Mix.Task

  alias Grappa.{Accounts, Networks}
  alias Mix.Tasks.Grappa.{Boot, OptionParsing, Output}

  @switches [
    user: :string,
    network: :string,
    nick: :string,
    password: :string,
    auth: :string,
    autojoin: :string,
    realname: :string,
    sasl_user: :string
  ]

  @impl Mix.Task
  def run(args) do
    {opts, _, _} = OptionParser.parse(args, strict: @switches)

    user_name = Keyword.fetch!(opts, :user)
    slug = Keyword.fetch!(opts, :network)

    Boot.start_app_silent()

    user = Accounts.get_user_by_name!(user_name)
    network = Networks.get_network_by_slug!(slug)

    attrs =
      opts
      |> Keyword.take([:nick, :password, :realname, :sasl_user])
      |> Map.new()
      |> maybe_put_auth(opts)
      |> maybe_put_autojoin(opts)

    case Networks.update_credential!(user, network, attrs) do
      {:ok, _} -> IO.puts("updated credential for #{user.name} on #{slug}")
      {:error, cs} -> Output.halt_changeset("updating credential", cs)
    end
  end

  defp maybe_put_auth(attrs, opts) do
    case Keyword.get(opts, :auth) do
      nil -> attrs
      str -> Map.put(attrs, :auth_method, OptionParsing.parse_auth(str))
    end
  end

  defp maybe_put_autojoin(attrs, opts) do
    case Keyword.get(opts, :autojoin) do
      nil -> attrs
      str -> Map.put(attrs, :autojoin_channels, OptionParsing.parse_autojoin(str))
    end
  end
end
