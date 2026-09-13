defmodule Grappa.Auth.Oidc.Jwks do
  @moduledoc """
  The provider's JWKS — the key set `id_token` signatures are checked
  against. Fetched from the `jwks_uri` the discovery document named,
  cached briefly, filtered down to the keys that may SIGN: a provider
  advertises its encryption keys in the same document, and a key that
  exists for the provider to encrypt to us must never be accepted as a
  key the provider signs with.

  Rotations are survived by the cache lifetime rather than by a
  `kid`-miss refetch, deliberately: a key rotation with a cached-old
  set fails closed (one login attempt fails, the next one after the
  TTL succeeds), while refetching on every miss turns an attacker who
  can guess `kid` values into a client that happily fetches and caches
  whatever it is pointed at. 60 seconds of staleness against an
  operator-managed rotation is the cheap side of that trade.
  """

  @moduledoc since: "1.6.0"

  @ttl_ms 60_000
  @http_timeout_ms 5_000

  @doc """
  Returns the provider's signing keys as raw JWK maps (still base64url
  fields — `jose` builds them, we do not).

  `@spec signing_keys(Discovery.t()) ::
         {:ok, [map()]} | {:error, :provider_unavailable}`
  """
  @spec signing_keys(Grappa.Auth.Oidc.Discovery.t()) ::
          {:ok, [map()]} | {:error, :provider_unavailable}
  def signing_keys(discovery) do
    case :persistent_term.get({__MODULE__, discovery.jwks_uri}, :miss) do
      {keys, cached_at} ->
        if System.system_time(:millisecond) - cached_at < @ttl_ms,
          do: {:ok, keys},
          else: refresh(discovery)

      _ ->
        refresh(discovery)
    end
  end

  @doc false
  @spec refresh(Grappa.Auth.Oidc.Discovery.t()) ::
          {:ok, [map()]} | {:error, :provider_unavailable}
  def refresh(discovery) do
    with {:ok, %{"keys" => keys}} <- get_keys(discovery.jwks_uri),
         {:ok, keys} <- filter_signing_keys(keys) do
      :persistent_term.put(
        {__MODULE__, discovery.jwks_uri},
        {keys, System.system_time(:millisecond)}
      )

      {:ok, keys}
    end
  end

  @doc """
  Filters a key set down to signature-verification keys. An empty result
  is a provider-unavailable, not an empty success: verifying against an
  empty set can only refuse, and refusing with "the provider publishes
  nothing we can check with" is the honest answer.
  """
  @spec filter_signing_keys(term()) :: {:ok, [map()]} | {:error, :provider_unavailable}
  def filter_signing_keys(keys) when is_list(keys) do
    usable = Enum.filter(keys, &signing_key?/1)

    if usable == [],
      do: {:error, :provider_unavailable},
      else: {:ok, usable}
  end

  def filter_signing_keys(_), do: {:error, :provider_unavailable}

  # `use` and `key_ops` are OPTIONAL in JWK (RFC 7517 §4.2/§4.3), so
  # their absence does not disqualify — only a stated `enc` purpose or a
  # `key_ops` list that omits `verify` does.
  @spec signing_key?(term()) :: boolean()
  defp signing_key?(%{"kty" => kty} = key) when is_binary(kty) and kty != "" do
    Map.get(key, "use") in [nil, "sig"] and
      case Map.get(key, "key_ops") do
        nil -> true
        ops when is_list(ops) -> "verify" in ops
        _ -> false
      end
  end

  defp signing_key?(_), do: false

  @spec get_keys(String.t()) :: {:ok, map()} | {:error, :provider_unavailable}
  defp get_keys(url) do
    case Req.get(url, receive_timeout: @http_timeout_ms, retry: :transient) do
      {:ok, %Req.Response{status: 200, body: body}} when is_map(body) -> {:ok, body}
      _ -> {:error, :provider_unavailable}
    end
  rescue
    _ -> {:error, :provider_unavailable}
  end

  if Mix.env() == :test do
    @doc false
    @spec put_test_keys(String.t(), [map()]) :: :ok
    def put_test_keys(jwks_uri, keys) when is_binary(jwks_uri) and is_list(keys) do
      :persistent_term.put(
        {__MODULE__, jwks_uri},
        {keys, System.system_time(:millisecond)}
      )

      :ok
    end
  end
end
