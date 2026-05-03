defmodule Mix.Tasks.Grappa.SetNetworkCaps do
  @shortdoc "Sets admission caps on a network: --network --max-sessions [N] --max-per-client [N]"

  @moduledoc """
  Operator-side admission-cap binding. Updates `max_concurrent_sessions`
  and/or `max_per_client` on a network row.

  ## Usage

      scripts/mix.sh grappa.set_network_caps \\
        --network azzurra \\
        --max-sessions 3 \\
        --max-per-client 1

  At least one of `--max-sessions` or `--max-per-client` is required.
  Pass only the flag(s) you want to change — the unsupplied cap stays
  at its current value. Both caps must be positive integers (the
  schema's `validate_number(greater_than: 0)` rule rejects zero or
  negative values).

  ## In production

  This Mix task is a dev-DB convenience. The prod release ships
  without `mix`; bind caps against `runtime/grappa_prod.db` from a
  remote shell:

      docker compose -f compose.prod.yaml exec grappa \\
        bin/grappa rpc 'Grappa.Networks.update_network_caps( \\
          Grappa.Networks.get_network_by_slug!("azzurra"), \\
          %{max_concurrent_sessions: 3, max_per_client: 1})'

  Both paths route through the same `Grappa.Networks.update_network_caps/2`
  context fn so the validation contract is single-sourced.
  """
  use Boundary,
    top_level?: true,
    deps: [
      Grappa.Networks,
      Mix.Tasks.Grappa.Boot,
      Mix.Tasks.Grappa.Output
    ]

  use Mix.Task

  alias Grappa.Networks
  alias Mix.Tasks.Grappa.{Boot, Output}

  @switches [
    network: :string,
    max_sessions: :integer,
    max_per_client: :integer
  ]

  @impl Mix.Task
  def run(args) do
    {opts, _, _} = OptionParser.parse(args, strict: @switches)

    slug = Keyword.fetch!(opts, :network)

    attrs =
      opts
      |> Keyword.take([:max_sessions, :max_per_client])
      |> Enum.map(fn
        {:max_sessions, v} -> {:max_concurrent_sessions, v}
        {:max_per_client, v} -> {:max_per_client, v}
      end)
      |> Map.new()

    if map_size(attrs) == 0 do
      Mix.raise("at least one of --max-sessions or --max-per-client is required")
    end

    Boot.start_app_silent()

    network = Networks.get_network_by_slug!(slug)

    case Networks.update_network_caps(network, attrs) do
      {:ok, updated} ->
        IO.puts(
          "set caps on #{updated.slug}: " <>
            "max_concurrent_sessions=#{inspect(updated.max_concurrent_sessions)} " <>
            "max_per_client=#{inspect(updated.max_per_client)}"
        )

      {:error, cs} ->
        Output.halt_changeset("setting network caps", cs)
    end
  end
end
