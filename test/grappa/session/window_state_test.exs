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

  describe "set_invited/3" do
    test "marks the channel as :invited without touching failure / kicked maps (#78)" do
      ws = WindowState.set_invited(WindowState.new(), "#grappa", "inviter")

      assert WindowState.state_of(ws, "#grappa") == :invited
      assert WindowState.failure_meta(ws, "#grappa") == nil
      assert WindowState.kicked_meta(ws, "#grappa") == nil
    end

    # #902 — the inviter is window metadata now, not only a scrollback row.
    # The banner that replaced the greyed tab renders "<nick> is inviting you
    # to #chan" the moment `window_invited` lands, BEFORE the channel buffer
    # holding the persisted INVITE row is ever fetched — so the nick has to
    # ride the window state, or the cold-subscribe backfill below cannot
    # reproduce it.
    test "records the inviter (#902)" do
      ws = WindowState.set_invited(WindowState.new(), "#grappa", "vjt")

      assert WindowState.invited_by(ws, "#grappa") == "vjt"
    end

    test "a repeat INVITE overwrites the recorded inviter" do
      ws =
        WindowState.new()
        |> WindowState.set_invited("#grappa", "first")
        |> WindowState.set_invited("#grappa", "second")

      assert WindowState.invited_by(ws, "#grappa") == "second"
    end

    test "invited_by/2 is nil for a channel that was never invited" do
      ws = WindowState.set_joined(WindowState.new(), "#grappa")

      assert WindowState.invited_by(ws, "#grappa") == nil
    end
  end

  # #902 — the ONE invariant that keeps `invited_by` from becoming a parallel
  # structure that drifts (CLAUDE.md: "don't duplicate state that already
  # exists — every parallel structure needs housekeeping"). The map is not a
  # second source of truth for invitedness: `states` is. So the key exists in
  # `invited_by` IF AND ONLY IF `states[channel] == :invited`, and EVERY
  # mutator that moves a channel out of `:invited` drops it. Asserted per
  # mutator, because a full-struct-literal rebuild (`set_joined`, `set_parted`)
  # that forgets the new field silently resets the WHOLE map, not one key.
  describe "invited_by is dropped by every transition out of :invited (#902)" do
    setup do
      %{invited: WindowState.set_invited(WindowState.new(), "#grappa", "vjt")}
    end

    test "set_pending/2 clears the recorded inviter", %{invited: ws} do
      assert WindowState.invited_by(WindowState.set_pending(ws, "#grappa"), "#grappa") == nil
    end

    test "set_joined/2 clears the recorded inviter", %{invited: ws} do
      assert WindowState.invited_by(WindowState.set_joined(ws, "#grappa"), "#grappa") == nil
    end

    test "set_failed/4 clears the recorded inviter", %{invited: ws} do
      ws = WindowState.set_failed(ws, "#grappa", "Cannot join (+i)", 473)
      assert WindowState.invited_by(ws, "#grappa") == nil
    end

    test "set_kicked/4 clears the recorded inviter", %{invited: ws} do
      ws = WindowState.set_kicked(ws, "#grappa", "op", "bye")
      assert WindowState.invited_by(ws, "#grappa") == nil
    end

    test "set_parted/2 clears the recorded inviter", %{invited: ws} do
      assert WindowState.invited_by(WindowState.set_parted(ws, "#grappa"), "#grappa") == nil
    end

    test "a transition on ANOTHER channel leaves this channel's inviter intact" do
      ws =
        WindowState.new()
        |> WindowState.set_invited("#grappa", "vjt")
        |> WindowState.set_joined("#elsewhere")
        |> WindowState.set_parted("#gone")

      assert WindowState.invited_by(ws, "#grappa") == "vjt"
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

    test ":invited returns {:error, :not_tracked} (broadcast on user-topic, like :pending) (#78/#482)" do
      # #482: :invited stays OFF the per-channel snapshot path on purpose.
      # It is a user-topic state (cic subscribes per-channel only AFTER
      # seeing it), so its cold-load backfill rides `invited_windows/2` on
      # the user topic — NOT to_wire/3, which would push a user-topic-shaped
      # payload on the per-channel topic (cic drops it as malformed).
      ws = WindowState.set_invited(WindowState.new(), "#grappa", "vjt")
      assert WindowState.to_wire(ws, "azzurra", "#grappa") == {:error, :not_tracked}
    end

    test "unknown channel returns {:error, :not_tracked}" do
      assert WindowState.to_wire(WindowState.new(), "azzurra", "#nope") ==
               {:error, :not_tracked}
    end
  end

  describe "invited_windows/2 — user-topic cold-snapshot backfill (#482)" do
    # The user-topic twin of to_wire/3: enumerates every :invited window as
    # a `window_invited` payload so `push_user_snapshot` can re-surface the
    # greyed tab on a cold WS subscribe. Without this the tab evaporates on
    # reload — the invite lands only in scrollback, invisible in the bottom
    # bar (the #482 symptom). Funnels through the SAME `SessionWire.window_
    # invited/2` verb the event-time broadcast uses, so backfill + event
    # payloads stay byte-identical.
    alias Grappa.Session.Wire, as: SessionWire

    test "returns a window_invited payload for EVERY :invited channel, nothing else" do
      ws =
        WindowState.new()
        |> WindowState.set_invited("#random", "alice")
        |> WindowState.set_invited("#other", "bob")
        |> WindowState.set_pending("#joining")
        |> WindowState.set_joined("#here")
        |> WindowState.set_failed("#nope", "Cannot join (+i)", 473)

      assert MapSet.new(WindowState.invited_windows(ws, "azzurra")) ==
               MapSet.new([
                 SessionWire.window_invited("azzurra", "#random", "alice"),
                 SessionWire.window_invited("azzurra", "#other", "bob")
               ])
    end

    # #902 — the whole reason the inviter became window metadata. On a cold
    # WS subscribe there is no live INVITE echo, so this backfill is the ONLY
    # source the banner can render its "<nick> is inviting you" copy from.
    # Pre-#902 the nick lived exclusively in the persisted scrollback row and
    # this payload could not carry it at all.
    test "each payload carries the inviter recorded at INVITE time" do
      ws = WindowState.set_invited(WindowState.new(), "#random", "alice")

      assert [%{channel: "#random", inviter: "alice"}] =
               WindowState.invited_windows(ws, "azzurra")
    end

    test "returns [] when no channel is :invited" do
      ws = WindowState.set_joined(WindowState.new(), "#here")
      assert WindowState.invited_windows(ws, "azzurra") == []
    end

    test "returns [] for a brand-new (empty) window state" do
      assert WindowState.invited_windows(WindowState.new(), "azzurra") == []
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
