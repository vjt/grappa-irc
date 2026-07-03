defmodule Grappa.AdminEvents.WireTest do
  @moduledoc """
  Wire-shape contract tests for `Grappa.AdminEvents.Wire`. Closed-union
  discipline per `feedback_no_silent_drops_closed`:

    * Every constructor renders a typed map with a `:kind` discriminator.
    * `from_telemetry/3` translates known events; `:operator_reset`
      circuit-close path is intentionally `:skip` (operator events emit
      a synthetic `:circuit_reset` via `AdminEvents.record/1` with
      actor attribution, so the telemetry-side reset would double-emit).
    * `from_telemetry/3` raises `FunctionClauseError` on an unknown event
      name — exact closed-union signal so adding a new attached event
      without a Wire arm fails loudly.
  """
  use Grappa.DataCase, async: true

  alias Grappa.AdminEvents.Wire

  describe "circuit_open/4" do
    test "renders the typed wire shape" do
      event = Wire.circuit_open(1, "azzurra", 3, 60_000)

      assert event.kind == :circuit_open
      assert event.network_id == 1
      assert event.network_slug == "azzurra"
      assert event.threshold == 3
      assert event.cooldown_ms == 60_000
      assert is_binary(event.at)
    end

    test "accepts nil network_slug for deleted-network race" do
      event = Wire.circuit_open(99, nil, 3, 60_000)
      assert event.network_slug == nil
    end
  end

  describe "circuit_close/3" do
    test ":success reason" do
      event = Wire.circuit_close(1, "azzurra", :success)
      assert event.kind == :circuit_close
      assert event.reason == :success
    end

    test ":cooldown_expired reason" do
      event = Wire.circuit_close(1, "azzurra", :cooldown_expired)
      assert event.reason == :cooldown_expired
    end

    test "rejects :operator_reset (synthetic-only)" do
      # The constructor refuses :operator_reset because that path emits
      # a synthetic `:circuit_reset` event via record/1 with actor
      # attribution; passing :operator_reset here would silently strip
      # the actor.
      assert_raise FunctionClauseError, fn ->
        Wire.circuit_close(1, "azzurra", :operator_reset)
      end
    end
  end

  describe "capacity_reject/5" do
    test "atom error" do
      event = Wire.capacity_reject(:visitor, :network_cap_exceeded, 1, "azzurra", "203.0.113.5")
      assert event.kind == :capacity_reject
      assert event.flow == :visitor
      assert event.error == "network_cap_exceeded"
      assert event.source_ip == "203.0.113.5"
    end

    test "tuple error renders via inspect" do
      event = Wire.capacity_reject(:user, {:network_circuit_open, 60_000}, 1, "azzurra", nil)
      assert event.error == "{:network_circuit_open, 60000}"
      assert event.source_ip == nil
    end
  end

  describe "visitor_deleted/5" do
    test "renders with actor" do
      event =
        Wire.visitor_deleted("v-uuid", "S`grappa", "azzurra", "u-uuid", "vjt")

      assert event.kind == :visitor_deleted
      assert event.visitor_id == "v-uuid"
      assert event.visitor_nick == "S`grappa"
      assert event.actor_user_id == "u-uuid"
      assert event.actor_user_name == "vjt"
    end

    test "renders with nil actor (system path)" do
      event = Wire.visitor_deleted("v-uuid", "S`grappa", "azzurra", nil, nil)
      assert event.actor_user_id == nil
      assert event.actor_user_name == nil
    end
  end

  describe "visitor_reaped/3 + reaper_swept/1" do
    test "visitor_reaped" do
      event = Wire.visitor_reaped("v-uuid", "nick", "azzurra")
      assert event.kind == :visitor_reaped
    end

    test "reaper_swept" do
      event = Wire.reaper_swept(5)
      assert event.kind == :reaper_swept
      assert event.count == 5
    end

    test "reaper_swept refuses negative count" do
      assert_raise FunctionClauseError, fn -> Wire.reaper_swept(-1) end
    end
  end

  describe "session_disconnected/6 + session_terminated/6" do
    test "session_disconnected user subject" do
      event =
        Wire.session_disconnected(:user, "u-uuid", 1, "azzurra", "actor-id", "vjt")

      assert event.kind == :session_disconnected
      assert event.subject_kind == :user
    end

    test "session_terminated visitor subject" do
      event =
        Wire.session_terminated(:visitor, "v-uuid", 1, "azzurra", "actor-id", "vjt")

      assert event.kind == :session_terminated
      assert event.subject_kind == :visitor
    end

    test "rejects unknown subject_kind" do
      assert_raise FunctionClauseError, fn ->
        Wire.session_terminated(:robot, "id", 1, "n", "a", "b")
      end
    end
  end

  describe "network_caps_updated/7" do
    test "renders with all three caps set" do
      event = Wire.network_caps_updated(1, "azzurra", 5, 7, 2, "u-id", "vjt")
      assert event.kind == :network_caps_updated
      assert event.max_concurrent_visitor_sessions == 5
      assert event.max_concurrent_user_sessions == 7
      assert event.max_per_ip == 2
    end

    test "nil caps mean unlimited" do
      event = Wire.network_caps_updated(1, "azzurra", nil, nil, nil, nil, nil)
      assert event.max_concurrent_visitor_sessions == nil
      assert event.max_concurrent_user_sessions == nil
      assert event.max_per_ip == nil
    end

    test "rejects empty slug" do
      assert_raise FunctionClauseError, fn ->
        Wire.network_caps_updated(1, "", 5, 7, 2, nil, nil)
      end
    end
  end

  describe "circuit_reset/4" do
    test "renders with actor" do
      event = Wire.circuit_reset(1, "azzurra", "u-id", "vjt")
      assert event.kind == :circuit_reset
      assert event.actor_user_name == "vjt"
    end
  end

  describe "cap_counts_changed/5" do
    test "renders the typed wire shape" do
      event = Wire.cap_counts_changed(7, "azzurra", %{visitors: 2, users: 1}, 3, 3)

      assert event.kind == :cap_counts_changed
      assert event.network_id == 7
      assert event.network_slug == "azzurra"
      assert event.visitors == 2
      assert event.users == 1
      assert event.max_concurrent_visitor_sessions == 3
      assert event.max_concurrent_user_sessions == 3
      assert is_binary(event.at)
    end

    test "accepts nil caps (unlimited)" do
      event = Wire.cap_counts_changed(7, "azzurra", %{visitors: 0, users: 0}, nil, nil)

      assert event.max_concurrent_visitor_sessions == nil
      assert event.max_concurrent_user_sessions == nil
    end

    test "rejects nil network_slug (REV-H H5: broadcaster early-returns on missing network)" do
      # `AdminEvents.broadcast_lifecycle/3` short-circuits when
      # `Networks.get_network/1` returns nil, so `cap_counts_changed`
      # NEVER fires with a nil slug. The boundary enforces it.
      # `apply/3` defeats the Elixir 1.19 set-theoretic compile-time
      # type checker which would flag the nil literal as the wrong
      # type before the runtime FunctionClauseError fires.
      assert_raise FunctionClauseError, fn ->
        apply(Wire, :cap_counts_changed, [7, nil, %{visitors: 0, users: 0}, nil, nil])
      end
    end

    test "rejects negative counts" do
      assert_raise FunctionClauseError, fn ->
        Wire.cap_counts_changed(7, "azzurra", %{visitors: -1, users: 0}, nil, nil)
      end
    end
  end

  # ----- Admin-panel bucket 4 mutation constructors -------------------
  #
  # Each describe block pins (a) the wire shape, (b) the closed-union
  # `kind:` discriminator, (c) the actor-presence invariant: admin-
  # mutation events ALWAYS carry a non-nil operator, so a nil actor
  # arm trips `FunctionClauseError` at the boundary (different from
  # the visitor/session events whose `validate_actor/2` accepts the
  # system-path nil pair).

  describe "user_created/5" do
    test "renders the typed wire shape" do
      event = Wire.user_created("u-uuid", "alice", false, "actor-id", "vjt")
      assert event.kind == :user_created
      assert event.user_id == "u-uuid"
      assert event.user_name == "alice"
      assert event.is_admin == false
      assert event.actor_user_id == "actor-id"
      assert event.actor_user_name == "vjt"
      assert is_binary(event.at)
    end

    test "admin-promote on create renders is_admin: true" do
      event = Wire.user_created("u-uuid", "bob", true, "actor-id", "vjt")
      assert event.is_admin == true
    end

    test "rejects nil actor (admin-only path, no system emitter)" do
      assert_raise FunctionClauseError, fn ->
        apply(Wire, :user_created, ["u-uuid", "alice", false, nil, nil])
      end
    end
  end

  describe "user_updated/5" do
    test "renders with is_admin flip" do
      event = Wire.user_updated("u-uuid", "alice", true, "actor-id", "vjt")
      assert event.kind == :user_updated
      assert event.is_admin == true
    end

    test "rejects non-boolean is_admin" do
      assert_raise FunctionClauseError, fn ->
        apply(Wire, :user_updated, ["u-uuid", "alice", "true", "actor", "vjt"])
      end
    end
  end

  describe "user_password_changed/4" do
    test "renders the typed wire shape (no password body)" do
      event = Wire.user_password_changed("u-uuid", "alice", "actor-id", "vjt")
      assert event.kind == :user_password_changed
      assert event.user_id == "u-uuid"
      assert event.user_name == "alice"
      refute Map.has_key?(event, :password)
    end

    test "rejects nil actor" do
      assert_raise FunctionClauseError, fn ->
        apply(Wire, :user_password_changed, ["u-uuid", "alice", nil, nil])
      end
    end
  end

  describe "user_deleted/4" do
    test "renders the typed wire shape" do
      event = Wire.user_deleted("u-uuid", "alice", "actor-id", "vjt")
      assert event.kind == :user_deleted
      assert event.user_id == "u-uuid"
    end
  end

  describe "network_created/4" do
    test "renders the typed wire shape" do
      event = Wire.network_created(7, "azzurra", "actor-id", "vjt")
      assert event.kind == :network_created
      assert event.network_id == 7
      assert event.network_slug == "azzurra"
    end

    test "rejects empty slug" do
      assert_raise FunctionClauseError, fn ->
        Wire.network_created(7, "", "actor-id", "vjt")
      end
    end
  end

  describe "network_deleted/4" do
    test "renders the typed wire shape" do
      event = Wire.network_deleted(7, "azzurra", "actor-id", "vjt")
      assert event.kind == :network_deleted
      assert event.network_id == 7
    end
  end

  describe "server_added/8" do
    test "renders the typed wire shape" do
      event = Wire.server_added(7, "azzurra", 42, "irc.example.org", 6697, true, "actor-id", "vjt")
      assert event.kind == :server_added
      assert event.network_id == 7
      assert event.network_slug == "azzurra"
      assert event.server_id == 42
      assert event.host == "irc.example.org"
      assert event.port == 6697
      assert event.tls == true
    end

    test "plain-text endpoint" do
      event = Wire.server_added(7, "azzurra", 42, "irc.example.org", 6667, false, "a", "vjt")
      assert event.tls == false
      assert event.port == 6667
    end

    test "rejects empty slug" do
      assert_raise FunctionClauseError, fn ->
        Wire.server_added(7, "", 42, "irc.example.org", 6697, true, "a", "vjt")
      end
    end
  end

  describe "server_updated/8" do
    test "renders the typed wire shape" do
      event =
        Wire.server_updated(7, "azzurra", 42, "irc.example.org", 6697, true, "actor-id", "vjt")

      assert event.kind == :server_updated
      assert event.host == "irc.example.org"
    end
  end

  describe "server_removed/7" do
    test "renders the typed wire shape" do
      event = Wire.server_removed(7, "azzurra", 42, "irc.example.org", 6697, "actor-id", "vjt")
      assert event.kind == :server_removed
      assert event.server_id == 42
      refute Map.has_key?(event, :tls)
    end
  end

  describe "credential_bound/7" do
    test "renders the typed wire shape" do
      event =
        Wire.credential_bound("u-uuid", "alice", 7, "azzurra", "alice_irc", "actor-id", "vjt")

      assert event.kind == :credential_bound
      assert event.user_id == "u-uuid"
      assert event.user_name == "alice"
      assert event.network_id == 7
      assert event.network_slug == "azzurra"
      assert event.nick == "alice_irc"
    end

    test "rejects empty slug" do
      assert_raise FunctionClauseError, fn ->
        Wire.credential_bound("u-uuid", "alice", 7, "", "nick", "a", "vjt")
      end
    end
  end

  describe "credential_updated/7" do
    test ":left_alone session action" do
      event =
        Wire.credential_updated("u-uuid", "alice", 7, "azzurra", :left_alone, "actor-id", "vjt")

      assert event.kind == :credential_updated
      assert event.session_action == :left_alone
    end

    test ":stopped session action" do
      event = Wire.credential_updated("u-uuid", "alice", 7, "azzurra", :stopped, "a", "vjt")
      assert event.session_action == :stopped
    end

    test "rejects unknown session_action" do
      assert_raise FunctionClauseError, fn ->
        Wire.credential_updated("u-uuid", "alice", 7, "azzurra", :restarted, "a", "vjt")
      end
    end
  end

  describe "credential_unbound/6" do
    test "renders the typed wire shape" do
      event = Wire.credential_unbound("u-uuid", "alice", 7, "azzurra", "actor-id", "vjt")
      assert event.kind == :credential_unbound
      assert event.user_id == "u-uuid"
      assert event.network_slug == "azzurra"
    end
  end

  describe "from_telemetry/3" do
    test "translates :circuit, :open" do
      event =
        Wire.from_telemetry(
          [:grappa, :admission, :circuit, :open],
          %{},
          %{network_id: 9999, threshold: 3, cooldown_ms: 60_000}
        )

      assert event.kind == :circuit_open
      # network_slug is nil because no network row exists for id 9999
      assert event.network_slug == nil
    end

    test "translates :circuit, :close :success" do
      event =
        Wire.from_telemetry(
          [:grappa, :admission, :circuit, :close],
          %{},
          %{network_id: 9999, reason: :success}
        )

      assert event.kind == :circuit_close
      assert event.reason == :success
    end

    test "translates :circuit, :close :cooldown_expired" do
      event =
        Wire.from_telemetry(
          [:grappa, :admission, :circuit, :close],
          %{},
          %{network_id: 9999, reason: :cooldown_expired}
        )

      assert event.reason == :cooldown_expired
    end

    test "skips :circuit, :close :operator_reset (synthetic path)" do
      result =
        Wire.from_telemetry(
          [:grappa, :admission, :circuit, :close],
          %{},
          %{network_id: 9999, reason: :operator_reset}
        )

      assert result == :skip
    end

    test "translates :capacity, :reject" do
      event =
        Wire.from_telemetry(
          [:grappa, :admission, :capacity, :reject],
          %{},
          %{flow: :visitor, error: :network_cap_exceeded, network_id: 9999, source_ip: nil}
        )

      assert event.kind == :capacity_reject
    end

    test "raises FunctionClauseError on unknown event name (closed-union invariant)" do
      # Adding a new :telemetry.attach_many entry in AdminEvents.init/1
      # without a matching from_telemetry/3 arm MUST raise here so the
      # silent-drop class doesn't reach the wire.
      #
      # `apply/3` avoids a compile-time type-check warning: the Wire
      # function's typespec narrows the event name to the closed
      # admission-event union, so a direct call with an unknown name
      # trips Elixir's static typing analyzer. The runtime invariant
      # (FunctionClauseError on call) is what we test here.
      assert_raise FunctionClauseError, fn ->
        apply(Wire, :from_telemetry, [[:grappa, :totally, :new, :event], %{}, %{anything: 1}])
      end
    end
  end
end
