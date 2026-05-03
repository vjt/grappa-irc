defmodule Grappa.Admission.ConfigTest do
  use ExUnit.Case, async: false

  alias Grappa.Admission.Config

  @pt_key {Grappa.Admission.Config, :config}

  # Restore both Application env AND :persistent_term to pre-test state.
  # Without this, sibling tests still reading via `Application.get_env(:grappa,
  # :admission, [])` (B1.3 hasn't migrated them yet) inherit our Turnstile
  # stubs and fail; and any later test calling `Config.config/0` inherits the
  # `put_test_config/1` override from test 4.
  setup do
    original_env = Application.get_env(:grappa, :admission)
    original_pt = :persistent_term.get(@pt_key, :__unset__)

    on_exit(fn ->
      if is_nil(original_env) do
        Application.delete_env(:grappa, :admission)
      else
        Application.put_env(:grappa, :admission, original_env)
      end

      case original_pt do
        :__unset__ -> :persistent_term.erase(@pt_key)
        cfg -> :persistent_term.put(@pt_key, cfg)
      end
    end)

    :ok
  end

  describe "boot/0 + config/0" do
    test "boot stores struct in :persistent_term, config/0 reads it" do
      Application.put_env(:grappa, :admission,
        captcha_provider: Grappa.Admission.Captcha.Disabled,
        captcha_secret: nil,
        captcha_site_key: nil,
        turnstile_endpoint: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        hcaptcha_endpoint: "https://hcaptcha.com/siteverify"
      )

      :ok = Config.boot()
      cfg = Config.config()
      assert %Config{captcha_provider: Grappa.Admission.Captcha.Disabled} = cfg
      assert cfg.captcha_secret == nil
    end

    test "boot crashes loud when provider Turnstile + secret nil" do
      Application.put_env(:grappa, :admission,
        captcha_provider: Grappa.Admission.Captcha.Turnstile,
        captcha_secret: nil,
        captcha_site_key: "site-key-x"
      )

      assert_raise ArgumentError, ~r/captcha_secret.*required.*Turnstile/i, fn ->
        Config.boot()
      end
    end

    test "boot crashes loud when provider Turnstile + site_key nil" do
      Application.put_env(:grappa, :admission,
        captcha_provider: Grappa.Admission.Captcha.Turnstile,
        captcha_secret: "secret",
        captcha_site_key: nil
      )

      assert_raise ArgumentError, ~r/captcha_site_key.*required/i, fn -> Config.boot() end
    end

    test "put_test_config/1 substitutes config in test env" do
      override = %Config{
        captcha_provider: Grappa.Admission.Captcha.Disabled,
        captcha_secret: nil,
        captcha_site_key: nil,
        turnstile_endpoint: "x",
        hcaptcha_endpoint: "y"
      }

      Config.put_test_config(override)
      assert Config.config() == override
    end
  end
end
