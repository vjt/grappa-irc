defmodule Grappa.Auth.IdentifierClassifierTest do
  use ExUnit.Case, async: true
  doctest Grappa.Auth.IdentifierClassifier
  alias Grappa.Auth.IdentifierClassifier

  describe "classify/1" do
    test "valid email → {:email, id}" do
      assert {:email, "vjt@bad.ass"} = IdentifierClassifier.classify("vjt@bad.ass")
    end

    test "valid RFC2812 nick → {:nick, id}" do
      assert {:nick, "vjt"} = IdentifierClassifier.classify("vjt")
      assert {:nick, "_grump"} = IdentifierClassifier.classify("_grump")
      assert {:nick, "[ofc]nerd"} = IdentifierClassifier.classify("[ofc]nerd")
    end

    test "nick starting with digit → :malformed (RFC2812)" do
      assert {:error, :malformed} = IdentifierClassifier.classify("9livesleft")
    end

    test "nick > 30 chars → :malformed" do
      long = String.duplicate("a", 31)
      assert {:error, :malformed} = IdentifierClassifier.classify(long)
    end

    test "nick with @ but invalid email → :malformed" do
      assert {:error, :malformed} = IdentifierClassifier.classify("foo@")
      assert {:error, :malformed} = IdentifierClassifier.classify("@bar")
    end

    test "empty string → :malformed" do
      assert {:error, :malformed} = IdentifierClassifier.classify("")
    end

    test "whitespace-padded → :malformed (no implicit trim)" do
      assert {:error, :malformed} = IdentifierClassifier.classify(" vjt ")
    end
  end

  describe "property: classify/1" do
    use ExUnitProperties

    property "any x@y.z-shaped string classifies as :email" do
      check all(
              local <- StreamData.string([?a..?z, ?A..?Z, ?0..?9, ?_], min_length: 1, max_length: 20),
              domain <- StreamData.string([?a..?z, ?A..?Z, ?0..?9], min_length: 1, max_length: 20),
              tld <- StreamData.string([?a..?z], min_length: 2, max_length: 6)
            ) do
        addr = "#{local}@#{domain}.#{tld}"
        assert {:email, ^addr} = IdentifierClassifier.classify(addr)
      end
    end
  end
end
