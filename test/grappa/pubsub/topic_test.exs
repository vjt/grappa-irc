defmodule Grappa.PubSub.TopicTest do
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

  describe "network/1" do
    test "builds the network topic" do
      assert Topic.network("azzurra") == "grappa:network:azzurra"
    end

    test "raises on empty string" do
      assert_raise FunctionClauseError, fn -> Topic.network("") end
    end
  end

  describe "channel/2" do
    test "builds the per-channel topic" do
      assert Topic.channel("azzurra", "#sniffo") == "grappa:network:azzurra/channel:#sniffo"
    end

    test "preserves channel name including the # sigil" do
      assert Topic.channel("net", "&local") == "grappa:network:net/channel:&local"
    end

    test "raises on empty network_id" do
      assert_raise FunctionClauseError, fn -> Topic.channel("", "#chan") end
    end

    test "raises on empty channel name" do
      assert_raise FunctionClauseError, fn -> Topic.channel("net", "") end
    end
  end

  describe "parse/1" do
    test "parses a user topic" do
      assert Topic.parse("grappa:user:vjt") == {:ok, {:user, "vjt"}}
    end

    test "parses a network topic" do
      assert Topic.parse("grappa:network:azzurra") == {:ok, {:network, "azzurra"}}
    end

    test "parses a per-channel topic" do
      assert Topic.parse("grappa:network:azzurra/channel:#sniffo") ==
               {:ok, {:channel, "azzurra", "#sniffo"}}
    end

    test "rejects empty user" do
      assert Topic.parse("grappa:user:") == :error
    end

    test "rejects empty network" do
      assert Topic.parse("grappa:network:") == :error
    end

    test "rejects empty channel name in per-channel topic" do
      assert Topic.parse("grappa:network:azzurra/channel:") == :error
    end

    test "rejects malformed separator after network_id" do
      assert Topic.parse("grappa:network:azzurra/wrong:#sniffo") == :error
    end

    test "rejects unknown prefix" do
      assert Topic.parse("foo:bar:baz") == :error
    end

    test "rejects non-grappa prefix" do
      assert Topic.parse("user:vjt") == :error
    end
  end

  describe "valid?/1" do
    test "true for valid user topic" do
      assert Topic.valid?("grappa:user:vjt")
    end

    test "true for valid network topic" do
      assert Topic.valid?("grappa:network:azzurra")
    end

    test "true for valid per-channel topic" do
      assert Topic.valid?("grappa:network:azzurra/channel:#sniffo")
    end

    test "false for malformed topic" do
      refute Topic.valid?("grappa:network:")
      refute Topic.valid?("grappa:network:net/wrong:foo")
    end

    test "round-trips: built → parsed back to same identifiers" do
      assert {:ok, {:user, "vjt"}} = Topic.parse(Topic.user("vjt"))
      assert {:ok, {:network, "azzurra"}} = Topic.parse(Topic.network("azzurra"))

      assert {:ok, {:channel, "azzurra", "#sniffo"}} =
               Topic.parse(Topic.channel("azzurra", "#sniffo"))
    end
  end
end
