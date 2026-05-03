defmodule Grappa.Admission.Captcha.HCaptcha do
  @moduledoc """
  hCaptcha siteverify implementation.

  Wire shape mirrors the hCaptcha API
  (https://docs.hcaptcha.com/#verify-the-user-response-server-side).
  Shared HTTP plumbing lives in `SiteVerifyHttp`.
  """
  @behaviour Grappa.Admission.Captcha

  @impl Grappa.Admission.Captcha
  @spec wire_name() :: String.t()
  def wire_name, do: "hcaptcha"

  @impl Grappa.Admission.Captcha
  @spec verify(Grappa.Admission.Captcha.token(), Grappa.Admission.Captcha.ip()) ::
          :ok | {:error, Grappa.Admission.Captcha.error()}
  def verify(nil, _), do: {:error, :captcha_required}
  def verify("", _), do: {:error, :captcha_required}

  def verify(token, remote_ip) when is_binary(token) do
    cfg = Grappa.Admission.Config.config()

    Grappa.Admission.Captcha.SiteVerifyHttp.verify(
      cfg.hcaptcha_endpoint,
      cfg.captcha_secret,
      token,
      remote_ip
    )
  end
end
