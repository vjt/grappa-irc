defmodule Grappa.AdmissionCaptchaTestHelper do
  @moduledoc """
  Shared fixture for `Grappa.Admission.Captcha` provider smoke tests
  (`Turnstile`, `HCaptcha`).

  Both providers delegate to the SiteVerifyHttp helper and differ only
  in which `*_endpoint` field they read from `Grappa.Admission.Config`.
  This helper installs a Bypass-backed config, captures+restores the
  shared `:persistent_term` slot, and exposes a single `setup_provider/2`
  entry point to keep the per-provider test files mechanical.

  ## Why `async: false` is mandatory at every call site

  `Grappa.Admission.Config.put_test_config/1` writes to the global
  `:persistent_term` slot `{Grappa.Admission.Config, :config}`. The
  pre-B1.3 code used `Application.put_env` per-key (also globally racy);
  the struct's all-or-nothing snapshot makes the race observable, so we
  serialise. Tests using this helper MUST `use ExUnit.Case, async: false`.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Admission]

  alias Grappa.Admission.Config

  @pt_key {Config, :config}

  @typedoc """
  Per-provider knobs injected into the config struct. The endpoint
  field is the keyword key that the provider reads (e.g.
  `:turnstile_endpoint`); the other endpoint field is set to a
  sentinel `"unused"` to make a misroute fail loudly.
  """
  @type endpoint_key :: :turnstile_endpoint | :hcaptcha_endpoint

  @doc """
  Sets up a Bypass server, installs an `Admission.Config` snapshot
  pointing the requested provider's endpoint at the Bypass URL, and
  registers an `on_exit` to restore the previous `:persistent_term`
  value. Returns `{:ok, bypass: bypass}` for the test context.

  `provider` MUST implement the `Grappa.Admission.Captcha` behaviour.
  """
  @spec setup_provider(provider :: module(), endpoint_key()) ::
          {:ok, [bypass: Bypass.t()]}
  def setup_provider(provider, endpoint_key)
      when is_atom(provider) and endpoint_key in [:turnstile_endpoint, :hcaptcha_endpoint] do
    Code.ensure_loaded!(provider)

    unless function_exported?(provider, :verify, 2),
      do: raise(ArgumentError, "#{inspect(provider)} does not implement Captcha.verify/2")

    bypass = Bypass.open()
    original_pt = :persistent_term.get(@pt_key, :__unset__)

    Config.put_test_config(build_config(provider, endpoint_key, bypass))

    ExUnit.Callbacks.on_exit(fn -> restore_pt(original_pt) end)

    {:ok, bypass: bypass}
  end

  @spec build_config(module(), endpoint_key(), Bypass.t()) :: Config.t()
  defp build_config(provider, endpoint_key, bypass) do
    base = %{
      captcha_provider: provider,
      captcha_secret: "test-secret",
      captcha_site_key: "test-site-key",
      turnstile_endpoint: "unused",
      hcaptcha_endpoint: "unused"
    }

    struct!(Config, Map.put(base, endpoint_key, bypass_url(bypass)))
  end

  @spec bypass_url(Bypass.t()) :: String.t()
  defp bypass_url(bypass), do: "http://localhost:#{bypass.port}/siteverify"

  @spec restore_pt(Config.t() | :__unset__) :: :ok
  defp restore_pt(:__unset__) do
    _ = :persistent_term.erase(@pt_key)
    :ok
  end

  defp restore_pt(%Config{} = cfg), do: Config.put_test_config(cfg)
end
