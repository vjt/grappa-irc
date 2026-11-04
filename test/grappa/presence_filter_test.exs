defmodule Grappa.PresenceFilterTest do
  use ExUnit.Case, async: true

  alias Grappa.PresenceFilter
  alias Grappa.Scrollback.Message

  # #458 — the server-side twin of cic's `resolvePresenceVisible`
  # (`cicchetto/src/lib/presenceFilter.ts`), INVERTED: cic asks "is presence
  # VISIBLE?", the server asks "should the fetch HIDE presence?". An explicit
  # per-channel pref wins; unset follows the live member-count size default
  # against the shared `LARGE_CHANNEL_THRESHOLD`.
  describe "hidden?/2 — presence-hide decision (mirror of resolvePresenceVisible, inverted)" do
    test "explicit \"hide\" hides regardless of member count" do
      assert PresenceFilter.hidden?("hide", 0)
      assert PresenceFilter.hidden?("hide", 10_000)
      assert PresenceFilter.hidden?("hide", nil)
    end

    test "explicit \"show\" shows regardless of member count" do
      refute PresenceFilter.hidden?("show", 0)
      refute PresenceFilter.hidden?("show", 10_000)
      refute PresenceFilter.hidden?("show", nil)
    end

    test "unset follows the size default: hides at or above the threshold" do
      threshold = PresenceFilter.large_channel_threshold()
      assert PresenceFilter.hidden?(nil, threshold)
      assert PresenceFilter.hidden?(nil, threshold + 1)
    end

    test "unset follows the size default: shows below the threshold" do
      threshold = PresenceFilter.large_channel_threshold()
      refute PresenceFilter.hidden?(nil, threshold - 1)
      refute PresenceFilter.hidden?(nil, 0)
    end

    test "unset with an unavailable member count defaults to show (decision D — never hide on a guess)" do
      refute PresenceFilter.hidden?(nil, nil)
    end
  end

  # #915 — the cutoff exists TWICE, once per language, and until now the ONLY
  # thing holding the two equal was a sentence in each moduledoc. Every test on
  # both sides derives from its own constant, so raising one alone leaves both
  # suites fully green while the server omits presence from the REST history
  # page and cic renders it on the live tail — for every channel sized between
  # the two values, silently. Same executable-drift-guard shape as
  # `GrappaWeb.RouterSwDenylistTest` (which parses `swNavigationRoute.ts`) and the
  # `should_notify_parity_test.exs` shared truth table: the rule is expressed
  # once per language, so the EQUALITY has to be expressed as code.
  describe "cross-language threshold parity (#915)" do
    @cic_path "cicchetto/src/lib/presenceFilter.ts"

    test "@large_channel_threshold equals cic's LARGE_CHANNEL_THRESHOLD" do
      source = File.read!(@cic_path)

      cic_value =
        case Regex.run(~r/export\s+const\s+LARGE_CHANNEL_THRESHOLD\s*=\s*(\d+)\s*;/, source) do
          [_, digits] -> String.to_integer(digits)
          _ -> flunk("Could not locate `export const LARGE_CHANNEL_THRESHOLD = <n>;` in #{@cic_path}")
        end

      assert cic_value == PresenceFilter.large_channel_threshold(),
             """
             The denoise size-default cutoff has drifted between the two languages.

               #{@cic_path}: #{cic_value}
               Grappa.PresenceFilter:            #{PresenceFilter.large_channel_threshold()}

             They MUST be equal (#458 gave the render-layer rule a server twin for
             the REST history fetch). While they differ, every channel whose member
             count falls between the two values shows join/part/quit on the live WS
             tail and loses it on page-up. Move BOTH or neither.
             """
    end

    # #1262 — the threshold was not the only thing held equal by prose. The
    # KIND SET exists twice too (`Message.suppressed_presence_kinds/0` and
    # cic's `SUPPRESSED_PRESENCE_KINDS`), and adding `:mode` to one side alone
    # leaves BOTH suites green while the REST history page folds a mode row
    # the live WS tail still renders. Same executable-drift-guard shape as the
    # threshold test above: the rule is expressed once per language, so the
    # EQUALITY has to be expressed as code. Order is asserted too — both sides
    # document the mirror order, and a set-only compare would let the two
    # documented orders diverge silently.
    test "suppressed_presence_kinds/0 equals cic's SUPPRESSED_PRESENCE_KINDS, in order" do
      source = File.read!(@cic_path)

      body =
        case Regex.run(
               ~r/export\s+const\s+SUPPRESSED_PRESENCE_KINDS[^=]*=\s*new\s+Set\(\[(.*?)\]\)/s,
               source
             ) do
          [_, captured] ->
            captured

          _ ->
            flunk("Could not locate `export const SUPPRESSED_PRESENCE_KINDS = new Set([...])` in #{@cic_path}")
        end

      cic_kinds =
        ~r/"([a-z_]+)"/
        |> Regex.scan(body)
        |> Enum.map(fn [_, kind] -> String.to_atom(kind) end)

      # A drift guard that reads its subject out of ANOTHER language's source
      # has one failure mode worse than being wrong: becoming a no-op. If a
      # reformat, a quoting-style change, or a rename makes the parse yield
      # NOTHING, the comparison below must not quietly degrade into a
      # confusing `[] != [...]`. Assert the parse produced something FIRST, so
      # the failure names the real cause — the gate stopped reading the file.
      refute cic_kinds == [],
             """
             Parsed ZERO kinds out of #{@cic_path}.

             The literal was located but no `"kind"` strings came out of it,
             so this parity gate is no longer reading anything and would pass
             vacuously the moment the two sides agreed on emptiness. Fix the
             parse (quoting style? the array inlined or reformatted?) rather
             than the assertion.
             """

      assert cic_kinds == Message.suppressed_presence_kinds(),
             """
             The denoise KIND SET has drifted between the two languages.

               #{@cic_path}: #{inspect(cic_kinds)}
               Grappa.Scrollback.Message:        #{inspect(Message.suppressed_presence_kinds())}

             They MUST be equal AND in the same order: the server omits these
             kinds from the REST history fetch (#458) while cic omits the same
             kinds from the live-tail render. While they differ, page-up and
             the live tail disagree about which rows exist. Move BOTH or
             neither.
             """
    end

    # issue 2176 — the kind-set gate above can no longer see the whole rule,
    # and saying so is the point of this test existing beside it. `mode` is in
    # the suppressed set on BOTH sides and stays there; what decides whether a
    # given mode row folds is now the per-ROW tag the server writes
    # (`Message.structural_meta_key/0`) and cic reads (`STRUCTURAL_META_KEY`).
    # Rename one spelling and the sets still match, both suites still pass, and
    # every ban on a denoised channel silently goes back to being invisible —
    # the #1262 defect, restored by a typo no gate was watching. The gate had to
    # GROW an axis, not merely keep comparing the old one.
    test "STRUCTURAL_META_KEY equals Message.structural_meta_key/0" do
      source = File.read!(@cic_path)

      cic_key =
        case Regex.run(~r/export\s+const\s+STRUCTURAL_META_KEY\s*=\s*"([a-z_]+)"/, source) do
          [_, key] ->
            key

          _ ->
            flunk(~s(Could not locate `export const STRUCTURAL_META_KEY = "<key>"` in #{@cic_path}))
        end

      assert cic_key == Atom.to_string(Message.structural_meta_key()),
             """
             The structural-mode EXEMPTION key has drifted between the two languages.

               #{@cic_path}: #{inspect(cic_key)}
               Grappa.Scrollback.Message:        #{inspect(Message.structural_meta_key())}

             The server writes this key into `meta` at persist time for a MODE
             row that changed the channel (a ban, a key, a limit, a flag); both
             the REST history filter and cic's live-tail render filter exempt a
             row carrying it. They MUST be the same string. While they differ
             the kind sets still agree, so the gate above stays green, and a
             `+b` is invisible on every denoised channel again (issue 2176).
             """
    end
  end

  # #1769 — the PAUSABLE set is a second cross-language pair, and it fails
  # differently from the one above. The suppressed set governs what the
  # history fetch OMITS (a row the operator can still scroll to); this one
  # governs what the socket is never SENT. A kind that drifts INTO it on one
  # side alone is a frame the client is entitled to and never receives, with
  # no page-up that recovers it — which is exactly the `nick_change` /`mode`
  # case, whose consumers (#372/#373 identity migration, channel-mode state)
  # break silently rather than loudly.
  describe "cross-language pausable-presence parity (#1769)" do
    @pause_path "cicchetto/src/lib/presencePause.ts"

    test "pausable_presence_kinds/0 is a STRICT subset of suppressed_presence_kinds/0" do
      pausable = Message.pausable_presence_kinds()
      suppressed = Message.suppressed_presence_kinds()

      assert pausable -- suppressed == [],
             """
             `pausable_presence_kinds/0` contains a kind that is not presence at all:

               pausable:   #{inspect(pausable)}
               suppressed: #{inspect(suppressed)}

             The pausable set answers "is this presence we can afford to miss?",
             so every member must first BE presence. A kind outside the
             suppressed set landing here means the socket is dropping something
             that is not presence noise.
             """

      refute suppressed -- pausable == [],
             """
             `pausable_presence_kinds/0` has grown to cover the WHOLE presence set.

             The carve-out is the point: `nick_change` drives the #372/#373
             identity migration and `mode` feeds channel-mode state, and neither
             has a refetch that rebuilds it on resume. If the sets are now equal
             this assertion is the only thing left saying so — decide it on
             purpose, in `Message`, and change this test with the reason.
             """
    end

    test "pausable_presence_kinds/0 equals cic's PAUSABLE_PRESENCE_KINDS, in order" do
      source = File.read!(@pause_path)

      body =
        case Regex.run(
               ~r/export\s+const\s+PAUSABLE_PRESENCE_KINDS[^=]*=\s*new\s+Set\(\[(.*?)\]\)/s,
               source
             ) do
          [_, captured] ->
            captured

          _ ->
            flunk("Could not locate `export const PAUSABLE_PRESENCE_KINDS = new Set([...])` in #{@pause_path}")
        end

      cic_kinds =
        ~r/"([a-z_]+)"/
        |> Regex.scan(body)
        |> Enum.map(fn [_, kind] -> String.to_atom(kind) end)

      # Same positive control as the sibling gate above: a parse that yields
      # nothing must fail as "the gate stopped reading", not as a puzzling
      # empty-list mismatch.
      refute cic_kinds == [],
             """
             Parsed ZERO kinds out of #{@pause_path}.

             The literal was located but no `"kind"` strings came out of it, so
             this parity gate is no longer reading anything. Fix the parse, not
             the assertion.
             """

      assert cic_kinds == Message.pausable_presence_kinds(),
             """
             The pausable KIND SET has drifted between the two languages.

               #{@pause_path}: #{inspect(cic_kinds)}
               Grappa.Scrollback.Message:       #{inspect(Message.pausable_presence_kinds())}

             cic drops these at its dispatch edge (#1680) and the server refuses
             to push them to a socket that joined with `presence: false` (#1769).
             A kind present only server-side is one the client will never see and
             cannot recover; a kind present only client-side merely wastes a
             frame. Both are drift. Move BOTH or neither.
             """
    end
  end
end
