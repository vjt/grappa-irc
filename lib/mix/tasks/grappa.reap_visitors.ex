defmodule Mix.Tasks.Grappa.ReapVisitors do
  @shortdoc "Reap visitors pinned to a given network slug"

  @moduledoc """
  Operator-side recovery — deletes every visitor row pinned to a
  given `network_slug`.

  ## Usage

      scripts/mix.sh grappa.reap_visitors --network=azzurra

  ## Why

  Used to unblock the `Grappa.Bootstrap` W7 hard-error path (Task 20):
  when an operator removes a network from the DB while visitor rows
  still point at it, `Bootstrap.run/0` raises with recovery
  instructions that point here. This task drains the orphaned rows so
  the next boot succeeds.

  CASCADE: the visitor row's deletion wipes `visitor_channels`,
  `messages`, and `accounts_sessions` in the same transaction (FK
  ON DELETE CASCADE on all three).

  ## Bootstrap suppression

  Boots with `Grappa.Bootstrap` suppressed via
  `Mix.Tasks.Grappa.Boot.start_app_silent/0` — the whole point of
  this task is recovering from a state that makes a normal boot
  raise. Without suppression the mix task could not start the app
  to do its work.
  """
  use Boundary,
    top_level?: true,
    deps: [Grappa.Visitors, Mix.Tasks.Grappa.Boot]

  use Mix.Task

  alias Grappa.Visitors
  alias Mix.Tasks.Grappa.Boot

  @impl Mix.Task
  def run(args) do
    {opts, _, _} = OptionParser.parse(args, strict: [network: :string])
    slug = opts[:network] || Mix.raise("--network=<slug> required")

    Boot.start_app_silent()

    {:ok, count} = Visitors.reap_by_network_slug(slug)

    Mix.shell().info(
      "Reaped #{count} visitor(s) pinned to '#{slug}' " <>
        "(CASCADE wiped sessions + channels + messages)."
    )
  end
end
