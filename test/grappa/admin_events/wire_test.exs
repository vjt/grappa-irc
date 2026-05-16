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
      event = Wire.capacity_reject(:visitor, :network_cap_exceeded, 1, "azzurra", "client-abc")
      assert event.kind == :capacity_reject
      assert event.flow == :visitor
      assert event.error == "network_cap_exceeded"
      assert event.client_id == "client-abc"
    end

    test "tuple error renders via inspect" do
      event = Wire.capacity_reject(:user, {:network_circuit_open, 60_000}, 1, "azzurra", nil)
      assert event.error == "{:network_circuit_open, 60000}"
      assert event.client_id == nil
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
      assert event.max_per_client == 2
    end

    test "nil caps mean unlimited" do
      event = Wire.network_caps_updated(1, "azzurra", nil, nil, nil, nil, nil)
      assert event.max_concurrent_visitor_sessions == nil
      assert event.max_concurrent_user_sessions == nil
      assert event.max_per_client == nil
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

    test "accepts nil network_slug for deleted-network race" do
      event = Wire.cap_counts_changed(7, nil, %{visitors: 0, users: 0}, nil, nil)
      assert event.network_slug == nil
    end

    test "rejects negative counts" do
      assert_raise FunctionClauseError, fn ->
        Wire.cap_counts_changed(7, "azzurra", %{visitors: -1, users: 0}, nil, nil)
      end
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
          %{flow: :visitor, error: :network_cap_exceeded, network_id: 9999, client_id: nil}
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
