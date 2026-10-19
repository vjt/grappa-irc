defmodule GrappaWeb.Plugs.SecurityHeadersTest do
  @moduledoc """
  #485 — the security-header set moved off nginx into the app. This plug
  is now the SINGLE source of truth for CSP + the four sibling headers on
  every substrate (Docker single-container, the m42 bastille jail, the
  operator's own TLS front door). nginx — where it survives (jail + e2e) —
  is a dumb reverse proxy that emits none of these.

  The golden literal below started as the CSP that shipped byte-for-byte
  in the retired `infra/snippets/security-headers.conf`; #607 widened
  `media-src` to `https:` (external audio in the docked mini-player) and
  #1240 widened `img-src` the same way (cross-host images in the media
  viewer) — deliberate, pinned deviations. It is intentionally hardcoded
  here (not read from the plug) so this test PINS the plug against drift —
  a characterization contract, not a mirror.
  """
  use ExUnit.Case, async: true

  import Plug.{Conn, Test}

  alias GrappaWeb.Plugs.SecurityHeaders

  # The plug's Content-Security-Policy SSOT (was byte-identical to the
  # deleted nginx snippet; #607 widened media-src to https:, #1240 img-src,
  # #1695 added ONE connect-src host, 1883 added `blob:` to img-src, issue
  # 2430 added `'wasm-unsafe-eval'` to script-src). If the
  # app must change the policy, change it in ONE place (the plug) and update
  # this pin deliberately.
  @golden_csp "default-src 'self'; connect-src 'self' https://challenges.cloudflare.com https://*.hcaptcha.com https://litterbox.catbox.moe https://api.somafm.com https://kohina.brona.dk; script-src 'self' 'wasm-unsafe-eval' 'sha256-ZswfTY7H35rbv8WC7NXBoiC7WNu86vSzCDChNWwZZDM=' https://challenges.cloudflare.com https://*.hcaptcha.com; style-src 'self' 'unsafe-inline' https://*.hcaptcha.com; img-src 'self' data: blob: https:; font-src 'self'; manifest-src 'self'; media-src 'self' blob: https:; worker-src 'self' blob:; frame-src https://challenges.cloudflare.com https://*.hcaptcha.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"

  defp sent(status) do
    :get
    |> conn("/")
    |> SecurityHeaders.call(SecurityHeaders.init([]))
    |> send_resp(status, "body")
  end

  # Parse the EMITTED policy into %{directive => MapSet.t(source)}. The golden
  # pin above catches byte drift; the #1695 tests below need to ask what a
  # directive ADMITS, and re-typing the expected string to answer that would
  # make them mirrors of the implementation instead of assertions about it.
  defp directives do
    SecurityHeaders.csp()
    |> String.split(";", trim: true)
    |> Map.new(fn directive ->
      [name | sources] = directive |> String.trim() |> String.split(" ", trim: true)
      {name, MapSet.new(sources)}
    end)
  end

  describe "#1695 — the SomaFM catalogue host on connect-src" do
    # Measured against the live catalogue (46 channels, 425 absolute URLs,
    # 2026-08-23): the 184 `.pls` playlist URLs — the only kind a client
    # FETCHES, and so the only kind `connect-src` governs — are 184/184 on
    # `api.somafm.com`. The 138 logos ride `img-src https:` and the 103
    # prerolls ride `media-src https:`, both already wide enough, and the
    # prerolls are the only thing on the bare `somafm.com` at all.
    test "connect-src admits the catalogue host" do
      assert MapSet.member?(directives()["connect-src"], "https://api.somafm.com"),
             "connect-src must admit https://api.somafm.com — it is the host every " <>
               "connect-src-governed SomaFM URL lives on."
    end

    # `https://*.somafm.com` (the issue TITLE's spelling) is wider than the
    # measurement: it admits every present and future somafm subdomain —
    # ice/ice2..6, hls — for `fetch`, and not one of them appears in the
    # catalogue's connect-src set. It also does NOT match the bare
    # `somafm.com` (a CSP host-source with `*.` requires at least one label),
    # so it buys nothing for the prerolls either. Widening past the measured
    # host is a security regression, not a convenience.
    test "connect-src stays at the measured host, not a somafm wildcard" do
      somafm =
        directives()["connect-src"]
        |> Enum.filter(&String.contains?(&1, "somafm.com"))
        |> Enum.sort()

      assert somafm == ["https://api.somafm.com"],
             "connect-src must carry exactly the measured host and no wildcard; got " <>
               inspect(somafm)
    end

    # #1695 is a one-token change. Its own verification step says so: the
    # logos and prerolls already pass on directives that must not move.
    test "no directive other than connect-src gained a somafm source" do
      leaked =
        for {name, sources} <- directives(),
            name != "connect-src",
            source <- sources,
            String.contains?(source, "somafm"),
            do: {name, source}

      assert leaked == [],
             "only connect-src needed widening; somafm leaked into " <> inspect(leaked)
    end
  end

  describe "#1835 — the second metadata host on connect-src" do
    # Kohina publishes its now-playing fact as an Icecast `status-json.xsl`
    # (measured 2026-08-27: HTTP 200 `application/json`,
    # `Access-Control-Allow-Origin: *`). A `fetch` is governed by connect-src,
    # so without this token the station plays perfectly and its track line stays
    # empty forever, with nothing but a browser console saying why.
    test "connect-src admits the icecast status host" do
      assert MapSet.member?(directives()["connect-src"], "https://kohina.brona.dk"),
             "connect-src must admit https://kohina.brona.dk — it is the host cic reads " <>
               "the Kohina now-playing feed from."
    end

    # The audio for this station comes off the SAME host and needs no entry of
    # its own: a stream is `media-src https:`, already scheme-wide. Pinned
    # because the tempting "tidy" move is to add the host to media-src too,
    # which would narrow nothing and imply the two directives are one axis.
    test "no directive other than connect-src gained the icecast host" do
      leaked =
        for {name, sources} <- directives(),
            name != "connect-src",
            source <- sources,
            String.contains?(source, "kohina"),
            do: {name, source}

      assert leaked == [],
             "only connect-src needed the feed host; kohina leaked into " <> inspect(leaked)
    end

    # 🔴 THE RULE THE WHOLE DIRECTIVE RESTS ON, and the one a second vendor
    # makes tempting to break. Two hosts is where somebody proposes
    # `connect-src https:` "so the table can hold anything" — which would turn a
    # curated station list into a blanket outbound-fetch permission for every
    # future row, and take with it the #1695 refusals that pin this policy apart
    # from a wildcard. Adding a THIRD metadata host is fine and is meant to be
    # visible; collapsing them into a scheme is not.
    test "connect-src names hosts, never a bare scheme" do
      schemes =
        directives()["connect-src"]
        |> Enum.filter(&(&1 in ["https:", "http:", "*"]))
        |> Enum.sort()

      assert schemes == [],
             "connect-src must stay a per-vendor host allowlist; found " <> inspect(schemes)

      # The positive control beside it: the filter above must be capable of
      # matching, or an inverted predicate would report this green having
      # compared nothing. `media-src` genuinely carries `https:` (#607).
      assert Enum.any?(directives()["media-src"], &(&1 == "https:")),
             "the scheme filter matched nothing anywhere — it cannot be trusted to " <>
               "have checked connect-src either."
    end
  end

  describe "1883 — the picked-file thumbnail on img-src" do
    # The upload confirm previews the operator's OWN file before anything is
    # sent, as an `<img>` on a `URL.createObjectURL` blob (ConfirmModal.tsx).
    # Measured in the e2e stack before the token existed: Chromium refused it
    # with `violatedDirective: img-src, blockedURI: blob`, so the dialog whose
    # whole job is showing WHICH photo showed an empty box — and the browser
    # says so only in a console nobody reads in prod.
    test "img-src admits blob:" do
      assert MapSet.member?(directives()["img-src"], "blob:"),
             "img-src must admit blob: — the picker confirm's thumbnail is an " <>
               "object URL over the operator's own file, never a fetch."
    end

    # `blob:` is an ADDITION, not a replacement. The RULE at the top of the
    # plug's moduledoc is that naming a directive replaces the `default-src`
    # fallback wholesale, so a "tidy" rewrite that drops one of the other three
    # tokens while adding this one would pass the test above and silently take
    # out favicons (`data:`) or the cross-host viewer (`https:`, #1240).
    test "the other img-src sources survive the addition" do
      missing = MapSet.difference(MapSet.new(["'self'", "data:", "https:"]), directives()["img-src"])

      assert MapSet.equal?(missing, MapSet.new()),
             "img-src lost " <> inspect(MapSet.to_list(missing)) <> " — blob: is an addition."
    end
  end

  describe "issue 2430 — WebAssembly compilation on script-src" do
    # cic runs vodozemac (the Olm library of end-to-end encrypted queries) as
    # WebAssembly. Without a source that allows it, `script-src` refuses
    # `WebAssembly.instantiate` outright and every E2E feature is dead in the
    # browser while the unit tests, which run in node, stay green.
    test "script-src admits WebAssembly compilation" do
      assert MapSet.member?(directives()["script-src"], "'wasm-unsafe-eval'"),
             "script-src must carry 'wasm-unsafe-eval' — without it the browser refuses to " <>
               "compile cic's vodozemac binding."
    end

    # 'wasm-unsafe-eval' allows compiling WebAssembly and nothing else.
    # 'unsafe-eval' would be the lazy spelling of the same need, and it also
    # turns on `eval()` and `new Function()` for every script on the page.
    test "script-src still refuses JavaScript eval and inline scripts" do
      refused = MapSet.intersection(directives()["script-src"], MapSet.new(["'unsafe-eval'", "'unsafe-inline'"]))

      assert MapSet.equal?(refused, MapSet.new()),
             "script-src gained " <> inspect(MapSet.to_list(refused)) <> " — only WebAssembly was asked for."
    end
  end

  test "csp/0 matches the golden pin (SSOT, incl. the #607 media-src + #1240 img-src https: widenings)" do
    assert SecurityHeaders.csp() == @golden_csp
  end

  test "emits the CSP header on a 2xx response" do
    assert get_resp_header(sent(200), "content-security-policy") == [@golden_csp]
  end

  test "emits the full sibling header set (verbatim from the snippet)" do
    conn = sent(200)
    assert get_resp_header(conn, "x-content-type-options") == ["nosniff"]
    assert get_resp_header(conn, "referrer-policy") == ["same-origin"]
    assert get_resp_header(conn, "x-frame-options") == ["DENY"]

    assert get_resp_header(conn, "permissions-policy") ==
             ["geolocation=(), microphone=(), camera=(), payment=(), usb=()"]
  end

  test "headers land on a non-2xx response too (nginx `always` parity)" do
    assert get_resp_header(sent(404), "content-security-policy") == [@golden_csp]
    assert get_resp_header(sent(500), "x-frame-options") == ["DENY"]
  end

  test "the plug is the sole owner — its value wins over a downstream header" do
    conn =
      :get
      |> conn("/")
      |> SecurityHeaders.call(SecurityHeaders.init([]))
      |> put_resp_header("x-frame-options", "SAMEORIGIN")
      |> send_resp(200, "body")

    assert get_resp_header(conn, "x-frame-options") == ["DENY"]
  end
end
