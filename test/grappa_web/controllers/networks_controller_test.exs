defmodule GrappaWeb.NetworksControllerTest do
  @moduledoc """
  `GET /networks` — lists the authenticated subject's bound networks.
  `PATCH /networks/:network_id` — T32 connection_state transitions.

  Cicchetto (Phase 3 PWA) calls GET on app boot to render the
  network → channel tree. User branch:
  `Grappa.Networks.Credentials.list_credentials_for_user/1` gates on
  credential ownership — a user sees only networks they bind to.
  Visitor branch: returns the single network the visitor is row-pinned
  to (`visitor.network_slug` resolved via `Networks.get_network_by_slug/1`).
  Two operators on the same deployment do NOT see each other's
  networks; a visitor sees exactly one.

  PATCH is user-only (credentials are user→network bindings; visitors
  have no Credential row to transition). Authz is handled by the
  `ResolveNetwork` plug — a user patching another user's network slug
  collapses to 404 so credential-existence is not leaked.

  Wire shape comes from `Grappa.Networks.Wire.network_to_json/1`
  (GET) and `Grappa.Networks.Wire.credential_to_json/1` (PATCH —
  returns the updated credential including connection_state fields).

  `async: false` for the same unique-index race reason as
  `messages_controller_test.exs`: per-test inserts of `networks` rows
  with reused slugs would flake under `max_cases: 2` sandbox parallelism.
  Also `async: false` because PATCH exercises `Session.start_session/3`
  which uses the shared `Grappa.SessionRegistry` + `Grappa.SessionSupervisor`
  singletons.
  """
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.Admission.NetworkCircuit
  alias Grappa.{AdmissionStateHelpers, IRCServer, Networks, Repo}
  alias Grappa.Networks.Credential

  # U-0 — admission state must start known-empty between tests.
  # The U-0 cap-exceeded + circuit-open tests deliberately drive the
  # admission ETS tables into reject-mode; without a per-test reset
  # the subsequent test sees leaked state (CircuitOpen 1 on a fresh
  # network row, registry-leaked Session.Servers from the happy
  # path). Same `reset_all/0` pattern as admin/sessions_controller_test.exs.
  setup do
    AdmissionStateHelpers.reset_all()
    :ok
  end

  describe "GET /networks — user subject" do
    test "with valid Bearer returns 200 + list of bound networks", %{conn: conn} do
      vjt = user_fixture(name: "vjt-list-#{u()}")
      session = session_fixture(vjt)

      {azzurra, _} = network_with_server(port: 6667, slug: "azzurra-list-#{u()}")
      {libera, _} = network_with_server(port: 6668, slug: "libera-list-#{u()}")
      _ = credential_fixture(vjt, azzurra)
      _ = credential_fixture(vjt, libera)

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/networks")

      body = json_response(conn, 200)
      assert is_list(body)

      slugs = Enum.map(body, & &1["slug"])
      assert azzurra.slug in slugs
      assert libera.slug in slugs

      first = hd(body)
      assert is_integer(first["id"])
      assert is_binary(first["slug"])
      assert is_binary(first["inserted_at"])
      assert is_binary(first["updated_at"])
      # nick is the per-network configured IRC nick — cicchetto uses it to
      # subscribe to the correct DM topic (channel:<nick>) and to avoid the
      # own-nick clash when user.name matches a query window targetNick.
      assert is_binary(first["nick"])
      # HIGH-24 (no-silent-drops B6.9a 2026-05-14): explicit kind
      # discriminator on the wire so cic doesn't have to join against
      # /me to tag the network shape.
      assert first["kind"] == "user"
    end

    test "nick in response matches the credential's configured IRC nick", %{conn: conn} do
      vjt = user_fixture(name: "vjt-nick-check-#{u()}")
      session = session_fixture(vjt)
      {net, _} = network_with_server(port: 6671, slug: "azzurra-nick-#{u()}")
      _ = credential_fixture(vjt, net, %{nick: "irc-grappa"})

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/networks")

      body = json_response(conn, 200)
      found = Enum.find(body, &(&1["slug"] == net.slug))
      assert found["nick"] == "irc-grappa"
    end

    # T32 parked-window cluster (CP19): cic derives the per-network +
    # per-channel greyed cascade from `connection_state`. The user-topic
    # `connection_state_changed` event triggers a `GET /networks` refetch
    # in cic (`userTopic.ts` arm); without the T32 fields surfacing here,
    # cic refetches the same shape and can't derive anything. Default
    # row state is `:connected` (the bind_credential default), so a
    # freshly-bound network MUST report `connection_state: "connected"`.
    test "T32 fields surface in user network listing", %{conn: conn} do
      vjt = user_fixture(name: "vjt-t32-fields-#{u()}")
      session = session_fixture(vjt)
      {net, _} = network_with_server(port: 6672, slug: "azzurra-t32-#{u()}")
      _ = credential_fixture(vjt, net)

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/networks")

      body = json_response(conn, 200)
      found = Enum.find(body, &(&1["slug"] == net.slug))

      assert found["connection_state"] == "connected"
      assert Map.has_key?(found, "connection_state_reason")
      assert Map.has_key?(found, "connection_state_changed_at")
      assert is_nil(found["connection_state_reason"])
    end

    test "T32 fields reflect a parked credential post-/disconnect", %{conn: conn} do
      vjt = user_fixture(name: "vjt-t32-parked-#{u()}")
      session = session_fixture(vjt)
      {net, _} = network_with_server(port: 6673, slug: "azzurra-parked-#{u()}")
      cred = credential_fixture(vjt, net)

      reason = "testing parked state"
      {:ok, _} = Networks.disconnect(cred, reason)

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/networks")

      body = json_response(conn, 200)
      found = Enum.find(body, &(&1["slug"] == net.slug))

      assert found["connection_state"] == "parked"
      assert found["connection_state_reason"] == reason
      assert is_binary(found["connection_state_changed_at"])
    end

    test "returns empty list when user has no bindings", %{conn: conn} do
      vjt = user_fixture(name: "vjt-empty-#{u()}")
      session = session_fixture(vjt)

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/networks")

      assert json_response(conn, 200) == []
    end

    test "does not include other users' networks (per-user iso)", %{conn: conn} do
      vjt = user_fixture(name: "vjt-iso-#{u()}")
      alice = user_fixture(name: "alice-iso-#{u()}")

      {vjt_net, _} = network_with_server(port: 6669, slug: "vjt-only-#{u()}")
      {alice_net, _} = network_with_server(port: 6670, slug: "alice-only-#{u()}")
      _ = credential_fixture(vjt, vjt_net)
      _ = credential_fixture(alice, alice_net)

      vjt_session = session_fixture(vjt)

      conn =
        conn
        |> put_bearer(vjt_session.id)
        |> get("/networks")

      body = json_response(conn, 200)
      slugs = Enum.map(body, & &1["slug"])
      assert vjt_net.slug in slugs
      refute alice_net.slug in slugs
    end

    test "without Bearer returns 401", %{conn: conn} do
      conn = get(conn, "/networks")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end
  end

  describe "GET /networks — visitor subject" do
    test "returns the single bound network for the visitor", %{conn: conn} do
      slug = "azzurra-vis-#{u()}"
      {:ok, network} = Networks.find_or_create_network(%{slug: slug})
      {_, session} = visitor_and_session(network_slug: slug)

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/networks")

      body = json_response(conn, 200)
      assert is_list(body)
      assert length(body) == 1
      assert hd(body)["slug"] == network.slug
      assert hd(body)["id"] == network.id
      # HIGH-24 (no-silent-drops B6.9a 2026-05-14): explicit kind
      # discriminator on the wire so cic doesn't have to join against
      # /me to tag the network shape.
      assert hd(body)["kind"] == "visitor"
    end

    test "does not include other visitors' networks (per-visitor iso)", %{conn: conn} do
      vjt_slug = "azzurra-iso-#{u()}"
      alice_slug = "libera-iso-#{u()}"
      {:ok, _} = Networks.find_or_create_network(%{slug: vjt_slug})
      {:ok, _} = Networks.find_or_create_network(%{slug: alice_slug})

      {_, session} = visitor_and_session(network_slug: vjt_slug)
      _ = visitor_fixture(network_slug: alice_slug)

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/networks")

      body = json_response(conn, 200)
      slugs = Enum.map(body, & &1["slug"])
      assert vjt_slug in slugs
      refute alice_slug in slugs
    end
  end

  defp u, do: System.unique_integer([:positive])

  # ---------------------------------------------------------------------------
  # PATCH /networks/:network_id — T32 connection_state transitions
  # ---------------------------------------------------------------------------

  describe "PATCH /networks/:network_id — parked transition" do
    test "transitions connected credential to parked and returns 200 with updated state",
         %{conn: conn} do
      vjt = user_fixture(name: "vjt-patch-park-#{u()}")
      session = session_fixture(vjt)
      slug = "net-park-#{u()}"
      {network, _} = network_with_server(port: 9_999, slug: slug)
      _ = credential_fixture(vjt, network)

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/networks/#{slug}", %{connection_state: "parked", reason: "manual"})

      body = json_response(conn, 200)
      assert body["connection_state"] == "parked"
      assert body["connection_state_reason"] == "manual"
      assert is_binary(body["connection_state_changed_at"])

      # Verify DB row persisted
      cred = Repo.get_by!(Credential, user_id: vjt.id, network_id: network.id)
      assert cred.connection_state == :parked
      assert cred.connection_state_reason == "manual"
    end

    test "returns 400 when already parked", %{conn: conn} do
      vjt = user_fixture(name: "vjt-patch-park2-#{u()}")
      session = session_fixture(vjt)
      slug = "net-park2-#{u()}"
      {network, _} = network_with_server(port: 9_999, slug: slug)
      cred = credential_fixture(vjt, network)

      # Seed a parked credential directly (bypasses transition fn)
      seed_state(cred, :parked, "prior-park")

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/networks/#{slug}", %{connection_state: "parked", reason: "again"})

      assert json_response(conn, 400)["error"] == "not_connected"
    end
  end

  describe "PATCH /networks/:network_id — connected transition" do
    test "transitions parked credential to connected, spawns session, returns 200",
         %{conn: conn} do
      vjt = user_fixture(name: "vjt-patch-connect-#{u()}")
      session = session_fixture(vjt)
      slug = "net-connect-#{u()}"
      {:ok, irc_server} = IRCServer.start_link(fn state, _ -> {:reply, nil, state} end)
      port = IRCServer.port(irc_server)
      {network, _} = network_with_server(port: port, slug: slug)
      cred = credential_fixture(vjt, network)

      # Seed the credential as parked so connect is a valid transition
      seed_state(cred, :parked, "user-parked")

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/networks/#{slug}", %{connection_state: "connected"})

      body = json_response(conn, 200)
      assert body["connection_state"] == "connected"
      # reason cleared on connect (prior parked reason is wiped)
      assert is_nil(body["connection_state_reason"])

      # Verify DB row persisted
      updated = Repo.get_by!(Credential, user_id: vjt.id, network_id: network.id)
      assert updated.connection_state == :connected

      # Tear down the spawned session (it was connected to the fake IRC server)
      :ok = Grappa.Session.stop_session({:user, vjt.id}, network.id)
    end

    # U cluster U-0 — stop-swallow fix. Pre-U-0, `apply_transition(:connected)`
    # called `Networks.connect/1` (committing DB → `:connected`) BEFORE
    # `spawn_session_after_connect/3` ran, and the latter swallowed every
    # spawn error and returned `:ok`. Net effect: a cap-saturated PATCH /connect
    # returned 200 OK with `connection_state: "connected"` while no
    # Session.Server was running — subsequent `POST /messages` 404'd
    # with no signal to the operator.
    #
    # Post-U-0: spawn FIRST against the parked credential; on rejection,
    # DB stays at PREVIOUS state and the typed error reaches
    # FallbackController. Per CLAUDE.md "Phoenix Channels = the event
    # push surface" / "REST is for resources" — the failure to
    # transition surfaces honestly at the REST boundary.
    test "503 + DB stays parked when network cap exceeded (U-0 stop-swallow)",
         %{conn: conn} do
      vjt = user_fixture(name: "vjt-u0-netcap-#{u()}")
      session = session_fixture(vjt)
      slug = "net-u0-netcap-#{u()}"
      {:ok, irc_server} = IRCServer.start_link(fn state, _ -> {:reply, nil, state} end)
      port = IRCServer.port(irc_server)
      {network, _} = network_with_server(port: port, slug: slug)
      cred = credential_fixture(vjt, network)
      seed_state(cred, :parked, "user-parked")

      # Saturate the network: cap=0 means every spawn attempt rejects
      # at admission. No live session needed — `Admission.check_network_total/1`
      # short-circuits on cap==0. U-2 split: a user-flow PATCH consults
      # `max_concurrent_user_sessions`; the visitor cap is independent.
      {:ok, _} = Networks.update_network_caps(network, %{max_concurrent_user_sessions: 0})

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/networks/#{slug}", %{connection_state: "connected"})

      # Per existing FallbackController mapping (T31): :network_cap_exceeded
      # → 503 `network_busy`. U-2 unifies status codes across the typed
      # error family; U-0 just propagates whatever atom comes out of
      # SpawnOrchestrator.
      assert json_response(conn, 503)["error"] == "network_busy"

      # DB MUST stay at :parked (NOT silently transition to :connected).
      # This is the heart of U-0: pre-fix the row was already :connected
      # by the time spawn rejected; post-fix the spawn runs first.
      updated = Repo.get_by!(Credential, user_id: vjt.id, network_id: network.id)
      assert updated.connection_state == :parked
      assert updated.connection_state_reason == "user-parked"
    end

    test "503 + DB stays parked when network circuit open (U-0 stop-swallow)",
         %{conn: conn} do
      vjt = user_fixture(name: "vjt-u0-circuit-#{u()}")
      session = session_fixture(vjt)
      slug = "net-u0-circuit-#{u()}"
      # No real IRC server needed — circuit-open rejects before any
      # network I/O. Port 9_999 is the canonical never-listened sentinel
      # used elsewhere in this file for "won't reach" coverage.
      {network, _} = network_with_server(port: 9_999, slug: slug)
      cred = credential_fixture(vjt, network)
      seed_state(cred, :parked, "user-parked")

      # Force the circuit OPEN by recording threshold-many failures.
      # Threshold + cooldown live in `Grappa.Admission.NetworkCircuit`
      # config; we drive the helper directly rather than coupling to
      # the exact numbers.
      :ok = open_circuit(network.id)

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/networks/#{slug}", %{connection_state: "connected"})

      # `{:network_circuit_open, retry_after}` → 503 `network_unreachable`
      # with Retry-After header (T31 FallbackController clause).
      assert json_response(conn, 503)["error"] == "network_unreachable"
      assert [_] = Plug.Conn.get_resp_header(conn, "retry-after")

      updated = Repo.get_by!(Credential, user_id: vjt.id, network_id: network.id)
      assert updated.connection_state == :parked

      # Reset circuit so other tests aren't affected.
      :ok = NetworkCircuit.reset(network.id)
    end

    # NOTE: A reachability test for FallbackController's
    # `{:start_failed, _}` clause was attempted here but removed:
    # `Session.Server.init/1` is non-blocking by design (TCP connect
    # runs in `handle_continue`), so `DynamicSupervisor.start_child/2`
    # returns `{:ok, pid}` immediately and the `{:start_failed, _}`
    # path requires a synchronous init/1 error that the current
    # Session.Server cannot produce. The FC clause is a safety net
    # against a future init/1 change, not a reachable production path.
    # If a future bucket adds a sync probe to init/1, add the test then.

    # UX-5 bucket BC (2026-05-19) — cap-on-park unblocker. The operator's
    # browser holds an active accounts_session under `client_id = X`;
    # they X-button the network header (T32 park) then send /connect
    # (PATCH connection_state=connected). Pre-BC the cap counted vjt's
    # OWN session against him with the default `max_per_client = 1`,
    # returning 503 `too_many_sessions`. T32 was a red herring — the
    # bug fired on first PATCH /connect from any logged-in user.
    # Post-BC, `requesting_subject: {:user, user.id}` is threaded into
    # the admission input and self-exclusion at
    # `Admission.count_subjects_for_client_on_network/4` drops the
    # requesting subject's rows from the cap count.
    test "PATCH /connect succeeds when requesting user already holds own session on this device (UX-5 BC)",
         %{conn: conn} do
      vjt = user_fixture(name: "vjt-ux5bc-self-#{u()}")
      client_id = "11111111-2222-4444-8888-fedcba987650"

      # Session minted on the same client_id the PATCH will carry — this
      # is the row that pre-BC counted toward the cap as 1, blocking
      # any subsequent spawn from the SAME subject + same device.
      {:ok, session} =
        Grappa.Accounts.create_session({:user, vjt.id}, "1.2.3.4", "ua", client_id: client_id)

      slug = "net-ux5bc-self-#{u()}"
      {:ok, irc_server} = IRCServer.start_link(fn state, _ -> {:reply, nil, state} end)
      port = IRCServer.port(irc_server)
      {network, _} = network_with_server(port: port, slug: slug)

      # Pin per-device cap at 1 — the tightest configuration AND the
      # production default. Pre-fix this guarantees the buggy path.
      {:ok, _} = Networks.update_network_caps(network, %{max_per_client: 1})

      cred = credential_fixture(vjt, network)
      # Seed the credential as parked so :connected is a valid transition
      # (mirrors the T32 X-button → park flow).
      _ =
        cred
        |> Ecto.Changeset.change(%{
          connection_state: :parked,
          connection_state_reason: "user-disconnect",
          connection_state_changed_at: DateTime.truncate(DateTime.utc_now(), :second)
        })
        |> Repo.update!()

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> put_req_header("x-grappa-client-id", client_id)
        |> patch("/networks/#{slug}", %{connection_state: "connected"})

      body = json_response(conn, 200)
      assert body["connection_state"] == "connected"

      # DB persisted the transition.
      updated = Repo.get_by!(Credential, user_id: vjt.id, network_id: network.id)
      assert updated.connection_state == :connected

      # Tear down the spawned session.
      :ok = Grappa.Session.stop_session({:user, vjt.id}, network.id)
    end

    # Negative twin: a DIFFERENT user on the SAME device must still be
    # cap-blocked. The fix narrows the cap to "different subjects on the
    # same device," not "no cap at all." This guards against a regression
    # that drops the exclusion clause and loosens the cap entirely.
    test "PATCH /connect 503s when a DIFFERENT user holds the cap slot on same device (UX-5 BC negative)",
         %{conn: conn} do
      alice = user_fixture(name: "alice-ux5bc-other-#{u()}")
      bob = user_fixture(name: "bob-ux5bc-other-#{u()}")
      client_id = "22222222-3333-4444-8888-fedcba987651"

      slug = "net-ux5bc-other-#{u()}"
      {network, _} = network_with_server(port: 9_999, slug: slug)
      {:ok, _} = Networks.update_network_caps(network, %{max_per_client: 1})

      # alice has a credential + an accounts_session under client_id X.
      # That row IS the cap-occupying session; bob trying to PATCH /connect
      # from the same device must 503 (cross-subject = legit cap hit).
      _ = credential_fixture(alice, network)

      {:ok, _} =
        Grappa.Accounts.create_session({:user, alice.id}, "1.2.3.4", "ua", client_id: client_id)

      # bob also has a credential on this network but no live session;
      # their PATCH carries bob's own bearer + same client_id header.
      cred_bob = credential_fixture(bob, network)

      _ =
        cred_bob
        |> Ecto.Changeset.change(%{
          connection_state: :parked,
          connection_state_reason: "user-disconnect",
          connection_state_changed_at: DateTime.truncate(DateTime.utc_now(), :second)
        })
        |> Repo.update!()

      {:ok, bob_session} =
        Grappa.Accounts.create_session({:user, bob.id}, "1.2.3.5", "ua",
          client_id: "33333333-4444-4444-8888-fedcba987652"
        )

      conn =
        conn
        |> put_bearer(bob_session.id)
        |> put_req_header("content-type", "application/json")
        |> put_req_header("x-grappa-client-id", client_id)
        |> patch("/networks/#{slug}", %{connection_state: "connected"})

      # 503 too_many_sessions: alice's session occupies the slot, bob
      # is a different subject, cap stays honest.
      assert json_response(conn, 503)["error"] == "too_many_sessions"

      # DB stays parked — U-0 stop-swallow lesson: failure must NOT
      # silently transition the row.
      reloaded = Repo.get_by!(Credential, user_id: bob.id, network_id: network.id)
      assert reloaded.connection_state == :parked
    end
  end

  describe "PATCH /networks/:network_id — failed transition (server-set only)" do
    test "returns 400 when client tries to set connection_state to failed", %{conn: conn} do
      vjt = user_fixture(name: "vjt-patch-fail-#{u()}")
      session = session_fixture(vjt)
      slug = "net-fail-#{u()}"
      {network, _} = network_with_server(port: 9_999, slug: slug)
      _ = credential_fixture(vjt, network)

      conn =
        conn
        |> put_bearer(session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/networks/#{slug}", %{connection_state: "failed"})

      assert json_response(conn, 400)["error"] == "bad_request"
    end
  end

  describe "PATCH /networks/:network_id — authorization" do
    test "returns 404 when user has no credential for the network (authz oracle)", %{conn: conn} do
      vjt = user_fixture(name: "vjt-patch-authz-#{u()}")
      alice = user_fixture(name: "alice-patch-authz-#{u()}")
      vjt_session = session_fixture(vjt)
      slug = "net-authz-#{u()}"
      {network, _} = network_with_server(port: 9_999, slug: slug)
      # Only Alice binds the network; vjt has no credential for it
      _ = credential_fixture(alice, network)

      conn =
        conn
        |> put_bearer(vjt_session.id)
        |> put_req_header("content-type", "application/json")
        |> patch("/networks/#{slug}", %{connection_state: "parked", reason: "probe"})

      assert json_response(conn, 404)["error"] == "not_found"
    end

    test "returns 401 without bearer", %{conn: conn} do
      conn =
        conn
        |> put_req_header("content-type", "application/json")
        |> patch("/networks/any-slug", %{connection_state: "parked"})

      assert json_response(conn, 401)["error"] == "unauthorized"
    end
  end

  # Writes connection_state + reason directly into the row, bypassing
  # the context transition fns. Used to seed arbitrary states for tests
  # that are verifying the *endpoint* reaction to pre-existing states,
  # not re-testing the context fns themselves.
  defp seed_state(%Credential{} = cred, state, reason) do
    now = DateTime.truncate(DateTime.utc_now(), :second)

    cred
    |> Ecto.Changeset.change(%{
      connection_state: state,
      connection_state_reason: reason,
      connection_state_changed_at: now
    })
    |> Repo.update!()
  end

  # U-0 helper — drive the per-network circuit to `:open` by directly
  # writing the ETS row with a far-future `cooled_at_ms`. We bypass
  # `NetworkCircuit.record_failure/1` because the test config sets
  # cooldown_ms to 50ms (snappy unit tests) and the controller test
  # suite under full-check.sh load can easily eat that window between
  # `:sys.get_state` flush and the PATCH HTTP call — exposing a
  # load-flake where the circuit auto-closes via `cooldown_expire`
  # before admission re-checks it. Pinning `cooled_at_ms` to
  # +1 hour makes the open state load-independent for the duration
  # of the test (cleared by AdmissionStateHelpers.reset_network_circuit
  # in the next test's setup).
  defp open_circuit(network_id) do
    now = System.monotonic_time(:millisecond)
    one_hour_ms = 60 * 60 * 1_000
    threshold = NetworkCircuit.threshold()

    :ets.insert(
      :admission_network_circuit_state,
      {network_id, threshold, now, :open, now + one_hour_ms}
    )

    :ok
  end
end
