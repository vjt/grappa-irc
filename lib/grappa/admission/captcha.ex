defmodule Grappa.Admission.Captcha do
  @moduledoc """
  Behaviour contract for CAPTCHA verification at fresh-anon visitor
  login. Plan 1 ships only the `Disabled` impl (always `:ok`); Plan 2
  adds `Turnstile` (Cloudflare) and `HCaptcha` impls.

  ## Why a behaviour

  Provider lock-in is bad — the operator picks at runtime via
  `config :grappa, :admission, captcha_provider: <module>`, the verb
  delegates. Tests stub a `CaptchaMock` via Mox.

  ## Contract

  `verify/2` takes the client-supplied token + the request IP and
  returns `:ok` on a valid solve OR a tagged error:

    * `:captcha_required` — token is `nil` / empty (client didn't
      send one).
    * `:captcha_failed` — provider rejected the token (expired /
      already used / not a real solve).
    * `:captcha_provider_unavailable` — provider's HTTP endpoint
      returned 5xx, was unreachable, or our request timed out. Distinct
      from `:captcha_failed` because operator-side issue, not user-side.

  `wire_name/0` returns the wire-shape provider token used in error
  envelopes (e.g. the `provider:` key in `captcha_required` JSON
  responses). Cicchetto uses this to decide which widget to mount.

  Implementations MUST NOT raise. Network errors land as
  `{:error, :captcha_provider_unavailable}`.
  """

  @type token :: String.t() | nil
  @type ip :: String.t() | nil
  @type error :: :captcha_required | :captcha_failed | :captcha_provider_unavailable

  @callback verify(token(), ip()) :: :ok | {:error, error()}
  @callback wire_name() :: String.t()
end
