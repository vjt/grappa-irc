defmodule GrappaWeb.RouterScopeTest do
  @moduledoc """
  GH #1196 — a router-table invariant, not a route test.

  The scope gate is mounted per pipeline, so a credential-management
  route declared inside the right block inherits it automatically. The
  hazard is the route declared in the WRONG block: it authenticates, it
  works, and it is silently reachable by a per-client token. Nothing
  about it looks wrong at the call site.

  So this enumerates the compiled route table and actually DRIVES every
  route with a client-token bearer, asserting the scope refusal each
  time. Exercising beats introspecting the pipelines: it survives a plug
  being moved between pipelines, and it fails on the thing that matters
  — the response — rather than on a spelling.

  ## The invariant is stated as an ALLOWLIST (#1353)

  It used to run the other way round: a hand-maintained list of
  credential-looking path PREFIXES was driven, and everything else was
  left alone. That direction fails OPEN — a route the prefixes do not
  describe is not asserted about at all, and the invariant passes
  vacuously over it while looking exhaustive.

  This runs from the complement instead. `@client_usable_*` names what a
  per-client token is FOR — reading, sending, and configuring the
  connection it reads and sends on — plus `@unauthenticated_*` for the
  routes that carry no bearer gate at all. **Every other route in the
  table must answer `403 client_token_scope`.** A new route is therefore
  refused by default and joining either list is a deliberate act, which
  is the review moment that should exist.

  Prefix vs exact is chosen per family, not for brevity:

    * resource families whose whole point is "use the account"
      (`/networks/...`, `/themes/...`, the push subscriptions) are
      prefix-listed, so a sibling verb added later inherits;
    * `/me` is exact-listed to the last route, because that namespace
      is MIXED — the account's settings live next to the account's
      credentials, so nothing there may be inherited by prefix.

  The bearer belongs to an ADMIN account on purpose. A non-admin would
  be refused by `GrappaWeb.Admin.AuthPlug` first, and every `/admin` arm
  would pass for the wrong reason; requiring the body to be exactly
  `client_token_scope` is what keeps the admin arms honest.
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Accounts

  # Resource families a per-client token may reach in full. Prefix-
  # matched: a verb added to one of these families is, by the family's
  # definition, another way to use the account rather than to change it.
  #
  # `/networks` carries the per-network connection settings —
  # `/identity`, `/perform`, `/password` (the upstream services secret,
  # not the account password). They are deliberately IN this list: they
  # configure the upstream connection a headless client exists to hold
  # open, and #1196 shipped them reachable. Named here rather than left
  # implicit so that moving them behind the full-session gate is a
  # decision someone takes, not a default someone inherits.
  @client_usable_prefixes [
    "/networks",
    "/themes",
    "/push/subscriptions",
    "/session/networks",
    "/api/uploads",
    "/api/server-settings"
  ]

  # The `/me` namespace, one route at a time — it holds the account's
  # settings AND the account's credentials, so no prefix may stand in
  # for it. Everything under `/me` that is not here must answer the
  # scope refusal.
  @client_usable_routes [
    {"DELETE", "/auth/logout"},
    # #1679 — the boot envelope. Client-usable by the same reasoning as
    # `GET /me` and the `/networks` prefix it is assembled from: it is the
    # read a client performs to know what it is connected to, and refusing
    # it to a headless client would leave that client on the per-network
    # fan-out the endpoint exists to remove. It carries no credential and
    # no setting — networks, channel names, and message rows the same
    # client can already fetch one at a time.
    {"GET", "/boot"},
    {"GET", "/me"},
    {"GET", "/me/theme"},
    {"PUT", "/me/theme"},
    # The owned-library listing. It reads as part of the `/themes`
    # family but is spelled under `/me`, so the prefix does not reach
    # it — which is the whole reason `/me` is enumerated.
    {"GET", "/me/themes"},
    {"GET", "/me/settings/notification-prefs"},
    {"PUT", "/me/settings/notification-prefs"},
    {"GET", "/me/settings/upload-ttl-seconds"},
    {"PUT", "/me/settings/upload-ttl-seconds"},
    # #1883 — the pre-upload confirm opt-in. Client-usable for the same
    # reason its upload-retention sibling above is: it configures how this
    # client SENDS, not who the account is, and a headless client that can
    # upload has every business deciding whether it is asked first. It
    # changes no credential and reveals nothing about the account.
    {"GET", "/me/settings/upload-confirm-enabled"},
    {"PUT", "/me/settings/upload-confirm-enabled"},
    {"GET", "/me/settings/auto-away-debounce-seconds"},
    {"PUT", "/me/settings/auto-away-debounce-seconds"},
    {"GET", "/me/settings/vhost"},
    {"PUT", "/me/settings/vhost"},
    {"GET", "/me/settings/aliases"},
    {"PUT", "/me/settings/aliases"},
    {"GET", "/me/settings/display-prefs"},
    {"PUT", "/me/settings/display-prefs"},
    # M2 — the peer-profile opt-in. Client-usable by the same reasoning as
    # `display-prefs` above: it is a per-subject switch over what the
    # connection this client reads on may ASK other users, not a
    # credential and not an account-management verb. It carries no
    # secret, and refusing it would leave a headless client unable to
    # tell whether the badges it renders are even being populated.
    {"GET", "/me/settings/show-peer-profiles"},
    {"PUT", "/me/settings/show-peer-profiles"}
  ]

  # Routes with no bearer gate at all — the login doors, the public
  # discovery endpoints, the upload GET and the SPA shell. They cannot
  # answer `client_token_scope` because nothing there reads a session,
  # so they are excluded by name rather than by hopeful pattern.
  @unauthenticated_routes [
    {"GET", "/healthz"},
    {"POST", "/auth/login"},
    {"POST", "/auth/totp/verify"},
    {"POST", "/auth/passkeys/options"},
    {"POST", "/auth/passkeys/verify"},
    {"POST", "/auth/passkeys/second-factor"},
    {"POST", "/auth/passkeys/recover"},
    {"POST", "/auth/share/consume"},
    {"GET", "/push/vapid-public-key"},
    {"GET", "/api/config"},
    {"GET", "/uploads/:slug"},
    {"GET", "/service-worker.js"},
    {"GET", "/*path"}
  ]

  # The loopback `/admin` scope (`POST /admin/reload`,
  # `/admin/cic-bundle-changed`) carries no bearer at all: it is gated on
  # the transport peer by `GrappaWeb.Plugs.LoopbackOnly`, so there is no
  # session whose kind could be checked, and driving it here would run a
  # real code reload. Identified by its controller — the loopback scope
  # routes to `GrappaWeb.AdminController`, the operator console to
  # `GrappaWeb.Admin.*` — so a console route can never fall into the
  # exclusion by being named `/admin/something`.
  @loopback_plug GrappaWeb.AdminController

  defp method(%{verb: verb}), do: verb |> Atom.to_string() |> String.upcase()

  defp client_usable?(%{path: path} = route) do
    Enum.any?(@client_usable_prefixes, &String.starts_with?(path, &1)) or
      {method(route), path} in @client_usable_routes
  end

  defp unauthenticated?(route), do: {method(route), route.path} in @unauthenticated_routes

  # The complement: everything the two lists above do not name.
  defp gated_routes do
    Enum.reject(
      GrappaWeb.Router.__routes__(),
      &(client_usable?(&1) or unauthenticated?(&1) or &1.plug == @loopback_plug)
    )
  end

  # `:id` / `:handle` / `:network_id` only have to be routable; the scope
  # gate runs in the pipeline, upstream of any controller that would
  # care what they contain.
  defp concrete_path(%{path: path}) do
    path
    |> String.split("/")
    |> Enum.map_join("/", fn
      ":" <> _ -> "placeholder"
      "*" <> _ -> "placeholder"
      segment -> segment
    end)
  end

  defp drive(conn, route) do
    path = concrete_path(route)

    case route.verb do
      :get -> get(conn, path)
      :post -> post(conn, path, %{})
      :put -> put(conn, path, %{})
      :patch -> patch(conn, path, %{})
      :delete -> delete(conn, path)
    end
  end

  test "every route outside the client-usable set answers the scope refusal" do
    admin = user_fixture(is_admin: true)
    {:ok, token} = Accounts.create_client_token(admin, "headless", nil, nil, [])

    for route <- gated_routes() do
      conn =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(token.id)
        |> drive(route)

      assert json_response(conn, 403) == %{"error" => "client_token_scope"},
             """
             #{method(route)} #{route.path} answers a per-client token.

             Either mount it on the `:full_session` scope (or
             `:admin_authn`) in GrappaWeb.Router, or — if a headless
             client is meant to reach it — add it to
             `@client_usable_routes` / `@client_usable_prefixes` here
             and say why. Silence is not one of the options.
             """
    end
  end

  test "the invariant has something to check" do
    # A filter that matches nothing passes vacuously forever. This is the
    # arm that notices when a router refactor renames the paths out from
    # under the lists above.
    assert length(gated_routes()) > 40
  end

  test "every allowlisted route still exists in the table" do
    # The other direction of the same drift. A stale entry here silently
    # exempts nothing today and quietly re-exempts whatever claims the
    # path tomorrow, so an entry that matches no route is an error.
    routes = GrappaWeb.Router.__routes__()

    for prefix <- @client_usable_prefixes do
      assert Enum.any?(routes, &String.starts_with?(&1.path, prefix)),
             "no route starts with the client-usable prefix #{prefix} any more"
    end

    for {verb, path} <- @client_usable_routes ++ @unauthenticated_routes do
      assert Enum.any?(routes, &(&1.path == path and method(&1) == verb)),
             "no route matches #{verb} #{path} any more"
    end
  end
end
