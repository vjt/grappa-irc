defmodule Grappa.Admission.Captcha.Turnstile do
  @moduledoc """
  Cloudflare Turnstile captcha verify impl.

  Endpoint: https://challenges.cloudflare.com/turnstile/v0/siteverify
  Expected form-encoded body: secret + response + remoteip.
  """
  @behaviour Grappa.Admission.Captcha

  @endpoint_default "https://challenges.cloudflare.com/turnstile/v0/siteverify"
  @timeout_ms 5_000

  @impl Grappa.Admission.Captcha
  @spec verify(Grappa.Admission.Captcha.token(), Grappa.Admission.Captcha.ip()) ::
          :ok | {:error, Grappa.Admission.Captcha.error()}
  def verify(nil, _), do: {:error, :captcha_required}
  def verify("", _), do: {:error, :captcha_required}

  def verify(token, ip) when is_binary(token) do
    config = Application.get_env(:grappa, :admission, [])
    secret = Keyword.fetch!(config, :captcha_secret)
    endpoint = Keyword.get(config, :turnstile_endpoint, @endpoint_default)

    body = URI.encode_query(%{secret: secret, response: token, remoteip: ip || ""})
    headers = [{"content-type", "application/x-www-form-urlencoded"}]

    case Req.post(endpoint, body: body, headers: headers, receive_timeout: @timeout_ms) do
      {:ok, %{status: 200, body: %{"success" => true}}} -> :ok
      {:ok, %{status: 200, body: %{"success" => false}}} -> {:error, :captcha_failed}
      {:ok, %{status: status}} when status >= 500 -> {:error, :captcha_provider_unavailable}
      {:ok, %{status: _}} -> {:error, :captcha_failed}
      {:error, _} -> {:error, :captcha_provider_unavailable}
    end
  end
end
