defmodule Grappa.Accounts do
  @moduledoc """
  Operator-managed user accounts + bearer-token auth sessions.

  Public surface:

    * users: `create_user/1`, `get_user_by_credentials/2`, `get_user!/1`,
      `get_user/1`, `get_user_by_name!/1`, `list_all_users/0`,
      `update_admin_flags/2`
    * sessions: `create_session/4`, `authenticate/1`, `revoke_session/1`

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
  `Grappa.Accounts.Session` moduledoc for the trade-off.

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
    exports: [User, Session, Wire, AdminWire]

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
  Typed-nil sibling of `get_user!/1` for HTTP / programmatic callers
  (M-cluster M-6 `PATCH /admin/users/:id`,
  `PATCH /admin/credentials/:user_id/:network_id`). Returns `nil`
  when the id doesn't exist; callers translate to `{:error, :not_found}`
  at their boundary.
  """
  @spec get_user(Ecto.UUID.t()) :: User.t() | nil
  def get_user(id) when is_binary(id), do: Repo.get(User, id)

  @doc """
  Batched lookup: `[user_id]` → `%{user_id => %User{}}`. One query
  regardless of input size — used by admin endpoints that need to
  resolve N user_ids to display labels without N+1 round-trips.

  Returns an empty map when the input is empty (no query issued).
  Missing ids are absent from the result map; callers translate to
  the "DB row missing" honesty signal at their boundary.
  """
  @spec get_users_by_ids([Ecto.UUID.t()]) :: %{Ecto.UUID.t() => User.t()}
  def get_users_by_ids([]), do: %{}

  def get_users_by_ids(ids) when is_list(ids) do
    User
    |> where([u], u.id in ^ids)
    |> Repo.all()
    |> Map.new(fn user -> {user.id, user} end)
  end

  @doc """
  Batched MAX(`last_seen_at`) across cookie sessions, keyed by
  subject id. Used by `GrappaWeb.Admin.SessionsController` to
  surface "when did this subject's browser last touch the bouncer"
  alongside live BEAM state (mailbox, memory).

  `subject_kind` discriminates the column: `:user` selects
  `user_id`, `:visitor` selects `visitor_id`. Result map keys are
  ONLY ids that had at least one cookie session — missing ids
  signal the U-0 honesty case (`nil` on the wire: bouncer pid
  exists but no browser ever logged in).

  MAX across N cookie rows per subject collapses multi-device
  users to "most recent touch." Both `Accounts.authenticate/1`
  (REST plug) and `UserSocket.connect/3` (WS upgrade) bump
  `last_seen_at`, cadence-capped at 60 s — so the timestamp is
  per-minute precision in practice, ISO8601 microseconds on the
  wire only because the underlying column is `:utc_datetime_usec`.

  Empty input → `%{}` (skip the round-trip).
  """
  @spec max_last_seen_by_subject_ids(:user | :visitor, [Ecto.UUID.t()]) ::
          %{Ecto.UUID.t() => DateTime.t()}
  def max_last_seen_by_subject_ids(_, []), do: %{}

  def max_last_seen_by_subject_ids(:user, ids) when is_list(ids) do
    Session
    |> where([s], s.user_id in ^ids)
    |> group_by([s], s.user_id)
    |> select([s], {s.user_id, max(s.last_seen_at)})
    |> Repo.all()
    |> Map.new()
  end

  def max_last_seen_by_subject_ids(:visitor, ids) when is_list(ids) do
    Session
    |> where([s], s.visitor_id in ^ids)
    |> group_by([s], s.visitor_id)
    |> select([s], {s.visitor_id, max(s.last_seen_at)})
    |> Repo.all()
    |> Map.new()
  end

  @doc """
  Every user row, ordered by `name` ascending. Operator-facing —
  the M-6 admin console (`GET /admin/users`) materializes the full
  table. Users are operator-curated (low cardinality); full
  materialization is fine.
  """
  @spec list_all_users() :: [User.t()]
  def list_all_users do
    query = from(u in User, order_by: [asc: u.name])
    Repo.all(query)
  end

  @doc """
  Fetches a user by `name`. Raises `Ecto.NoResultsError` on miss.

  Used by the operator-side mix tasks where a typo in `--user`
  should fail loudly with a stack trace, not silently no-op.
  """
  @spec get_user_by_name!(String.t()) :: User.t()
  def get_user_by_name!(name) when is_binary(name), do: Repo.get_by!(User, name: name)

  @doc """
  Toggle the operator-authorization `is_admin` bit on `user`. The M
  cluster's `PATCH /admin/users/:id` endpoint calls into this, and
  `grappa.create_user --admin` calls it right after creating the user —
  the one-command first-admin bootstrap (Q-FIRST-ADMIN).

  Narrow surface: accepts only `%{is_admin: boolean()}` (User's
  `admin_changeset/2` ignores any other key) so a controller body
  can't smuggle name / password mutations through the admin endpoint.

  ## Last-admin guard (admin-panel bucket 2, A-4)

  Refuses to demote the LAST admin with `{:error, :last_admin}` —
  would lock the deployment out of its own admin panel. The check
  counts other admins (excluding `user.id`) BEFORE the update; SQLite's
  single-writer model serializes concurrent demotes naturally (the
  second tx observes the first's commit). A future Postgres migration
  would need an advisory lock here.
  """
  @spec update_admin_flags(User.t(), %{required(:is_admin) => boolean()}) ::
          {:ok, User.t()} | {:error, :last_admin | Ecto.Changeset.t()}
  def update_admin_flags(%User{} = user, attrs) do
    if demoting_last_admin?(user, attrs) do
      {:error, :last_admin}
    else
      user |> User.admin_changeset(attrs) |> Repo.update()
    end
  end

  defp demoting_last_admin?(%User{is_admin: true, id: id}, %{is_admin: false}) do
    other_admins_count(id) == 0
  end

  defp demoting_last_admin?(%User{is_admin: true, id: id}, %{"is_admin" => false}) do
    other_admins_count(id) == 0
  end

  defp demoting_last_admin?(_, _), do: false

  defp other_admins_count(exclude_id) do
    query = from(u in User, where: u.is_admin == true and u.id != ^exclude_id)
    Repo.aggregate(query, :count, :id)
  end

  @doc """
  Rotates `user`'s plaintext password (admin-panel bucket 2 —
  `PUT /admin/users/:id/password`). Re-hashes via Argon2id at the
  changeset boundary; auth sessions are NOT revoked because the
  bearer token IS the session row id (no derived-from-password
  material in the token), so existing sessions keep working.

  Operators that need to evict every active session call
  `revoke_sessions_for_user/1` alongside — the admin rotation endpoint
  (`PUT /admin/users/:id/password`) does exactly this (S8).
  """
  @spec update_password(User.t(), %{optional(:password) => String.t()}) ::
          {:ok, User.t()} | {:error, Ecto.Changeset.t()}
  def update_password(%User{} = user, attrs) when is_map(attrs) do
    user |> User.password_changeset(attrs) |> Repo.update()
  end

  @doc """
  Deletes `user` (admin-panel bucket 2 — `DELETE /admin/users/:id`).
  Refuses with `{:error, :last_admin}` when `user` is the sole admin
  (per A-4: same lockout class as demoting the last admin). Returns
  `{:error, :not_found}` for an unknown id.

  ## Cascade

  FK `ON DELETE CASCADE` on `sessions.user_id`, `messages.user_id`,
  and `network_credentials.user_id` (verified at the migrations):
  auth sessions, scrollback, and per-(user, network) credentials are
  removed atomically by SQLite alongside the user row.
  `messages.network_id` is `:restrict`, but the cascade fires on
  `user_id` first; the network row itself stays (shared infra).

  Live `Session.Server` processes attached to the user's credentials
  are NOT explicitly stopped here — the DynamicSupervisor's children
  will crash on the next mailbox call against an absent DB row and
  the `:transient` restart strategy will trip its init-gate
  (`subject_row_present?: false → :ignore`), draining the registry
  on its own. This is the same path `Visitors.delete_visitor/1`
  relies on for visitor teardown.
  """
  @spec delete_user(User.t()) :: :ok | {:error, :not_found | :last_admin}
  def delete_user(%User{id: id} = user) when is_binary(id) do
    case Repo.get(User, id) do
      nil ->
        {:error, :not_found}

      %User{} = current ->
        if current.is_admin and other_admins_count(id) == 0 do
          {:error, :last_admin}
        else
          {:ok, _} = Repo.delete(user)
          :ok
        end
    end
  end

  @doc """
  Creates a new bearer-token session for the given `subject`.

  `subject` is a tagged tuple — `{:user, user_id}` for an
  operator-managed account login, `{:visitor, visitor_id}` for an
  anonymous-IRC visitor session (cluster `visitor-auth` decisions
  Q-A / Q-C: a single `sessions` table with an XOR FK so the
  Authorization-bearer transport stays a single token namespace).

  `ip` and `user_agent` are recorded for audit; both may be `nil`
  (mix tasks bypass the HTTP surface and have neither). The optional
  `opts` keyword list accepts `client_id:` (the opaque device identifier
  extracted from `X-Grappa-Client-Id` by `GrappaWeb.Plugs.Authn`); when
  present it is stored on the row so `Grappa.Admission.check_capacity/1`
  can count per-(client, network) sessions. The returned `Session.t().id`
  IS the bearer token to hand back to the client.
  """
  @spec create_session(subject(), String.t() | nil, String.t() | nil, keyword()) ::
          {:ok, Session.t()} | {:error, Ecto.Changeset.t()}
  def create_session({:user, user_id}, ip, user_agent, opts) when is_binary(user_id) do
    do_create_session(%{user_id: user_id, ip: ip, user_agent: user_agent}, opts)
  end

  def create_session({:visitor, visitor_id}, ip, user_agent, opts) when is_binary(visitor_id) do
    do_create_session(%{visitor_id: visitor_id, ip: ip, user_agent: user_agent}, opts)
  end

  defp do_create_session(attrs, opts) do
    now = DateTime.utc_now()

    extra =
      case Keyword.get(opts, :client_id) do
        nil -> %{created_at: now, last_seen_at: now}
        client_id -> %{created_at: now, last_seen_at: now, client_id: client_id}
      end

    %Session{}
    |> Session.changeset(Map.merge(attrs, extra))
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
    Logger.info("session revoked", session_ref: session_handle(id), affected: affected)
    :ok
  end

  @doc """
  Bulk-revoke every non-revoked `Session` row tied to the given
  visitor. Used by `Grappa.Visitors.Login`'s case-2 (registered
  password match → preempt) and case-3 (anon token rotation) paths
  to invalidate every prior bearer for the visitor before issuing a
  fresh one.

  Idempotent — a subsequent call finds no candidate rows and updates
  zero. The affected count rides the audit log so a visitor with
  zero prior sessions stays distinguishable from one whose sessions
  were all already revoked.
  """
  @spec revoke_sessions_for_visitor(Ecto.UUID.t()) :: :ok
  def revoke_sessions_for_visitor(visitor_id) when is_binary(visitor_id) do
    query =
      from(s in Session, where: s.visitor_id == ^visitor_id and is_nil(s.revoked_at))

    {affected, _} = Repo.update_all(query, set: [revoked_at: DateTime.utc_now()])

    Logger.info(
      "visitor sessions revoked",
      visitor_id: visitor_id,
      affected: affected
    )

    :ok
  end

  @doc """
  Bulk-revoke every non-revoked `Session` row tied to the given user.
  Used by admin password rotation (`PUT /admin/users/:id/password`, S8):
  the bearer token IS the session-id (not derived from the password), so
  rotating a compromised account's password does NOT invalidate existing
  bearers on its own — revoking here restores the usual point of a forced
  reset (evict the attacker).

  Idempotent — a subsequent call finds no candidate rows and updates
  zero. The affected count rides the audit log so a user with zero prior
  sessions stays distinguishable from one whose sessions were all already
  revoked. Sibling of `revoke_sessions_for_visitor/1`.
  """
  @spec revoke_sessions_for_user(User.t()) :: :ok
  def revoke_sessions_for_user(%User{id: user_id}) do
    query = from(s in Session, where: s.user_id == ^user_id and is_nil(s.revoked_at))

    {affected, _} = Repo.update_all(query, set: [revoked_at: DateTime.utc_now()])

    Logger.info(
      "user sessions revoked",
      user_id: user_id,
      affected: affected
    )

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

  # B5.4 L-pers-3: route the sliding `last_seen_at` bump through
  # `Session.touch_changeset/2` so backward-clock skew is REJECTED at
  # the changeset boundary instead of silently moving the column
  # backward. The API contract returns a `Session.t()` (not
  # `{:ok, _} | {:error, _}`), so the error path is swallowed with a
  # `Logger.warning` — a backward clock is an operator-side
  # infrastructure problem the bouncer can't recover from inline; the
  # session continues with its previous `last_seen_at` (idle timer
  # keeps counting down from there) until the clock drift resolves.
  defp touch_session(session, now) do
    case session |> Session.touch_changeset(now) |> Repo.update() do
      {:ok, updated} ->
        updated

      {:error, _} ->
        Logger.warning("touch_session backward-clock detected; ignoring",
          session_ref: session_handle(session.id),
          reason: :backward_clock
        )

        session
    end
  end

  # S9: the bearer token IS the session-id (accounts/session.ex), so
  # logging the raw id emits a live credential into the log stream —
  # log-read access is broader than DB access, and this path fires for an
  # ACTIVE, non-revoked session (the backward-clock warning). A truncated
  # SHA-256 hex digest is a stable, non-reversible handle: it correlates
  # log lines for one session without ever exposing a usable token. 12
  # hex chars (48 bits) disambiguates concurrent sessions in a grep;
  # reversing it would mean brute-forcing the 122-bit UUID space.
  @spec session_handle(String.t()) :: String.t()
  defp session_handle(id) when is_binary(id) do
    digest = :crypto.hash(:sha256, id)
    binary_part(Base.encode16(digest, case: :lower), 0, 12)
  end
end
