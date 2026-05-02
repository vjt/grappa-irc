defmodule Grappa.Auth.IdentifierClassifierTest do
  use ExUnit.Case, async: true
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

    property "valid nick generators always classify as :nick" do
      check all(
              first <- StreamData.string([?A..?Z, ?a..?z, ?_], length: 1),
              rest <- StreamData.string([?A..?Z, ?a..?z, ?0..?9, ?_, ?-], min_length: 0, max_length: 29)
            ) do
        nick = first <> rest
        assert {:nick, ^nick} = Grappa.Auth.IdentifierClassifier.classify(nick)
      end
    end

    property "any string with leading digit → :malformed" do
      check all(
              digit <- StreamData.string([?0..?9], length: 1),
              rest <- StreamData.string(:alphanumeric, min_length: 0, max_length: 20)
            ) do
        bad = digit <> rest
        refute match?({:nick, _}, Grappa.Auth.IdentifierClassifier.classify(bad))
      end
    end
  end
end
