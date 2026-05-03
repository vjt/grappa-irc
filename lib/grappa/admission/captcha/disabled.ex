defmodule Grappa.Admission.Captcha.Disabled do
  @moduledoc """
  Captcha behaviour impl that always returns `:ok`. Default for
  `config/test.exs` and for operator-private deployments where there's
  no need for human-vs-bot distinguishing — friends-and-family
  bouncer, dev environment, etc.

  Operator opts into a real provider (Plan 2 `Turnstile` / `HCaptcha`)
  via `config :grappa, :admission, captcha_provider: <module>`.
  """
  @behaviour Grappa.Admission.Captcha

  @impl Grappa.Admission.Captcha
  @spec verify(Grappa.Admission.Captcha.token(), Grappa.Admission.Captcha.ip()) :: :ok
  def verify(_token, _ip), do: :ok
end
