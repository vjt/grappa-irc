defmodule Grappa.Accounts.WebAuthn do
  @moduledoc "Passkey registration and assertion ceremonies for durable accounts."
  import Ecto.Query

  alias Grappa.Accounts.{Passkey, RecoveryCodes, User, WebAuthnChallengeStore}
  alias Grappa.Repo

  @type binding :: %{ip: String.t() | nil, client_id: String.t() | nil}
  @type mode :: String.t()

  @doc "Lists public passkey metadata for account settings."
  @spec list(User.t()) :: [Passkey.t()]
  def list(%User{id: user_id}) do
    Passkey
    |> where([p], p.user_id == ^user_id)
    |> order_by([p], asc: p.inserted_at)
    |> Repo.all()
  end

  @doc "Begins authenticated passkey registration after password confirmation."
  @spec begin_registration(User.t(), String.t(), String.t(), binding(), String.t()) ::
          {:ok, map()} | {:error, :invalid_credentials}
  def begin_registration(user, password, name, binding, origin) do
    if Argon2.verify_pass(password, user.password_hash) do
      challenge = Wax.new_registration_challenge(challenge_opts(origin))

      id =
        WebAuthnChallengeStore.put(challenge, :registration, %{
          user_id: user.id,
          name: name,
          binding: binding
        })

      {:ok, registration_options(id, challenge, user)}
    else
      {:error, :invalid_credentials}
    end
  end

  @doc "Completes registration and persists the credential public key."
  @spec complete_registration(User.t(), map(), binding()) :: {:ok, Passkey.t()} | {:error, term()}
  def complete_registration(user, params, binding) do
    with {:ok, challenge, %{user_id: user_id, name: name, binding: ^binding}} <-
           WebAuthnChallengeStore.take(params["challenge_id"], :registration),
         true <- user_id == user.id,
         {:ok, attestation} <- decode(params["attestation_object"]),
         {:ok, client_data} <- decode(params["client_data_json"]),
         {:ok, {auth_data, _}} <- Wax.register(attestation, client_data, challenge) do
      credential = auth_data.attested_credential_data

      %Passkey{}
      |> Passkey.changeset(%{
        user_id: user.id,
        credential_id: credential.credential_id,
        public_key: CBOR.encode(credential.credential_public_key),
        sign_count: auth_data.sign_count,
        name: name,
        transports: %{"values" => List.wrap(params["transports"])}
      })
      |> Repo.insert()
    else
      false -> {:error, :invalid_passkey}
      {:error, _} -> {:error, :invalid_passkey}
    end
  end

  @doc "Begins a passkey assertion for login or a settings mode change."
  @spec begin_authentication(User.t(), atom(), binding(), String.t(), map()) :: {:ok, map()} | {:error, term()}
  def begin_authentication(user, purpose, binding, origin, metadata \\ %{}) do
    credentials = credentials(user.id)

    if credentials == [] do
      {:error, :passkey_not_configured}
    else
      options = [{:allow_credentials, Enum.map(credentials, &credential_tuple/1)} | challenge_opts(origin)]
      challenge = Wax.new_authentication_challenge(options)

      id =
        WebAuthnChallengeStore.put(
          challenge,
          purpose,
          Map.merge(metadata, %{
            user_id: user.id,
            binding: binding
          })
        )

      {:ok, authentication_options(id, challenge)}
    end
  end

  @doc "Consumes and verifies a passkey assertion once."
  @spec authenticate(map(), atom(), binding()) :: {:ok, User.t(), map()} | {:error, term()}
  def authenticate(params, purpose, binding) do
    with {:ok, challenge, %{user_id: user_id, binding: ^binding} = metadata} <-
           WebAuthnChallengeStore.take(params["challenge_id"], purpose),
         {:ok, credential_id} <- decode(params["raw_id"]),
         %Passkey{} = passkey <- Repo.get_by(Passkey, credential_id: credential_id, user_id: user_id),
         {:ok, auth_data} <- verify_assertion(params, credential_id, challenge),
         :ok <- accept_counter(passkey, auth_data.sign_count),
         %User{} = user <- Repo.get(User, user_id) do
      {:ok, user, metadata}
    else
      _ -> {:error, :invalid_passkey}
    end
  end

  @doc "Changes passkey mode after a verified assertion; passwordless rotates recovery codes."
  @spec set_mode(User.t(), mode(), Ecto.UUID.t(), [String.t()]) :: {:ok, mode()} | {:error, term()}
  def set_mode(user, mode, current_session_id, recovery_codes \\ [])

  def set_mode(user, "passwordless" = mode, current_session_id, recovery_codes)
      when length(recovery_codes) == 10 do
    run_mode_transaction(user, mode, current_session_id, recovery_codes)
  end

  def set_mode(user, "second_factor" = mode, current_session_id, []) do
    run_mode_transaction(user, mode, current_session_id, [])
  end

  def set_mode(_, "passwordless", _, _),
    do: {:error, :recovery_codes_required}

  def set_mode(_, "second_factor", _, _),
    do: {:error, :unexpected_recovery_codes}

  @doc "Deletes one credential owned by the account."
  @spec delete(User.t(), Ecto.UUID.t()) :: :ok | {:error, :not_found}
  def delete(user, id) do
    query = from(p in Passkey, where: p.id == ^id and p.user_id == ^user.id)

    case Repo.delete_all(query) do
      {1, _} -> :ok
      {0, _} -> {:error, :not_found}
    end
  end

  defp challenge_opts(origin) do
    [origin: origin, rp_id: URI.parse(origin).host, user_verification: "required", timeout: 300]
  end

  defp credentials(user_id), do: Passkey |> where([p], p.user_id == ^user_id) |> Repo.all()

  defp credential_tuple(passkey) do
    {:ok, public_key, ""} = CBOR.decode(passkey.public_key)
    {passkey.credential_id, public_key}
  end

  defp registration_options(id, challenge, user) do
    %{
      challenge_id: id,
      public_key: %{
        challenge: encode(challenge.bytes),
        rp: %{id: challenge.rp_id, name: "Grappa"},
        user: %{id: encode(user.id), name: user.name, displayName: user.name},
        pubKeyCredParams: [%{type: "public-key", alg: -7}, %{type: "public-key", alg: -257}],
        timeout: 300_000,
        attestation: "none",
        authenticatorSelection: %{residentKey: "preferred", userVerification: "required"}
      }
    }
  end

  defp authentication_options(id, challenge) do
    %{
      challenge_id: id,
      public_key: %{
        challenge: encode(challenge.bytes),
        rpId: challenge.rp_id,
        timeout: 300_000,
        userVerification: "required"
      }
    }
  end

  defp verify_assertion(params, credential_id, challenge) do
    with {:ok, auth_data} <- decode(params["authenticator_data"]),
         {:ok, signature} <- decode(params["signature"]),
         {:ok, client_data} <- decode(params["client_data_json"]) do
      Wax.authenticate(credential_id, auth_data, signature, client_data, challenge)
    end
  end

  defp accept_counter(%Passkey{id: id}, new_count) when new_count == 0 do
    touch_query(from(p in Passkey, where: p.id == ^id), 0)
  end

  defp accept_counter(%Passkey{id: id, sign_count: old_count}, new_count)
       when new_count > old_count do
    touch_query(from(p in Passkey, where: p.id == ^id and p.sign_count < ^new_count), new_count)
  end

  defp accept_counter(_, _), do: {:error, :cloned_authenticator}

  defp touch_query(query, count) do
    case Repo.update_all(query, set: [sign_count: count, last_used_at: DateTime.utc_now()]) do
      {1, _} -> :ok
      {0, _} -> {:error, :cloned_authenticator}
    end
  end

  defp encode(binary), do: Base.url_encode64(binary, padding: false)
  defp decode(value) when is_binary(value), do: Base.url_decode64(value, padding: false)
  defp decode(_), do: :error

  defp run_mode_transaction(user, mode, current_session_id, recovery_codes) do
    Repo.BusyRetry.run(fn ->
      Repo.transaction(fn -> set_mode_transaction(user, mode, current_session_id, recovery_codes) end)
    end)
  end

  defp set_mode_transaction(user, mode, current_session_id, recovery_codes) do
    if mode == "passwordless", do: :ok = RecoveryCodes.replace(user.id, recovery_codes)
    {1, _} = User |> where([u], u.id == ^user.id) |> Repo.update_all(set: [passkey_mode: mode])
    :ok = Grappa.Accounts.revoke_other_sessions_for_user(user, current_session_id)
    mode
  end
end
