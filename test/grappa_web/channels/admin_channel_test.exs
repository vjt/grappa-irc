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

  import ExUnit.CaptureLog
  import Grappa.AuthFixtures

  alias Grappa.{AdminEvents, AdminOverview, AdmissionStateHelpers, Repo, SessionLog}
  alias Grappa.AdminEvents.Wire
  alias Grappa.PubSub.Topic
  alias GrappaWeb.UserSocket
  alias Phoenix.Socket.Broadcast

  setup do
    # The ring must start empty so the snapshot push contains exactly
    # what THIS test queued.
    AdmissionStateHelpers.reset_admin_events()

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
      is_admin: is_admin,
      # #1196 — `UserSocket.connect/3` assigns the authenticated row's
      # kind; `:web` is what an ordinary browser handshake produces.
      current_session_kind: Keyword.get(opts, :session_kind, :web)
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

    test "an admin's per-client token rejected forbidden" do
      # #1196 — the console's live feed comes through this socket, not
      # through REST, so the scope gate has to exist on both doors. An
      # admin holding a client token is admin AND scoped: the token is
      # for reading and sending, never for operating the bouncer.
      admin = user_fixture(is_admin: true)

      socket =
        build_socket(admin.name, {:user, admin.id}, is_admin: true, session_kind: :client)

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

  describe "overview push (#1075)" do
    test "join pushes the overview snapshot the top bar renders" do
      # Hostname and version are constants for the life of the socket;
      # they ride the join push rather than the stream. The counts ride
      # it too so the bar is populated before the first tick elapses
      # (cold-WS-subscribe parity with the events snapshot above).
      admin = user_fixture(is_admin: true)
      socket = build_socket(admin.name, {:user, admin.id}, is_admin: true)

      {:ok, _, _} = subscribe_and_join(socket, "grappa:admin:events", %{})

      assert_push "overview", %{
        sessions: sessions,
        visitors: %{total: _, live: _},
        hostname: hostname,
        version: version
      }

      assert is_integer(sessions)
      assert is_binary(hostname) and hostname != ""
      assert version == Grappa.Version.current()
    end

    test "the tick re-pushes without the client asking" do
      # Loadavg is a SAMPLED quantity — it has no event to hang off, so
      # the channel ticks. Squeeze the interval to keep the test honest
      # about cadence without sleeping the production default.
      previous = AdminOverview.push_interval_ms()
      :ok = AdminOverview.put_test_push_interval_ms(50)
      on_exit(fn -> AdminOverview.put_test_push_interval_ms(previous) end)

      admin = user_fixture(is_admin: true)
      socket = build_socket(admin.name, {:user, admin.id}, is_admin: true)

      {:ok, _, _} = subscribe_and_join(socket, "grappa:admin:events", %{})

      assert_push "overview", _
      assert_push "overview", _, 1_000
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

  describe "session_log live push (#215)" do
    test "a Topic.session_log broadcast lands on the admin socket as session_log_event" do
      admin = user_fixture(is_admin: true)
      raw = build_socket(admin.name, {:user, admin.id}, is_admin: true)

      {:ok, _, _} = subscribe_and_join(raw, "grappa:admin:events", %{})
      assert_push "snapshot", _

      event = %SessionLog.Event{
        id: 99,
        session_id: "user:x:7",
        event: :disconnected,
        subject_kind: :user,
        network_id: 7,
        network_slug: "az",
        nick: "vjt",
        reason: ":tcp_closed",
        clean: false,
        duration_ms: 3,
        at: DateTime.utc_now()
      }

      :ok = Grappa.PubSub.broadcast_event(Topic.session_log(), SessionLog.Wire.entry_payload(event))

      assert_push "session_log_event",
                  %{kind: :session_log_event, entry: %{session_id: "user:x:7", event: :disconnected}},
                  500
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

  # W-S7 (#1407) — the info side of the same posture the inbound catch-all
  # above already takes. The barrier in both tests is mailbox ORDER: the
  # `push` is enqueued after the stray message, so a reply can only come
  # back if the stray one was handled without killing the channel pid.
  describe "unhandled info catch-all" do
    test "a stray send is logged and leaves the operator console alive" do
      admin = user_fixture(is_admin: true)
      raw = build_socket(admin.name, {:user, admin.id}, is_admin: true)

      {:ok, _, socket} = subscribe_and_join(raw, "grappa:admin:events", %{})
      assert_push "snapshot", _

      log =
        capture_log(fn ->
          send(socket.channel_pid, :no_clause_matches_this)

          ref = push(socket, "ping", %{})
          assert_reply ref, :ok
        end)

      assert log =~ "unexpected mailbox message"
      assert log =~ "no_clause_matches_this"
    end

    test "a broadcast the channel has no clause for is logged and not fatal" do
      admin = user_fixture(is_admin: true)
      raw = build_socket(admin.name, {:user, admin.id}, is_admin: true)

      {:ok, _, socket} = subscribe_and_join(raw, "grappa:admin:events", %{})
      assert_push "snapshot", _

      log =
        capture_log(fn ->
          send(socket.channel_pid, %Broadcast{
            topic: Topic.session_log(),
            event: "an_event_name_added_later",
            payload: %{}
          })

          ref = push(socket, "ping", %{})
          assert_reply ref, :ok
        end)

      assert log =~ "unexpected mailbox message"
      assert log =~ "an_event_name_added_later"
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

      {:ok, socket} =
        Phoenix.ChannelTest.connect(UserSocket, %{}, connect_info: %{auth_token: session.id})

      assert socket.assigns.is_admin == true

      assert {:ok, _, _} = subscribe_and_join(socket, "grappa:admin:events", %{})
    end

    test "non-admin user connect → AdminChannel forbidden" do
      user = user_fixture(is_admin: false)
      session = session_fixture(user)

      {:ok, socket} =
        Phoenix.ChannelTest.connect(UserSocket, %{}, connect_info: %{auth_token: session.id})

      assert socket.assigns.is_admin == false

      assert {:error, %{error: "forbidden"}} =
               subscribe_and_join(socket, "grappa:admin:events", %{})
    end
  end
end
