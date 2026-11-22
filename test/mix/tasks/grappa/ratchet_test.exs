defmodule Mix.Tasks.Grappa.RatchetTest do
  # NOT async: the known-answer control compiles and purges a module at run
  # time, and two of those in flight would only make a failure harder to read.
  use ExUnit.Case, async: false

  alias Mix.Tasks.Grappa.Ratchet

  # Issue 2690 — the ratchet on Session.Server's state keys, its
  # handle_call/handle_info clauses and every boundary's `deps:` count.
  # These tests pin the parts a wrong implementation would get wrong without
  # anyone noticing: the counting (against a module whose answers are known),
  # the verdict (every way a count and a record can disagree), the record
  # format, and the discovery set.

  @moduletag :ratchet

  describe "self_test/0 — the known-answer control the task runs before any verdict" do
    test "counts the fixture exactly and the verdict controls hold" do
      assert Ratchet.self_test() == :ok
    end

    test "the fixture's counts are the known answers, read through the real counters" do
      assert Ratchet.fixture_counts() == %{
               state_keys: 3,
               handle_call_clauses: 2,
               handle_info_clauses: 1,
               deps: 2
             }
    end

    test "leaves no fixture module loaded behind it" do
      :ok = Ratchet.self_test()

      leftovers =
        for {mod, _} <- :code.all_loaded(),
            String.starts_with?(Atom.to_string(mod), "Elixir.Grappa.RatchetFixture"),
            do: mod

      assert leftovers == []
    end
  end

  describe "check/2 — every way a count and a record can disagree" do
    test "equal → :ok" do
      assert Ratchet.check(%{"a" => 3, "b" => 0}, %{"a" => 3, "b" => 0}) == :ok
    end

    # THE gate. The rest of this file exists to make this line trustworthy.
    test "a count above its record → :rose" do
      assert Ratchet.check(%{"a" => 4}, %{"a" => 3}) == {:error, [{:rose, "a", 3, 4}]}
    end

    test "a count below its record → :fell, so slack cannot hide the next rise" do
      assert Ratchet.check(%{"a" => 2}, %{"a" => 3}) == {:error, [{:fell, "a", 3, 2}]}
    end

    test "a counted key the record lacks → :unrecorded" do
      assert Ratchet.check(%{"a" => 3, "n" => 1}, %{"a" => 3}) ==
               {:error, [{:unrecorded, "n", 1}]}
    end

    test "a recorded key nothing counts any more → :gone" do
      assert Ratchet.check(%{"a" => 3}, %{"a" => 3, "g" => 2}) == {:error, [{:gone, "g", 2}]}
    end

    test "reports every finding, sorted by key, not just the first" do
      assert Ratchet.check(%{"b" => 5, "a" => 1}, %{"a" => 2, "b" => 4}) ==
               {:error, [{:fell, "a", 2, 1}, {:rose, "b", 4, 5}]}
    end
  end

  describe "failure_message/1" do
    test "a rise names the key in backticks and asks for the DESIGN_NOTES line in the same commit" do
      msg = Ratchet.failure_message([{:rose, "deps:Grappa.Session", 28, 29}])

      assert msg =~ "`deps:Grappa.Session`"
      assert msg =~ "28 -> 29"
      assert msg =~ "DESIGN_NOTES"
      assert msg =~ "same commit"
      assert msg =~ "mix grappa.ratchet --update"
    end

    test "a fall asks only to lower the record" do
      msg = Ratchet.failure_message([{:fell, "state_keys:Grappa.Session.Server", 96, 95}])

      assert msg =~ "96 -> 95"
      assert msg =~ "mix grappa.ratchet --update"
      refute msg =~ "DESIGN_NOTES"
    end
  end

  describe "the record format" do
    test "render/1 and parse/1 round-trip, sorted" do
      counts = %{"deps:Grappa.B" => 2, "deps:Grappa.A" => 0, "state_keys:Grappa.S" => 9}
      text = Ratchet.render(counts)

      assert Ratchet.parse(text) == {:ok, counts}

      assert text |> String.split("\n") |> Enum.reject(&(&1 == "" or String.starts_with?(&1, "#"))) ==
               ["deps:Grappa.A = 0", "deps:Grappa.B = 2", "state_keys:Grappa.S = 9"]
    end

    test "parse/1 rejects a line that is neither a comment nor `key = integer`" do
      assert {:error, msg} = Ratchet.parse("# header\ndeps:Grappa.A = two\n")
      assert msg =~ "deps:Grappa.A = two"
    end

    test "parse/1 rejects a duplicated key" do
      assert {:error, msg} = Ratchet.parse("deps:Grappa.A = 1\ndeps:Grappa.A = 2\n")
      assert msg =~ "deps:Grappa.A"
    end

    test "parse/1 rejects a record with no key at all — a gate on nothing passes on anything" do
      assert {:error, _} = Ratchet.parse("# only a header\n")
    end
  end

  describe "counts/0 — the real tree" do
    setup do
      %{counts: Ratchet.counts()}
    end

    test "counts Session.Server's state keys and both callback clause sets", %{counts: counts} do
      for key <- [
            "state_keys:Grappa.Session.Server",
            "handle_call_clauses:Grappa.Session.Server",
            "handle_info_clauses:Grappa.Session.Server"
          ] do
        assert is_integer(counts[key]) and counts[key] > 0, "#{key} missing or zero: #{inspect(counts[key])}"
      end
    end

    # A real boundary whose declared deps are known and stable.
    test "reads a boundary's declared deps off the build", %{counts: counts} do
      assert counts["deps:Mix.Tasks.Grappa.WirePin"] == 2
    end

    test "records boundaries declared under lib/ only, never test/support", %{counts: counts} do
      files =
        for {"deps:" <> name, _} <- counts do
          mod = Module.concat([name])
          [%{pos: %{file: file}}] = Keyword.fetch!(mod.__info__(:attributes), Boundary)
          Path.relative_to_cwd(file)
        end

      assert files != []

      assert Enum.all?(files, &String.starts_with?(&1, "lib/")),
             inspect(Enum.reject(files, &String.starts_with?(&1, "lib/")))
    end
  end
end
