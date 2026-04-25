defmodule GrappaWeb.Router do
  @moduledoc """
  Top-level router. Two scopes today:

    * `/` (no pipeline) — operator-facing endpoints that must answer
      under any condition (`/healthz`). Skipping `:api` keeps the
      response a plain `text/plain` so it round-trips cleanly through
      load balancers and `curl --fail`.
    * `/` (`:api`) — JSON resources. Routes land here in Task 5+.

  WebSocket mount (`socket "/socket", GrappaWeb.UserSocket`) lands in
  the Endpoint, not here, when Task 6 wires Phoenix Channels.
  """
  use GrappaWeb, :router

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/", GrappaWeb do
    pipe_through []

    get "/healthz", HealthController, :show
  end

  scope "/", GrappaWeb do
    pipe_through :api
    # Routes added in Task 5+.
  end
end
