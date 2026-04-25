defmodule Grappa.Accounts do
  @moduledoc """
  Operator-managed user accounts.

  Public surface: `create_user/1`, `get_user_by_credentials/2`,
  `get_user!/1`. The `User` schema is exported so `Sessions` (sub-task
  2b) and downstream Plug pipelines can pattern-match on `%User{}` —
  internal field shape is intentionally part of the contract.

  ## Authentication oracle posture

  `get_user_by_credentials/2` returns `{:error, :invalid_credentials}`
  for BOTH wrong-username and wrong-password to prevent enumeration of
  registered names. On the wrong-username branch we still call
  `Argon2.no_user_verify/0` to consume the same CPU budget a real
  Argon2 verification would — without this the response-time gap
  (microseconds vs ~100ms) leaks user existence.

  ## Argon2 parameters

  We use `argon2_elixir`'s defaults (m=64MiB, t=3, p=4) unmodified.
  Phase 5 hardening will profile on the deployment hardware and
  tune `:argon2_elixir` config if the per-login cost is unacceptable;
  Phase 2 sticks with the library default so an operator's first
  install matches every other Argon2-using BEAM service in the wild.
  """
  use Boundary, top_level?: true, deps: [Grappa.Repo], exports: [User]

  alias Grappa.Accounts.User
  alias Grappa.Repo

  @doc """
  Creates a user from `name` + plaintext `password`.

  Validation lives in `User.changeset/2`; uniqueness on `name` is
  enforced by both the changeset's `unique_constraint/2` and the
  `users_name_index` DB index — concurrent inserts that race the
  in-process check still surface `{:error, changeset}` on the second
  insert.
  """
  @spec create_user(%{required(:name) => String.t(), required(:password) => String.t()}) ::
          {:ok, User.t()} | {:error, Ecto.Changeset.t()}
  def create_user(attrs) do
    %User{}
    |> User.changeset(attrs)
    |> Repo.insert()
  end

  @doc """
  Verifies `name` + plaintext `password` against a stored Argon2 hash.

  Returns `{:ok, %User{}}` on a match, `{:error, :invalid_credentials}`
  on either wrong username or wrong password. The wrong-username branch
  invokes `Argon2.no_user_verify/0` so timing observation cannot
  distinguish "no such user" from "wrong password" — see moduledoc.
  """
  @spec get_user_by_credentials(String.t(), String.t()) ::
          {:ok, User.t()} | {:error, :invalid_credentials}
  def get_user_by_credentials(name, password)
      when is_binary(name) and is_binary(password) do
    case Repo.get_by(User, name: name) do
      %User{password_hash: hash} = user ->
        if Argon2.verify_pass(password, hash),
          do: {:ok, user},
          else: {:error, :invalid_credentials}

      nil ->
        Argon2.no_user_verify()
        {:error, :invalid_credentials}
    end
  end

  @doc """
  Fetches a user by id. Raises `Ecto.NoResultsError` on miss.

  Used by authenticated request handlers to materialize the `%User{}`
  from a session-bearing token's `user_id` claim — the token
  verification step has already proven the id is valid, so a miss here
  is an invariant violation worth crashing on.
  """
  @spec get_user!(Ecto.UUID.t()) :: User.t()
  def get_user!(id), do: Repo.get!(User, id)
end
