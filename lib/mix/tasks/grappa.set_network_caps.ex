defmodule Mix.Tasks.Grappa.SetNetworkCaps do
  @shortdoc "Sets / clears admission caps on a network: --network --max-sessions [N] --max-per-client [N] --clear-max-sessions --clear-max-per-client"

  @moduledoc """
  Operator-side admission-cap binding. Updates `max_concurrent_sessions`
  and/or `max_per_client` on a network row.

  ## Usage

      scripts/mix.sh grappa.set_network_caps \\
        --network azzurra \\
        --max-sessions 3 \\
        --max-per-client 1

  At least one of `--max-sessions`, `--max-per-client`,
  `--clear-max-sessions`, or `--clear-max-per-client` is required.
  Pass only the flag(s) you want to change — the unsupplied cap stays
  at its current value.

  ## Three-valued cap contract (decision F, B5.3)

    * `--max-sessions N` / `--max-per-client N` with `N >= 0` sets
      the cap. `N == 0` is a degenerate lock-down (allow none).
    * `--clear-max-sessions` / `--clear-max-per-client` clears the
      cap (the column becomes `NULL`, meaning "unlimited").
    * `--max-*` and `--clear-max-*` for the same cap are mutually
      exclusive — passing both raises `Mix.Error`.

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
    max_per_client: :integer,
    clear_max_sessions: :boolean,
    clear_max_per_client: :boolean
  ]

  @impl Mix.Task
  def run(args) do
    {opts, _, _} = OptionParser.parse(args, strict: @switches)

    validate_mutual_exclusion!(opts)
    attrs = build_attrs(opts)
    validate_non_empty!(attrs)
    slug = fetch_slug!(opts)

    Boot.start_app_silent()

    network = fetch_network!(slug)

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

  defp validate_mutual_exclusion!(opts) do
    if opts[:max_sessions] && opts[:clear_max_sessions] do
      Mix.raise("--clear-max-sessions and --max-sessions are mutually exclusive")
    end

    if opts[:max_per_client] && opts[:clear_max_per_client] do
      Mix.raise("--clear-max-per-client and --max-per-client are mutually exclusive")
    end
  end

  defp validate_non_empty!(attrs) when map_size(attrs) > 0, do: :ok

  defp validate_non_empty!(_) do
    Mix.raise(
      "no changes specified — pass at least one of --max-sessions, --max-per-client, --clear-max-sessions, --clear-max-per-client"
    )
  end

  defp fetch_slug!(opts) do
    Keyword.get(opts, :network) || Mix.raise("--network <slug> is required")
  end

  defp fetch_network!(slug) do
    case Networks.get_network_by_slug(slug) do
      {:ok, net} -> net
      {:error, :not_found} -> Mix.raise("network #{inspect(slug)} not found")
    end
  end

  defp build_attrs(opts) do
    %{}
    |> maybe_put(:max_concurrent_sessions, opts[:max_sessions])
    |> maybe_put_clear(:max_concurrent_sessions, opts[:clear_max_sessions])
    |> maybe_put(:max_per_client, opts[:max_per_client])
    |> maybe_put_clear(:max_per_client, opts[:clear_max_per_client])
  end

  defp maybe_put(map, _, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp maybe_put_clear(map, _, nil), do: map
  defp maybe_put_clear(map, _, false), do: map
  defp maybe_put_clear(map, key, true), do: Map.put(map, key, nil)
end
