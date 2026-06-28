defmodule Grappa.Session.WindowStateTest do
  @moduledoc """
  Tests for `Grappa.Session.WindowState` — the per-channel window
  state quartet extracted from `Grappa.Session.Server` (cluster #6,
  Theme 3 / resp-A1 / ext-A9 god-module decomposition).

  CRITICAL invariants asserted here (per CLAUDE.md "Window state
  model lives on the server"):

    * The 5 mutators (`set_pending/2`, `set_joined/2`, `set_failed/4`,
      `set_kicked/4`, `set_parted/2`) are the ONLY way to transition
      a channel's window state. Every state transition emitted by
      `Session.Server.apply_effects/2` arms calls one of these.
    * `set_joined/2` clears prior failure / kicked metadata —
      symmetric with the previous inline mutation in
      `apply_effects([{:joined, _} | _], _)`. A re-join after a fail
      MUST NOT leak the old reason / numeric / kicked-by into the
      next snapshot push.
    * `set_failed/4` records reason + numeric. `set_kicked/4` records
      by + reason. Both maps are sibling to the state map (separate
      maps because the metadata types are heterogeneous and absent
      for non-failure / non-kicked states).
    * `set_parted/2` archives the channel by dropping it from EVERY
      sibling map — cic projects "no key + scrollback present" as
      `:archived`.
    * `to_wire/3` is the single source of truth for the snapshot
      payload (`Session.Server.handle_call({:get_window_state, _}, _)`
      collapses to a one-call dispatch). Snapshot + event-time
      payloads MUST be byte-identical (CP15 B7 invariant inherited).
  """
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.Session.WindowState

  describe "new/0" do
    test "returns an empty struct (no channels tracked)" do
      ws = WindowState.new()

      assert ws.states == %{}
      assert ws.failure_reasons == %{}
      assert ws.failure_numerics == %{}
      assert ws.kicked_meta == %{}
    end
  end

  describe "set_pending/2" do
    test "marks the channel as :pending without touching sibling maps" do
      ws = WindowState.set_pending(WindowState.new(), "#grappa")

      assert WindowState.state_of(ws, "#grappa") == :pending
      assert WindowState.failure_meta(ws, "#grappa") == nil
      assert WindowState.kicked_meta(ws, "#grappa") == nil
    end
  end

  describe "set_invited/2" do
    test "marks the channel as :invited without touching sibling maps (#78)" do
      ws = WindowState.set_invited(WindowState.new(), "#grappa")

      assert WindowState.state_of(ws, "#grappa") == :invited
      assert WindowState.failure_meta(ws, "#grappa") == nil
      assert WindowState.kicked_meta(ws, "#grappa") == nil
    end
  end

  describe "set_joined/2" do
    test "marks the channel as :joined and clears any prior failure / kicked metadata" do
      ws =
        WindowState.new()
        |> WindowState.set_failed("#grappa", "Cannot join (+i)", 473)
        |> WindowState.set_joined("#grappa")

      assert WindowState.state_of(ws, "#grappa") == :joined
      assert WindowState.failure_meta(ws, "#grappa") == nil
      assert WindowState.kicked_meta(ws, "#grappa") == nil
    end

    test "clears kicked metadata when transitioning out of :kicked" do
      ws =
        WindowState.new()
        |> WindowState.set_kicked("#grappa", "vjt", "stop spamming")
        |> WindowState.set_joined("#grappa")

      assert WindowState.state_of(ws, "#grappa") == :joined
      assert WindowState.kicked_meta(ws, "#grappa") == nil
    end

    test "marks the channel as :joined when no prior state exists" do
      ws = WindowState.set_joined(WindowState.new(), "#grappa")

      assert WindowState.state_of(ws, "#grappa") == :joined
    end
  end

  describe "set_failed/4" do
    test "records :failed state plus reason + numeric" do
      ws = WindowState.set_failed(WindowState.new(), "#grappa", "Cannot join channel (+i)", 473)

      assert WindowState.state_of(ws, "#grappa") == :failed

      assert WindowState.failure_meta(ws, "#grappa") == %{
               reason: "Cannot join channel (+i)",
               numeric: 473
             }
    end

    test "overwrites a prior :failed entry with the new reason + numeric" do
      ws =
        WindowState.new()
        |> WindowState.set_failed("#grappa", "Cannot join channel (+i)", 473)
        |> WindowState.set_failed("#grappa", "No such channel", 403)

      assert WindowState.state_of(ws, "#grappa") == :failed
      assert WindowState.failure_meta(ws, "#grappa") == %{reason: "No such channel", numeric: 403}
    end
  end

  describe "set_kicked/4" do
    test "records :kicked state plus by + reason" do
      ws = WindowState.set_kicked(WindowState.new(), "#grappa", "vjt", "stop spamming")

      assert WindowState.state_of(ws, "#grappa") == :kicked
      assert WindowState.kicked_meta(ws, "#grappa") == %{by: "vjt", reason: "stop spamming"}
    end

    test "supports a nil reason (KICK without trailing comment)" do
      ws = WindowState.set_kicked(WindowState.new(), "#grappa", "vjt", nil)

      assert WindowState.state_of(ws, "#grappa") == :kicked
      assert WindowState.kicked_meta(ws, "#grappa") == %{by: "vjt", reason: nil}
    end
  end

  describe "set_parted/2" do
    test "drops the channel from every sibling map (archive)" do
      ws =
        WindowState.new()
        |> WindowState.set_failed("#grappa", "Cannot join (+i)", 473)
        |> WindowState.set_parted("#grappa")

      assert WindowState.state_of(ws, "#grappa") == nil
      assert WindowState.failure_meta(ws, "#grappa") == nil
      assert WindowState.kicked_meta(ws, "#grappa") == nil
    end

    test "drops kicked metadata too" do
      ws =
        WindowState.new()
        |> WindowState.set_kicked("#grappa", "vjt", "out")
        |> WindowState.set_parted("#grappa")

      assert WindowState.state_of(ws, "#grappa") == nil
      assert WindowState.kicked_meta(ws, "#grappa") == nil
    end

    test "is a no-op for an unknown channel" do
      ws = WindowState.set_parted(WindowState.new(), "#never-joined")

      assert WindowState.state_of(ws, "#never-joined") == nil
    end
  end

  describe "state_of/2" do
    test "returns nil for unknown channels (untracked / archived)" do
      assert WindowState.state_of(WindowState.new(), "#nope") == nil
    end

    test "returns the recorded state atom" do
      ws = WindowState.set_pending(WindowState.new(), "#grappa")
      assert WindowState.state_of(ws, "#grappa") == :pending
    end
  end

  describe "failure_meta/2" do
    test "returns nil when the channel is not in :failed state" do
      ws = WindowState.set_joined(WindowState.new(), "#grappa")
      assert WindowState.failure_meta(ws, "#grappa") == nil
    end

    test "returns nil for unknown channels" do
      assert WindowState.failure_meta(WindowState.new(), "#nope") == nil
    end
  end

  describe "kicked_meta/2" do
    test "returns nil when the channel is not in :kicked state" do
      ws = WindowState.set_joined(WindowState.new(), "#grappa")
      assert WindowState.kicked_meta(ws, "#grappa") == nil
    end

    test "returns nil for unknown channels" do
      assert WindowState.kicked_meta(WindowState.new(), "#nope") == nil
    end
  end

  describe "to_wire/3 — snapshot payload (byte-identical to event-time broadcast)" do
    # These assertions enforce the CP15 B7 invariant: the
    # cold-WS-subscribe snapshot push and the apply_effects-arm
    # broadcast emit LITERALLY the same map for the same window
    # state. Both paths funnel through `Grappa.Session.Wire`, so
    # the test compares against the Wire verbs directly — if either
    # path drifts, this test fires.
    alias Grappa.Session.Wire, as: SessionWire

    test ":joined snapshot matches SessionWire.joined/2" do
      ws = WindowState.set_joined(WindowState.new(), "#grappa")

      assert WindowState.to_wire(ws, "azzurra", "#grappa") ==
               {:ok, SessionWire.joined("azzurra", "#grappa")}
    end

    test ":failed snapshot matches SessionWire.join_failed/4 with recorded reason + numeric" do
      ws = WindowState.set_failed(WindowState.new(), "#grappa", "Cannot join (+i)", 473)

      assert WindowState.to_wire(ws, "azzurra", "#grappa") ==
               {:ok, SessionWire.join_failed("azzurra", "#grappa", "Cannot join (+i)", 473)}
    end

    test ":kicked snapshot matches SessionWire.kicked/4 with recorded by + reason" do
      ws = WindowState.set_kicked(WindowState.new(), "#grappa", "vjt", "stop spamming")

      assert WindowState.to_wire(ws, "azzurra", "#grappa") ==
               {:ok, SessionWire.kicked("azzurra", "#grappa", "vjt", "stop spamming")}
    end

    test ":pending returns {:error, :not_tracked} (broadcast on user-topic, not channel-topic)" do
      ws = WindowState.set_pending(WindowState.new(), "#grappa")
      assert WindowState.to_wire(ws, "azzurra", "#grappa") == {:error, :not_tracked}
    end

    test ":invited returns {:error, :not_tracked} (broadcast on user-topic, like :pending) (#78)" do
      ws = WindowState.set_invited(WindowState.new(), "#grappa")
      assert WindowState.to_wire(ws, "azzurra", "#grappa") == {:error, :not_tracked}
    end

    test "unknown channel returns {:error, :not_tracked}" do
      assert WindowState.to_wire(WindowState.new(), "azzurra", "#nope") ==
               {:error, :not_tracked}
    end
  end

  describe "property: set_joined-after-set_failed clears failure metadata" do
    property "any sequence of set_failed followed by set_joined leaves failure_meta nil" do
      check all(
              reason <- StreamData.string(:printable, min_length: 1, max_length: 64),
              numeric <- StreamData.integer(400..599),
              channel <- StreamData.member_of(["#grappa", "#azzurra", "#dev"])
            ) do
        ws =
          WindowState.new()
          |> WindowState.set_failed(channel, reason, numeric)
          |> WindowState.set_joined(channel)

        assert WindowState.state_of(ws, channel) == :joined
        assert WindowState.failure_meta(ws, channel) == nil
      end
    end

    property "any sequence of set_kicked followed by set_joined leaves kicked_meta nil" do
      check all(
              by <- StreamData.string(:alphanumeric, min_length: 1, max_length: 32),
              reason <- StreamData.one_of([StreamData.constant(nil), StreamData.string(:printable, max_length: 64)]),
              channel <- StreamData.member_of(["#grappa", "#azzurra", "#dev"])
            ) do
        ws =
          WindowState.new()
          |> WindowState.set_kicked(channel, by, reason)
          |> WindowState.set_joined(channel)

        assert WindowState.state_of(ws, channel) == :joined
        assert WindowState.kicked_meta(ws, channel) == nil
      end
    end
  end
end
