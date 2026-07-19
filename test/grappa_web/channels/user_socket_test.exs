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

  import Grappa.AuthFixtures

  alias Grappa.{Accounts, PubSub.Topic}
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

  # #95 + #202 — connect observability: connect/3 emits a
  # [:grappa, :ws, :connect] counter on every authenticated connect. #202
  # dropped the `auth_method` metadata tag — it had collapsed to a
  # constant `:subprotocol` once the query-string fallback was removed —
  # leaving a bare `%{count: 1}` measurement with EMPTY metadata. The
  # token value is NEVER emitted (the raw bearer IS the session
  # credential — S9).
  describe "connect telemetry (#95 / #202)" do
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

    test "emits the connect counter with empty metadata on an authenticated connect", %{ref: ref} do
      {_, session} = user_and_session(name: "vjt-#{System.unique_integer([:positive])}")

      assert {:ok, _} = connect_via_subprotocol(session.id)
      assert_receive {^ref, measurements, metadata}
      assert measurements == %{count: 1}
      assert metadata == %{}
    end

    test "emits NO connect event on an auth failure (counter is post-auth)", %{ref: ref} do
      assert :error = connect_via_subprotocol(Ecto.UUID.generate())
      refute_receive {^ref, _, _}
    end
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
