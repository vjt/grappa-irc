defmodule Grappa.Auth.Oidc.Discovery do
  @moduledoc """
  The provider's `.well-known/openid-configuration` document: fetched
  once per authorization attempt, cached briefly, and used as the SINGLE
  source of the `authorization_endpoint`, `token_endpoint`, `jwks_uri`
  and — the part that matters — `issuer`.

  The last one is the security payload of this module. #89's rule for
  outbound TLS is "anchor on the system CA store", and it is necessary
  but not sufficient here: a certificate only proves the peer owns the
  NAME it answered on. The `issuer` in the document is what proves that
  name is the issuer the OPERATOR configured, and the `iss` claim in
  the `id_token` is what proves the token came from there. Skipping the
  first check turns a same-CA look-alike host into a full account
  takeover; it is therefore not a validation nicety but the whole chain.

  Endpoints are read from the document and nowhere else. An operator
  who wants to point the client at a token endpoint of its own choosing
  is asking to bypass that chain, and there is no knob for it.
  """

  @moduledoc since: "1.6.0"

  @typedoc "The subset of the discovery document this flow consumes."
  @type t :: %__MODULE__{
          issuer: String.t(),
          authorization_endpoint: String.t(),
          token_endpoint: String.t(),
          jwks_uri: String.t()
        }

  @enforce_keys [:issuer, :authorization_endpoint, :token_endpoint, :jwks_uri]
  defstruct @enforce_keys

  # Long enough that a login burst is one round-trip, short enough that
  # an operator rotating a provider's endpoints is not stuck behind the
  # cache. There is no invalidation hook: a discovery document is
  # operator-owned and changes roughly never, and 60s of staleness is
  # invisible next to the human timescale of a login.
  @ttl_ms 60_000

  @http_timeout_ms 5_000

  @doc """
  Returns the provider's discovery document, from cache when fresh.
  `{:error, :provider_unavailable}` when the provider cannot be reached
  or answers with a document that does not describe the configured
  issuer — the caller treats both as "the door is broken", never as
  "the user is wrong".
  """
  @spec fetch(Grappa.Auth.Oidc.Config.t()) :: {:ok, t()} | {:error, :provider_unavailable}
  def fetch(config) do
    case :persistent_term.get({__MODULE__, config.issuer}, :miss) do
      {%__MODULE__{} = doc, cached_at} ->
        if System.system_time(:millisecond) - cached_at < @ttl_ms,
          do: {:ok, doc},
          else: refresh(config)

      _ ->
        refresh(config)
    end
  end

  @doc false
  @spec refresh(Grappa.Auth.Oidc.Config.t()) :: {:ok, t()} | {:error, :provider_unavailable}
  def refresh(config) do
    url = String.trim_trailing(config.issuer, "/") <> "/.well-known/openid-configuration"

    with {:ok, %{} = document} <- get_document(url),
         {:ok, doc} <- build(config, document) do
      :persistent_term.put({__MODULE__, config.issuer}, {doc, System.system_time(:millisecond)})
      {:ok, doc}
    end
  end

  # house HTTP style (Grappa.Admission.Captcha.SiteVerifyHttp): `Req`
  # against the system CA store, a bounded timeout, transient retries —
  # a provider blip is the network being the network, not a login
  # failure to charge anybody for.
  @spec get_document(String.t()) :: {:ok, map()} | {:error, :provider_unavailable}
  defp get_document(url) do
    case Req.get(url, receive_timeout: @http_timeout_ms, retry: :transient) do
      {:ok, %Req.Response{status: 200, body: body}} when is_map(body) -> {:ok, body}
      _ -> {:error, :provider_unavailable}
    end
  rescue
    _ -> {:error, :provider_unavailable}
  end

  @doc """
  Validates that the document describes the issuer we configured, then
  projects the four fields the flow needs. An HTTPS endpoint is a hard
  requirement: a bearer code and a client secret must not be handed to
  a cleartext hop, whoever is operating it.
  """
  @spec build(Grappa.Auth.Oidc.Config.t(), map()) :: {:ok, t()} | {:error, :provider_unavailable}
  def build(config, document) do
    with {:ok, issuer} <- fetch_string(document, "issuer"),
         :ok <- check_issuer(config, issuer),
         {:ok, authorization_endpoint} <- fetch_https(document, "authorization_endpoint"),
         {:ok, token_endpoint} <- fetch_https(document, "token_endpoint"),
         {:ok, jwks_uri} <- fetch_https(document, "jwks_uri") do
      {:ok,
       %__MODULE__{
         issuer: Grappa.Auth.Oidc.Config.normalize_issuer(issuer),
         authorization_endpoint: authorization_endpoint,
         token_endpoint: token_endpoint,
         jwks_uri: jwks_uri
       }}
    end
  end

  # The issuer check. Compared trailing-slash-insensitively: providers
  # disagree about the final slash and the disagreement is not a
  # security property worth failing a login over.
  @spec check_issuer(Grappa.Auth.Oidc.Config.t(), String.t()) :: :ok | {:error, :provider_unavailable}
  defp check_issuer(config, issuer) do
    if Grappa.Auth.Oidc.Config.normalize_issuer(issuer) == config.issuer do
      :ok
    else
      {:error, :provider_unavailable}
    end
  end

  @spec fetch_string(map(), String.t()) :: {:ok, String.t()} | {:error, :provider_unavailable}
  defp fetch_string(document, key) do
    case Map.fetch(document, key) do
      {:ok, value} when is_binary(value) and byte_size(value) > 0 -> {:ok, value}
      _ -> {:error, :provider_unavailable}
    end
  end

  @spec fetch_https(map(), String.t()) :: {:ok, String.t()} | {:error, :provider_unavailable}
  defp fetch_https(document, key) do
    case fetch_string(document, key) do
      {:ok, value} ->
        case URI.new(value) do
          {:ok, %URI{scheme: "https", host: host}} when is_binary(host) and host != "" ->
            {:ok, value}

          _ ->
            {:error, :provider_unavailable}
        end

      error ->
        error
    end
  end

  if Mix.env() == :test do
    @doc false
    @spec put_test_discovery(String.t(), t()) :: :ok
    def put_test_discovery(issuer, %__MODULE__{} = document) do
      :persistent_term.put(
        {__MODULE__, Grappa.Auth.Oidc.Config.normalize_issuer(issuer)},
        {document, System.system_time(:millisecond)}
      )

      :ok
    end
  end
end
