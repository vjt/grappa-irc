defmodule GrappaWeb.UserSocketTest do
  @moduledoc """
  WebSocket connect-time auth (sub-task 2i + #95 + #202).

  `UserSocket.connect/3` derives its assigns from a bearer token that
  rides the `Sec-WebSocket-Protocol` subprotocol
  (`connect_info.auth_token`), entirely OFF the WS upgrade URL:

    * `connect_info.auth_token` — the bearer Phoenix decodes from the
      `base64url.bearer.phx.<token>` subprotocol. The same UUID PK that
      `Accounts.create_session/3` returns + the REST surface consumes
      via `Authorization: Bearer ...`.
    * `Accounts.authenticate(token)` validates + bumps `last_seen_at`
      with the same 60 s threshold the REST plug uses.
    * On success: `socket.assigns.user_name` (from the User row) and
      `:current_session_id` (for future revocation hooks).
    * On any failure (missing / empty / malformed token, unknown row,
      revoked, expired): `:error` so Phoenix returns the standard
      WS rejection — distinct error strings would just leak
      enumeration info.

  #202 dropped the legacy `params["token"]` query-string fallback that
  #95 had retained for one deploy cycle: a bearer supplied only via the
  query string is now IGNORED (see the "ignores a query-string token
  entirely" regression guard below).

  Cross-user join authz at the channel layer
  (`GrappaWeb.GrappaChannel.authorize/2`) was wired in 2h against
  `socket.assigns.user_name`; this test proves the value is now
  load-bearing (alice can't join vjt's topics even with a valid
  alice token).
  """
  use GrappaWeb.ChannelCase, async: false

  import ExUnit.CaptureLog
  import Grappa.AuthFixtures

  alias Grappa.{Accounts, Protocol, PubSub.Topic, TaskSupervisorHelpers}
  alias GrappaWeb.UserSocket

  # #95 + #202 — the ONLY token source: the bearer arrives via
  # `connect_info.auth_token` (Phoenix decodes it from the
  # `Sec-WebSocket-Protocol` header), NOT via a query-string param.
  defp connect_via_subprotocol(token) do
    Phoenix.ChannelTest.connect(UserSocket, %{}, connect_info: %{auth_token: token})
  end

  # #202 — a query-string `?token=` connect with NO subprotocol token.
  # The fallback that once honored this is gone, so every such connect is
  # rejected regardless of whether the query-string token is valid.
  defp connect_with_query_string(token) do
    Phoenix.ChannelTest.connect(UserSocket, %{"token" => token}, connect_info: %{})
  end

  # #447 — a connect declaring a wire protocol version via the
  # `client_proto` query param (values arrive as strings, like real query
  # params), with a valid bearer via the subprotocol.
  defp connect_with_proto(client_proto, token) do
    Phoenix.ChannelTest.connect(UserSocket, %{"client_proto" => client_proto}, connect_info: %{auth_token: token})
  end

  # #447 — same, but with NO token: proves the version gate runs BEFORE
  # auth (a below-floor client is refused even with no/invalid credential).
  defp connect_with_proto_no_token(client_proto) do
    Phoenix.ChannelTest.connect(UserSocket, %{"client_proto" => client_proto}, connect_info: %{})
  end

  # #1416 — the VALUE cicchetto actually shipped on the wire when
  # `socketEndpoint` baked the query into the endpoint string and
  # phoenix.js concatenated `/websocket` onto it (DESIGN_NOTES 2026-08-16,
  # "the hop this entry named as unmeasured was the bug"). `Integer.parse/1`
  # answers `{1, "/websocket"}` — parseable head, unconsumed tail — which is
  # the exact shape the `_ -> :ok` arm swallowed in silence.
  @shipped_unreadable "1/websocket"

  # #1618 — the client-source capture is a DETACHED `Grappa.TaskSupervisor`
  # task, so its write lands after `connect/3` has already returned. Every
  # assertion on the persisted sample waits (bounded) for the live children to
  # exit first (`TaskSupervisorHelpers.drain_children/0`), and the `on_exit`
  # twin keeps a straggler off the sandbox owner's teardown.

  describe "connect/3" do
    test "returns :error when no token is given" do
      assert :error = Phoenix.ChannelTest.connect(UserSocket, %{}, connect_info: %{})
    end

    test "returns :error for a malformed (non-UUID) token" do
      assert :error = connect_via_subprotocol("not-a-uuid")
    end

    test "returns :error for a UUID that does not match any session" do
      assert :error = connect_via_subprotocol(Ecto.UUID.generate())
    end

    test "returns :error for a revoked token" do
      {_, session} = user_and_session(name: "vjt-#{System.unique_integer([:positive])}")
      _ = Accounts.revoke_session(session.id)

      assert :error = connect_via_subprotocol(session.id)
    end

    test "returns :error when the subprotocol auth_token is empty" do
      assert :error = connect_via_subprotocol("")
    end

    test "assigns :user_name + :current_session_id on success" do
      user_name = "vjt-#{System.unique_integer([:positive])}"
      {_, session} = user_and_session(name: user_name)

      assert {:ok, socket} = connect_via_subprotocol(session.id)
      assert socket.assigns.user_name == user_name
      assert socket.assigns.current_session_id == session.id
    end

    # #202 — the legacy `params["token"]` fallback is gone. A VALID
    # bearer supplied only via the query string is now IGNORED, so the
    # connect is rejected exactly as if no token were present. This is
    # the regression guard that the URL can never again carry the bearer.
    test "ignores a query-string token entirely (subprotocol-only)" do
      {_, session} = user_and_session(name: "vjt-#{System.unique_integer([:positive])}")

      assert :error = connect_with_query_string(session.id)
    end
  end

  # #447 — protocol-version handshake gate. A client declares the wire
  # protocol it speaks via the `client_proto` query param; a client below
  # `Grappa.Protocol.min_version/0` is refused with
  # `{:error, :upgrade_required}` (→ the endpoint's error_handler emits a
  # 426; the HTTP status itself is proven end-to-end in the issue447 e2e
  # spec — `ChannelTest.connect/3` returns the raw `connect/3` value, not
  # the transport's HTTP mapping). Absent/unparseable → current, the
  # zero-behavior-change guarantee for cicchetto + shottino.
  describe "connect/3 protocol-version gate (#447)" do
    test "absent client_proto connects as before — zero-behavior-change guarantee" do
      # THE contract for existing clients (cicchetto/shottino send no
      # version): a connect with no client_proto param behaves exactly like
      # the pre-#447 connect. Not a comment — a test.
      user_name = "vjt-#{System.unique_integer([:positive])}"
      {_, session} = user_and_session(name: user_name)

      assert {:ok, socket} = connect_via_subprotocol(session.id)
      assert socket.assigns.user_name == user_name
    end

    test "client_proto at the floor (min_version) connects" do
      {_, session} = user_and_session(name: "vjt-#{System.unique_integer([:positive])}")

      assert {:ok, _} =
               connect_with_proto(Integer.to_string(Protocol.min_version()), session.id)
    end

    test "client_proto ABOVE the server version still connects — no upper bound" do
      # The gate has a floor and no ceiling. Its reason is NOT the
      # "a newer client tolerates an older server" this comment used to
      # give — #1393d withdrew that. What a client made mandatory is not a
      # fact this server holds, and refusing the socket would withhold the
      # join reply cic reads to raise its own outdated-server banner.
      {_, session} = user_and_session(name: "vjt-#{System.unique_integer([:positive])}")

      assert {:ok, _} =
               connect_with_proto(Integer.to_string(Protocol.version() + 100), session.id)
    end

    test "client_proto BELOW the floor is refused with {:error, :upgrade_required} (→ 426)" do
      {_, session} = user_and_session(name: "vjt-#{System.unique_integer([:positive])}")
      below = Integer.to_string(Protocol.min_version() - 1)

      assert {:error, :upgrade_required} = connect_with_proto(below, session.id)
    end

    test "a parseable NEGATIVE client_proto is below the floor → refused (not 'current')" do
      # A negative parses cleanly (`Integer.parse("-1") → {-1, ""}`), so it
      # is a below-floor value, NOT the unparseable-means-current path — it
      # 426s. Pins the narrative boundary flagged in review.
      {_, session} = user_and_session(name: "vjt-#{System.unique_integer([:positive])}")

      assert {:error, :upgrade_required} = connect_with_proto("-1", session.id)
    end

    test "the version gate runs BEFORE auth — below-floor is refused even with no token" do
      # A too-old client gets :upgrade_required (426), NOT the :error (403)
      # of an auth failure: it can't speak the protocol regardless of
      # credentials, and the distinct status is the whole point of #447.
      below = Integer.to_string(Protocol.min_version() - 1)

      assert {:error, :upgrade_required} = connect_with_proto_no_token(below)
    end

    test "unparseable client_proto is treated as current (unknown-is-never-fatal)" do
      {_, session} = user_and_session(name: "vjt-#{System.unique_integer([:positive])}")

      assert {:ok, _} = connect_with_proto("garbage", session.id)
    end

    # #1416 — `?client_proto[]=1` decodes to a LIST, not a binary, so it
    # misses the `is_binary(raw)` head and lands on the catch-all clause.
    # The DECISION is unchanged (served as current, same as any other
    # value the server cannot read); this pins that the new clause added
    # for the signal did not smuggle in a refusal.
    test "a present-but-non-binary client_proto still connects (decision unchanged)" do
      {_, session} = user_and_session(name: "vjt-#{System.unique_integer([:positive])}")

      assert {:ok, _} =
               Phoenix.ChannelTest.connect(UserSocket, %{"client_proto" => ["1"]},
                 connect_info: %{auth_token: session.id}
               )
    end
  end

  # #447 — the custom error_handler wired into the endpoint's `websocket:`
  # opts. Unit-proves the 426 BODY shape (status + JSON naming the floor);
  # the end-to-end HTTP status over a real handshake is the issue447 e2e.
  describe "handle_ws_error/2 (#447)" do
    test ":upgrade_required → 426 with a snake_case body naming the floor" do
      conn =
        UserSocket.handle_ws_error(Plug.Test.conn(:get, "/socket/websocket"), :upgrade_required)

      assert conn.status == 426
      body = Jason.decode!(conn.resp_body)
      assert body["error"] == "upgrade_required"
      assert body["protocol_version"] == Protocol.version()
      assert body["min_protocol_version"] == Protocol.min_version()
    end
  end

  # #95 + #202 — connect observability: connect/3 emits a
  # [:grappa, :ws, :connect] counter on every authenticated connect. #202
  # dropped the `auth_method` metadata tag — it had collapsed to a
  # constant `:subprotocol` once the query-string fallback was removed.
  #
  # #1416 re-populates the metadata with ONE bounded key: what the connect
  # boundary could make of the client's `client_proto` declaration. Before
  # it, a declaration the server could not read was byte-identical in every
  # observable output to one it read — the counter carried `%{}` and the
  # Logger line was a bare string. The token value is still NEVER emitted
  # (the raw bearer IS the session credential — S9).
  describe "connect telemetry (#95 / #202 / #1416)" do
    setup do
      ref = make_ref()
      handler_id = "ws-connect-test-#{System.unique_integer([:positive])}"
      test_pid = self()

      :telemetry.attach(
        handler_id,
        [:grappa, :ws, :connect],
        fn _, measurements, metadata, _ ->
          send(test_pid, {ref, measurements, metadata})
        end,
        nil
      )

      on_exit(fn -> :telemetry.detach(handler_id) end)
      %{ref: ref}
    end

    # #202 asserted `metadata == %{}` here. #1416 supersedes that: the
    # empty map was the defect, not the contract — it is what made an
    # unreadable declaration indistinguishable from a read one. The
    # measurement is untouched.
    test "an absent declaration is reported as :absent, not as nothing", %{ref: ref} do
      {_, session} = user_and_session(name: "vjt-#{System.unique_integer([:positive])}")

      assert {:ok, _} = connect_via_subprotocol(session.id)
      assert_receive {^ref, measurements, metadata}
      assert measurements == %{count: 1}
      assert metadata == %{client_proto: :absent}
    end

    test "a readable declaration is reported as :declared", %{ref: ref} do
      {_, session} = user_and_session(name: "vjt-#{System.unique_integer([:positive])}")

      assert {:ok, _} =
               connect_with_proto(Integer.to_string(Protocol.min_version()), session.id)

      assert_receive {^ref, _, metadata}
      assert metadata == %{client_proto: :declared}
    end

    # THE issue. Same return value as the test above by design — the
    # distinction can only live in the emitted signal, so that is where
    # it is asserted.
    test "a declaration the server could not read is reported as :unreadable", %{ref: ref} do
      {_, session} = user_and_session(name: "vjt-#{System.unique_integer([:positive])}")

      assert {:ok, _} = connect_with_proto(@shipped_unreadable, session.id)

      assert_receive {^ref, _, metadata}
      assert metadata == %{client_proto: :unreadable}
    end

    # A present-but-non-binary value (`?client_proto[]=1`) is a client that
    # DECLARED something the server could not read — reporting it as
    # `:absent` would be the same lie in a second costume, so the catch-all
    # clause splits on whether the key is there at all.
    test "a present-but-non-binary declaration is :unreadable, not :absent", %{ref: ref} do
      {_, session} = user_and_session(name: "vjt-#{System.unique_integer([:positive])}")

      assert {:ok, _} =
               Phoenix.ChannelTest.connect(UserSocket, %{"client_proto" => ["1"]},
                 connect_info: %{auth_token: session.id}
               )

      assert_receive {^ref, _, metadata}
      assert metadata == %{client_proto: :unreadable}
    end

    test "emits NO connect event on an auth failure (counter is post-auth)", %{ref: ref} do
      assert :error = connect_via_subprotocol(Ecto.UUID.generate())
      refute_receive {^ref, _, _}
    end
  end

  # #1416 — the Logger half of the same signal, and the half that has an
  # operator behind it: nothing in `lib/` attaches to
  # `[:grappa, :ws, :connect]`, so the counter above is a hook for a future
  # exporter while the log line is what a 2am grep actually reads.
  #
  # This describe pins the `config/config.exs` `:metadata` allowlist as
  # much as the code: an undeclared key is dropped at FORMAT time, so the
  # call site would compile, the telemetry tests above would pass, and the
  # operator would still read a bare line. Only a capture of the RENDERED
  # output can tell those apart.
  #
  # `Logger.configure(level: :info)` because the test env runs at
  # :warning — same rationale (and same `async: false` requirement) as
  # `Grappa.IRC.ClientOutboundCostTest`.
  describe "connect log line (#1416)" do
    setup do
      original = Logger.level()
      Logger.configure(level: :info)
      on_exit(fn -> Logger.configure(level: original) end)
      :ok
    end

    defp capture_connect(fun) do
      capture_log(fn ->
        assert {:ok, _} = fun.()
        Logger.flush()
      end)
    end

    test "an unreadable declaration is named as unreadable" do
      {_, session} = user_and_session(name: "vjt-#{System.unique_integer([:positive])}")

      log = capture_connect(fn -> connect_with_proto(@shipped_unreadable, session.id) end)

      # The message is byte-unchanged — #95's greppable line keeps working
      # and the new fact rides the metadata prefix beside it.
      assert log =~ "ws connect authenticated"
      assert log =~ "client_proto=unreadable"
    end

    test "a readable declaration is named as declared" do
      {_, session} = user_and_session(name: "vjt-#{System.unique_integer([:positive])}")

      log =
        capture_connect(fn ->
          connect_with_proto(Integer.to_string(Protocol.min_version()), session.id)
        end)

      assert log =~ "ws connect authenticated"
      assert log =~ "client_proto=declared"
    end

    test "an absent declaration is named as absent" do
      {_, session} = user_and_session(name: "vjt-#{System.unique_integer([:positive])}")

      log = capture_connect(fn -> connect_via_subprotocol(session.id) end)

      assert log =~ "client_proto=absent"
    end

    # NOT ASSERTED HERE, deliberately: that the declared VALUE is also
    # observable. It is — phoenix's own `[:phoenix, :socket_connected]`
    # handler prints `Parameters: <inspect>` from this same process
    # (`deps/phoenix/lib/phoenix/logger.ex:363`, level defaulting to
    # `:info` at `socket.ex:524`, and prod runs at `:info`) — but no test
    # in this file can witness it, because `Phoenix.ChannelTest.__connect__/4`
    # synthesises its own socket options (`channel_test.ex:337-343`) and
    # never passes the endpoint's, so `log:` is hardcoded `:info` in every
    # ChannelTest connect. Measured, not assumed: injecting `log: false`
    # into `endpoint.ex`'s socket declaration killed ZERO tests. An
    # assertion on that line would measure the harness and pass forever.
    # See `UserSocket`'s emission comment for what this leaves unpinned.
  end

  describe "id/1" do
    test "scopes the per-user socket id by user_name" do
      user_name = "vjt-#{System.unique_integer([:positive])}"
      {_, session} = user_and_session(name: user_name)
      {:ok, socket} = connect_via_subprotocol(session.id)

      assert UserSocket.id(socket) == "user_socket:#{user_name}"
    end
  end

  describe "cross-user join authz (2i regression)" do
    test "alice's authenticated socket cannot join vjt's user topic" do
      vjt_name = "vjt-#{System.unique_integer([:positive])}"
      _ = user_fixture(name: vjt_name)

      {_, alice_session} =
        user_and_session(name: "alice-#{System.unique_integer([:positive])}")

      {:ok, socket} = connect_via_subprotocol(alice_session.id)

      assert {:error, %{error: "forbidden"}} =
               Phoenix.ChannelTest.subscribe_and_join(socket, Topic.user(vjt_name), %{})
    end
  end

  describe "connect/3 visitor token path" do
    test "visitor token assigns :user_name = visitor:<id> + :current_visitor_id" do
      visitor = visitor_fixture()
      {:ok, session} = Accounts.create_session({:visitor, visitor.id}, "1.2.3.4", "ua", [])

      assert {:ok, socket} = connect_via_subprotocol(session.id)
      assert socket.assigns.user_name == "visitor:" <> visitor.id
      assert socket.assigns.current_visitor_id == visitor.id
      assert socket.assigns.current_visitor.id == visitor.id
      assert socket.assigns.current_session_id == session.id
      refute Map.has_key?(socket.assigns, :current_user_id)
    end

    test "expired visitor session rejects with :error" do
      past = DateTime.add(DateTime.utc_now(), -1, :hour)
      visitor = visitor_fixture(expires_at: past)
      {:ok, session} = Accounts.create_session({:visitor, visitor.id}, "1.2.3.4", "ua", [])

      assert :error = connect_via_subprotocol(session.id)
    end

    # CP24 bucket E web/S5: visitor connects must register with
    # WSPresence so `cic_bundle_changed` reaches visitor sockets.
    # Pre-fix the connect path explicitly skipped `WSPresence.register/2`
    # for visitors to keep the auto-away machinery user-only — but
    # that exclusion accidentally hid visitors from `list_user_names/0`,
    # which the cic-bundle-changed admin endpoint iterates to fan out
    # the new bundle hash. Visitors with long-lived tabs would never
    # see the refresh banner trigger. Auto-away machinery stays
    # user-only because visitor `Session.Server` does not subscribe
    # to `Topic.ws_presence/1` (see `Session.Server.init/1`).
    test "visitor connect registers with WSPresence so list_user_names includes visitor" do
      visitor = visitor_fixture()
      {:ok, session} = Accounts.create_session({:visitor, visitor.id}, "1.2.3.4", "ua", [])

      assert {:ok, _} = connect_via_subprotocol(session.id)

      visitor_name = "visitor:" <> visitor.id
      assert visitor_name in Grappa.WSPresence.list_user_names()
    end
  end

  # #543 Part C — at WS connect the trusted client IP is resolved (via the
  # `RemoteIpFromProxy` SSOT, from `connect_info.peer_data`/`x_headers`) and
  # fed to `Vhosts.record_client_source/2`, so INC-3's per-subject
  # `last_client_prefix64` persistence is actually populated. Capture is
  # best-effort: an absent/garbage peer_data must NOT fail the connect.
  describe "connect/3 client-source capture (#543 Part C)" do
    alias Grappa.Vhosts
    alias Grappa.Vhosts.SourceMapping

    # Registered AFTER `ChannelCase`'s sandbox-owner `on_exit`, so LIFO runs
    # this one FIRST — a #1618 capture task must not still be querying when
    # `stop_owner` pulls the shared connection out from under it.
    setup do
      on_exit(&TaskSupervisorHelpers.drain_children/0)
      :ok
    end

    # Mirrors the transport: `peer_data.address` is the peer IP tuple,
    # `x_headers` are the forwarded (`x-*`) request headers, both riding
    # `connect_info` alongside the subprotocol bearer.
    defp connect_with_peer(token, peer_ip, x_headers) do
      Phoenix.ChannelTest.connect(UserSocket, %{},
        connect_info: %{
          auth_token: token,
          peer_data: %{address: peer_ip, port: 12_345, ssl_cert: nil},
          x_headers: x_headers
        }
      )
    end

    test "records the resolved client /64 for a user subject (loopback proxy + XFF)" do
      user_name = "vjt-#{System.unique_integer([:positive])}"
      {user, session} = user_and_session(name: user_name)
      subject = {:user, user.id}

      assert Vhosts.last_client_prefix64(subject) == nil

      assert {:ok, _} =
               connect_with_peer(session.id, {127, 0, 0, 1}, [
                 {"x-forwarded-for", "2001:db8:1:2:3:4:5:6"}
               ])

      # #1618 — the capture is detached, so wait for it before reading.
      TaskSupervisorHelpers.drain_children()

      # The stored key equals the production derivation of the RESOLVED IP —
      # the /64 of the XFF client, NOT the loopback peer. No hardcoded bytes.
      assert Vhosts.last_client_prefix64(subject) ==
               SourceMapping.client_key({0x2001, 0xDB8, 1, 2, 3, 4, 5, 6})
    end

    test "records the peer directly for a direct (non-loopback, no-XFF) client" do
      {user, session} = user_and_session(name: "vjt-#{System.unique_integer([:positive])}")
      subject = {:user, user.id}

      assert {:ok, _} = connect_with_peer(session.id, {203, 0, 113, 7}, [])

      TaskSupervisorHelpers.drain_children()

      assert Vhosts.last_client_prefix64(subject) ==
               SourceMapping.client_key({203, 0, 113, 7})
    end

    test "records for a visitor subject too (one door — user + visitor)" do
      visitor = visitor_fixture()
      {:ok, session} = Accounts.create_session({:visitor, visitor.id}, "1.2.3.4", "ua", [])
      subject = {:visitor, visitor.id}

      assert {:ok, _} =
               connect_with_peer(session.id, {127, 0, 0, 1}, [
                 {"x-forwarded-for", "203.0.113.42"}
               ])

      TaskSupervisorHelpers.drain_children()

      assert Vhosts.last_client_prefix64(subject) ==
               SourceMapping.client_key({203, 0, 113, 42})
    end

    test "connect still succeeds and captures nothing when peer_data is absent" do
      user_name = "vjt-#{System.unique_integer([:positive])}"
      {user, session} = user_and_session(name: user_name)
      subject = {:user, user.id}

      # No peer_data key at all — the pre-Part-C connect_info shape. Connect
      # proceeds; capture is silently skipped (no crash, nothing recorded).
      assert {:ok, _} =
               Phoenix.ChannelTest.connect(UserSocket, %{}, connect_info: %{auth_token: session.id})

      # #1618 — drain first, so "nothing recorded" cannot pass merely because
      # a detached capture task had not got there yet: the skip must be a
      # skip, not a race we outran.
      TaskSupervisorHelpers.drain_children()

      assert Vhosts.last_client_prefix64(subject) == nil
    end

    test "connect succeeds and captures nothing for a structurally-invalid peer address" do
      user_name = "vjt-#{System.unique_integer([:positive])}"
      {user, session} = user_and_session(name: user_name)
      subject = {:user, user.id}

      # A tuple that is NOT an IP-arity tuple (4 v4 / 8 v6) is garbage
      # peer_data the real transport can't produce; the `ip_tuple?/1` guard
      # skips capture rather than letting `SourceMapping.client_key/1` raise
      # and fail the connect.
      assert {:ok, _} =
               Phoenix.ChannelTest.connect(UserSocket, %{},
                 connect_info: %{
                   auth_token: session.id,
                   peer_data: %{address: {1, 2, 3}, port: 12_345, ssl_cert: nil},
                   x_headers: []
                 }
               )

      TaskSupervisorHelpers.drain_children()

      assert Vhosts.last_client_prefix64(subject) == nil
    end
  end

  # #1618 — the capture write is best-effort by CONTRACT already: #523 made
  # `Vhosts.record_client_source/2` swallow `:db_unavailable` precisely so it
  # could never fail a connect. What it was not is best-effort in LATENCY.
  # The call sat between authentication and `{:ok, socket}`, and Phoenix holds
  # the WebSocket upgrade open until `connect/3` returns — so a writer holding
  # the SQLite write lock made the upgrade wait the whole `busy_timeout`
  # (31 575 ms measured on one `scripts/integration.sh` run) and then DROP the
  # write it had waited for. Detaching it to `Grappa.TaskSupervisor` is what
  # makes "this can never hurt a connect" true of the clock as well as of the
  # result.
  #
  # Proven by the PROCESS the write runs in, not by a wall-clock threshold
  # (which would be flaky and would need a real 30 s lock to be honest):
  # `Phoenix.ChannelTest.connect/3` invokes `connect/3` in THIS test process,
  # so a synchronous capture reports `self()` and the `refute` fails. The
  # probe is Ecto's own `[:grappa, :repo, :query]` event — the one
  # `Grappa.DbLatency` already consumes — which fires in whichever process ran
  # the query, so there is no production seam this test could be satisfied by
  # instead of the real write.
  describe "connect/3 client-source capture is off the upgrade path (#1618)" do
    setup do
      on_exit(&TaskSupervisorHelpers.drain_children/0)
      :ok
    end

    test "runs the user_settings write in a task process, not the connect process" do
      {user, session} = user_and_session(name: "vjt-#{System.unique_integer([:positive])}")
      test_pid = self()
      handler = "ws-client-source-probe-#{System.unique_integer([:positive])}"

      :telemetry.attach(
        handler,
        [:grappa, :repo, :query],
        fn _, _, metadata, _ ->
          if Map.get(metadata, :source) == "user_settings" do
            send(test_pid, {:user_settings_query_in, self()})
          end
        end,
        nil
      )

      on_exit(fn -> :telemetry.detach(handler) end)

      # Nothing before the capture touches `user_settings` (auth reads
      # `accounts_sessions` + `users`), so the FIRST such query after the
      # attach is the capture's own.
      assert {:ok, _} = connect_with_peer(session.id, {203, 0, 113, 7}, [])

      assert_receive {:user_settings_query_in, exec_pid}, 2_000
      refute exec_pid == test_pid

      # And it is a DEFERRAL, not a drop — once the task exits the sample is
      # persisted exactly as the synchronous path persisted it.
      TaskSupervisorHelpers.drain_children()

      assert Grappa.Vhosts.last_client_prefix64({:user, user.id}) ==
               Grappa.Vhosts.SourceMapping.client_key({203, 0, 113, 7})
    end
  end

  describe "id/1 visitor branch" do
    test "scopes the per-socket id by visitor:<id>" do
      visitor = visitor_fixture()
      {:ok, session} = Accounts.create_session({:visitor, visitor.id}, "1.2.3.4", "ua", [])
      {:ok, socket} = connect_via_subprotocol(session.id)

      assert UserSocket.id(socket) == "user_socket:visitor:" <> visitor.id
    end
  end

  describe "id_for_subject/1 (W6 — topology helper)" do
    # W6: AuthController.maybe_disconnect_socket/1 used to inline the
    # `"user_socket:"` prefix at the broadcast site. A typo in either
    # place (or a future shape change to id/1) silently broke disconnect
    # — broadcast on the wrong topic = no subscribers = no-op = stale
    # WS keeps receiving pushes after logout. The helper is the single
    # source: id/1 routes through it and the disconnect broadcast does
    # too, so the two stay byte-equal by construction.
    test "user subject — equals UserSocket.id/1 of the matching connect" do
      user_name = "vjt-#{System.unique_integer([:positive])}"
      {user, session} = user_and_session(name: user_name)
      {:ok, socket} = connect_via_subprotocol(session.id)

      assert UserSocket.id_for_subject({:user, user}) == UserSocket.id(socket)
    end

    test "visitor subject — equals UserSocket.id/1 of the matching connect" do
      visitor = visitor_fixture()
      {:ok, session} = Accounts.create_session({:visitor, visitor.id}, "1.2.3.4", "ua", [])
      {:ok, socket} = connect_via_subprotocol(session.id)

      assert UserSocket.id_for_subject({:visitor, visitor}) == UserSocket.id(socket)
    end
  end
end
