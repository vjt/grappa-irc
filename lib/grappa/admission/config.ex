defmodule Grappa.Admission.Config do
  @moduledoc """
  Boot-time captcha configuration. Read once via `boot/0` from
  `Application.get_env(:grappa, :admission, ...)`, validated, stored
  in `:persistent_term`. Readers call `config/0` (lock-free,
  non-allocating, ~10ns per BEAM persistent_term semantics).

  CLAUDE.md "Application.{put,get}_env: boot-time only" — this is the
  designated boundary; no other module reads `:admission` config at
  runtime.

  ## Configuration keys

  Operator-facing (set via env vars in `compose.prod.yaml` →
  `runtime.exs` → `:grappa, :admission` keyword):

    * `:captcha_provider` — `Disabled` (default), `Turnstile`, `HCaptcha`
    * `:captcha_secret` — provider secret (required for non-Disabled)
    * `:captcha_site_key` — public site key (required for non-Disabled)

  Test-only override seam — production uses `build!/1` defaults and
  no operator path sets these:

    * `:turnstile_endpoint` — defaults to the Cloudflare siteverify URL
    * `:hcaptcha_endpoint` — defaults to the hCaptcha siteverify URL

  Tests inject a Bypass-backed endpoint via the canonical
  `put_test_config/1` (Mix.env() == :test gated) rather than poking
  `Application.put_env` + re-running `boot/0`. The kwlist override
  remains supported for completeness but is not the recommended path.
  """

  @type t :: %__MODULE__{
          captcha_provider: module(),
          captcha_secret: String.t() | nil,
          captcha_site_key: String.t() | nil,
          turnstile_endpoint: String.t(),
          hcaptcha_endpoint: String.t()
        }

  @enforce_keys [
    :captcha_provider,
    :captcha_secret,
    :captcha_site_key,
    :turnstile_endpoint,
    :hcaptcha_endpoint
  ]
  defstruct @enforce_keys

  @key {__MODULE__, :config}

  @spec boot() :: :ok
  def boot do
    raw = Application.get_env(:grappa, :admission, [])
    cfg = build!(raw)
    :persistent_term.put(@key, cfg)
    :ok
  end

  @spec config() :: t()
  def config, do: :persistent_term.get(@key)

  if Mix.env() == :test do
    @doc false
    @spec put_test_config(t()) :: :ok
    def put_test_config(%__MODULE__{} = cfg), do: :persistent_term.put(@key, cfg)
  end

  defp build!(raw) do
    provider = Keyword.fetch!(raw, :captcha_provider)
    secret = Keyword.get(raw, :captcha_secret)
    site_key = Keyword.get(raw, :captcha_site_key)

    validate_non_disabled!(provider, secret, site_key)

    %__MODULE__{
      captcha_provider: provider,
      captcha_secret: secret,
      captcha_site_key: site_key,
      turnstile_endpoint:
        Keyword.get(
          raw,
          :turnstile_endpoint,
          "https://challenges.cloudflare.com/turnstile/v0/siteverify"
        ),
      hcaptcha_endpoint: Keyword.get(raw, :hcaptcha_endpoint, "https://hcaptcha.com/siteverify")
    }
  end

  defp validate_non_disabled!(Grappa.Admission.Captcha.Disabled, _, _), do: :ok

  defp validate_non_disabled!(provider, secret, site_key) do
    unless is_binary(secret) and byte_size(secret) > 0,
      do:
        raise(
          ArgumentError,
          "captcha_secret required when provider is #{inspect(provider)}"
        )

    unless is_binary(site_key) and byte_size(site_key) > 0,
      do:
        raise(
          ArgumentError,
          "captcha_site_key required when provider is #{inspect(provider)}"
        )

    :ok
  end
end
