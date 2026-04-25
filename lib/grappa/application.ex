defmodule Grappa.Application do
  @moduledoc false

  use Application

  @impl Application
  def start(_, _) do
    children =
      [
        Grappa.Repo,
        {Phoenix.PubSub, name: Grappa.PubSub},
        {Registry, keys: :unique, name: Grappa.SessionRegistry},
        {DynamicSupervisor, name: Grappa.SessionSupervisor, strategy: :one_for_one},
        GrappaWeb.Endpoint
      ] ++ bootstrap_child()

    opts = [strategy: :one_for_one, name: Grappa.Supervisor]
    Supervisor.start_link(children, opts)
  end

  # Bootstrap is opt-in via the `:start_bootstrap` flag (true in dev/prod,
  # false in test) so the test suite doesn't try to spawn live IRC sessions
  # against the operator's real grappa.toml when running `mix test`.
  defp bootstrap_child do
    if Application.get_env(:grappa, :start_bootstrap, true) do
      [{Grappa.Bootstrap, config_path: Application.fetch_env!(:grappa, :config_path)}]
    else
      []
    end
  end

  @impl Application
  def config_change(changed, _, removed) do
    GrappaWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
