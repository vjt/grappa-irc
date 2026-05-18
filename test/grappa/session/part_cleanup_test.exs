defmodule Grappa.Session.PartCleanupTest do
  @moduledoc """
  UX-4 bucket H — `PartCleanup.cleanup_local/2` is the single source for
  self-PART local-state eviction. Two consumers (Session.Server eager
  cast handler + EventRouter PART self-arm) share the helper so a future
  per-channel cache extension lands here once.

  Pure data; no Genserver, no socket. Mirrors the EventRouterTest shape.
  """
  use ExUnit.Case, async: true

  alias Grappa.Session.{PartCleanup, WindowState}

  defp base_state(overrides) do
    Map.merge(
      %{
        nick: "vjt",
        members: %{},
        topics: %{},
        channels_created: %{},
        channel_modes: %{},
        userhost_cache: %{},
        seeded_channels: MapSet.new(),
        window_state: WindowState.new()
      },
      overrides
    )
  end

  describe "cleanup_local/2 — joined-channel wipe" do
    test "drops members, topics, channel_modes, channels_created, seeded_channels entries" do
      state =
        base_state(%{
          members: %{
            "#italia" => %{"vjt" => [], "alice" => []},
            "#other" => %{"vjt" => [], "bob" => []}
          },
          topics: %{"#italia" => %{topic: "ciao", by: "x", at: 1}},
          channel_modes: %{"#italia" => "+nt"},
          channels_created: %{"#italia" => 999},
          seeded_channels: MapSet.new(["#italia", "#other"]),
          window_state: WindowState.set_joined(WindowState.new(), "#italia")
        })

      next = PartCleanup.cleanup_local(state, "#italia")

      refute Map.has_key?(next.members, "#italia")
      assert Map.has_key?(next.members, "#other")
      refute Map.has_key?(next.topics, "#italia")
      refute Map.has_key?(next.channel_modes, "#italia")
      refute Map.has_key?(next.channels_created, "#italia")
      refute MapSet.member?(next.seeded_channels, "#italia")
      assert MapSet.member?(next.seeded_channels, "#other")
      assert WindowState.state_of(next.window_state, "#italia") == nil
    end

    test "evicts userhost_cache nicks that share no remaining channel" do
      state =
        base_state(%{
          members: %{
            "#italia" => %{"vjt" => [], "alice" => []},
            "#other" => %{"vjt" => [], "bob" => []}
          },
          userhost_cache: %{
            "vjt" => %{user: "u", host: "h"},
            "alice" => %{user: "u", host: "h"},
            "bob" => %{user: "u", host: "h"}
          }
        })

      next = PartCleanup.cleanup_local(state, "#italia")

      # alice was only in #italia → evicted
      refute Map.has_key?(next.userhost_cache, "alice")
      # vjt + bob share #other → kept
      assert Map.has_key?(next.userhost_cache, "vjt")
      assert Map.has_key?(next.userhost_cache, "bob")
    end

    test "channel name with mixed case canonicalises EVERY map / MapSet / WindowState delete" do
      # Members + seeded keyed at canonical, caller passes mixed case →
      # all wipes hit canonical key. Pin both sides of the contract:
      # the M1 reviewer finding (pre-fix the helper used `channel` raw
      # for members/window_state/seeded_channels and `norm` for the
      # other three) would silently leak the members entry when the
      # caller passed `"#Italia"` while members was keyed `"#italia"`.
      state =
        base_state(%{
          members: %{"#italia" => %{"vjt" => []}},
          topics: %{"#italia" => %{topic: "ciao", by: "x", at: 1}},
          channel_modes: %{"#italia" => "+nt"},
          channels_created: %{"#italia" => 999},
          seeded_channels: MapSet.new(["#italia"]),
          window_state: WindowState.set_joined(WindowState.new(), "#italia")
        })

      next = PartCleanup.cleanup_local(state, "#Italia")

      refute Map.has_key?(next.members, "#italia")
      refute Map.has_key?(next.topics, "#italia")
      refute Map.has_key?(next.channel_modes, "#italia")
      refute Map.has_key?(next.channels_created, "#italia")
      refute MapSet.member?(next.seeded_channels, "#italia")
      assert WindowState.state_of(next.window_state, "#italia") == nil
    end

    test "inverse: state keyed at mixed case, caller passes canonical — wipe still hits" do
      # Defense-in-depth on the same M1 contract. The canonicalisation
      # rule is "all consumers observe the canonical form", so state
      # keyed at non-canonical is itself a contract violation, but the
      # helper should not depend on caller-side casing to do the right
      # thing.
      state =
        base_state(%{
          members: %{"#italia" => %{"vjt" => []}},
          topics: %{"#italia" => %{topic: "ciao", by: "x", at: 1}}
        })

      next = PartCleanup.cleanup_local(state, "#ITALIA")

      refute Map.has_key?(next.members, "#italia")
      refute Map.has_key?(next.topics, "#italia")
    end
  end

  describe "cleanup_local/2 — idempotency on unknown channel" do
    test "no-op when the channel was never joined (no members entry, no caches)" do
      state =
        base_state(%{
          members: %{"#other" => %{"vjt" => []}},
          topics: %{"#other" => %{topic: "x", by: "y", at: 1}}
        })

      next = PartCleanup.cleanup_local(state, "#neverjoined")

      assert next.members == state.members
      assert next.topics == state.topics
      assert next.channel_modes == state.channel_modes
      assert next.channels_created == state.channels_created
      assert next.userhost_cache == state.userhost_cache
      assert next.seeded_channels == state.seeded_channels
      assert next.window_state == state.window_state
    end

    test "no-op when applied twice (second call sees already-cleaned state)" do
      state =
        base_state(%{
          members: %{"#italia" => %{"vjt" => []}},
          window_state: WindowState.set_joined(WindowState.new(), "#italia")
        })

      once = PartCleanup.cleanup_local(state, "#italia")
      twice = PartCleanup.cleanup_local(once, "#italia")

      assert once.members == twice.members
      assert once.window_state == twice.window_state
    end

    test "no-op when window_state already :failed (idempotent on WindowState.set_parted)" do
      state =
        base_state(%{
          members: %{},
          window_state: WindowState.set_failed(WindowState.new(), "#noaccess", "+i (invite only)", 473)
        })

      next = PartCleanup.cleanup_local(state, "#noaccess")

      # set_parted drops EVERY sibling entry; the failure metadata clears.
      assert WindowState.state_of(next.window_state, "#noaccess") == nil
      assert WindowState.failure_meta(next.window_state, "#noaccess") == nil
    end
  end

  describe "cleanup_local/2 — seeded_channels nil fallback" do
    test "tolerates state without :seeded_channels key (pure-fn callers without the full struct)" do
      state =
        %{
          members: %{"#italia" => %{"vjt" => []}},
          topics: %{},
          channel_modes: %{},
          channels_created: %{},
          userhost_cache: %{},
          window_state: WindowState.new()
        }

      next = PartCleanup.cleanup_local(state, "#italia")

      refute Map.has_key?(next, :seeded_channels)
      refute Map.has_key?(next.members, "#italia")
    end
  end
end
