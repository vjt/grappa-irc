defmodule Grappa.Accounts.WebAuthn do
  @moduledoc "Passkey registration and assertion ceremonies for durable accounts."
  import Ecto.Query

  alias Grappa.Accounts.{Passkey, RecoveryCodes, User, WebAuthnChallengeStore}
  alias Grappa.Repo

  require Logger

  @type binding :: %{ip: String.t() | nil, client_id: String.t() | nil}
  @type mode :: User.passkey_mode()

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
    with :ok <- Grappa.Accounts.verify_password(user, password) do
      challenge = Wax.new_registration_challenge(challenge_opts(origin))

      id =
        WebAuthnChallengeStore.put(challenge, :registration, %{
          user_id: user.id,
          name: name,
          binding: binding
        })

      {:ok, registration_options(id, challenge, user)}
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

      changeset =
        Passkey.changeset(%Passkey{}, %{
          user_id: user.id,
          credential_id: credential.credential_id,
          public_key: CBOR.encode(credential.credential_public_key),
          sign_count: auth_data.sign_count,
          name: name,
          transports: %{"values" => List.wrap(params["transports"])}
        })

      # #768 — ride out a transient SQLITE_BUSY on the credential insert rather
      # than raising a 500 at the end of a ceremony the user cannot cheaply
      # repeat. `Repo.insert/1` already returns the `{:ok, _} | {:error,
      # changeset}` shape `BusyRetry.run/1` wants, so the wrap is the whole
      # change; sustained saturation degrades to `{:error, :db_unavailable}`.
      # This is the `with` BODY, not a `<-` clause, so it bypasses the
      # `:invalid_passkey` else and reaches the caller intact.
      Repo.BusyRetry.run(fn -> Repo.insert(changeset) end)
    else
      false -> {:error, :invalid_passkey}
      {:error, _} -> {:error, :invalid_passkey}
    end
  end

  @doc "Begins a passkey assertion for login or a settings mode change."
  @spec begin_authentication(User.t(), atom(), binding(), String.t(), map()) :: {:ok, map()} | {:error, term()}
  def begin_authentication(user, purpose, binding, origin, metadata) do
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

      {:ok, authentication_options(id, challenge, exposed_credentials(purpose, credentials))}
    end
  end

  @doc "Consumes and verifies a passkey assertion once."
  @spec authenticate(map(), atom(), binding()) ::
          {:ok, User.t(), map()} | {:error, :invalid_passkey | :db_unavailable}
  def authenticate(params, purpose, binding) do
    with {:ok, challenge, %{user_id: user_id, binding: ^binding} = metadata} <-
           WebAuthnChallengeStore.take(params["challenge_id"], purpose),
         {:ok, credential_id} <- decode(params["raw_id"]),
         %Passkey{} = passkey <- Repo.get_by(Passkey, credential_id: credential_id, user_id: user_id),
         {:ok, auth_data} <- verify_assertion(params, credential_id, challenge),
         :ok <- consume_sign_count(passkey, auth_data.sign_count),
         %User{} = user <- Repo.get(User, user_id) do
      {:ok, user, metadata}
    else
      # #815 — the LAST clause reached here decides what a saturated writer
      # looks like, and the catch-all below answers "your credential is bad".
      # Since #815 wrapped the counter commit in `Repo.BusyRetry`, that answer
      # would be a statement about a credential this function verified and
      # accepted: everything ahead of the write passed, and only the write
      # failed. It is the same lie #768 removed from `set_mode/2` and
      # `register/2`, one layer down — and worse than the 500 the wrap replaced,
      # because the user believes it and re-enrols a credential that was fine.
      #
      # ONE atom widens, not the else. `:cloned_authenticator` in particular
      # stays collapsed below: the wire must never confirm to an attacker that
      # their clone was spotted (see `refuse_clone/2`). A 503 here can only be
      # read by someone who already produced a valid assertion for a credential
      # we hold, so it tells them nothing they did not supply themselves.
      {:error, :db_unavailable} = err -> err
      _ -> {:error, :invalid_passkey}
    end
  end

  @doc """
  Decodes a wire mode string into the closed set the schema stores.

  The wire speaks the three mode spellings; the column stores them as the
  atoms that make the set closed. This is the single door between the two,
  and it reads the schema's own mapping rather than restating the list, so
  a fourth mode cannot exist on one side only.
  """
  @spec decode_mode(term()) :: {:ok, mode()} | {:error, :invalid_mode}
  def decode_mode(value) when is_binary(value) do
    case Enum.find(Ecto.Enum.mappings(User, :passkey_mode), fn {_, wire} -> wire == value end) do
      {mode, _} -> {:ok, mode}
      nil -> {:error, :invalid_mode}
    end
  end

  def decode_mode(_), do: {:error, :invalid_mode}

  @doc "Changes passkey mode after a verified assertion; passwordless rotates recovery codes."
  @spec set_mode(User.t(), mode(), Ecto.UUID.t(), [String.t()]) :: {:ok, mode()} | {:error, term()}
  def set_mode(user, :passwordless = mode, current_session_id, recovery_codes)
      when length(recovery_codes) == 10 do
    run_mode_transaction(user, mode, current_session_id, recovery_codes)
  end

  def set_mode(user, :second_factor = mode, current_session_id, []) do
    run_mode_transaction(user, mode, current_session_id, [])
  end

  def set_mode(user, :disabled = mode, current_session_id, []) do
    run_mode_transaction(user, mode, current_session_id, [])
  end

  def set_mode(_, :passwordless, _, _),
    do: {:error, :recovery_codes_required}

  def set_mode(_, :second_factor, _, _),
    do: {:error, :unexpected_recovery_codes}

  @doc """
  Deletes one credential owned by the account, refusing the last one an
  armed mode still needs.

  The "is this the last one" test is part of the DELETE rather than a read
  before it. Counting first and deleting second is two statements, and two
  concurrent requests both saw two credentials and both went ahead — which
  leaves a passwordless account with zero passkeys and no door at all. As
  one statement the second request re-decides against the row the first
  already removed, and loses.
  """
  @spec delete(User.t(), Ecto.UUID.t()) ::
          :ok | {:error, :not_found | :passkey_required | :db_unavailable}
  def delete(%User{passkey_mode: :disabled} = user, id), do: run_delete(user, id, owned(user, id))

  def delete(user, id) do
    others = from(o in Passkey, where: o.user_id == ^user.id and o.id != ^id)

    run_delete(user, id, from(p in owned(user, id), where: exists(others)))
  end

  defp owned(user, id), do: from(p in Passkey, where: p.id == ^id and p.user_id == ^user.id)

  # #768 — ride out a transient SQLITE_BUSY on the credential delete; sustained
  # saturation degrades to `{:error, :db_unavailable}` (a 503 at the REST
  # caller) rather than raising a 500. Wrap the delete in an `{:ok, _}` so the
  # op honours the `BusyRetry.run/1` contract, as `QueryWindows.close/3` does.
  # `refuse_delete/2` stays OUTSIDE the retry: it is a read, and re-running it
  # per attempt would re-decide a question the delete already answered.
  defp run_delete(user, id, query) do
    result =
      Repo.BusyRetry.run(fn ->
        {count, _} = Repo.delete_all(query)
        {:ok, count}
      end)

    case result do
      {:ok, 1} -> :ok
      {:ok, 0} -> refuse_delete(user, id)
      {:error, :db_unavailable} = err -> err
    end
  end

  # A zero-row delete is either "not yours, or not there" or "it is the last
  # one an armed mode needs", and one statement cannot report which. Asking
  # afterwards can only mis-label under a concurrent delete, where both
  # answers were true of some instant.
  defp refuse_delete(user, id) do
    if Repo.exists?(owned(user, id)),
      do: {:error, :passkey_required},
      else: {:error, :not_found}
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
        user: %{id: encode(user.id), name: user.name, display_name: user.name},
        pub_key_cred_params: [%{type: "public-key", alg: -7}, %{type: "public-key", alg: -257}],
        timeout: 300_000,
        attestation: "none",
        authenticator_selection: %{resident_key: "preferred", user_verification: "required"}
      }
    }
  end

  # `residentKey: "preferred"` lets an authenticator hand back a
  # NON-discoverable credential, and the browser cannot find one of those
  # without being told the id. So every ceremony whose caller has already
  # proven who they are gets the account's credential list; the
  # passwordless login door does not, because it answers an anonymous
  # caller and credential ids are a tracking handle we will not hand out.
  defp exposed_credentials(purpose, credentials) when purpose in [:second_factor, :mode_change],
    do: credentials

  defp exposed_credentials(_, _), do: []

  defp authentication_options(id, challenge, credentials) do
    %{
      challenge_id: id,
      public_key:
        maybe_allow_credentials(
          %{
            challenge: encode(challenge.bytes),
            rp_id: challenge.rp_id,
            timeout: 300_000,
            user_verification: "required"
          },
          credentials
        )
    }
  end

  defp maybe_allow_credentials(options, []), do: options

  defp maybe_allow_credentials(options, credentials),
    do: Map.put(options, :allow_credentials, Enum.map(credentials, &allow_credential/1))

  defp allow_credential(%Passkey{credential_id: credential_id, transports: transports}) do
    descriptor = %{type: "public-key", id: encode(credential_id)}

    case Map.get(transports, "values", []) do
      [] -> descriptor
      values -> Map.put(descriptor, :transports, values)
    end
  end

  defp verify_assertion(params, credential_id, challenge) do
    with {:ok, auth_data} <- decode(params["authenticator_data"]),
         {:ok, signature} <- decode(params["signature"]),
         {:ok, client_data} <- decode(params["client_data_json"]) do
      Wax.authenticate(credential_id, auth_data, signature, client_data, challenge)
    end
  end

  @doc """
  Consumes the signature counter an assertion presented, refusing one that
  did not advance.

  The assertion-time step of `authenticate/3`, exposed because it is the
  clone-detection rule and deserves to be tested against real rows rather
  than through a hand-forged WebAuthn ceremony.

  A zero counter means "this authenticator does not count" ONLY when the
  credential has never counted either. Once a stored counter has moved, a
  zero is the clone signal WebAuthn L3 7.2.21 describes — and the old
  unguarded clause not only accepted it, it wrote the zero back, so the
  clone erased the very evidence and every later assertion looked clean.

  The write is a compare-and-set on the stored counter, so two assertions
  racing on one credential cannot both win.
  """
  @spec consume_sign_count(Passkey.t(), non_neg_integer()) ::
          :ok | {:error, :cloned_authenticator | :db_unavailable}
  def consume_sign_count(%Passkey{sign_count: 0} = passkey, 0), do: commit_counter(passkey, 0, 0)

  def consume_sign_count(%Passkey{sign_count: old_count} = passkey, new_count)
      when new_count > old_count,
      do: commit_counter(passkey, new_count, old_count)

  def consume_sign_count(passkey, new_count), do: refuse_clone(passkey, new_count)

  # Compare-and-set against the counter we read. A concurrent assertion that
  # already moved the row wins and this one is refused, so a captured
  # assertion cannot be replayed alongside the genuine one.
  #
  # #815 — the last unwrapped passkey write, deliberately left out of #768
  # because a CAS is not idempotent: an attempt that COMMITTED and then
  # reported an error would be retried, match zero rows against the counter it
  # had itself advanced, and be refused as a clone — a legitimate login denied
  # and a false clone alarm in the operator's log. That sequence was measured
  # rather than reasoned about (142 forced mid-flight connection kills, zero
  # occurrences) and it cannot happen through this pool; the whole argument,
  # its limits, and what must be re-measured if `db_connection`'s internals
  # change are in DESIGN_NOTES 2026-08-05. Every retry therefore re-runs an
  # attempt that left the row untouched, so the CAS still matches.
  #
  # `refuse_clone/2` stays on the `{:ok, 0}` branch only: a degrade is not a
  # refusal, and routing it through the clone rule would write exactly the
  # alarm this wrap was accused of manufacturing.
  defp commit_counter(%Passkey{id: id} = passkey, new_count, expected) do
    query = from(p in Passkey, where: p.id == ^id and p.sign_count == ^expected)

    result =
      Repo.BusyRetry.run(fn ->
        {count, _} = Repo.update_all(query, set: [sign_count: new_count, last_used_at: DateTime.utc_now()])
        {:ok, count}
      end)

    case result do
      {:ok, 1} -> :ok
      {:ok, 0} -> refuse_clone(passkey, new_count)
      {:error, :db_unavailable} = err -> err
    end
  end

  # `authenticate/3` collapses this into `:invalid_passkey` so the wire
  # never confirms to an attacker that their clone was spotted. That makes
  # the log the ONLY place the operator can learn it happened, so it has to
  # carry enough to act on: which account, which credential, both counters.
  defp refuse_clone(%Passkey{id: id, user_id: user_id, sign_count: stored}, presented) do
    Logger.warning("passkey assertion refused: sign counter did not advance",
      passkey_id: id,
      user_id: user_id,
      stored_sign_count: stored,
      presented_sign_count: presented
    )

    {:error, :cloned_authenticator}
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
    if mode == :passwordless, do: :ok = RecoveryCodes.replace(user.id, recovery_codes)

    user |> User.passkey_mode_changeset(%{passkey_mode: mode}) |> Repo.update!()

    # AFTER the mode write, so the shared-set rule reads the mode we just
    # committed. It replaces a narrower guard that fired only on
    # passwordless -> disabled and deleted unconditionally, which wiped a
    # TOTP user's codes and left the second_factor exits unconsidered.
    :ok = RecoveryCodes.drop_if_orphaned(user.id)

    :ok = Grappa.Accounts.revoke_other_sessions_for_user(user, current_session_id)
    mode
  end
end
