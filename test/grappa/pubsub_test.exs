defmodule Grappa.PubSubTest do
  @moduledoc """
  Unit tests for `Grappa.PubSub.broadcast_event/2`.

  ## Test isolation

  `async: true`. The test exercises the function-clause guard purely
  by argument shape; no Phoenix.PubSub server interaction needed for
  the failing path. The success path subscribes the test pid to a
  unique topic per test and asserts the framework `%Broadcast{}`
  fan-out shape.
  """
  use ExUnit.Case, async: true

  alias Grappa.PubSub
  alias Phoenix.Socket.Broadcast

  describe "broadcast_event/2 struct guard (no-silent-drops B6.2 / HIGH-18)" do
    # CP15 B6 root cause was a raw %Window{} reaching fastlane!/1 — the
    # pre-fix `%{} = payload` guard matched every struct because every
    # %__MODULE__{} is also a %{}. Now `is_map(payload) and not
    # is_struct(payload)` rejects structs at the broadcast site so the
    # wrong shape surfaces as a FunctionClauseError at the call site
    # rather than an opaque encoder crash inside the framework's
    # fan-out.
    test "rejects struct payloads with FunctionClauseError" do
      # A schema-shaped struct stand-in: any defstruct'd module qualifies.
      assert_raise FunctionClauseError, fn ->
        PubSub.broadcast_event("grappa:user:test", %URI{scheme: "https"})
      end
    end

    test "accepts plain map payloads" do
      topic = "grappa:test:#{System.unique_integer([:positive])}"
      payload = %{kind: "test_event", body: "hello"}

      Phoenix.PubSub.subscribe(Grappa.PubSub, topic)
      assert :ok = PubSub.broadcast_event(topic, payload)

      assert_receive %Broadcast{topic: ^topic, event: "event", payload: ^payload}, 100
    end

    test "rejects non-map payloads" do
      assert_raise FunctionClauseError, fn ->
        PubSub.broadcast_event("grappa:user:test", "not a map")
      end

      assert_raise FunctionClauseError, fn ->
        PubSub.broadcast_event("grappa:user:test", nil)
      end
    end

    test "rejects non-binary topic" do
      assert_raise FunctionClauseError, fn ->
        PubSub.broadcast_event(:not_a_string, %{ok: true})
      end
    end
  end

  # HIGH-5 (no-silent-drops B6.8 2026-05-14): broadcast_event/2 used to
  # discard the dispatcher's `:ok | {:error, term()}` return — silent
  # drops at the streaming-surface heart. Now the return is surfaced
  # and a `[:grappa, :pubsub, :broadcast_failed]` telemetry event is
  # emitted on `{:error, _}`. Local PG2 adapter rarely errors but
  # serializer fastlane CAN fail (CP15 B6 class) — telemetry gives
  # ops visibility instead of stale UI badges hours later.
  describe "broadcast_event/2 return value + telemetry (HIGH-5)" do
    test "returns :ok on successful broadcast" do
      topic = "grappa:test:#{System.unique_integer([:positive])}"
      assert :ok = PubSub.broadcast_event(topic, %{kind: "ok"})
    end

    test "emits no failure telemetry on success path" do
      handler_id = "test-no-failure-#{System.unique_integer([:positive])}"
      parent = self()

      :telemetry.attach(
        handler_id,
        [:grappa, :pubsub, :broadcast_failed],
        fn event, measurements, metadata, _ ->
          send(parent, {:telemetry, event, measurements, metadata})
        end,
        nil
      )

      try do
        topic = "grappa:test:#{System.unique_integer([:positive])}"
        assert :ok = PubSub.broadcast_event(topic, %{kind: "no_fail"})
        refute_receive {:telemetry, [:grappa, :pubsub, :broadcast_failed], _, _}, 50
      after
        :telemetry.detach(handler_id)
      end
    end

    test "surfaces dispatcher {:error, reason} + emits telemetry" do
      handler_id = "test-broadcast-failed-#{System.unique_integer([:positive])}"
      parent = self()

      :telemetry.attach(
        handler_id,
        [:grappa, :pubsub, :broadcast_failed],
        fn event, measurements, metadata, _ ->
          send(parent, {:telemetry, event, measurements, metadata})
        end,
        nil
      )

      try do
        # Drive the failure path by calling do_broadcast/3 with an
        # adapter that returns {:error, _} synthetically. We can't
        # invoke the Phoenix dispatcher's failure branch in unit tests
        # without monkeypatching (an unregistered PubSub raises rather
        # than returning {:error, _}), so we exercise the wrapper by
        # invoking the failure surfacing helper directly.
        topic = "grappa:test:#{System.unique_integer([:positive])}"

        assert {:error, :synthetic_failure} =
                 PubSub.handle_broadcast_result({:error, :synthetic_failure}, topic)

        assert_receive {:telemetry, [:grappa, :pubsub, :broadcast_failed], %{count: 1},
                        %{topic: ^topic, reason: :synthetic_failure}},
                       200
      after
        :telemetry.detach(handler_id)
      end
    end
  end
end
