defmodule GrappaWeb.AdminChannelTest do
  @moduledoc """
  Channel tests for `GrappaWeb.AdminChannel`.

  `async: false` because the channel pushes the
  `Grappa.AdminEvents.snapshot/0` ring buffer on join, and that
  singleton is shared across the suite (CP25 max_cases: 1 invariant).
  Per-test we reset the buffer to keep the snapshot push deterministic.

  Authz invariants under test:
    1. `{:user, %User{is_admin: true}}` subject can join + receives snapshot.
    2. `{:user, %User{is_admin: false}}` subject rejected `forbidden`.
    3. `{:visitor, _}` subject rejected `forbidden` (visitors can never
       be admin by construction — `is_admin` lives on `User` only).
    4. Missing `current_subject` assign rejected `forbidden`.
    5. A broadcast on `Topic.admin_events/0` lands on the joined socket
       as a `"event"` push (fastlane).
  """
  use GrappaWeb.ChannelCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{AdminEvents, Repo}
  alias Grappa.AdminEvents.Wire
  alias GrappaWeb.UserSocket

  setup do
    # AdminEvents is the global singleton — reset buffer per-test so
    # the snapshot push contains exactly what THIS test queued.
    :sys.replace_state(AdminEvents, fn _ -> %AdminEvents{buffer: []} end)

    # AdminEvents runs in its own supervised pid; allow it on the
    # sandbox connection ChannelCase already checked out (`async:
    # false` → shared mode), so the GenServer's `Wire.lookup_slug/1`
    # Repo lookup doesn't crash on telemetry-translated events.
    Ecto.Adapters.SQL.Sandbox.allow(Repo, self(), Process.whereis(AdminEvents))

    :ok
  end

  # Build a socket with the same assigns shape `UserSocket.connect/3`
  # produces at WS handshake time. Mirror of the production assigns:
  # `:user_name` (string), `:current_subject` (bare-id tuple per V4
  # visitor-parity), `:is_admin` (boolean per M-11). Tests pass the
  # `is_admin` bit explicitly so the admin / non-admin / visitor
  # cases each land the right authz signal.
  defp build_socket(user_name, subject, opts) do
    is_admin = Keyword.get(opts, :is_admin, false)

    socket(UserSocket, "user_socket:test", %{
      user_name: user_name,
      current_subject: subject,
      is_admin: is_admin
    })
  end

  describe "join authz" do
    test "admin user can join" do
      admin = user_fixture(is_admin: true)
      socket = build_socket(admin.name, {:user, admin.id}, is_admin: true)

      assert {:ok, _, _} = subscribe_and_join(socket, "grappa:admin:events", %{})
    end

    test "non-admin user rejected forbidden" do
      user = user_fixture(is_admin: false)
      socket = build_socket(user.name, {:user, user.id}, is_admin: false)

      assert {:error, %{error: "forbidden"}} =
               subscribe_and_join(socket, "grappa:admin:events", %{})
    end

    test "visitor subject rejected forbidden" do
      vid = Ecto.UUID.generate()
      # Visitors are never admins by construction; UserSocket assigns
      # `:is_admin = false` explicitly so the authz lands the same
      # `forbidden` path as a non-admin user.
      socket = build_socket("visitor:" <> vid, {:visitor, vid}, is_admin: false)

      assert {:error, %{error: "forbidden"}} =
               subscribe_and_join(socket, "grappa:admin:events", %{})
    end

    test "missing is_admin assign rejected forbidden" do
      # Raw socket without the `:is_admin` assign — defense-in-depth
      # against a future UserSocket regression that drops the bit.
      socket = socket(UserSocket, "user_socket:bare", %{})

      assert {:error, %{error: "forbidden"}} =
               subscribe_and_join(socket, "grappa:admin:events", %{})
    end

    test "unknown topic on admin route returns unknown topic reason" do
      # The UserSocket routes the exact string `"grappa:admin:events"`
      # to AdminChannel; any other `grappa:admin:*` shape doesn't match
      # the channel registration and Phoenix's transport rejects it at
      # the framework boundary (the AdminChannel.join/3 catch-all only
      # fires for topics that DO route to this channel). The user-facing
      # error path stays "no channel found" — verified end-to-end by
      # the framework's routing.
      admin = user_fixture(is_admin: true)
      socket = build_socket(admin.name, {:user, admin.id}, is_admin: true)

      assert_raise RuntimeError, ~r/no channel found/, fn ->
        subscribe_and_join(socket, "grappa:admin:other", %{})
      end
    end
  end

  describe "snapshot on join" do
    test "delivers the current ring buffer as a snapshot push" do
      :ok = AdminEvents.record(Wire.reaper_swept(7))
      _ = AdminEvents.snapshot()

      admin = user_fixture(is_admin: true)
      socket = build_socket(admin.name, {:user, admin.id}, is_admin: true)

      {:ok, _, _} = subscribe_and_join(socket, "grappa:admin:events", %{})

      assert_push "snapshot", %{events: [%{kind: :reaper_swept, count: 7}]}
    end

    test "empty buffer sends an empty snapshot list" do
      admin = user_fixture(is_admin: true)
      socket = build_socket(admin.name, {:user, admin.id}, is_admin: true)

      {:ok, _, _} = subscribe_and_join(socket, "grappa:admin:events", %{})

      assert_push "snapshot", %{events: []}
    end
  end

  describe "fan-out" do
    test "assert push fan-out lands on the joined admin socket" do
      admin = user_fixture(is_admin: true)
      raw = build_socket(admin.name, {:user, admin.id}, is_admin: true)

      {:ok, _, _} = subscribe_and_join(raw, "grappa:admin:events", %{})
      assert_push "snapshot", _

      :ok = AdminEvents.record(Wire.reaper_swept(11))

      assert_push "event", %{kind: :reaper_swept, count: 11}, 500
    end
  end

  describe "inbound catch-all" do
    test "client-sent messages collapse to :ok reply (no crash)" do
      admin = user_fixture(is_admin: true)
      raw = build_socket(admin.name, {:user, admin.id}, is_admin: true)

      {:ok, _, socket} = subscribe_and_join(raw, "grappa:admin:events", %{})
      assert_push "snapshot", _

      ref = push(socket, "anything", %{})
      assert_reply ref, :ok
    end
  end

  # End-to-end UserSocket.connect/3 coverage. Goes through the real
  # connect path (token → Accounts.authenticate → assign_subject →
  # is_admin). The hand-constructed `build_socket/3` above can lie
  # about the assigns shape if `UserSocket.assign_subject/2` regresses;
  # this test catches that class by driving the production connect
  # surface directly.
  describe "UserSocket.connect produces the assigns AdminChannel needs" do
    test "admin user connect → AdminChannel join OK" do
      admin = user_fixture(is_admin: true)
      session = session_fixture(admin)

      {:ok, socket} = Phoenix.ChannelTest.connect(UserSocket, %{"token" => session.id})
      assert socket.assigns.is_admin == true

      assert {:ok, _, _} = subscribe_and_join(socket, "grappa:admin:events", %{})
    end

    test "non-admin user connect → AdminChannel forbidden" do
      user = user_fixture(is_admin: false)
      session = session_fixture(user)

      {:ok, socket} = Phoenix.ChannelTest.connect(UserSocket, %{"token" => session.id})
      assert socket.assigns.is_admin == false

      assert {:error, %{error: "forbidden"}} =
               subscribe_and_join(socket, "grappa:admin:events", %{})
    end
  end
end
