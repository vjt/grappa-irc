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
      :ok = PubSub.broadcast_event(topic, payload)

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
end
