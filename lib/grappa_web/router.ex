defmodule GrappaWeb.Router do
  @moduledoc """
  Top-level router. Pipelines:

    * `:api`     — JSON content negotiation + `X-Grappa-Client-Id`
      extraction (`GrappaWeb.Plugs.ClientId` populates
      `:current_client_id`). Applied to every JSON surface,
      authenticated or not (login is unauthenticated but still JSON,
      and admission gates need the client_id at login time too).
    * `:authn`   — bearer-token authentication. Plugs
      `GrappaWeb.Plugs.Authn`, which assigns `:current_subject` (a
      `{:user, %User{}} | {:visitor, %Visitor{}}` tagged tuple) +
      `:current_session_id` on success and halts with a uniform 401
      JSON body on any failure mode (no header, malformed token,
      unknown / revoked / expired session).
    * `:admin`   — loopback-only gate. Used by `POST /admin/reload`
      and `POST /admin/cic-bundle-changed`; see `Plugs.LoopbackOnly`.
    * `:admin_authn` — operator-console gate (M cluster). Mounted
      downstream of `:authn`; rejects every subject shape except
      `{:user, %User{is_admin: true}}` with a uniform 403. See
      `GrappaWeb.Admin.AuthPlug`.

  Scopes:

    * `/healthz` — outside both pipelines so it answers under any
      condition (load balancers, `curl --fail`, etc.).
    * `/auth/login` — `:api` only. Credentials in, token out.
    * Resource routes (logout, `/me`, networks/channels/messages) —
      `:api` + `:authn`. Resource routes were unprotected through
      Phase 1; gating them here is the load-bearing change of
      Sub-task 2c. The plug halts the conn before the controller
      sees it, so existing controller logic is untouched.
    * `/admin/*` — split across two scopes: the loopback scope
      (`:admin`) for hot-reload + cic-bundle hooks, and the operator
      console scope (`:api + :authn + :admin_authn`) for the M
      cluster's admin surface. Routes don't collide (`/reload` +
      `/cic-bundle-changed` vs `/me` and the rest).

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

  # Admin pipeline — loopback-only gate. Used by `POST /admin/reload`
  # (CP23 cluster `code-reload` B3). Reachable from `docker exec grappa
  # curl ...` inside the container; nginx doesn't proxy `/admin/*` and
  # the compose service publishes loopback-only by default.
  pipeline :admin do
    plug :accepts, ["json", "text"]
    plug GrappaWeb.Plugs.LoopbackOnly
  end

  # Admin AUTHN pipeline — operator-surface gate. Mounted downstream of
  # `:authn` so `current_subject` is already assigned; rejects every
  # subject shape except `{:user, %User{is_admin: true}}` with a uniform
  # 403. Distinct from `:admin` (loopback-only) because the operator
  # console (M cluster) reaches over the public surface — the
  # `is_admin` bit replaces the loopback gate as the authorization
  # signal. M-cluster M-2.
  pipeline :admin_authn do
    plug GrappaWeb.Admin.AuthPlug
  end

  scope "/", GrappaWeb do
    pipe_through []

    get "/healthz", HealthController, :show
  end

  scope "/admin", GrappaWeb do
    pipe_through :admin

    post "/reload", AdminController, :reload
    post "/cic-bundle-changed", AdminController, :cic_bundle_changed
  end

  # Operator-console admin surface (M cluster). Distinct from the
  # loopback `/admin/reload` scope above: this stack is `:api + :authn +
  # :admin_authn`, so it's reachable over the public surface AND gated
  # on `current_subject = {:user, %User{is_admin: true}}`. Controllers
  # live under `GrappaWeb.Admin.*` namespace.
  scope "/admin", GrappaWeb.Admin do
    pipe_through [:api, :authn, :admin_authn]

    get "/me", MeController, :index
    get "/visitors", VisitorsController, :index
    delete "/visitors/:id", VisitorsController, :delete
    get "/sessions", SessionsController, :index
    post "/sessions/:id/disconnect", SessionsController, :disconnect
    delete "/sessions/:id", SessionsController, :delete

    # M-cluster M-5 (operator console networks pane):
    get "/networks", NetworksController, :index
    patch "/networks/:slug", NetworksController, :update
    post "/reaper/run", ReaperController, :run
    post "/circuit/:network_id/reset", CircuitController, :reset

    # M-cluster M-6 (operator console users + credentials panes):
    get "/users", UsersController, :index
    patch "/users/:id", UsersController, :update
    get "/credentials", CredentialsController, :index
    patch "/credentials/:user_id/:network_id", CredentialsController, :update
  end

  scope "/auth", GrappaWeb do
    pipe_through :api

    post "/login", AuthController, :login
  end

  # VAPID public key — push notifications cluster B2 (2026-05-14).
  # Unauthenticated by design: cic SW registers a PushSubscription
  # before user-session login, and the key is non-secret per W3C
  # Push spec (`applicationServerKey` is published material). The
  # downstream POST /push/subscriptions IS authenticated and binds
  # the subscription to the operator's user.
  scope "/push", GrappaWeb do
    pipe_through :api

    get "/vapid-public-key", PushVapidController, :show
  end

  scope "/", GrappaWeb do
    pipe_through [:api, :authn]

    delete "/auth/logout", AuthController, :logout
    get "/me", MeController, :show

    # Per-user settings — push notifications cluster B3 (2026-05-14).
    # First exposed accessor: notification_prefs. User-only (visitors
    # get :forbidden inside the controller); persists into the existing
    # `user_settings.data` JSON column via Grappa.UserSettings typed
    # accessors. Future per-key accessors plug in here as additional
    # routes, not by widening /me.
    get "/me/settings/notification-prefs", UserSettingsController, :show_notification_prefs
    put "/me/settings/notification-prefs", UserSettingsController, :update_notification_prefs

    get "/networks", NetworksController, :index

    # Push notifications cluster B1 (2026-05-14) — Web Push
    # subscription registry. User-only (visitors get :forbidden inside
    # the controller per the visitor-gating boundary). Powers the cic
    # PWA's notification opt-in dance: SW.pushManager.subscribe →
    # POST here → server stores endpoint+keys for B2's Push.Sender.
    get "/push/subscriptions", PushSubscriptionController, :index
    post "/push/subscriptions", PushSubscriptionController, :create
    delete "/push/subscriptions/:id", PushSubscriptionController, :delete
  end

  scope "/networks/:network_id", GrappaWeb do
    pipe_through [:api, :authn, :resolve_network]

    patch "/", NetworksController, :update

    get "/channels", ChannelsController, :index
    post "/channels", ChannelsController, :create
    delete "/channels/:channel_id", ChannelsController, :delete
    post "/channels/:channel_id/topic", ChannelsController, :topic

    get "/channels/:channel_id/messages", MessagesController, :index
    post "/channels/:channel_id/messages", MessagesController, :create

    post "/channels/:channel_id/read-cursor", ReadCursorController, :create

    get "/channels/:channel_id/members", MembersController, :index

    get "/archive", ArchiveController, :index
    delete "/archive/:target", ArchiveController, :delete

    post "/nick", NickController, :create
  end
end
