defmodule GrappaWeb.Router do
  @moduledoc """
  Top-level router. Three pipelines:

    * `:api`     — JSON content negotiation + `X-Grappa-Client-Id`
      extraction (`GrappaWeb.Plugs.ClientId` populates
      `:current_client_id`). Applied to every JSON surface,
      authenticated or not (login is unauthenticated but still JSON,
      and admission gates need the client_id at login time too).
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
    plug GrappaWeb.Plugs.ClientId
  end

  pipeline :authn do
    plug GrappaWeb.Plugs.Authn
  end

  # Per-user iso boundary for `/networks/:network_id/...`. Resolves the
  # slug to the integer FK + asserts the authenticated user has a
  # credential for the network. Failures collapse to 404 :not_found
  # (uniform body) so a probing user cannot distinguish "wrong slug"
  # from "someone else's network." See `GrappaWeb.Plugs.ResolveNetwork`
  # moduledoc; this is the CP10 review S14 oracle close.
  pipeline :resolve_network do
    plug GrappaWeb.Plugs.ResolveNetwork
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

    get "/networks", NetworksController, :index
  end

  scope "/networks/:network_id", GrappaWeb do
    pipe_through [:api, :authn, :resolve_network]

    get "/channels", ChannelsController, :index
    post "/channels", ChannelsController, :create
    delete "/channels/:channel_id", ChannelsController, :delete
    post "/channels/:channel_id/topic", ChannelsController, :topic

    get "/channels/:channel_id/messages", MessagesController, :index
    post "/channels/:channel_id/messages", MessagesController, :create

    get "/channels/:channel_id/members", MembersController, :index

    post "/nick", NickController, :create
  end
end
