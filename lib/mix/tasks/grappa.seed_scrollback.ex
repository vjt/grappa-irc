defmodule Mix.Tasks.Grappa.SeedScrollback do
  @shortdoc "Seeds N synthetic scrollback rows on (user, network, channel) for e2e overflow tests"

  @moduledoc """
  E2e fixture verb. Persists N `:privmsg` rows on
  `(user, network, channel)` via `Grappa.Scrollback.persist_event/1` so
  scrollback tests have a deterministic, sufficiently-tall pane to
  exercise scroll behavior (initial scroll-to-marker / scroll-to-bottom,
  loadMore on scroll-up, etc.) without driving an IRC peer through
  bahamut-test (whose fakelag throttle makes >5-msg seeds non-
  deterministic).

  ## Usage

      scripts/mix.sh grappa.seed_scrollback \\
        --user vjt --network bahamut-test --channel '#bofh' \\
        --count 100 --sender seed-bot

  All flags required. `--count` is a positive integer; >2000 is
  refused (e2e specs don't need more than that, and the cost stops
  being trivial). `--sender` is the synthetic peer nick that appears
  on every row.

  Each row's `server_time` is monotonically increasing from
  `now - count * 100ms` so the rows sort naturally and span a
  determinable timeline a test can place a read cursor inside.

  e2e-only: this task takes no production input. Wired through the
  `grappa-e2e-seeder` sidecar in `cicchetto/e2e/compose.yaml` AFTER
  the user + network bind has run.
  """
  use Boundary,
    top_level?: true,
    deps: [
      Grappa.Accounts,
      Grappa.Networks,
      Grappa.Scrollback,
      Mix.Tasks.Grappa.Boot,
      Mix.Tasks.Grappa.Output
    ]

  use Mix.Task

  alias Grappa.{Accounts, Networks, Scrollback}
  alias Mix.Tasks.Grappa.{Boot, Output}

  @switches [
    user: :string,
    network: :string,
    channel: :string,
    count: :integer,
    sender: :string
  ]

  @max_count 2_000
  @gap_ms 100

  @impl Mix.Task
  def run(args) do
    {opts, _, _} = OptionParser.parse(args, strict: @switches)
    user_name = Keyword.fetch!(opts, :user)
    network_slug = Keyword.fetch!(opts, :network)
    channel = Keyword.fetch!(opts, :channel)
    count = Keyword.fetch!(opts, :count)
    sender = Keyword.fetch!(opts, :sender)

    if count <= 0 or count > @max_count do
      Mix.raise("--count must be 1..#{@max_count}, got #{count}")
    end

    Boot.start_app_silent()

    user = Accounts.get_user_by_name!(user_name)
    network = Networks.get_network_by_slug!(network_slug)

    base_time = System.system_time(:millisecond) - count * @gap_ms

    Enum.each(1..count, fn i ->
      attrs = %{
        user_id: user.id,
        network_id: network.id,
        channel: channel,
        server_time: base_time + i * @gap_ms,
        kind: :privmsg,
        sender: sender,
        body: "seed line ##{i}",
        meta: %{}
      }

      case Scrollback.persist_event(attrs) do
        {:ok, _} -> :ok
        {:error, changeset} -> Output.halt_changeset("seeding row ##{i}", changeset)
      end
    end)

    IO.puts("seeded #{count} rows on user=#{user_name} network=#{network_slug} channel=#{channel} sender=#{sender}")
  end
end
