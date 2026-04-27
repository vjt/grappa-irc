defmodule Grappa.PubSub.TopicTest do
  @moduledoc """
  Phase 2 sub-task 2h reshape: every Grappa PubSub topic is rooted in
  the user discriminator. The 1-arg `network/1` and 2-arg `channel/2`
  shapes from Phase 1 are gone — `network/2` and `channel/3` take the
  user_name as the first segment so multi-user instances cannot leak
  broadcasts across users (Phoenix.PubSub topic strings are a global
  namespace, see DESIGN_NOTES 2026-04-25).
  """
  use ExUnit.Case, async: true

  alias Grappa.PubSub.Topic

  describe "user/1" do
    test "builds the user topic" do
      assert Topic.user("vjt") == "grappa:user:vjt"
    end

    test "preserves identifiers verbatim" do
      assert Topic.user("alice-2") == "grappa:user:alice-2"
    end

    test "raises on empty string" do
      assert_raise FunctionClauseError, fn -> Topic.user("") end
    end
  end

  describe "network/2" do
    test "builds the per-user network topic" do
      assert Topic.network("vjt", "azzurra") == "grappa:user:vjt/network:azzurra"
    end

    test "raises on empty user_name" do
      assert_raise FunctionClauseError, fn -> Topic.network("", "azzurra") end
    end

    test "raises on empty network slug" do
      assert_raise FunctionClauseError, fn -> Topic.network("vjt", "") end
    end
  end

  describe "channel/3" do
    test "builds the per-user-network-channel topic" do
      assert Topic.channel("vjt", "azzurra", "#sniffo") ==
               "grappa:user:vjt/network:azzurra/channel:#sniffo"
    end

    test "preserves channel name including the # sigil" do
      assert Topic.channel("alice", "net", "&local") ==
               "grappa:user:alice/network:net/channel:&local"
    end

    test "raises on empty user_name" do
      assert_raise FunctionClauseError, fn -> Topic.channel("", "net", "#chan") end
    end

    test "raises on empty network slug" do
      assert_raise FunctionClauseError, fn -> Topic.channel("vjt", "", "#chan") end
    end

    test "raises on empty channel name" do
      assert_raise FunctionClauseError, fn -> Topic.channel("vjt", "net", "") end
    end
  end

  describe "parse/1" do
    test "parses a user topic" do
      assert Topic.parse("grappa:user:vjt") == {:ok, {:user, "vjt"}}
    end

    test "parses a per-user network topic" do
      assert Topic.parse("grappa:user:vjt/network:azzurra") ==
               {:ok, {:network, "vjt", "azzurra"}}
    end

    test "parses a per-user-network-channel topic" do
      assert Topic.parse("grappa:user:vjt/network:azzurra/channel:#sniffo") ==
               {:ok, {:channel, "vjt", "azzurra", "#sniffo"}}
    end

    test "rejects empty user" do
      assert Topic.parse("grappa:user:") == :error
    end

    test "rejects empty network slug in network topic" do
      assert Topic.parse("grappa:user:vjt/network:") == :error
    end

    test "rejects empty channel name in per-channel topic" do
      assert Topic.parse("grappa:user:vjt/network:azzurra/channel:") == :error
    end

    test "rejects malformed separator after network slug" do
      assert Topic.parse("grappa:user:vjt/network:azzurra/wrong:#sniffo") == :error
    end

    test "rejects unknown prefix" do
      assert Topic.parse("foo:bar:baz") == :error
    end

    test "S38: rejects compound network shape with empty user_name" do
      # `grappa:user:/network:azzurra` has rest = "/network:azzurra",
      # which splits into `["", "network:azzurra"]`. Without an explicit
      # `name != ""` guard, the two-segment clause matched with
      # `name = ""` — channel-side authz rejected it today, but a
      # parser-invariant violation should not depend on a downstream
      # check to avoid leaking to subscribers.
      assert Topic.parse("grappa:user:/network:azzurra") == :error
    end

    test "S38: rejects compound channel shape with empty user_name" do
      assert Topic.parse("grappa:user:/network:azzurra/channel:#sniffo") == :error
    end

    test "rejects non-grappa prefix" do
      assert Topic.parse("user:vjt") == :error
    end

    test "rejects Phase 1 grappa:network: shape (regression: it must NOT parse)" do
      # Decision G3 routing iso: the only thing keeping per-user
      # delivery from cross-talk is that the OLD topic shape is now
      # un-parseable, so any leftover broadcaster on the old shape gets
      # rejected at GrappaChannel.join/3.
      assert Topic.parse("grappa:network:azzurra") == :error
      assert Topic.parse("grappa:network:azzurra/channel:#sniffo") == :error
    end
  end

  describe "valid?/1" do
    test "true for valid user topic" do
      assert Topic.valid?("grappa:user:vjt")
    end

    test "true for valid per-user network topic" do
      assert Topic.valid?("grappa:user:vjt/network:azzurra")
    end

    test "true for valid per-user-network-channel topic" do
      assert Topic.valid?("grappa:user:vjt/network:azzurra/channel:#sniffo")
    end

    test "false for malformed topic" do
      refute Topic.valid?("grappa:user:vjt/network:")
      refute Topic.valid?("grappa:user:vjt/network:net/wrong:foo")
    end

    test "false for Phase 1 grappa:network: shape" do
      refute Topic.valid?("grappa:network:azzurra")
      refute Topic.valid?("grappa:network:azzurra/channel:#sniffo")
    end

    test "round-trips: built → parsed back to same identifiers" do
      assert {:ok, {:user, "vjt"}} = Topic.parse(Topic.user("vjt"))

      assert {:ok, {:network, "vjt", "azzurra"}} =
               Topic.parse(Topic.network("vjt", "azzurra"))

      assert {:ok, {:channel, "vjt", "azzurra", "#sniffo"}} =
               Topic.parse(Topic.channel("vjt", "azzurra", "#sniffo"))
    end
  end
end
