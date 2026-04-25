defmodule Grappa.Application do
  @moduledoc false

  use Application

  @impl Application
  def start(_, _) do
    children = [
      Grappa.Repo,
      {Phoenix.PubSub, name: Grappa.PubSub},
      {Registry, keys: :unique, name: Grappa.SessionRegistry},
      {DynamicSupervisor, name: Grappa.SessionSupervisor, strategy: :one_for_one},
      GrappaWeb.Endpoint
      # Grappa.Bootstrap                                          # Task 8 — spawn sessions from config
    ]

    opts = [strategy: :one_for_one, name: Grappa.Supervisor]
    Supervisor.start_link(children, opts)
  end

  @impl Application
  def config_change(changed, _, removed) do
    GrappaWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
