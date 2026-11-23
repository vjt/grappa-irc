defmodule Mix.Tasks.Grappa.WirePinTest do
  use ExUnit.Case, async: true

  alias Mix.Tasks.Grappa.{GenWireTypes, WirePin}

  # #1393d — the gate behind vjt's "bump it every time" ruling.
  #
  # The rule it enforces cannot be enforced by the sibling drift gate, and
  # that is a MEASUREMENT and not an opinion: `grappa.gen_wire_types --check`
  # compares the generated artefact against its own SOURCE, so a developer who
  # adds a field and regenerates gets `in sync.` — green in exactly the case
  # to catch. The detector needs a BEFORE, and `--check` has none.
  #
  # This task supplies the BEFORE as a PIN in the tree: the shape digest and
  # the `Grappa.Protocol.version/0` it was taken at, together in one file. The
  # pair is what makes it un-greenable — you cannot refresh the digest without
  # the refresh refusing unless the number moved too.

  @moduletag :wire_pin

  defp pin(version, digest), do: %{protocol_version: version, shape_digest: digest}

  describe "check/3 — the four states, exhaustively" do
    test "digest and version both match the pin → :ok" do
      assert WirePin.check("sha256:aaa", 2, pin(2, "sha256:aaa")) == :ok
    end

    # THE gate. Everything else in this file exists to make this line true.
    test "shape moved and the version did NOT → the ruling's violation" do
      assert WirePin.check("sha256:bbb", 2, pin(2, "sha256:aaa")) ==
               {:error, :shape_moved_without_bump}
    end

    test "shape moved and the version moved with it → the rule held, pin is stale" do
      assert WirePin.check("sha256:bbb", 3, pin(2, "sha256:aaa")) == {:error, :pin_stale}
    end

    # Bumping alone is allowed (min_version moves, a doc-only protocol change),
    # so this is NOT the violation — but the pin still has to be refreshed, or
    # the next shape change would compare against a version nobody is at.
    test "version moved with the shape unchanged → pin is stale, not a violation" do
      assert WirePin.check("sha256:aaa", 3, pin(2, "sha256:aaa")) == {:error, :pin_stale}
    end
  end

  describe "update refusal — what makes the pin un-greenable" do
    test "refuses to rewrite the pin when the shape moved and the version did not" do
      assert WirePin.updatable?("sha256:bbb", 2, pin(2, "sha256:aaa")) == false
    end

    test "allows the rewrite once the version has moved too" do
      assert WirePin.updatable?("sha256:bbb", 3, pin(2, "sha256:aaa")) == true
    end

    test "allows the rewrite when only the version moved" do
      assert WirePin.updatable?("sha256:aaa", 3, pin(2, "sha256:aaa")) == true
    end
  end

  describe "the failure message tells the developer what to do" do
    # The orchestrator made this binding, and the reason is that a gate which
    # only says "you are red" gets routed around instead of obeyed. Asserted
    # on CONTENT, not on wording: which number, from what to what, in which
    # file, and the command that finishes the job.
    test "names the number, both values, the file that holds it, and the next step" do
      message = WirePin.failure_message(:shape_moved_without_bump, "sha256:bbb", 2, pin(2, "sha"))

      assert message =~ "@protocol_version"
      assert message =~ "lib/grappa/protocol.ex"
      assert message =~ "2"
      assert message =~ "3"
      assert message =~ "grappa.wire_pin --update"
    end

    test "the stale-pin message does NOT accuse the developer of skipping the bump" do
      message = WirePin.failure_message(:pin_stale, "sha256:bbb", 3, pin(2, "sha256:aaa"))

      assert message =~ "grappa.wire_pin --update"
      # The two failures are different facts and must not read alike: one is a
      # rule violation, the other is bookkeeping the task itself completes.
      refute message =~ "@protocol_version"
    end
  end

  describe "the pin file" do
    test "round-trips through render and parse" do
      original = pin(7, "sha256:deadbeef")
      assert original |> WirePin.render_pin() |> WirePin.parse_pin() == {:ok, original}
    end

    # A pin that silently reads as a default is a gate that passes on a file
    # nobody wrote. Both halves are required, and a missing one is loud.
    test "refuses a pin missing either half" do
      assert {:error, _} = WirePin.parse_pin("protocol_version = 2\n")
      assert {:error, _} = WirePin.parse_pin("shape_digest = sha256:aaa\n")
      assert {:error, _} = WirePin.parse_pin("")
    end

    test "refuses a non-integer version rather than coercing it" do
      assert {:error, _} = WirePin.parse_pin("protocol_version = two\nshape_digest = sha256:a\n")
    end
  end

  describe "the gate, against the real tree" do
    # The gate itself, run as a test so `mix test` catches the violation even
    # when nobody ran `scripts/check.sh`. A red here is not a broken test: it
    # is the wire shape having moved without the number.
    test "the committed pin is current for the live wire shape and protocol version" do
      digest = WirePin.shape_digest(WirePin.shape_text())
      version = Grappa.Protocol.version()
      pin = WirePin.read_pin!()

      # The task's own message, reused rather than paraphrased: whoever
      # reddens this reads it here too, and does not have to go find the
      # gate to learn what to do about it.
      case WirePin.check(digest, version, pin) do
        :ok -> assert true
        {:error, failure} -> flunk(WirePin.failure_message(failure, digest, version, pin))
      end
    end

    test "the digest is a pure, sensitive function of the generated text" do
      text = WirePin.shape_text()

      assert WirePin.shape_digest(text) == WirePin.shape_digest(text)
      assert WirePin.shape_digest(text) != WirePin.shape_digest(text <> " ")
      assert WirePin.shape_digest(text) =~ ~r/^sha256:[0-9a-f]{64}$/
    end

    # BOTH artefacts, and the reason is that preferring one rested on an
    # unmeasured claim. Measured: neither carries typedoc prose, so there was
    # no false-positive argument for excluding either, and no evidence they
    # cannot move independently. A change to what the codegen emits is a
    # change to the wire, full stop.
    test "the digest covers the types artefact as well as the schema one" do
      text = WirePin.shape_text()

      assert String.contains?(text, GenWireTypes.generate())
      assert String.contains?(text, GenWireTypes.generate_schema())
    end
  end

  # #2037 — the third component. The two generated artefacts are not the whole
  # wire: the hand-written `GrappaWeb.*JSON` views ship response shapes the
  # codegen never sees, and a field added to one of them left this gate GREEN.
  # Measured live before the cure, on this branch: `mutant_probe` added to
  # `MessagesJSON.count/1` (spec AND body) kept `--check` at rc 0 and
  # `gen_wire_types --check` at `in sync.`, with the field appearing 0 times in
  # either artefact. After the cure the same addition moves the digest.
  describe "the hand-written web views are in the digest too" do
    test "the digested text carries what a view DECLARES, not only the codegen" do
      text = WirePin.shape_text()
      views = WirePin.json_view_spec_text()

      # Load-bearing, not decorative: the old two-artefact composition must
      # not already contain it, or this component is buying nothing.
      old_composition = GenWireTypes.generate() <> "\n" <> GenWireTypes.generate_schema()

      assert String.contains?(text, views)
      refute String.contains?(old_composition, views)
    end

    test "the #2037 count response is inside the digested text" do
      text = WirePin.shape_text()
      views = WirePin.json_view_spec_text()

      # The exact shape whose ADDITION this gate failed to see. Named rather
      # than probed generically: if a refactor moves this response out of
      # what the digest reads, the coverage is gone and this says so. Issue
      # 2694 was such a refactor — the inline return became the named
      # `count_response/0` — so the fields now reach the digest through the
      # CODEGEN component, and the spec component carries the name.
      assert views =~ "GrappaWeb.MessagesJSON"
      assert views =~ "count_response()"
      assert text =~ "export type MessagesJSONSplitCountResponse = {"
      assert text =~ "  messages: number;"
      assert text =~ "  events: number;"
    end

    test "discovery is DERIVED from the build output and finds every view" do
      # ONE view set, shared with the codegen since issue 2694 — the pin reads
      # it through `json_view_spec_text/0`, so this is the set it digests.
      mods = GenWireTypes.json_view_modules()

      # Positive control: a set this small going empty is the failure mode
      # the component raises on, and an assertion of ">= 1" would not notice
      # twelve of thirteen disappearing.
      assert length(mods) >= 13
      assert GrappaWeb.MessagesJSON in mods
      assert GrappaWeb.UserSettingsJSON in mods
      assert GrappaWeb.PushSubscriptionJSON in mods

      # Sorted, so the digest cannot move on filesystem ordering alone.
      assert mods == Enum.sort(mods)

      # Nothing that is not a view. The glob is the whole membership rule and
      # a widened one would quietly digest unrelated modules.
      for mod <- mods do
        name = inspect(mod)
        assert String.starts_with?(name, "GrappaWeb.")
        assert String.ends_with?(name, "JSON")
      end
    end

    test "a private helper's spec is NOT digested, while its exported sibling is" do
      views = WirePin.json_view_spec_text()

      # `PushSubscriptionJSON` is the module that makes this testable rather
      # than argued: it `@spec`s BOTH `device/1` (exported, a wire shape) and
      # `summary/1` (`defp`, an internal helper). One pair, one module, so a
      # filter that passed everything and a filter that passed nothing are
      # both caught here.
      assert {:device, 1} in GrappaWeb.PushSubscriptionJSON.__info__(:functions)
      refute {:summary, 1} in GrappaWeb.PushSubscriptionJSON.__info__(:functions)

      assert views =~ "@spec device("
      refute views =~ "@spec summary("
    end
  end

  describe "no network, and it is enforced rather than promised" do
    # The orchestrator's second binding requirement: a gate that reaches for
    # `origin/main` or a tag breaks CI the moment CI is offline. The pin is in
    # the tree precisely so the comparison is local, and this asserts the
    # property on the SOURCE rather than trusting the design note.
    test "the task shells out to nothing and opens no socket" do
      source = File.read!("lib/mix/tasks/grappa/wire_pin.ex")

      for forbidden <- ["System.cmd", ":httpc", "HTTPoison", "Req.", ":inets", ":gen_tcp"] do
        refute source =~ forbidden, "wire_pin must stay offline, found #{forbidden}"
      end
    end
  end
end
