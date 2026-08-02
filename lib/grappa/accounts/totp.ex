defmodule Grappa.Accounts.TOTP do
  @moduledoc """
  TOTP enrollment and second-factor verification for durable user accounts.

  Secrets use the existing Cloak vault through `User.totp_secret_encrypted`.
  Recovery codes carry 128 random bits and are stored only as SHA-256 hashes.
  A conditional update of `totp_last_used_step` makes TOTP consumption atomic,
  so two concurrent requests cannot spend the same RFC 6238 code.
  """
  import Ecto.Query
  import Bitwise

  alias Grappa.Accounts.{TOTPRecoveryCode, User}
  alias Grappa.Repo

  @digits 6
  @period_seconds 30
  @recovery_code_count 10
  @secret_bytes 20

  @type enrollment :: %{secret: String.t(), provisioning_uri: String.t()}
  @type verify_error :: :invalid_two_factor | :two_factor_not_enabled | :two_factor_replayed

  @doc "Creates an unarmed secret and its `otpauth://` provisioning URI."
  @spec new_enrollment(User.t(), String.t()) :: enrollment()
  def new_enrollment(%User{name: name}, issuer) when is_binary(issuer) do
    secret = @secret_bytes |> :crypto.strong_rand_bytes() |> Base.encode32(padding: false)
    label = URI.encode("#{issuer}:#{name}")

    query =
      URI.encode_query(%{
        "algorithm" => "SHA1",
        "digits" => Integer.to_string(@digits),
        "issuer" => issuer,
        "period" => Integer.to_string(@period_seconds),
        "secret" => secret
      })

    %{secret: secret, provisioning_uri: "otpauth://totp/#{label}?#{query}"}
  end

  @doc "Arms TOTP after consuming one valid code and returns recovery codes once."
  @spec confirm_enrollment(User.t(), String.t(), String.t(), integer()) ::
          {:ok, [String.t()]} | {:error, :already_enabled | :invalid_two_factor}
  def confirm_enrollment(%User{id: user_id}, secret, code, unix_seconds)
      when is_binary(secret) and is_binary(code) and is_integer(unix_seconds) do
    with {:ok, step} <- matching_step(secret, code, unix_seconds) do
      recovery_codes = generate_recovery_codes()
      now = DateTime.utc_now()
      Repo.transaction(fn -> arm(user_id, secret, step, recovery_codes, now) end)
    end
  end

  @doc "Consumes a TOTP or recovery code exactly once."
  @spec verify(User.t(), String.t(), integer()) :: {:ok, :totp | :recovery} | {:error, verify_error()}
  def verify(%User{id: user_id}, code, unix_seconds)
      when is_binary(code) and is_integer(unix_seconds) do
    Repo.transaction(fn ->
      user = Repo.get!(User, user_id)

      if is_nil(user.totp_enabled_at) or is_nil(user.totp_secret_encrypted) do
        Repo.rollback(:two_factor_not_enabled)
      else
        consume_second_factor(user, code, unix_seconds)
      end
    end)
  end

  @doc "Returns whether TOTP is armed for the user."
  @spec enabled?(User.t()) :: boolean()
  def enabled?(%User{totp_enabled_at: enabled_at, totp_secret_encrypted: secret}),
    do: not is_nil(enabled_at) and not is_nil(secret)

  @doc "Generates the RFC 6238 code for tests and protocol verification."
  @spec code_at(String.t(), integer()) :: {:ok, String.t()} | {:error, :invalid_secret}
  def code_at(secret, unix_seconds) when is_binary(secret) and is_integer(unix_seconds) do
    case Base.decode32(secret, case: :mixed, padding: false) do
      {:ok, key} -> {:ok, hotp(key, div(unix_seconds, @period_seconds))}
      :error -> {:error, :invalid_secret}
    end
  end

  defp consume_second_factor(user, code, unix_seconds) do
    case matching_step(user.totp_secret_encrypted, code, unix_seconds) do
      {:ok, step} -> consume_totp_step(user, step)
      {:error, :invalid_two_factor} -> consume_recovery_code(user, code)
    end
  end

  defp consume_totp_step(%User{id: user_id}, step) do
    query =
      from(u in User,
        where:
          u.id == ^user_id and
            (is_nil(u.totp_last_used_step) or u.totp_last_used_step < ^step)
      )

    case Repo.update_all(query, set: [totp_last_used_step: step, updated_at: DateTime.utc_now()]) do
      {1, _} -> :totp
      {0, _} -> Repo.rollback(:two_factor_replayed)
    end
  end

  defp consume_recovery_code(%User{id: user_id}, code) do
    normalized = normalize_recovery_code(code)

    if valid_recovery_code?(normalized) do
      hash = recovery_code_hash(normalized)
      query = from(r in TOTPRecoveryCode, where: r.user_id == ^user_id and r.code_hash == ^hash)

      case Repo.delete_all(query) do
        {1, _} -> :recovery
        {0, _} -> Repo.rollback(:invalid_two_factor)
      end
    else
      Repo.rollback(:invalid_two_factor)
    end
  end

  defp matching_step(secret, code, unix_seconds) do
    normalized = String.trim(code)
    current_step = div(unix_seconds, @period_seconds)

    with true <- Regex.match?(~r/^\d{6}$/, normalized),
         {:ok, key} <- Base.decode32(secret, case: :mixed, padding: false) do
      matched_step =
        Enum.find([current_step - 1, current_step, current_step + 1], fn step ->
          Plug.Crypto.secure_compare(hotp(key, step), normalized)
        end)

      case matched_step do
        nil -> {:error, :invalid_two_factor}
        step -> {:ok, step}
      end
    else
      _ -> {:error, :invalid_two_factor}
    end
  end

  defp hotp(key, counter) do
    digest = :crypto.mac(:hmac, :sha, key, <<counter::unsigned-big-integer-size(64)>>)
    offset = :binary.last(digest) &&& 0x0F
    <<_::binary-size(offset), chunk::unsigned-big-integer-size(32), _::binary>> = digest
    value = rem(chunk &&& 0x7FFFFFFF, 1_000_000)
    value |> Integer.to_string() |> String.pad_leading(@digits, "0")
  end

  defp generate_recovery_codes do
    Enum.map(1..@recovery_code_count, fn _ ->
      16 |> :crypto.strong_rand_bytes() |> Base.encode32(case: :lower, padding: false)
    end)
  end

  defp insert_recovery_codes(user_id, codes, now) do
    rows =
      Enum.map(codes, fn code ->
        %{
          id: Ecto.UUID.generate(),
          user_id: user_id,
          code_hash: recovery_code_hash(code),
          inserted_at: now
        }
      end)

    {count, _} = Repo.insert_all(TOTPRecoveryCode, rows)
    @recovery_code_count = count
  end

  defp arm(user_id, secret, step, recovery_codes, now) do
    query = from(u in User, where: u.id == ^user_id and is_nil(u.totp_enabled_at))

    case Repo.update_all(query,
           set: [
             totp_secret_encrypted: secret,
             totp_enabled_at: now,
             totp_last_used_step: step,
             updated_at: now
           ]
         ) do
      {1, _} ->
        insert_recovery_codes(user_id, recovery_codes, now)
        recovery_codes

      {0, _} ->
        Repo.rollback(:already_enabled)
    end
  end

  defp normalize_recovery_code(code) do
    code
    |> String.trim()
    |> String.downcase()
    |> String.replace("-", "")
    |> String.replace(" ", "")
  end

  defp valid_recovery_code?(code), do: Regex.match?(~r/^[a-z2-7]{26}$/, code)
  defp recovery_code_hash(code), do: :crypto.hash(:sha256, normalize_recovery_code(code))
end
