defmodule Grappa.PresenceFilterTest do
  use ExUnit.Case, async: true

  alias Grappa.PresenceFilter

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
  # `GrappaWeb.RouterSwDenylistTest` (which parses `service-worker.ts`) and the
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
  end
end
