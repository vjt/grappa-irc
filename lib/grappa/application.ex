defmodule Grappa.Application do
  @moduledoc false

  use Application

  @impl Application
  def start(_type, _args) do
    children = [
      # Grappa.Repo,                                              # Task 2 — Ecto repo
      {Phoenix.PubSub, name: Grappa.PubSub},
      {Registry, keys: :unique, name: Grappa.SessionRegistry},
      {DynamicSupervisor, name: Grappa.SessionSupervisor, strategy: :one_for_one}
      # GrappaWeb.Endpoint,                                       # Task 4 — Phoenix HTTP+WS
      # Grappa.Bootstrap                                          # Task 8 — spawn sessions from config
    ]

    opts = [strategy: :one_for_one, name: Grappa.Supervisor]
    Supervisor.start_link(children, opts)
  end

  @impl Application
  def config_change(_changed, _new, _removed) do
    # GrappaWeb.Endpoint.config_change(changed, removed)            # Task 4 — re-enable
    :ok
  end
end
