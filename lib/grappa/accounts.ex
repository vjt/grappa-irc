defmodule Grappa.Accounts do
  @moduledoc """
  Operator-managed user accounts + bearer-token auth sessions.

  Public surface:

    * users: `create_user/1`, `get_user_by_credentials/2`, `get_user!/1`,
      `get_user_by_name!/1`
    * sessions: `create_session/3`, `authenticate/1`, `revoke_session/1`

  Both `User` and `Session` schemas are exported so downstream callers
  (controllers, channels, plugs) can pattern-match on the structs —
  the field shape is intentionally part of the boundary contract.

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

  ## Session lifecycle

  Bearer tokens ARE the session row's UUID PK — no separate token /
  hash column. Rationale: the operator-personal deployment posture
  means a DB compromise already exposes scrollback + encrypted creds,
  so a token-hash adds little marginal protection. See
  `Grappa.Accounts.Session` moduledoc + `docs/plans/2026-04-25-phase2-auth.md`
  Decision A for the trade-off.

  Sliding 7-day idle expiry: a session lives forever as long as the
  client keeps using it; 8 days of silence and the next `authenticate/1`
  call returns `{:error, :expired}`. To keep the per-request DB-write
  cost negligible, `last_seen_at` is bumped at most once every 60 s
  (`@last_seen_bump_threshold_seconds`).
  """
  use Boundary,
    top_level?: true,
    deps: [Grappa.Repo],
    # `Visitors.Visitor` is referenced by `Accounts.Session`
    # (`belongs_to :visitor` + `Visitor.t()` type) and by the
    # `validate_subject_exists/1` existence check (`from row in
    # Visitor`). Mirror of the `Networks.Network` dirty_xref in
    # `Grappa.Scrollback`: schema-only access whose only purpose is
    # to break the visitor-auth cycle inversion (Visitors → Networks
    # opens otherwise-transitive cycles via Accounts → Visitors and
    # Scrollback → Visitors). The cost — losing Boundary checks on
    # struct-shape access Boundary couldn't gate anyway — is
    # intentional.
    dirty_xrefs: [Grappa.Visitors.Visitor],
    exports: [User, Session, Wire]

  import Ecto.Query

  alias Grappa.Accounts.{Session, User}
  alias Grappa.Repo
  alias Grappa.Visitors.Visitor

  require Logger

  @type subject :: {:user, Ecto.UUID.t()} | {:visitor, Ecto.UUID.t()}

  @idle_timeout_seconds 7 * 24 * 3600
  @last_seen_bump_threshold_seconds 60

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

  @doc """
  Fetches a user by `name`. Raises `Ecto.NoResultsError` on miss.

  Used by the operator-side mix tasks where a typo in `--user`
  should fail loudly with a stack trace, not silently no-op.
  """
  @spec get_user_by_name!(String.t()) :: User.t()
  def get_user_by_name!(name) when is_binary(name), do: Repo.get_by!(User, name: name)

  @doc """
  Creates a new bearer-token session for the given `subject`.

  `subject` is a tagged tuple — `{:user, user_id}` for an
  operator-managed account login, `{:visitor, visitor_id}` for an
  anonymous-IRC visitor session (cluster `visitor-auth` decisions
  Q-A / Q-C: a single `sessions` table with an XOR FK so the
  Authorization-bearer transport stays a single token namespace).

  `ip` and `user_agent` are recorded for audit; both may be `nil`
  (mix tasks bypass the HTTP surface and have neither). The returned
  `Session.t().id` IS the bearer token to hand back to the client.
  """
  @spec create_session(subject(), String.t() | nil, String.t() | nil) ::
          {:ok, Session.t()} | {:error, Ecto.Changeset.t()}
  def create_session({:user, user_id}, ip, user_agent) when is_binary(user_id) do
    do_create_session(%{user_id: user_id, ip: ip, user_agent: user_agent})
  end

  def create_session({:visitor, visitor_id}, ip, user_agent) when is_binary(visitor_id) do
    do_create_session(%{visitor_id: visitor_id, ip: ip, user_agent: user_agent})
  end

  defp do_create_session(attrs) do
    now = DateTime.utc_now()

    %Session{}
    |> Session.changeset(Map.merge(attrs, %{created_at: now, last_seen_at: now}))
    |> validate_subject_exists()
    |> Repo.insert()
  end

  # `Session.changeset/2` carries `assoc_constraint(:user)` and
  # `assoc_constraint(:visitor)` for engines that surface FK
  # violations by name (PostgreSQL etc.), but `ecto_sqlite3` returns
  # the constraint name as `nil` so the built-in handling cannot
  # match — the FK violation would surface as a raw
  # `Ecto.ConstraintError` exception. Pre-flight existence check
  # converts the miss to a clean changeset error before the insert,
  # generalized from S29 H4's `validate_user_exists/1` to either
  # subject side. Race window between check and insert is narrow +
  # benign — a concurrently-deleted user / visitor would still trip
  # the DB FK as a backstop.
  defp validate_subject_exists(changeset) do
    cond do
      user_id = Ecto.Changeset.get_change(changeset, :user_id) ->
        check_subject_exists(changeset, User, user_id, :user)

      visitor_id = Ecto.Changeset.get_change(changeset, :visitor_id) ->
        check_subject_exists(changeset, Visitor, visitor_id, :visitor)

      true ->
        changeset
    end
  end

  defp check_subject_exists(changeset, schema, id, field) do
    query = from(row in schema, where: row.id == ^id)

    if Repo.exists?(query) do
      changeset
    else
      Ecto.Changeset.add_error(changeset, field, "does not exist")
    end
  end

  @doc """
  Verifies a bearer token and returns the live `Session` on success.

  Failure modes:

    * `:invalid_token` — `token` isn't a well-formed UUID. Cheap reject
      before any DB lookup.
    * `:not_found`    — UUID is well-formed but no row matches.
    * `:revoked`      — row exists but `revoked_at` is set.
    * `:expired`      — `last_seen_at` is older than the 7-day idle
      window. The row is left in place (audit + housekeeping cron).

  On success, `last_seen_at` is bumped to `now` if the previous bump
  was more than 60 s ago — otherwise the row is returned untouched
  to spare the DB write under sustained per-request traffic.
  """
  @spec authenticate(String.t()) ::
          {:ok, Session.t()}
          | {:error, :invalid_token | :not_found | :revoked | :expired}
  def authenticate(token) when is_binary(token) do
    with {:ok, _} <- Ecto.UUID.cast(token),
         %Session{revoked_at: nil} = session <- Repo.get(Session, token) do
      check_idle(session)
    else
      :error -> {:error, :invalid_token}
      nil -> {:error, :not_found}
      %Session{} -> {:error, :revoked}
    end
  end

  @doc """
  Marks the session row's `revoked_at` to now. Idempotent and safe to
  call with an unknown id — both paths return `:ok` (no-op for the
  unknown id) so callers don't need to branch on existence. The
  affected-row count is logged so a typo'd revoke (zero matches)
  remains greppable in operator logs without changing the API
  contract.
  """
  @spec revoke_session(Ecto.UUID.t()) :: :ok
  def revoke_session(id) when is_binary(id) do
    query = from(s in Session, where: s.id == ^id)
    {affected, _} = Repo.update_all(query, set: [revoked_at: DateTime.utc_now()])
    Logger.info("session revoked", session_id: id, affected: affected)
    :ok
  end

  defp check_idle(session) do
    now = DateTime.utc_now()
    idle = DateTime.diff(now, session.last_seen_at, :second)

    cond do
      idle > @idle_timeout_seconds ->
        {:error, :expired}

      idle > @last_seen_bump_threshold_seconds ->
        {:ok, touch_session(session, now)}

      true ->
        {:ok, session}
    end
  end

  defp touch_session(session, now) do
    {:ok, updated} =
      session
      |> Ecto.Changeset.change(last_seen_at: now)
      |> Repo.update()

    updated
  end
end
