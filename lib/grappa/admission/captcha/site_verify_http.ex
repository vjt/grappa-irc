defmodule Grappa.Admission.Captcha.SiteVerifyHttp do
  @moduledoc false

  @timeout_ms 5_000

  @doc false
  @spec verify(
          endpoint :: String.t(),
          secret :: String.t(),
          token :: String.t(),
          remote_ip :: String.t() | nil
        ) ::
          :ok | {:error, Grappa.Admission.Captcha.error()}
  def verify(endpoint, secret, token, remote_ip) do
    body =
      %{secret: secret, response: token}
      |> maybe_put_ip(remote_ip)
      |> URI.encode_query()

    headers = [{"content-type", "application/x-www-form-urlencoded"}]

    case Req.post(endpoint, body: body, headers: headers, receive_timeout: @timeout_ms) do
      {:ok, %{status: 200, body: %{"success" => true}}} -> :ok
      {:ok, %{status: 200, body: %{"success" => false}}} -> {:error, :captcha_failed}
      {:ok, %{status: status}} when status >= 500 -> {:error, :captcha_provider_unavailable}
      {:ok, %{status: _}} -> {:error, :captcha_provider_unavailable}
      {:error, _} -> {:error, :captcha_provider_unavailable}
    end
  end

  defp maybe_put_ip(map, nil), do: map
  defp maybe_put_ip(map, ip), do: Map.put(map, :remoteip, ip)
end
