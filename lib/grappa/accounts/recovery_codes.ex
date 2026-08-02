defmodule Grappa.Accounts.RecoveryCodes do
  @moduledoc "Account-level one-shot recovery codes shared by TOTP and passkeys."
  import Ecto.Query

  alias Grappa.Accounts.TOTPRecoveryCode
  alias Grappa.Repo

  @count 10

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
