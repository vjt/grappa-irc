defmodule GrappaWeb.Router do
  @moduledoc """
  Top-level router. Three pipelines:

    * `:api`     — JSON content negotiation. Applied to every JSON
      surface, authenticated or not (login is unauthenticated but
      still JSON).
    * `:authn`   — bearer-token authentication. Plugs
      `GrappaWeb.Plugs.Authn`, which assigns `:current_user_id` +
      `:current_session_id` on success and halts with a uniform 401
      JSON body on any failure mode (no header, malformed token,
      unknown / revoked / expired session).

  Scopes:

    * `/healthz` — outside both pipelines so it answers under any
      condition (load balancers, `curl --fail`, etc.).
    * `/auth/login` — `:api` only. Credentials in, token out.
    * Everything else (logout, `/me`, networks/channels/messages) —
      `:api` + `:authn`. Resource routes were unprotected through
      Phase 1; gating them here is the load-bearing change of
      Sub-task 2c. The plug halts the conn before the controller
      sees it, so existing controller logic is untouched.

  WebSocket mount (`socket "/socket", GrappaWeb.UserSocket`) lands in
  the Endpoint, not here. Channels do their own auth in
  `UserSocket.connect/3` — this router is HTTP-only.
  """
  use GrappaWeb, :router

  pipeline :api do
    plug :accepts, ["json"]
  end

  pipeline :authn do
    plug GrappaWeb.Plugs.Authn
  end

  scope "/", GrappaWeb do
    pipe_through []

    get "/healthz", HealthController, :show
  end

  scope "/auth", GrappaWeb do
    pipe_through :api

    post "/login", AuthController, :login
  end

  scope "/", GrappaWeb do
    pipe_through [:api, :authn]

    delete "/auth/logout", AuthController, :logout
    get "/me", MeController, :show

    get "/networks/:network_id/channels/:channel_id/messages",
        MessagesController,
        :index

    post "/networks/:network_id/channels/:channel_id/messages",
         MessagesController,
         :create

    post "/networks/:network_id/channels", ChannelsController, :create
    delete "/networks/:network_id/channels/:channel_id", ChannelsController, :delete
  end
end
