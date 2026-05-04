defmodule Grappa.Infra.CspProviderTest do
  @moduledoc """
  M-arch-6 (CSP-CI side) — drift catcher between the deployed CSP
  allowlist and the captcha provider impl set whose hosts MUST be
  reachable from the cicchetto SPA.

  Statically parses `infra/nginx.conf` + `infra/snippets/security-
  headers.conf`. For each captcha behaviour impl module enumerated in
  `configured_captcha_providers/0`, asserts the provider's host(s)
  appear somewhere in the CSP allowlist string. Mechanical check —
  catches the T31 deploy-bug-3 class (CSP misalignment with shipped
  captcha provider) at the test boundary instead of at real-browser
  e2e where the symptom is "Turnstile widget never renders, Login
  page hangs."

  ## Why static enum, not Application.get_env

  The provider list is the contract — Application reads are runtime
  state and (per CLAUDE.md) banned outside boot. The whole point of
  this test is that adding a new provider impl module forces an edit
  to `configured_captcha_providers/0` here, which forces a CSP
  allowlist update, OR the test reds. Drift becomes loud.

  ## HCaptcha note

  HCaptcha ships as an impl module (`Grappa.Admission.Captcha.HCaptcha`)
  but is intentionally NOT in this enum — the deployed CSP allowlist
  (M-cross-5) only covers Cloudflare Turnstile. When an operator-deploy
  selects HCaptcha, both the CSP allowlist (`hcaptcha.com` /
  `js.hcaptcha.com` / `*.hcaptcha.com`) AND this enum get updated in
  the same commit; the test enforces they land together.
  """

  use ExUnit.Case, async: true

  # Path.expand("../../../infra/...", __DIR__) — three levels up from
  # test/grappa/infra/ to the repo root, then into infra/.
  @nginx_conf_path Path.expand("../../../infra/nginx.conf", __DIR__)
  @snippet_path Path.expand("../../../infra/snippets/security-headers.conf", __DIR__)

  test "CSP allowlist covers every captcha provider in the deployed-impl set" do
    csp = read_csp()

    for provider_module <- configured_captcha_providers(),
        host <- provider_hosts(provider_module) do
      assert csp =~ host,
             "CSP allowlist missing host #{inspect(host)} for provider #{inspect(provider_module)} — " <>
               "either add it to infra/snippets/security-headers.conf (script-src / connect-src / " <>
               "frame-src as appropriate) or drop the provider from configured_captcha_providers/0."
    end
  end

  defp read_csp do
    Enum.map_join([@nginx_conf_path, @snippet_path], "\n", &File.read!/1)
  end

  # Static enum — the contract. Adding a captcha impl that an operator
  # can SELECT in production means adding the module here AND the
  # corresponding host(s) to the CSP snippet. See moduledoc HCaptcha note.
  defp configured_captcha_providers do
    [Grappa.Admission.Captcha.Turnstile]
  end

  # Per-provider host clauses. A new provider needs both a clause here
  # AND a CSP allowlist entry in infra/snippets/security-headers.conf.
  defp provider_hosts(Grappa.Admission.Captcha.Turnstile), do: ["challenges.cloudflare.com"]
end
