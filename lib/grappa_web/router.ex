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
    # Admin-panel bucket 1 (2026-05-31) — strict-create + delete + server CRUD.
    post "/networks", NetworksController, :create
    delete "/networks/:id", NetworksController, :delete
    get "/networks/:network_id/servers", ServersController, :index
    post "/networks/:network_id/servers", ServersController, :create
    put "/networks/:network_id/servers/:id", ServersController, :update
    delete "/networks/:network_id/servers/:id", ServersController, :delete
    # #85 — operator-curated featured channels per network. Rides the
    # `networks` admin nginx allowlist alt (no nginx change).
    get "/networks/:network_id/featured_channels", FeaturedChannelsController, :index
    post "/networks/:network_id/featured_channels", FeaturedChannelsController, :create
    put "/networks/:network_id/featured_channels/:id", FeaturedChannelsController, :update
    delete "/networks/:network_id/featured_channels/:id", FeaturedChannelsController, :delete
    post "/reaper/run", ReaperController, :run
    post "/circuit/:network_id/reset", CircuitController, :reset

    # M-cluster M-6 (operator console users + credentials panes):
    get "/users", UsersController, :index
    patch "/users/:id", UsersController, :update
    # Admin-panel bucket 2 (2026-05-31): user CRUD + dedicated
    # password rotation endpoint (split from PATCH so the is_admin
    # toggle and password rotation stay independent verbs).
    post "/users", UsersController, :create
    delete "/users/:id", UsersController, :delete
    put "/users/:id/password", UsersController, :update_password
    get "/credentials", CredentialsController, :index
    patch "/credentials/:user_id/:network_id", CredentialsController, :update
    # Admin-panel bucket 3 (2026-05-31): credential bind / unbind via REST.
    post "/credentials", CredentialsController, :create
    delete "/credentials/:user_id/:network_id", CredentialsController, :delete

    # UX-6-B1 (2026-05-20): admin server-settings + uploads registry.
    # Settings cover the embedded image uploader (active_host pick +
    # per-file cap + global cap); uploads list/delete give the
    # operator disk-budget visibility + emergency removal.
    get "/settings", SettingsController, :index
    put "/settings", SettingsController, :update
    get "/uploads", UploadsController, :index
    delete "/uploads/:id", UploadsController, :delete

    # #215 — persisted IRC session-lifecycle log (read-only tail).
    get "/session_log", SessionLogController, :index

    # #228 — vhost (source-bind) inventory + per-subject grants.
    get "/vhosts", VhostsController, :index
    # #257 — subject autocomplete backing the grant form (users + visitors).
    # Read-only; nests under `vhosts` so it rides the existing nginx
    # allowlist alt (no proxy change). No `GET /vhosts/:id` route exists, so
    # `/vhosts/subject_search` is unambiguous.
    get "/vhosts/subject_search", VhostsController, :subject_search
    post "/vhosts", VhostsController, :create
    patch "/vhosts/:id", VhostsController, :update
    delete "/vhosts/:id", VhostsController, :delete
    post "/vhosts/:id/grants", VhostsController, :grant
    delete "/vhosts/grants/:grant_id", VhostsController, :revoke
  end

  # E2E-ROBUSTNESS bucket D — test-only subject reset surface.
  # Compile-gated to dev/test Mix env. Prod release literally does
  # not contain the route (the if-block returns nil at compile time
  # so Phoenix's router macro never registers it).
  if Mix.env() in [:dev, :test] do
    scope "/admin/test", GrappaWeb.Admin do
      pipe_through [:api, :authn, :admin_authn]
      post "/reset-subject", TestResetSubjectController, :reset
    end
  end

  scope "/auth", GrappaWeb do
    pipe_through :api

    post "/login", AuthController, :login
    # Visitor session-sharing consume — unauthenticated by design. The
    # signed one-shot token IS the auth credential. Verified +
    # one-shot-checked + visitor-existence-checked inside the
    # controller; failure modes collapse via FallbackController to
    # 400 / 401 / 404 / 410.
    post "/share/consume", ShareTokenController, :consume
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

    # #211 phase 4c — visitor multi-network ACCRETION: attach an additional
    # visitor_enabled network to the authenticated identity + spawn it.
    # Phase 6 (ruling C) relaxed the gate to any visitor (anon OR
    # registered) — the home-page "connect available network" affordance
    # drives it, still bounded by the visitor_enabled allowlist + per-IP
    # cap. Rides the existing `/session/` nginx allowlist entry (both :80
    # and :443) — no proxy change.
    #
    # #211 phase 6 — the #126 `POST /session/{disconnect,reconnect}` pair
    # is RETIRED. Visitors carry a real per-network connection_state now
    # (ruling D), so they park/reconnect via `PATCH /networks/:network_id`
    # like users; global disconnect-all is client-composed park-all.
    post "/session/networks", SessionController, :add_network

    get "/me", MeController, :show

    # #157 — self-service account deletion: an explicit, IRREVERSIBLE
    # total wipe of the caller's OWN account + all state. Subject-routed
    # (user / visitor) in `Grappa.AccountDeletion`; admins + anon visitors
    # 403 (not offered self-delete). `/me` already rides the nginx
    # allowlist + the SW navigation denylist, so no proxy/SW change.
    delete "/me", MeController, :delete

    # Per-user settings — push notifications cluster B3 (2026-05-14).
    # Visitor-parity V4 (2026-05-15) lifted the user-only gate; both
    # registered users + visitors hit these endpoints. Persists into
    # the existing `user_settings.data` JSON column via
    # `Grappa.UserSettings` typed accessors. Future per-key accessors
    # plug in here as additional routes, not by widening /me.
    get "/me/settings/notification-prefs", UserSettingsController, :show_notification_prefs
    put "/me/settings/notification-prefs", UserSettingsController, :update_notification_prefs

    # UX-4 bucket M (2026-05-19) — image-upload TTL preference. Server
    # stores integer seconds; cic translates to/from the active host's
    # ttlOption tokens. `null` body / `null` response = "use the active
    # host's defaultTtl" sentinel. Per-key accessor lives in
    # `Grappa.UserSettings.{get,put}_upload_ttl_seconds`.
    get "/me/settings/upload-ttl-seconds", UserSettingsController, :show_upload_ttl_seconds
    put "/me/settings/upload-ttl-seconds", UserSettingsController, :update_upload_ttl_seconds

    # #228 — per-subject vhost (source-bind) self-selection. GET returns
    # the allowed set (generally-available ∪ granted) + current selection
    # + pin; PUT persists a selection authz-clamped to the allowed set.
    # Rides the existing `/me` nginx allowlist (no proxy change).
    get "/me/settings/vhost", UserSettingsController, :show_vhost
    put "/me/settings/vhost", UserSettingsController, :update_vhost

    # Visitor session-sharing mint — visitor-only (users get 403).
    # Returns a short-TTL Phoenix-signed token + ISO8601 expires_at.
    # The cic SPA wraps the token in a shareable URL; the consume
    # endpoint lives under /auth above (unauthenticated by design).
    post "/me/share-token", ShareTokenController, :mint

    get "/networks", NetworksController, :index

    # Push notifications cluster B1 (2026-05-14) — Web Push
    # subscription registry. User-only (visitors get :forbidden inside
    # the controller per the visitor-gating boundary). Powers the cic
    # PWA's notification opt-in dance: SW.pushManager.subscribe →
    # POST here → server stores endpoint+keys for B2's Push.Sender.
    get "/push/subscriptions", PushSubscriptionController, :index
    post "/push/subscriptions", PushSubscriptionController, :create
    delete "/push/subscriptions/:id", PushSubscriptionController, :delete

    # UX-6-B1 (2026-05-20): embedded image uploader — authenticated
    # POST + operator-visible settings snapshot. Visitor OR user
    # subject can upload; the cic ComposeBox triggers this from the
    # same picker/drag-drop/paste paths as litterbox.
    post "/api/uploads", UploadsController, :create
    get "/api/server-settings", ServerSettingsController, :show
  end

  # UX-6-B1 (2026-05-20): public file-fetch surface for embedded
  # uploads. NO `:authn` — the 26-char base32 slug carries 128 bits of
  # entropy and IS the access token (same model as litterbox.catbox.moe
  # public URLs). Slug-shape validation + soft-delete + expiry checks
  # collapse every miss to a uniform 404 with no oracle. Lives at
  # the top level (not `/api/`) so the URL is short + clean for
  # PRIVMSG bodies (`📸 https://host/uploads/<slug>`).
  scope "/", GrappaWeb do
    pipe_through [:api]

    get "/uploads/:slug", UploadsController, :show
  end

  scope "/networks/:network_id", GrappaWeb do
    pipe_through [:api, :authn, :resolve_network]

    patch "/", NetworksController, :update

    # #211 phase 6 (ruling E, subsumes original #211) — per-network IRC
    # identity edit (nick/ident/realname) for BOTH subjects, live-applied
    # via internal reconnect. Rides the `/networks/:network_id`
    # ResolveNetwork pipeline (ownership built-in) + the `networks` nginx
    # allowlist — no proxy change.
    patch "/identity", NetworksController, :identity

    get "/channels", ChannelsController, :index
    post "/channels", ChannelsController, :create
    delete "/channels/:channel_id", ChannelsController, :delete
    post "/channels/:channel_id/topic", ChannelsController, :topic

    get "/directory", DirectoryController, :index
    post "/directory/refresh", DirectoryController, :refresh

    # #85 — on-display read of operator-curated featured channels.
    get "/featured", FeaturedController, :index

    get "/channels/:channel_id/messages", MessagesController, :index
    post "/channels/:channel_id/messages", MessagesController, :create

    post "/channels/:channel_id/read-cursor", ReadCursorController, :create

    get "/channels/:channel_id/members", MembersController, :index

    get "/archive", ArchiveController, :index
    delete "/archive/:target", ArchiveController, :delete

    post "/nick", NickController, :create
  end

  # Test-only FORCE read-cursor surface. Compile-gated to dev/test Mix
  # env — the prod release literally does not contain the route (the
  # if-block returns nil at compile time so Phoenix's router macro never
  # registers it), same pattern as the reset-subject surface above.
  #
  # #233 made the production `POST .../read-cursor` advance-only. The e2e
  # cursor/divider/scroll specs must plant a mid-page (backward) cursor
  # to stage an unread-divider scenario, which `set/4` now correctly
  # refuses — so this sibling routes through `ReadCursor.force_set/4`
  # (bypasses the monotonic clamp) via `TestReadCursorController`. Same
  # `[:api, :authn, :resolve_network]` pipeline as the real route so the
  # specs keep seeding with the seeded user's own token.
  if Mix.env() in [:dev, :test] do
    scope "/networks/:network_id", GrappaWeb do
      pipe_through [:api, :authn, :resolve_network]

      post "/channels/:channel_id/read-cursor/force", TestReadCursorController, :force
    end
  end
end
