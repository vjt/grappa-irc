defmodule GrappaWeb.RouterSwDenylistTest do
  # REV-G H22 (2026-05-22): the cic PWA service worker installs a
  # navigation-route handler that serves the SPA shell on top-level
  # navigations. A denylist regex tells Workbox which top-level
  # paths must NOT serve the shell — they pass through to the
  # network so the origin server's controller answers (image bytes
  # from /uploads/<slug>, JSON from /admin/visitors, etc.).
  #
  # Router scopes ARE the source of truth (per CLAUDE.md "One
  # feature, one code path, every door" + the M-9b nginx-allowlist
  # lesson). The SW denylist MUST be a superset of router.ex's
  # top-level scope prefixes — adding a new top-level scope without
  # updating the SW results in the same broken-image / SPA-shell-
  # masking-controller failure mode H22 fixed.
  #
  # This test:
  #   1. enumerates GrappaWeb.Router.__routes__/0 (compiled-router
  #      reflection — authoritative source, not regex over
  #      router.ex);
  #   2. extracts each route's top-level path segment;
  #   3. parses cicchetto/src/service-worker.ts for the `denylist`
  #      array, extracting each `/^\/<token>/` regex's prefix;
  #   4. asserts every router top-level prefix appears in the SW
  #      denylist (modulo the small whitelist below).
  #
  # Whitelist (router-side prefixes intentionally NOT in the SW
  # denylist):
  #   - "/" — root scope hosts the SPA shell itself; rewriting "/"
  #     to index.html is the desired behaviour.
  #   - "/healthz" — single GET; load-balancer probe; if a probe URL
  #     opens in a browser tab the SPA shell is harmless.
  #
  # async: true — pure file reads + module reflection, no shared
  # state.
  use ExUnit.Case, async: true

  @sw_path "cicchetto/src/service-worker.ts"
  @whitelist ["/", "/healthz"]

  describe "SW denylist ⊇ router top-level scopes" do
    test "every router top-level prefix appears in the SW denylist" do
      router_prefixes = router_top_level_prefixes()
      sw_prefixes = sw_denylist_prefixes()

      missing = router_prefixes -- (sw_prefixes ++ @whitelist)

      assert missing == [],
             """
             SW navigation denylist is missing router top-level prefix(es): #{inspect(missing)}.

             Router prefixes:  #{inspect(router_prefixes)}
             SW denylist:      #{inspect(sw_prefixes)}
             Whitelist:        #{inspect(@whitelist)}

             Fix: add `/^\\/<prefix>/` to the `denylist` array in
             #{@sw_path}. See REV-G H22 (CP40, 2026-05-22) — without
             this, top-level navigation to the new path serves the
             SPA shell instead of reaching the controller.
             """
    end
  end

  describe "SW denylist parse sanity" do
    test "SW denylist contains the REV-G H22 baseline prefixes" do
      sw_prefixes = sw_denylist_prefixes()

      for required <- ~w(/auth /me /networks /socket /push /api /admin /uploads) do
        assert required in sw_prefixes,
               "SW denylist missing baseline prefix #{required} — REV-G H22 invariant violated"
      end
    end
  end

  # ── Helpers ───────────────────────────────────────────────────────

  defp router_top_level_prefixes do
    GrappaWeb.Router.__routes__()
    |> Enum.map(&top_level(&1.path))
    |> Enum.uniq()
    |> Enum.sort()
  end

  defp top_level("/"), do: "/"

  defp top_level(path) do
    case String.split(path, "/", trim: true) do
      [first | _] -> "/" <> first
      [] -> "/"
    end
  end

  defp sw_denylist_prefixes do
    @sw_path
    |> File.read!()
    |> extract_sw_denylist_tokens()
    |> Enum.map(&("/" <> &1))
    |> Enum.sort()
  end

  # Pulls every `/^\/<token>/` regex token out of the
  # `denylist: [ ... ]` array. Tolerates whitespace + multi-line
  # formatting. Single-line `:s` modifier handles either.
  defp extract_sw_denylist_tokens(source) do
    case Regex.run(~r/denylist:\s*\[([^\]]+)\]/s, source) do
      [_, body] ->
        ~r{/\^\\/([A-Za-z0-9_-]+)/}
        |> Regex.scan(body)
        |> Enum.map(fn [_, token] -> token end)

      _ ->
        flunk("Could not locate `denylist: [...]` block in #{@sw_path}")
    end
  end
end
