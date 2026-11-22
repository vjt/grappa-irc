defmodule Grappa.E2eVectorsTest do
  @moduledoc """
  The server's reader of the E2E conformance corpus (issue 2691).

  The corpus lives in `cicchetto/src/lib/e2e/vectors/` and is read by three
  suites: this one, cicchetto's `e2eVectors.test.ts` and shottino's
  `test_e2e.c`. Each suite runs ITS OWN production code against the same
  rows, so a change to the protocol that one side misses goes red on that
  side instead of failing closed in the field. The protocol itself is
  `docs/E2E_PROTOCOL.md`.

  The server reads the files whose subject it implements: the did
  (derivation, and the canonical check a frame address passes), the list
  text (the one signature grappa verifies), the line arithmetic of
  `Grappa.IRC.E2e.fragment/5`, and the identifier fold. It never parses a
  payload and never computes `fb`, so it does not read `payloads.json` or
  `fb.json`.

  ExUnit reads the cic-side files the way `ShouldNotifyParityTest` reads
  its truth table: `cicchetto/src` is mounted into the test container.
  """
  use ExUnit.Case, async: true

  alias Grappa.E2eKeys.{Device, DeviceList}
  alias Grappa.IRC.{E2e, Identifier}

  @dir Path.expand("../../cicchetto/src/lib/e2e/vectors", __DIR__)

  for name <- ~w(did signed_strings lines_needed fold) do
    @external_resource Path.join(@dir, name <> ".json")
  end

  read = fn name -> @dir |> Path.join(name <> ".json") |> File.read!() |> Jason.decode!() end

  @did read.("did")
  @signed read.("signed_strings")["cases"]
  @lines read.("lines_needed")
  @fold read.("fold")["cases"]

  # Explicit string→atom map, literal atoms: `String.to_existing_atom/1`
  # races module load order when this file runs alone.
  @verbs %{"keyreq" => :keyreq, "keys" => :keys, "pkmsg" => :pkmsg, "msg" => :msg, "nack" => :nack}

  test "every file the server reads holds cases (guards an accidental empty array)" do
    assert length(@did["derive"]) >= 2
    assert @did["not_keys"] != []
    assert length(@did["spellings"]) >= 5
    assert Enum.any?(@signed, &(&1["kind"] == "list"))
    assert length(@lines["cases"]) >= 10
    assert length(@fold) >= 5
  end

  for c <- @did["derive"] do
    test "did — derives #{c["did"]}: #{c["why"]}" do
      c = unquote(Macro.escape(c))
      assert Device.did(c["ed25519"]) == {:ok, c["did"]}
    end
  end

  for c <- @did["not_keys"] do
    test "did — refuses to derive from what is not a key: #{c["why"]}" do
      c = unquote(Macro.escape(c))
      assert Device.did(c["ed25519"]) == :error
    end
  end

  # A frame address is checked for the CANONICAL spelling (`E2e.did?/1`);
  # the clients check only the shape. The corpus states both answers.
  for c <- @did["spellings"] do
    test "did — #{inspect(c["did"])} is canonical: #{c["canonical"]} (#{c["why"]})" do
      c = unquote(Macro.escape(c))
      assert E2e.did?(c["did"]) == c["canonical"]
    end
  end

  for c <- @signed, c["kind"] == "list" do
    test "signed strings — the list text, ver #{c["ver"]}, #{length(c["devices"])} device(s)" do
      c = unquote(Macro.escape(c))
      assert DeviceList.signed_string(c["ver"], c["devices"]) == c["text"]
    end
  end

  for c <- @lines["cases"] do
    test "lines needed — #{c["why"]}" do
      c = unquote(Macro.escape(c))
      msgid = unquote(@lines["msgid"])
      payload = String.duplicate("A", c["payload_size"])
      verb = Map.fetch!(@verbs, c["verb"])

      case c["lines"] do
        nil ->
          assert E2e.fragment(verb, msgid, {c["from"], c["to"]}, payload, c["budget"]) == {:error, :too_large}

        n ->
          assert {:ok, lines} = E2e.fragment(verb, msgid, {c["from"], c["to"]}, payload, c["budget"])
          assert length(lines) == n
      end
    end
  end

  for c <- @fold do
    test "fold — #{inspect(c["in"])}: #{c["why"]}" do
      c = unquote(Macro.escape(c))
      assert Identifier.canonical_target(c["in"]) == c["out"]
    end
  end
end
