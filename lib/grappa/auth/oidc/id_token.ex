defmodule Grappa.Auth.Oidc.IdToken do
  @moduledoc """
  Verification of the `id_token` returned at the token endpoint — the
  ONLY artifact this flow will name a user by. The access token that
  travels beside it is opaque to us and is discarded unread: we are not
  a resource server, and an identifier minted by the provider's userinfo
  path would have to be trusted with exactly the checks below anyway.

  The checks are the OIDC Core §3.1.3.7 set, in the order a forgery has
  to beat them:

    1. **Signature** — JWS verified against the provider's JWKS, keyed
       by the header's `kid`. `none` and every algorithm outside
       `@allowed_algs` are refused before a key is even selected, which
       is the algorithm-confusion kill: a `HS256` header cannot talk a
       public-key verifier into treating the RSA public key as an HMAC
       secret.
    2. **iss** — must equal the ISSUER THE OPERATOR CONFIGURED, which
       `Grappa.Auth.Oidc.Discovery` has already compared against the
       document the provider itself advertised. A same-CA look-alike
       host fails here even with a perfectly valid certificate chain.
    3. **aud / azp** — the token must have been minted for THIS client.
       A token minted for another client of the same provider is a
       perfectly good, perfectly signed token for somebody else.
    4. **exp / nbf / iat** — against a 60-second leeway, because
       provider clocks drift and a login is not the place to litigate
       NTP.
    5. **nonce** — the one-time value signed into the authorization
       request and replayed here. This is the check that makes the
       response ours: without it, a `code` an attacker started for
       THEIR session could be driven back into ours (the code-injection
       / mix-up family). Everything else above can be true of a token
       we never asked for.
    6. **sub** — present and non-empty. It is the only claim we store,
       and an empty one would match the empty one we store next time.

  `kid` is the ONLY header field read. `jku` and `jwk` are deliberately
  ignored — they are the sender proposing its own trust anchor, which is
  precisely what the JWKS fetch exists to prevent.
  """

  @moduledoc since: "1.6.0"

  @leeway_seconds 60

  # Asymmetric signature algorithms only. There is no shared-secret
  # entry: the client secret is a token-endpoint credential, not a
  # signing key, and admitting `HS*` reopens the algorithm-confusion
  # forgery that `verify_strict` exists to close.
  @allowed_algs ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512"]

  @type verified :: %__MODULE__{
          subject: String.t(),
          claims: %{optional(String.t()) => term()}
        }

  @enforce_keys [:subject, :claims]
  defstruct @enforce_keys

  @doc """
  Verifies the compact JWS and its claims. `now` is the comparison
  instant in epoch seconds, passed rather than defaulted so a test can
  hold the clock still (CLAUDE.md: no `\\` defaults; production callers
  pass `System.system_time(:second)`).

  Returns `{:error, :invalid_token}` for every signature, issuer,
  audience and nonce refusal alike — a caller that distinguishes them
  has an oracle it does not need, and the reason is logged once at the
  controller instead. `:expired_token` is split out only because it is
  the one refusal a well-run provider produces for an honest user who
  sat on the consent screen.
  """
  @spec verify(String.t(), Grappa.Auth.Oidc.Config.t(), Grappa.Auth.Oidc.Discovery.t(), String.t(), integer()) ::
          {:ok, verified()} | {:error, :invalid_token | :expired_token}
  def verify(compact, config, discovery, expected_nonce, now)
      when is_binary(compact) and is_binary(expected_nonce) and is_integer(now) do
    with {:ok, header} <- peek_header(compact),
         {:ok, alg} <- allowlisted_alg(header),
         {:ok, jwk} <- signing_key(discovery, header),
         # `verify_strict` hands the claims back as a `%JOSE.JWT{}` record —
         # the map a claim check wants is its `fields`, and pattern-matching
         # the record itself is a silent fall-through to the
         # `check_issuer(_, _)` catch-all: the token verified and STILL read
         # as a forgery.
         {true, %JOSE.JWT{fields: claims}, _jws} <- JOSE.JWT.verify_strict(jwk, [alg], compact) do
      verify_claims(claims, config, discovery, expected_nonce, now)
    else
      {false, _claims, _jws} -> {:error, :invalid_token}
      {:error, reason} -> {:error, reason}
    end
  end

  # Malformed compact serializations must refuse, not raise. `jose`'s own
  # peek (`JOSE.JWT.peek_protected/1`) answers a `%JOSE.JWS{}` RECORD —
  # `alg` promoted to its own field, the rest under `fields` — and offers
  # no conversion back to the plain header map the two checks below
  # pattern-match on, so the segment is split and decoded here instead.
  # That is the whole of what "peek" means and it stays honest about it:
  # these bytes are UNVERIFIED, nothing downstream may act on them, and
  # the signature check that follows is the thing that decides.
  @spec peek_header(String.t()) :: {:ok, %{optional(String.t()) => term()}} | {:error, :invalid_token}
  defp peek_header(compact) when is_binary(compact) do
    with [protected | _] <- String.split(compact, ".", parts: 2),
         {:ok, raw} <- Base.url_decode64(protected, padding: false),
         {:ok, %{} = header} <- Jason.decode(raw) do
      {:ok, header}
    else
      _ -> {:error, :invalid_token}
    end
  end

  defp peek_header(_), do: {:error, :invalid_token}

  @spec allowlisted_alg(%{optional(String.t()) => term()}) ::
          {:ok, String.t()} | {:error, :invalid_token}
  defp allowlisted_alg(%{"alg" => alg}) when is_binary(alg) do
    if alg in @allowed_algs,
      do: {:ok, alg},
      else: {:error, :invalid_token}
  end

  defp allowlisted_alg(_), do: {:error, :invalid_token}

  # `kid`-keyed selection from the provider's own JWKS. No `kid`, and
  # the provider publishes exactly one signing key → that key (the
  # common single-key deployment). Ambiguity in either direction is a
  # refusal: guessing a key turns verification into a lottery a forger
  # can enter.
  # The JWK record is opaque here on purpose: it is built from one
  # entry of the provider's JWKS and handed straight to `jose`, and the
  # flow never inspects its fields.
  @spec signing_key(Grappa.Auth.Oidc.Discovery.t(), %{optional(String.t()) => term()}) ::
          {:ok, term()} | {:error, :invalid_token}
  defp signing_key(discovery, header) do
    with {:ok, keys} <- Grappa.Auth.Oidc.Jwks.signing_keys(discovery),
         {:ok, key} <- select_key(keys, Map.get(header, "kid")) do
      {:ok, JOSE.JWK.from_map(key)}
    end
  end

  @spec select_key([map()], String.t() | nil) :: {:ok, map()} | {:error, :invalid_token}
  defp select_key(keys, kid) when is_binary(kid) do
    case Enum.filter(keys, &(&1["kid"] == kid)) do
      [key] -> {:ok, key}
      _ -> {:error, :invalid_token}
    end
  end

  defp select_key(keys, nil) do
    case keys do
      [key] -> {:ok, key}
      _ -> {:error, :invalid_token}
    end
  end

  @doc """
  The claim checks of the flow, split from the JWS machinery so they can
  be exercised without a keypair. Same contract as `verify/5`.
  """
  @spec verify_claims(
          %{optional(String.t()) => term()},
          Grappa.Auth.Oidc.Config.t(),
          Grappa.Auth.Oidc.Discovery.t(),
          String.t(),
          integer()
        ) ::
          {:ok, verified()} | {:error, :invalid_token | :expired_token}
  def verify_claims(claims, config, discovery, expected_nonce, now)
      when is_map(claims) and is_integer(now) do
    with :ok <- check_issuer(claims, discovery),
         :ok <- check_audience(claims, config),
         :ok <- check_azp(claims, config),
         :ok <- check_time(claims, "exp", now),
         :ok <- check_not_before(claims, now),
         :ok <- check_nonce(claims, expected_nonce),
         {:ok, subject} <- check_subject(claims) do
      {:ok, %__MODULE__{subject: subject, claims: claims}}
    end
  end

  @spec check_issuer(%{optional(String.t()) => term()}, Grappa.Auth.Oidc.Discovery.t()) ::
          :ok | {:error, :invalid_token}
  defp check_issuer(%{"iss" => iss}, discovery) do
    if Grappa.Auth.Oidc.Config.normalize_issuer(iss) == discovery.issuer,
      do: :ok,
      else: {:error, :invalid_token}
  end

  defp check_issuer(_, _), do: {:error, :invalid_token}

  # String or array of strings, per OIDC Core §2. The multi-audience
  # form is accepted only while `azp` pins this client — checked next.
  @spec check_audience(%{optional(String.t()) => term()}, Grappa.Auth.Oidc.Config.t()) ::
          :ok | {:error, :invalid_token}
  defp check_audience(%{"aud" => aud}, config) when is_binary(aud),
    do: if(aud == config.client_id, do: :ok, else: {:error, :invalid_token})

  defp check_audience(%{"aud" => aud}, config) when is_list(aud) do
    if config.client_id in aud and Enum.all?(aud, &is_binary/1),
      do: :ok,
      else: {:error, :invalid_token}
  end

  defp check_audience(_, _), do: {:error, :invalid_token}

  @spec check_azp(%{optional(String.t()) => term()}, Grappa.Auth.Oidc.Config.t()) ::
          :ok | {:error, :invalid_token}
  defp check_azp(%{"azp" => azp}, config) when is_binary(azp),
    do: if(azp == config.client_id, do: :ok, else: {:error, :invalid_token})

  defp check_azp(_, _), do: :ok

  # `exp` is REQUIRED. Seconds since epoch.
  @spec check_time(%{optional(String.t()) => term()}, String.t(), integer()) ::
          :ok | {:error, :invalid_token | :expired_token}
  defp check_time(%{"exp" => exp}, _key, now) when is_integer(exp) do
    if exp > now - @leeway_seconds,
      do: :ok,
      else: {:error, :expired_token}
  end

  defp check_time(_, _key, _now), do: {:error, :invalid_token}

  @spec check_not_before(%{optional(String.t()) => term()}, integer()) ::
          :ok | {:error, :invalid_token}
  defp check_not_before(%{"nbf" => nbf}, now) when is_integer(nbf),
    do: if(nbf <= now + @leeway_seconds, do: :ok, else: {:error, :invalid_token})

  defp check_not_before(_, _), do: :ok

  # Exact-match byte comparison, no timing deference owed: a nonce is
  # random and single-use, and the wrong one means the response is not
  # ours.
  @spec check_nonce(%{optional(String.t()) => term()}, String.t()) ::
          :ok | {:error, :invalid_token}
  defp check_nonce(%{"nonce" => nonce}, expected) when is_binary(nonce),
    do: if(Plug.Crypto.secure_compare(nonce, expected), do: :ok, else: {:error, :invalid_token})

  defp check_nonce(_, _), do: {:error, :invalid_token}

  @spec check_subject(%{optional(String.t()) => term()}) ::
          {:ok, String.t()} | {:error, :invalid_token}
  defp check_subject(%{"sub" => sub}) when is_binary(sub) and byte_size(sub) > 0,
    do: {:ok, sub}

  defp check_subject(_), do: {:error, :invalid_token}
end
