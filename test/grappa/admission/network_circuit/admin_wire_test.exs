defmodule Grappa.Admission.NetworkCircuit.AdminWireTest do
  @moduledoc """
  Pure projection tests for `NetworkCircuit.AdminWire`. No GenServer
  or ETS table access — every test constructs the ETS-shape tuple
  literal + a frozen `now_ms` and asserts the rendered map.
  """
  use ExUnit.Case, async: true

  alias Grappa.Admission.NetworkCircuit.AdminWire

  describe "entry_to_admin_json/2" do
    test "nil entry → nil" do
      assert AdminWire.entry_to_admin_json(nil, 0) == nil
    end

    test "closed entry → state=closed + retry_after_seconds=0" do
      entry = {42, 3, 1_000, :closed, 0}

      assert %{
               state: "closed",
               failure_count: 3,
               window_start_ms: 1_000,
               cooled_at_ms: 0,
               retry_after_seconds: 0
             } = AdminWire.entry_to_admin_json(entry, 5_000)
    end

    test "open entry with cooldown in the future → positive retry_after_seconds" do
      now = 10_000
      cooled_at = now + 7_500
      entry = {42, 5, 1_000, :open, cooled_at}

      assert %{
               state: "open",
               failure_count: 5,
               retry_after_seconds: 8
             } = AdminWire.entry_to_admin_json(entry, now)
    end

    test "open entry with cooldown in the past → retry_after_seconds=0" do
      # Cooldown elapsed but the cooldown_expire cast hasn't drained
      # yet. Wire shape mustn't surface negative seconds — operator
      # console reads zero as "ready to re-allow".
      now = 10_000
      entry = {42, 5, 1_000, :open, now - 500}

      assert %{state: "open", retry_after_seconds: 0} =
               AdminWire.entry_to_admin_json(entry, now)
    end

    test "open entry with cooldown == now → retry_after_seconds=0" do
      now = 10_000
      entry = {42, 5, 1_000, :open, now}

      assert %{retry_after_seconds: 0} = AdminWire.entry_to_admin_json(entry, now)
    end
  end
end
