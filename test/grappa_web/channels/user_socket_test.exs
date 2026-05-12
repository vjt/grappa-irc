defmodule GrappaWeb.UserSocketTest do
  @moduledoc """
  WebSocket connect-time auth (sub-task 2i).

  `UserSocket.connect/3` flips from the Phase 1 hardcoded
  `user_name: "vjt"` to a token-derived assign chain:

    * params: `%{"token" => bearer}` — the same UUID PK that
      `Accounts.create_session/3` returns + the REST surface
      consumes via `Authorization: Bearer ...`.
    * `Accounts.authenticate(token)` validates + bumps `last_seen_at`
      with the same 60 s threshold the REST plug uses.
    * On success: `socket.assigns.user_name` (from the User row) and
      `:current_session_id` (for future revocation hooks).
    * On any failure (missing param, malformed UUID, unknown row,
      revoked, expired): `:error` so Phoenix returns the standard
      WS rejection — distinct error strings would just leak
      enumeration info.

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

  defp connect_with(params) do
    Phoenix.ChannelTest.connect(UserSocket, params, connect_info: %{})
  end

  describe "connect/3" do
    test "returns :error when no token param is given" do
      assert :error = connect_with(%{})
    end

    test "returns :error for a malformed (non-UUID) token" do
      assert :error = connect_with(%{"token" => "not-a-uuid"})
    end

    test "returns :error for a UUID that does not match any session" do
      assert :error = connect_with(%{"token" => Ecto.UUID.generate()})
    end

    test "returns :error for a revoked token" do
      {_, session} = user_and_session(name: "vjt-#{System.unique_integer([:positive])}")
      _ = Accounts.revoke_session(session.id)

      assert :error = connect_with(%{"token" => session.id})
    end

    test "assigns :user_name + :current_session_id on success" do
      user_name = "vjt-#{System.unique_integer([:positive])}"
      {_, session} = user_and_session(name: user_name)

      assert {:ok, socket} = connect_with(%{"token" => session.id})
      assert socket.assigns.user_name == user_name
      assert socket.assigns.current_session_id == session.id
    end
  end

  describe "id/1" do
    test "scopes the per-user socket id by user_name" do
      user_name = "vjt-#{System.unique_integer([:positive])}"
      {_, session} = user_and_session(name: user_name)
      {:ok, socket} = connect_with(%{"token" => session.id})

      assert UserSocket.id(socket) == "user_socket:#{user_name}"
    end
  end

  describe "cross-user join authz (2i regression)" do
    test "alice's authenticated socket cannot join vjt's user topic" do
      vjt_name = "vjt-#{System.unique_integer([:positive])}"
      _ = user_fixture(name: vjt_name)

      {_, alice_session} =
        user_and_session(name: "alice-#{System.unique_integer([:positive])}")

      {:ok, socket} = connect_with(%{"token" => alice_session.id})

      assert {:error, %{reason: "forbidden"}} =
               Phoenix.ChannelTest.subscribe_and_join(socket, Topic.user(vjt_name), %{})
    end
  end

  describe "connect/3 visitor token path" do
    test "visitor token assigns :user_name = visitor:<id> + :current_visitor_id" do
      visitor = visitor_fixture()
      {:ok, session} = Accounts.create_session({:visitor, visitor.id}, "1.2.3.4", "ua", [])

      assert {:ok, socket} = connect_with(%{"token" => session.id})
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

      assert :error = connect_with(%{"token" => session.id})
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

      assert {:ok, _} = connect_with(%{"token" => session.id})

      visitor_name = "visitor:" <> visitor.id
      assert visitor_name in Grappa.WSPresence.list_user_names()
    end
  end

  describe "id/1 visitor branch" do
    test "scopes the per-socket id by visitor:<id>" do
      visitor = visitor_fixture()
      {:ok, session} = Accounts.create_session({:visitor, visitor.id}, "1.2.3.4", "ua", [])
      {:ok, socket} = connect_with(%{"token" => session.id})

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
      {:ok, socket} = connect_with(%{"token" => session.id})

      assert UserSocket.id_for_subject({:user, user}) == UserSocket.id(socket)
    end

    test "visitor subject — equals UserSocket.id/1 of the matching connect" do
      visitor = visitor_fixture()
      {:ok, session} = Accounts.create_session({:visitor, visitor.id}, "1.2.3.4", "ua", [])
      {:ok, socket} = connect_with(%{"token" => session.id})

      assert UserSocket.id_for_subject({:visitor, visitor}) == UserSocket.id(socket)
    end
  end
end
