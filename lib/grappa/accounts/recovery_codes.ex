defmodule Grappa.Accounts.RecoveryCodes do
  @moduledoc "Account-level one-shot recovery codes shared by TOTP and passkeys."
  import Ecto.Query

  alias Grappa.Accounts.{TOTP, TOTPRecoveryCode, User}
  alias Grappa.Repo

  @count 10

  @doc """
  Drops the recovery set once the last factor that could redeem it is gone.

  There is ONE flat account-level set, shared by TOTP and passkey login,
  with no per-factor ownership recorded anywhere — so no single teardown
  is entitled to assume the codes are its own to destroy. Every teardown
  calls this AFTER its own mutation has landed, and the codes go only
  when nothing is armed to use them.

  The conservative half of that (keeping codes a surviving factor still
  needs) is the half that had been getting this wrong: disabling passkey
  login, or an operator resetting passkeys, wiped a TOTP user's codes
  outright.
  """
  @spec drop_if_orphaned(Ecto.UUID.t()) :: :ok
  def drop_if_orphaned(user_id) when is_binary(user_id) do
    User
    |> Repo.get!(user_id)
    |> armed_factor?()
    |> drop_unless_armed(user_id)
  end

  # "Armed" means the factor could still be the only thing between the
  # account and a locked door. Passkey `second_factor` counts (vjt,
  # 2026-08-03): the conservative line is that codes outlive any 2FA
  # factor still standing, not just the one that happened to mint them.
  @spec armed_factor?(User.t()) :: boolean()
  defp armed_factor?(user), do: TOTP.enabled?(user) or user.passkey_mode != :disabled

  @spec drop_unless_armed(boolean(), Ecto.UUID.t()) :: :ok
  defp drop_unless_armed(true, _), do: :ok

  defp drop_unless_armed(false, user_id) do
    TOTPRecoveryCode |> where([r], r.user_id == ^user_id) |> Repo.delete_all()
    :ok
  end

  @doc """
  Whether the account still holds an unspent recovery code.

  The question a door asks before offering itself (#766): the set is armed
  independently of which factor is, so "is TOTP on" is not the same
  question and answering with it strands the codes.
  """
  @spec armed?(Ecto.UUID.t()) :: boolean()
  def armed?(user_id) when is_binary(user_id),
    do: TOTPRecoveryCode |> where([r], r.user_id == ^user_id) |> Repo.exists?()

  @doc "Rotates all recovery codes and returns their plaintext values once."
  @spec rotate(Ecto.UUID.t()) :: [String.t()]
  def rotate(user_id) when is_binary(user_id) do
    codes = generate()
    :ok = replace(user_id, codes)
    codes
  end

  @doc "Generates a plaintext recovery set without arming it."
  @spec generate() :: [String.t()]
  def generate, do: Enum.map(1..@count, fn _ -> random_code() end)

  @doc "Atomically replaces the stored recovery set with supplied plaintext codes."
  @spec replace(Ecto.UUID.t(), [String.t()]) :: :ok
  def replace(user_id, codes) when is_binary(user_id) and length(codes) == @count do
    now = DateTime.utc_now()

    TOTPRecoveryCode
    |> where([r], r.user_id == ^user_id)
    |> Repo.delete_all()

    rows =
      Enum.map(codes, fn code ->
        %{id: Ecto.UUID.generate(), user_id: user_id, code_hash: hash(code), inserted_at: now}
      end)

    {@count, _} = Repo.insert_all(TOTPRecoveryCode, rows)
    :ok
  end

  @doc "Atomically consumes one recovery code for an account."
  @spec consume(Ecto.UUID.t(), String.t()) :: :ok | {:error, :invalid_recovery_code}
  def consume(user_id, code) when is_binary(user_id) and is_binary(code) do
    normalized = normalize(code)

    if Regex.match?(~r/^[a-z2-7]{26}$/, normalized) do
      digest = hash(normalized)
      query = from(r in TOTPRecoveryCode, where: r.user_id == ^user_id and r.code_hash == ^digest)

      case Repo.delete_all(query) do
        {1, _} -> :ok
        {0, _} -> {:error, :invalid_recovery_code}
      end
    else
      {:error, :invalid_recovery_code}
    end
  end

  defp random_code, do: 16 |> :crypto.strong_rand_bytes() |> Base.encode32(case: :lower, padding: false)
  defp hash(code), do: :crypto.hash(:sha256, normalize(code))

  defp normalize(code) do
    code |> String.trim() |> String.downcase() |> String.replace("-", "") |> String.replace(" ", "")
  end
end
