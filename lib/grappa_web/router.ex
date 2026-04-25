defmodule GrappaWeb.Router do
  @moduledoc """
  Top-level router. Two scopes today:

    * `/` (no pipeline) — operator-facing endpoints that must answer
      under any condition (`/healthz`). Skipping `:api` keeps the
      response a plain `text/plain` so it round-trips cleanly through
      load balancers and `curl --fail`.
    * `/` (`:api`) — JSON resources. Phase 1 messages resource
      (`GET` + `POST` on the same nested path).

  WebSocket mount (`socket "/socket", GrappaWeb.UserSocket`) lands in
  the Endpoint, not here, when Task 7 wires Phoenix Channels.
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

    get "/networks/:network_id/channels/:channel_id/messages",
        MessagesController,
        :index

    post "/networks/:network_id/channels/:channel_id/messages",
         MessagesController,
         :create
  end
end
