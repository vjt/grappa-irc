defmodule Grappa.IRC.E2eTest do
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.IRC.{E2e, LineSplit}
  alias Grappa.IRC.E2e.Fragment

  # A realistic payload: the padded base64 of a small JSON object, the
  # shape the agreed 2430 wire carries (`{"v":1}` is a KEYREQ body).
  @keyreq_payload Base.encode64(~s({"v":1}))

  describe "framed?/1" do
    test "true for any body opening with the E2E CTCP frame, malformed or not" do
      assert E2e.framed?("\x01E2E MSG AAAAAAAAAAA 1/1 eyJ2IjoxfQ==\x01")
      # Malformed (no fields at all) is still an E2E line: the never-persist
      # rule must catch it as surely as a well-formed one.
      assert E2e.framed?("\x01E2E garbage")
      assert E2e.framed?("\x01E2E\x01")
    end

    test "false for other CTCP verbs and plain text" do
      refute E2e.framed?("\x01ACTION waves\x01")
      refute E2e.framed?("\x01E2EMSG\x01")
      refute E2e.framed?("E2E MSG AAAAAAAAAAA 1/1 eyJ2IjoxfQ==")
      refute E2e.framed?("")
    end
  end

  describe "parse/1" do
    test "reads the five fields of a well-formed line" do
      assert {:ok, %Fragment{verb: :pkmsg, msgid: "q83vEjRWeJA", index: 2, total: 3, chunk: "eyJ2Ijox"}} =
               E2e.parse("\x01E2E PKMSG q83vEjRWeJA 2/3 eyJ2Ijox\x01")
    end

    test "the closing \\x01 is optional, like every CTCP frame" do
      assert {:ok, %Fragment{verb: :msg, chunk: "fQ=="}} = E2e.parse("\x01E2E MSG q83vEjRWeJA 1/1 fQ==")
    end

    test "maps every agreed verb, and nothing else" do
      for {wire, verb} <- [{"KEYREQ", :keyreq}, {"KEYS", :keys}, {"PKMSG", :pkmsg}, {"MSG", :msg}, {"NACK", :nack}] do
        assert {:ok, %Fragment{verb: ^verb}} = E2e.parse("\x01E2E #{wire} q83vEjRWeJA 1/1 eyJ2IjoxfQ==\x01")
      end

      # Draft 7 listed OFFLINE; vjt dropped it (2430, 19:3x), so it is as
      # unknown as any other word.
      assert {:error, :malformed} = E2e.parse("\x01E2E OFFLINE q83vEjRWeJA 1/1 eyJ2IjoxfQ==\x01")
      assert {:error, :malformed} = E2e.parse("\x01E2E msg q83vEjRWeJA 1/1 eyJ2IjoxfQ==\x01")
    end

    test "refuses an index outside 1..total and a total above 64" do
      for frac <- ["0/1", "2/1", "1/65", "65/65", "1/0", "-1/2", "+1/2", "1/2/3", "a/2", "1/", "/1"] do
        assert {:error, :malformed} = E2e.parse("\x01E2E MSG q83vEjRWeJA #{frac} eyJ2IjoxfQ==\x01"), frac
      end

      assert {:ok, %Fragment{index: 64, total: 64}} = E2e.parse("\x01E2E MSG q83vEjRWeJA 64/64 eyJ2IjoxfQ==\x01")
    end

    test "refuses a chunk or msgid outside the base64 alphabet, and an empty chunk" do
      assert {:error, :malformed} = E2e.parse("\x01E2E MSG q83vEjRWeJA 1/1 not-base64!\x01")
      assert {:error, :malformed} = E2e.parse("\x01E2E MSG q83v_jRWeJA 1/1 eyJ2IjoxfQ==\x01")
      assert {:error, :malformed} = E2e.parse("\x01E2E MSG q83vEjRWeJA 1/1 \x01")
      assert {:error, :malformed} = E2e.parse("\x01E2E MSG #{String.duplicate("A", 25)} 1/1 eyJ2IjoxfQ==\x01")
    end

    test "refuses a missing or an extra field" do
      assert {:error, :malformed} = E2e.parse("\x01E2E MSG q83vEjRWeJA 1/1\x01")
      assert {:error, :malformed} = E2e.parse("\x01E2E MSG q83vEjRWeJA 1/1 eyJ2 IjoxfQ==\x01")
      assert {:error, :malformed} = E2e.parse("\x01E2E MSG q83vEjRWeJA 1/1 eyJ2IjoxfQ== \x01")
    end

    test "refuses what is not an E2E line at all" do
      assert {:error, :malformed} = E2e.parse("\x01ACTION waves\x01")
      assert {:error, :malformed} = E2e.parse("hello")
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

  describe "fragment/4" do
    test "a payload that fits goes out as one line, 1/1" do
      assert {:ok, [line]} = E2e.fragment(:keyreq, "q83vEjRWeJA", @keyreq_payload, 400)
      assert line == "\x01E2E KEYREQ q83vEjRWeJA 1/1 #{@keyreq_payload}\x01"
    end

    test "every line fits the budget and the chunks rejoin to the payload, byte for byte" do
      payload = Base.encode64(:crypto.strong_rand_bytes(3_000))
      budget = LineSplit.frame_budget("vjt-claude", 512)

      assert {:ok, lines} = E2e.fragment(:msg, "q83vEjRWeJA", payload, budget)
      assert length(lines) > 1
      assert Enum.all?(lines, &(byte_size(&1) <= budget))

      fragments = Enum.map(lines, &parsed!/1)
      total = length(lines)
      assert Enum.map(fragments, & &1.index) == Enum.to_list(1..total)
      assert Enum.all?(fragments, &(&1.total == total and &1.verb == :msg and &1.msgid == "q83vEjRWeJA"))
      assert Enum.map_join(fragments, & &1.chunk) == payload
    end

    test "uses the room it has: one fewer byte of budget never means fewer lines" do
      payload = Base.encode64(:crypto.strong_rand_bytes(900))
      {:ok, wide} = E2e.fragment(:msg, "q83vEjRWeJA", payload, 300)
      {:ok, narrow} = E2e.fragment(:msg, "q83vEjRWeJA", payload, 299)
      assert length(narrow) >= length(wide)
      # Every line but the last is filled to the budget exactly.
      assert wide |> Enum.drop(-1) |> Enum.all?(&(byte_size(&1) == 300))
    end

    test "refuses a payload that needs more than 64 lines" do
      payload = Base.encode64(:crypto.strong_rand_bytes(20_000))
      assert {:error, :too_large} = E2e.fragment(:msg, "q83vEjRWeJA", payload, 300)
    end

    test "refuses a budget that cannot hold the frame around one byte" do
      assert {:error, :too_large} = E2e.fragment(:msg, "q83vEjRWeJA", @keyreq_payload, 20)
      assert {:error, :too_large} = E2e.fragment(:msg, "q83vEjRWeJA", @keyreq_payload, -5)
    end

    property "fragment then parse reassembles any payload within any workable budget" do
      check all(
              bytes <- binary(min_length: 1, max_length: 6_000),
              budget <- integer(60..512),
              verb <- member_of(E2e.verbs())
            ) do
        payload = Base.encode64(bytes)
        msgid = E2e.new_msgid()

        case E2e.fragment(verb, msgid, payload, budget) do
          {:ok, lines} ->
            assert length(lines) <= E2e.max_fragments()
            assert Enum.all?(lines, &(byte_size(&1) <= budget))
            parsed = Enum.map(lines, &parsed!/1)
            assert Enum.map_join(parsed, & &1.chunk) == payload

          {:error, :too_large} ->
            # Only ever because 64 lines of this budget cannot hold it.
            assert byte_size(payload) > 64 * (budget - byte_size("\x01E2E KEYREQ #{msgid} 64/64 \x01"))
        end
      end
    end
  end

  defp parsed!(line) do
    {:ok, fragment} = E2e.parse(line)
    fragment
  end
end
