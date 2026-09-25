defmodule Grappa.IRC.IgnoreTest do
  @moduledoc """
  Issue 2294 — an ignore entry is a mask PLUS an optional glob over the
  message text. The tests are grouped by the question each answers: what a
  normalised entry is, what the storage decoder accepts, and what the
  delivery match drops.
  """
  use ExUnit.Case, async: true

  alias Grappa.IRC.Ignore

  # The relay shape the issue is about: one bot mask, many authors in the body.
  @relay_mask "Gazzurbo!*@*"
  @relay_body "<SomeNick> ciao a tutti"

  describe "normalize/3" do
    test "a bare nick with no text pattern is exactly the #162 entry" do
      assert {:ok, %Ignore{mask: "spambot!*@*", text_pattern: nil}} =
               Ignore.normalize("spambot", nil, :ascii)
    end

    test "carries the text pattern alongside the mask" do
      assert {:ok, %Ignore{mask: "gazzurbo!*@*", text_pattern: "<SomeNick>*"}} =
               Ignore.normalize(@relay_mask, "<SomeNick>*", :ascii)
    end

    test "the text pattern keeps its case while the mask folds" do
      assert {:ok, %Ignore{mask: "gazzurbo!*@*", text_pattern: "<SomeNick>*"}} =
               Ignore.normalize("GAZZURBO!*@*", "<SomeNick>*", :ascii)
    end

    test "a text pattern may contain spaces — it is a line, not a token" do
      assert {:ok, %Ignore{text_pattern: "<A> hello *"}} =
               Ignore.normalize("bot", "<A> hello *", :ascii)
    end

    test "an unparseable mask is :invalid_mask, pattern or not" do
      assert {:error, :invalid_mask} = Ignore.normalize("a!b!c@d", "<X>*", :ascii)
      assert {:error, :invalid_mask} = Ignore.normalize("", nil, :ascii)
    end

    test "a blank or CRLF-bearing text pattern is :invalid_text_pattern" do
      assert {:error, :invalid_text_pattern} = Ignore.normalize("bot", "", :ascii)
      assert {:error, :invalid_text_pattern} = Ignore.normalize("bot", "   ", :ascii)
      assert {:error, :invalid_text_pattern} = Ignore.normalize("bot", "a\r\nPRIVMSG", :ascii)
    end

    test "an over-long text pattern is rejected rather than compiled" do
      assert {:error, :invalid_text_pattern} =
               Ignore.normalize("bot", String.duplicate("a", 513), :ascii)
    end

    test "a non-binary, non-nil text pattern is rejected, never crashed on" do
      assert {:error, :invalid_text_pattern} = Ignore.normalize("bot", 42, :ascii)
    end
  end

  describe "decode/1 — the stored-value door" do
    test "a legacy bare mask string reads as an entry with no pattern" do
      assert {:ok, %Ignore{mask: "spambot!*@*", text_pattern: nil}} =
               Ignore.decode("spambot!*@*")
    end

    test "a stored map round-trips through encode/1" do
      {:ok, entry} = Ignore.normalize(@relay_mask, "<SomeNick>*", :ascii)
      assert {:ok, ^entry} = entry |> Ignore.encode() |> Ignore.decode()
    end

    test "encode/1 omits the key entirely when there is no pattern" do
      {:ok, entry} = Ignore.normalize("spambot", nil, :ascii)
      assert Ignore.encode(entry) == %{"mask" => "spambot!*@*"}
    end

    test "junk decodes to :error rather than raising on the read path" do
      for junk <- [nil, 42, %{}, %{"text_pattern" => "x"}, %{"mask" => 7}, []] do
        assert :error == Ignore.decode(junk), "expected :error for #{inspect(junk)}"
      end
    end

    test "decode_all/1 keeps the readable entries and drops the junk" do
      assert [%Ignore{mask: "a!*@*"}, %Ignore{mask: "b!*@*", text_pattern: "<X>*"}] =
               Ignore.decode_all(["a!*@*", 42, %{"mask" => "b!*@*", "text_pattern" => "<X>*"}])
    end

    test "decode_all/1 on a non-list is an empty list, never a raise" do
      assert [] == Ignore.decode_all(%{"mask" => "a!*@*"})
      assert [] == Ignore.decode_all(nil)
    end
  end

  describe "any_match?/6 — the delivery question" do
    setup do
      {:ok, plain} = Ignore.normalize(@relay_mask, nil, :ascii)
      {:ok, targeted} = Ignore.normalize(@relay_mask, "<SomeNick>*", :ascii)
      %{plain: Ignore.compile_all([plain]), targeted: Ignore.compile_all([targeted])}
    end

    test "no pattern behaves exactly as #162 did — mask alone decides", ctx do
      assert Ignore.any_match?(ctx.plain, "Gazzurbo", "rel", "bridge.host", @relay_body, :ascii)

      assert Ignore.any_match?(
               ctx.plain,
               "Gazzurbo",
               "rel",
               "bridge.host",
               "<Other> buongiorno",
               :ascii
             )
    end

    test "a pattern narrows the SAME mask to one relayed author", ctx do
      assert Ignore.any_match?(ctx.targeted, "Gazzurbo", "rel", "bridge.host", @relay_body, :ascii)

      refute Ignore.any_match?(
               ctx.targeted,
               "Gazzurbo",
               "rel",
               "bridge.host",
               "<Other> buongiorno",
               :ascii
             )
    end

    test "a pattern never widens: a non-matching mask stays delivered", ctx do
      refute Ignore.any_match?(ctx.targeted, "Someone", "u", "h", @relay_body, :ascii)
    end

    test "the text glob is absolutely anchored, like the mask parts" do
      {:ok, entry} = Ignore.normalize("bot", "spam", :ascii)
      compiled = Ignore.compile_all([entry])

      assert Ignore.any_match?(compiled, "bot", "u", "h", "spam", :ascii)
      refute Ignore.any_match?(compiled, "bot", "u", "h", "this is spam too", :ascii)
      # the operator writes the wildcards they want
      {:ok, loose} = Ignore.normalize("bot", "*spam*", :ascii)
      assert Ignore.any_match?(Ignore.compile_all([loose]), "bot", "u", "h", "a spam b", :ascii)
    end

    test "the text glob is ASCII-case-insensitive — a body is content, not a key" do
      {:ok, entry} = Ignore.normalize("bot", "<somenick>*", :ascii)
      compiled = Ignore.compile_all([entry])

      assert Ignore.any_match?(compiled, "bot", "u", "h", "<SomeNick> ciao", :ascii)
    end

    test "NON-ASCII case is NOT folded — the same limit a nick key carries" do
      {:ok, entry} = Ignore.normalize("bot", "cafÉ", :ascii)
      compiled = Ignore.compile_all([entry])

      assert Ignore.any_match?(compiled, "bot", "u", "h", "cafÉ", :ascii)
      refute Ignore.any_match?(compiled, "bot", "u", "h", "café", :ascii)
    end

    test "a body that is not valid UTF-8 is answered, never raised on" do
      {:ok, entry} = Ignore.normalize("bot", "*spam*", :ascii)
      compiled = Ignore.compile_all([entry])

      refute Ignore.any_match?(compiled, "bot", "u", "h", <<0xFF, 0xFE, 0xFF>>, :ascii)
      assert Ignore.any_match?(compiled, "bot", "u", "h", <<0xFF, "spam", 0xFE>>, :ascii)
    end

    test "a CTCP ACTION matches on the UNWRAPPED text, not the \\x01 envelope" do
      {:ok, entry} = Ignore.normalize("bot", "<SomeNick>*", :ascii)
      compiled = Ignore.compile_all([entry])

      assert Ignore.any_match?(compiled, "bot", "u", "h", "\x01ACTION <SomeNick> saluta\x01", :ascii)
    end

    test "a non-ACTION CTCP frame is matched raw — the envelope IS the content" do
      {:ok, entry} = Ignore.normalize("bot", "*VERSION*", :ascii)
      compiled = Ignore.compile_all([entry])

      assert Ignore.any_match?(compiled, "bot", "u", "h", "\x01VERSION\x01", :ascii)
    end

    test "an empty entry list never matches" do
      refute Ignore.any_match?([], "bot", "u", "h", "anything", :ascii)
    end

    test "two entries on one mask are two independent authors" do
      {:ok, a} = Ignore.normalize(@relay_mask, "<A>*", :ascii)
      {:ok, b} = Ignore.normalize(@relay_mask, "<B>*", :ascii)
      compiled = Ignore.compile_all([a, b])

      assert Ignore.any_match?(compiled, "Gazzurbo", "u", "h", "<A> x", :ascii)
      assert Ignore.any_match?(compiled, "Gazzurbo", "u", "h", "<B> y", :ascii)
      refute Ignore.any_match?(compiled, "Gazzurbo", "u", "h", "<C> z", :ascii)
    end
  end
end
