defmodule GrappaWeb.Plugs.SecurityHeaders do
  @moduledoc """
  Emit the security-header set (CSP + four siblings) on EVERY response.

  ## Single source of truth (#485)

  These headers used to live only in `infra/snippets/security-headers.conf`,
  included by the nginx container that fronted the BEAM. #485 dropped that
  container and made the BEAM self-serve the SPA, so the headers moved here —
  where they belong. This plug is now the SOLE owner on every substrate:

    * Docker `--profile prod` — one container, BEAM published directly;
    * the m42 bastille jail — the in-jail nginx is a dumb reverse proxy that
      emits none of these (it would otherwise double the CSP, and duplicate
      `Content-Security-Policy` headers are enforced as the *intersection*,
      not the union — a prod-only footgun this centralisation removes);
    * an operator's own TLS front door — which previously got NO security
      headers at all, because ours only existed in a container they were
      told to bypass.

  Placed BEFORE `:serve_cic_static` in the endpoint and implemented via
  `register_before_send/2` so the headers land on `Plug.Static` hits (which
  send + halt) and on error responses alike — the app-side equivalent of
  nginx's `add_header ... always`. Registered early, so its callback runs
  LAST (before_send is LIFO) and its value wins over anything downstream set.

  ## CSP allowlist (hard-won — do not rewrite casually)

  RULE (2026-06-10, learned in prod): declaring ANY fetch directive REPLACES
  the `default-src` fallback for that resource type — it does not extend it.
  Every directive must restate `'self'` (and every other source `default-src`
  was silently providing) unless its absence is deliberate AND commented. The
  bare `media-src blob:` first cut cost a prod-only dogfood debugging session;
  e2e ships green on this mistake class because the test stack's CSP coverage
  historically lagged (that gap closes with #485 — the e2e nginx now proxies
  to the BEAM, so these plug-emitted headers are exercised end-to-end).

    * `default-src 'self'` — same-origin baseline.
    * `connect-src 'self' https://challenges.cloudflare.com https://*.hcaptcha.com
      https://litterbox.catbox.moe https://api.somafm.com https://kohina.brona.dk`
      — REST + WS to grappa
      (same-origin: `'self'`
      covers `ws://$host` / `wss://$host` per CSP3, so this is deployment-host
      agnostic — no edit when `PHX_HOST` changes); Cloudflare Turnstile +
      hCaptcha verification XHRs; `litterbox.catbox.moe` receives cic's
      image-upload XHR. The response host `litter.catbox.moe` needs no entry of
      its OWN — since #1240 a click on that link renders the image in the media
      viewer, but the widened `img-src https:` below already covers it. IRC
      stays text only (CLAUDE.md): the modal is on-click, never on arrival.
      `api.somafm.com` (#1695) is the SomaFM catalogue: `channels.json` and the
      `.pls` playlists it points at are `fetch`ed and parsed, so they fall here
      and not on the `media-src`/`img-src` widenings that already carry the
      streams and the logos. **It is ONE host and not `https://*.somafm.com`,
      deliberately.** Measured over the live catalogue on 2026-08-23 — 46
      channels, 425 absolute URLs — every URL this directive governs is on
      `api.somafm.com` (184/184 `.pls`), the 138 logos are `img-src https:` and
      the 103 prerolls are `media-src https:`; the bare `somafm.com` carries
      the prerolls and nothing else. The wildcard would hand `fetch` to every
      present and future somafm subdomain (ice, ice2..6, hls) with nothing
      measured asking for it, and it would not even cover the bare domain — a
      host-source spelled `*.` requires at least one label. CONSEQUENCE FOR A
      CLIENT AUTHOR: the catalogue answers byte-identically from either host
      (52,852 bytes for `channels.json` from both), so a `fetch` aimed at
      `https://somafm.com/...` works under `curl` and dies here. Aim it at
      `api.somafm.com`; `issue1695-somafm-connect-src-perimeter.spec.ts` pins
      both that refusal and the non-api subdomain that separates this policy
      from the wildcard.
      `kohina.brona.dk` (#1835) is the SECOND metadata host, and the fact that
      it needed its own line is the point rather than an inconvenience. cic's
      radio table reads a now-playing feed per station; Kohina publishes one as
      an Icecast `status-json.xsl` (measured 2026-08-27: HTTP 200
      `application/json`, `Access-Control-Allow-Origin: *`) and before this it
      was unreadable purely because the CSP admitted no host to read it from.
      **This directive stays a PER-VENDOR gate, deliberately** — the shape to
      refuse is `connect-src https:`, which would let any future table row
      `fetch` anywhere and turn a curated list into an open outbound
      permission. One host per provider we actually chose is the whole
      mechanism: adding a station that needs a feed is a visible network-surface
      change, reviewed as one, and a row pointing somewhere unlisted fails
      loudly in the console instead of quietly widening the app. The SAME host
      already carries this station's audio, and that needs no entry — a stream
      is `media-src https:` and a status document is a `fetch`; the two
      directives are not interchangeable. cic pins the mirror image of this list
      in `radioStations.test.ts` (`CSP_FEED_HOSTS`), because neither side can
      see the other: the plug does not know what the table holds, and the
      browser bundle cannot read this header.
    * `script-src 'self' 'wasm-unsafe-eval'
      'sha256-ZswfTY7H35rbv8WC7NXBoiC7WNu86vSzCDChNWwZZDM='
      https://challenges.cloudflare.com https://*.hcaptcha.com` — Vite modules +
      the Turnstile / hCaptcha widget loaders. `'wasm-unsafe-eval'` (issue 2430)
      lets cic compile its vodozemac binding, the WebAssembly Olm library of
      end-to-end encrypted queries; without it `WebAssembly.instantiate` is
      refused. It allows WebAssembly compilation ONLY — never widen it to
      `'unsafe-eval'`, which also turns on `eval()` / `new Function()`. The
      module itself is a same-origin asset, fetched under `connect-src 'self'`. Each loader injects a small
      INLINE bootstrap `<script>` that `script-src` blocks unless allowlisted;
      we pin it by sha256 (CSP3 hash-source) rather than relax to
      `'unsafe-inline'`, keeping our own first-party inline scripts forbidden.
      CAVEAT: the hash is the provider's inline bootstrap content — a
      provider-side widget update changes the bytes → new hash → the captcha
      silently fails CSP. When that happens the browser console prints the new
      `sha256-…` to add here (do NOT switch to `'unsafe-inline'`).
    * `style-src 'self' 'unsafe-inline' https://*.hcaptcha.com` — SolidJS ships
      dynamic style tags during interactive renders; rejecting `'unsafe-inline'`
      would break the irssi-shape theme system. hCaptcha loads its own sheet
      from `assets.hcaptcha.com`.
    * `img-src 'self' data: blob: https:` — `'self'` + `data:` for favicons,
      manifest icons and SolidJS inline `data:` SVGs; `https:` (#1240) so the
      media viewer's `<img>` can load a CROSS-HOST image link (an upload minted
      by another grappa instance, or a litterbox URL) that `mediaLink.ts`
      `externalMediaLink` admits client-side. Without it the classifier change
      is worse than a no-op — the modal opens EMPTY. Scheme-scoped to https,
      never http, so no mixed content; vjt granted `*` explicitly, and `https:`
      is the narrower spelling of the same practical grant (an http image on an
      https page is refused as mixed content either way) that keeps this
      directive shaped like its `media-src` sibling.
      `blob:` (1883) is that sibling's OTHER token, arriving here for the same
      reason it arrived there: the upload confirm previews the operator's OWN
      picked file as a thumbnail, off the wire entirely, via
      `URL.createObjectURL` (ConfirmModal.tsx) — the exact shape of the
      video-duration probe `media-src blob:` already carries. Measured, not
      argued: without it Chromium refuses the thumbnail with
      `violatedDirective: img-src, blockedURI: blob`, the confirm renders an
      empty box, and 29 e2e specs red on the `_cspGuard` fixture. It buys an
      attacker nothing this directive was still holding: a `blob:` URL is
      minted only by same-origin script, cannot name a foreign host, and so
      cannot exfiltrate — while `https:`, already admitted above, is the token
      that would carry an image-beacon anywhere.
    * `font-src 'self'` — system fonts only.
    * `manifest-src 'self'` — PWA install manifest.
    * `media-src 'self' blob: https:` — `blob:` for the video-upload duration
      probe (off-DOM `<video>` via `URL.createObjectURL`, videoPolicy.ts);
      `'self'` because declaring `media-src` REPLACES the `default-src`
      fallback and direct navigation to `/uploads/<slug>` videos (the 🎬 link
      — browsers render mp4 in a media document governed by this header) needs
      it; `https:` (#607) so the docked audio mini-player can play a
      third-party `.mp3`/`.m4a` link's `<audio>` element (admitted client-side
      by `mediaLink.ts` `externalMediaLink` — the widening is scheme-scoped to
      https, never http, so no mixed content). #1240 admitted cross-host VIDEO
      to the viewer as well and needed NO edit here: `media-src` governs
      `<video>` too, so the #607 `https:` token already covers it. This is a
      deliberate, documented loosening of the "restate only `'self'`" rule
      above; the plug test + `nginx-csp-range-parity.spec.ts` pin it.
    * `worker-src 'self' blob:` — the SW shell-cache worker, plus mediabunny
      spawns codec workers from `blob:` URLs.
    * `frame-src https://challenges.cloudflare.com https://*.hcaptcha.com` —
      Turnstile + hCaptcha render the challenge in a provider-hosted iframe.
      DELIBERATELY no `'self'` (the one RULE exception): cic never self-frames,
      and `frame-ancestors 'none'` + `X-Frame-Options DENY` would kill a
      same-origin iframe anyway.
    * `frame-ancestors 'none'` — no embedding (clickjacking).
    * `base-uri 'self'` — block `<base>` URL injection.
    * `form-action 'self'` — block form-jacking.

  `X-Content-Type-Options: nosniff` stops MIME-sniffing; `Referrer-Policy:
  same-origin` avoids leaking the canonical host on outbound clicks;
  `Permissions-Policy` disables device APIs the bouncer never asks for.
  CSP is the realistic XSS mitigation for the bearer-in-localStorage design
  (see cic `auth.ts`) — this is where it lands on the wire.
  """
  @behaviour Plug

  import Plug.Conn

  @csp "default-src 'self'; connect-src 'self' https://challenges.cloudflare.com https://*.hcaptcha.com https://litterbox.catbox.moe https://api.somafm.com https://kohina.brona.dk; script-src 'self' 'wasm-unsafe-eval' 'sha256-ZswfTY7H35rbv8WC7NXBoiC7WNu86vSzCDChNWwZZDM=' https://challenges.cloudflare.com https://*.hcaptcha.com; style-src 'self' 'unsafe-inline' https://*.hcaptcha.com; img-src 'self' data: blob: https:; font-src 'self'; manifest-src 'self'; media-src 'self' blob: https:; worker-src 'self' blob:; frame-src https://challenges.cloudflare.com https://*.hcaptcha.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"

  # HTTP header names are lower-cased (HTTP/2 + Plug convention); the VALUES
  # are byte-identical to the retired nginx snippet.
  @headers [
    {"content-security-policy", @csp},
    {"x-content-type-options", "nosniff"},
    {"referrer-policy", "same-origin"},
    {"x-frame-options", "DENY"},
    {"permissions-policy", "geolocation=(), microphone=(), camera=(), payment=(), usb=()"}
  ]

  @doc """
  The Content-Security-Policy string this plug emits. Exposed so callers and
  tests reference the SSOT instead of re-typing the (long, fragile) literal.
  """
  @spec csp() :: String.t()
  def csp, do: @csp

  @impl Plug
  def init(opts), do: opts

  @impl Plug
  def call(conn, _), do: register_before_send(conn, &put_security_headers/1)

  defp put_security_headers(conn) do
    Enum.reduce(@headers, conn, fn {name, value}, acc ->
      put_resp_header(acc, name, value)
    end)
  end
end
