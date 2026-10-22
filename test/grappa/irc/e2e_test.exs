defmodule Grappa.IRC.E2eTest do
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.IRC.{E2e, LineSplit}
  alias Grappa.IRC.E2e.Fragment

  # A realistic payload: the compact JSON a v2 KEYREQ carries (wire v2,
  # 2430 comment 6346686730: the chunk is the JSON text itself, no base64).
  @keyreq_payload ~s({"v":2})

  # Two device ids, the shape `Grappa.E2eKeys.Device.did/1` derives: 8
  # bytes of SHA-256, standard base64, unpadded.
  @alice "If4x36FUomE"
  @bob "AaZaARRDyBk"

  # Printable ASCII without a space: what compact JSON of base64 strings,
  # numbers and punctuation is made of.
  defp json_text(bytes), do: ~s({"v":2,"body":"#{Base.encode64(bytes)}"})

  describe "framed?/1" do
    test "true for any body opening with the E2E CTCP frame, malformed or not" do
      assert E2e.framed?("\x01E2E MSG AAAAAAAAAAA 1/1 #{@alice} #{@bob} {}\x01")
      # Malformed (no fields at all) is still an E2E line: the never-persist
      # rule must catch it as surely as a well-formed one.
      assert E2e.framed?("\x01E2E garbage")
      assert E2e.framed?("\x01E2E\x01")
    end

    test "false for other CTCP verbs and plain text" do
      refute E2e.framed?("\x01ACTION waves\x01")
      refute E2e.framed?("\x01E2EMSG\x01")
      refute E2e.framed?("E2E MSG AAAAAAAAAAA 1/1 #{@alice} #{@bob} {}")
      refute E2e.framed?("")
    end
  end

  describe "parse/1" do
    test "reads the seven fields of a well-formed line" do
      assert {:ok,
              %Fragment{
                verb: :pkmsg,
                msgid: "q83vEjRWeJA",
                index: 2,
                total: 3,
                from: @alice,
                to: @bob,
                chunk: ~s("body":"x")
              }} = E2e.parse(~s(\x01E2E PKMSG q83vEjRWeJA 2/3 #{@alice} #{@bob} "body":"x"\x01))
    end

    test "the closing \\x01 is optional, like every CTCP frame" do
      assert {:ok, %Fragment{verb: :msg, chunk: "}"}} = E2e.parse("\x01E2E MSG q83vEjRWeJA 1/1 #{@alice} #{@bob} }")
    end

    test "maps every agreed verb, each with the addresses it may carry, and nothing else" do
      for {wire, verb, from, to} <- [
            {"KEYREQ", :keyreq, @alice, "*"},
            {"KEYS", :keys, "*", @alice},
            {"PKMSG", :pkmsg, @alice, @bob},
            {"PKMSG", :pkmsg, @alice, "*"},
            {"MSG", :msg, @alice, @bob},
            {"MSG", :msg, @alice, "*"},
            {"NACK", :nack, @alice, @bob}
          ] do
        assert {:ok, %Fragment{verb: ^verb, from: ^from, to: ^to}} =
                 E2e.parse("\x01E2E #{wire} q83vEjRWeJA 1/1 #{from} #{to} #{@keyreq_payload}\x01")
      end

      # Draft 7 listed OFFLINE; vjt dropped it (2430, 19:3x), so it is as
      # unknown as any other word.
      assert {:error, :malformed} = E2e.parse("\x01E2E OFFLINE q83vEjRWeJA 1/1 #{@alice} #{@bob} {}\x01")
      assert {:error, :malformed} = E2e.parse("\x01E2E msg q83vEjRWeJA 1/1 #{@alice} #{@bob} {}\x01")
    end

    test "refuses every addressing outside the table" do
      for {wire, from, to} <- [
            # A KEYREQ is to the user, a KEYS from it, and only those.
            {"KEYREQ", @alice, @bob},
            {"KEYREQ", "*", "*"},
            {"KEYS", @alice, @bob},
            {"KEYS", "*", "*"},
            # A device always names itself as sender.
            {"PKMSG", "*", @bob},
            {"MSG", "*", "*"},
            {"NACK", @alice, "*"},
            {"NACK", "*", @bob},
            # A did is exactly 11 base64url characters, unpadded and
            # canonical: the standard alphabet's `+` and `/` are not a did.
            {"MSG", "If4x36FUom", @bob},
            {"MSG", "If4x36FUomEE", @bob},
            {"MSG", "If4x36FUom=", @bob},
            {"MSG", "If4x36FU/mE", @bob},
            {"MSG", "If4x36FU+mE", @bob},
            {"MSG", "If4x36FUomF", @bob}
          ] do
        assert {:error, :malformed} = E2e.parse("\x01E2E #{wire} q83vEjRWeJA 1/1 #{from} #{to} {}\x01"),
               "#{wire} #{from} #{to}"
      end
    end

    test "a v1 line, which names no device, is malformed: flag-day" do
      assert {:error, :malformed} = E2e.parse("\x01E2E MSG q83vEjRWeJA 1/1 eyJ2IjoxfQ==\x01")
      assert {:error, :malformed} = E2e.parse("\x01E2E KEYREQ q83vEjRWeJA 1/1 eyJ2IjoxfQ==\x01")
    end

    test "refuses an index outside 1..total and a total above 64" do
      for frac <- ["0/1", "2/1", "1/65", "65/65", "1/0", "-1/2", "+1/2", "1/2/3", "a/2", "1/", "/1"] do
        assert {:error, :malformed} = E2e.parse("\x01E2E MSG q83vEjRWeJA #{frac} #{@alice} #{@bob} {}\x01"), frac
      end

      assert {:ok, %Fragment{index: 64, total: 64}} =
               E2e.parse("\x01E2E MSG q83vEjRWeJA 64/64 #{@alice} #{@bob} {}\x01")
    end

    test "refuses a chunk outside printable ASCII, a msgid outside the base64 alphabet, and an empty chunk" do
      for chunk <- ["café", "a\tb", "a\x7fb", <<0xFF>>] do
        assert {:error, :malformed} = E2e.parse("\x01E2E MSG q83vEjRWeJA 1/1 #{@alice} #{@bob} #{chunk}\x01"),
               inspect(chunk)
      end

      assert {:error, :malformed} = E2e.parse("\x01E2E MSG q83v_jRWeJA 1/1 #{@alice} #{@bob} {}\x01")
      assert {:error, :malformed} = E2e.parse("\x01E2E MSG q83vEjRWeJA 1/1 #{@alice} #{@bob} \x01")
      assert {:error, :malformed} = E2e.parse("\x01E2E MSG #{String.duplicate("A", 25)} 1/1 #{@alice} #{@bob} {}\x01")
    end

    test "refuses a missing or an extra field: a chunk never holds a space" do
      assert {:error, :malformed} = E2e.parse("\x01E2E MSG q83vEjRWeJA 1/1 #{@alice} #{@bob}\x01")
      assert {:error, :malformed} = E2e.parse("\x01E2E MSG q83vEjRWeJA 1/1 #{@alice} {}\x01")
      assert {:error, :malformed} = E2e.parse(~s(\x01E2E MSG q83vEjRWeJA 1/1 #{@alice} #{@bob} {"v": 2}\x01))
      assert {:error, :malformed} = E2e.parse("\x01E2E MSG q83vEjRWeJA 1/1 #{@alice} #{@bob} {} \x01")
    end

    test "refuses what is not an E2E line at all" do
      assert {:error, :malformed} = E2e.parse("\x01ACTION waves\x01")
      assert {:error, :malformed} = E2e.parse("hello")
    end
  end

  describe "did?/1 and addressed?/3" do
    test "a did is the unpadded, canonical base64url of 8 bytes, nothing else" do
      assert 8 |> :crypto.strong_rand_bytes() |> Base.url_encode64(padding: false) |> E2e.did?()
      assert E2e.did?("_Uw_z3-OAsk")
      assert {:ok, _} = E2e.parse("\x01E2E MSG q83vEjRWeJA 1/1 _Uw_z3-OAsk #{@bob} {}\x01")
      # The same 8 bytes in the standard alphabet are not a did.
      refute E2e.did?("/Uw/z3+OAsk")
      refute 8 |> :crypto.strong_rand_bytes() |> Base.url_encode64() |> E2e.did?()
      # Nonzero trailing bits: the same bytes, a second spelling.
      refute E2e.did?("If4x36FUomF")
      refute E2e.did?("*")
      refute E2e.did?(nil)
    end

    test "the table the parser enforces is the one the send door asks" do
      assert E2e.addressed?(:keyreq, @alice, "*")
      assert E2e.addressed?(:pkmsg, @alice, "*")
      refute E2e.addressed?(:nack, @alice, "*")
      refute E2e.addressed?(:keys, @alice, @bob)
      refute E2e.addressed?(:msg, 1, @bob)
    end
  end

  describe "new_msgid/0" do
    test "is 8 random bytes, standard base64 unpadded — the agreed shape" do
      msgid = E2e.new_msgid()
      assert byte_size(msgid) == 11
      assert {:ok, <<_::binary-size(8)>>} = Base.decode64(msgid, padding: false)
      assert E2e.msgid?(msgid)
      refute msgid == E2e.new_msgid()
    end
  end

  describe "fragment/5" do
    test "a payload that fits goes out as one line, 1/1, with both addresses" do
      assert {:ok, [line]} = E2e.fragment(:keyreq, "q83vEjRWeJA", {@alice, "*"}, @keyreq_payload, 400)
      assert line == "\x01E2E KEYREQ q83vEjRWeJA 1/1 #{@alice} * #{@keyreq_payload}\x01"
    end

    test "every line fits the budget, repeats the addresses, and the chunks rejoin to the payload" do
      payload = json_text(:crypto.strong_rand_bytes(3_000))
      budget = LineSplit.frame_budget("vjt-claude", 512)

      assert {:ok, lines} = E2e.fragment(:msg, "q83vEjRWeJA", {@alice, "*"}, payload, budget)
      assert length(lines) > 1
      assert Enum.all?(lines, &(byte_size(&1) <= budget))

      fragments = Enum.map(lines, &parsed!/1)
      total = length(lines)
      assert Enum.map(fragments, & &1.index) == Enum.to_list(1..total)

      assert Enum.all?(
               fragments,
               &(&1.total == total and &1.verb == :msg and &1.msgid == "q83vEjRWeJA" and &1.from == @alice and
                   &1.to == "*")
             )

      assert Enum.map_join(fragments, & &1.chunk) == payload
    end

    test "uses the room it has: one fewer byte of budget never means fewer lines" do
      payload = json_text(:crypto.strong_rand_bytes(900))
      {:ok, wide} = E2e.fragment(:msg, "q83vEjRWeJA", {@alice, @bob}, payload, 300)
      {:ok, narrow} = E2e.fragment(:msg, "q83vEjRWeJA", {@alice, @bob}, payload, 299)
      assert length(narrow) >= length(wide)
      # Every line but the last is filled to the budget exactly.
      assert wide |> Enum.drop(-1) |> Enum.all?(&(byte_size(&1) == 300))
    end

    test "refuses a payload that needs more than 64 lines" do
      payload = json_text(:crypto.strong_rand_bytes(20_000))
      assert {:error, :too_large} = E2e.fragment(:msg, "q83vEjRWeJA", {@alice, @bob}, payload, 300)
    end

    test "refuses a budget that cannot hold the frame around one byte" do
      assert {:error, :too_large} = E2e.fragment(:msg, "q83vEjRWeJA", {@alice, @bob}, @keyreq_payload, 40)
      assert {:error, :too_large} = E2e.fragment(:msg, "q83vEjRWeJA", {@alice, @bob}, @keyreq_payload, -5)
    end

    property "fragment then parse reassembles any payload within any workable budget" do
      check all(
              bytes <- binary(min_length: 1, max_length: 6_000),
              budget <- integer(80..512),
              {verb, from, to} <-
                member_of([
                  {:keyreq, @alice, "*"},
                  {:keys, "*", @bob},
                  {:pkmsg, @alice, @bob},
                  {:msg, @alice, "*"},
                  {:nack, @bob, @alice}
                ])
            ) do
        payload = json_text(bytes)
        msgid = E2e.new_msgid()

        case E2e.fragment(verb, msgid, {from, to}, payload, budget) do
          {:ok, lines} ->
            assert length(lines) <= E2e.max_fragments()
            assert Enum.all?(lines, &(byte_size(&1) <= budget))
            parsed = Enum.map(lines, &parsed!/1)
            assert Enum.all?(parsed, &(&1.from == from and &1.to == to))
            assert Enum.map_join(parsed, & &1.chunk) == payload

          {:error, :too_large} ->
            # Only ever because 64 lines of this budget cannot hold it.
            head = byte_size("\x01E2E KEYREQ #{msgid} 64/64 #{from} #{to} \x01")
            assert byte_size(payload) > 64 * (budget - head)
        end
      end
    end
  end

  defp parsed!(line) do
    {:ok, fragment} = E2e.parse(line)
    fragment
  end
end
