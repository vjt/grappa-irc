defmodule Grappa.Accounts do
  @moduledoc """
  Operator-managed user accounts + bearer-token auth sessions.

  Public surface:

    * users: `create_user/1`, `get_user_by_credentials/2`, `get_user!/1`,
      `get_user/1`, `get_user_by_name!/1`, `get_user_by_name/1`,
      `list_all_users/0`, `update_admin_flags/2`
    * sessions: `create_session/4`, `authenticate/1`, `revoke_session/1`
    * client tokens (#1196): `create_client_token/5`,
      `list_client_tokens/1`, `revoke_client_token/2`,
      `authenticate_client_token/5`

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

  ## Client tokens (GH #1196)

  A `:client`-kind session is the credential a headless client presents
  in place of the account password, so that arming TOTP or a passkey no
  longer locks that client out. It is the same row primitive with two
  deliberate departures, both keyed on `Session.kind`:

    * the sliding idle window does NOT apply (`check_idle/1` and
      `delete_expired_sessions/0` both exempt it) — a client that was
      offline a fortnight must come back to a working token, and
      revocation is the intended kill switch;
    * it carries a restricted scope, enforced at the web edge by
      `GrappaWeb.Plugs.RequireFullSession`, so it can read and send but
      cannot administer, re-credential, or re-mint.

  The third difference is which revoke sweep reaches it (GH #1284), and
  the line is WHO is at the door:

    * a sweep the account holder triggered, having just proven they hold
      the account — arming or disarming TOTP, changing passkey mode —
      spares them (`revoke_other_sessions_for_user!/2`). The point of the
      credential is to outlive a change to the account's factors; revoking
      it there made the documented order (mint, then arm) lock the client
      out at the moment the factor was confirmed;
    * a sweep nobody proved they hold the account to reach — operator
      recovery, admin password rotation — takes them
      (`revoke_sessions_for_user/1` and its `!` twin, no `kind` filter).

  A token's own kill switch is `revoke_client_token/2`.
  """
  use Boundary,
    top_level?: true,
    deps: [
      Grappa.Accounts.Revocations,
      Grappa.Ecto.Like,
      Grappa.EncryptedBinary,
      Grappa.Repo,
      Grappa.Visitors.Visitor
    ],
    exports: [User, Session, Wire, AdminWire, TOTP, TOTPRecoveryCode, Passkey, WebAuthn]

  import Ecto.Query

  alias Grappa.Accounts.{Passkey, RecoveryCodes, Revocations, Session, TOTP, TOTPRecoveryCode, User}
  alias Grappa.Ecto.Like
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
      %User{} = user ->
        with :ok <- verify_password(user, password), do: {:ok, user}

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
  #257 — user leg of the admin subject-search autocomplete. Returns up to
  `limit` users whose `name` contains `query` (case-insensitive), ordered
  by name.

  The pattern is LIKE-escaped via `Grappa.Ecto.Like` (an underscore is a
  legal account-name char and must match literally) with an explicit
  `ESCAPE '\\'` clause; both sides go through SQLite `lower()` so the
  case-fold is applied identically to the column and the pattern. A blank/
  whitespace `query` short-circuits to `[]` (no round-trip).
  """
  @spec search_users(String.t(), pos_integer()) :: [User.t()]
  def search_users(query, limit) when is_binary(query) and is_integer(limit) and limit > 0 do
    case String.trim(query) do
      "" ->
        []

      trimmed ->
        pattern = Like.contains(trimmed)

        User
        |> where([u], fragment("lower(?) LIKE lower(?) ESCAPE '\\'", u.name, ^pattern))
        |> order_by([u], asc: u.name)
        |> limit(^limit)
        |> Repo.all()
    end
  end

  @doc """
  Fetches a user by `name`. Raises `Ecto.NoResultsError` on miss.

  Used by the operator-side mix tasks where a typo in `--user`
  should fail loudly with a stack trace, not silently no-op.
  """
  @spec get_user_by_name!(String.t()) :: User.t()
  def get_user_by_name!(name) when is_binary(name), do: Repo.get_by!(User, name: name)

  @doc """
  Typed-nil sibling of `get_user_by_name!/1` — fetches a user by `name`,
  returning `nil` on a miss instead of raising (mirrors the
  `get_user!/1` ↔ `get_user/1` pair).

  Used by the #404 login dispatch (`GrappaWeb.AuthController`): when a
  bare login identifier classifies as an IRC nick, this decides whether
  it ALSO names an existing account (→ route to the account credential,
  never a silently-provisioned guest) or not (→ visitor path). Matches
  the case-sensitive `name`-key semantics of `get_user_by_credentials/2`
  so the two account lookups can never disagree on what "an account
  named X" is — account names are the account key, a distinct namespace
  from the ASCII-folded IRC nick.
  """
  @spec get_user_by_name(String.t()) :: User.t() | nil
  def get_user_by_name(name) when is_binary(name), do: Repo.get_by(User, name: name)

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
          # The CASCADE takes the `accounts_sessions` rows with the user row,
          # so the socket teardown has to be announced here: nothing
          # downstream can resolve `user_id` to a name once the row is gone.
          # `current.name` (the row just read) over `user.name` (the caller's
          # possibly-stale struct) — the id-topic is keyed by the DB truth.
          :ok = Revocations.announce({:user, current.name})
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
          {:ok, Session.t()} | {:error, Ecto.Changeset.t() | :db_unavailable}
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

    # #523 — ride out a transient SQLITE_BUSY on the session-token insert;
    # sustained saturation degrades to `{:error, :db_unavailable}` → a clean 503
    # (#518) at every auth door (login provision, account login, share-token
    # consume) instead of a 500 raise. The op is a single INSERT (subject-exists
    # read + insert), all-DB with NO token delivery inside — the bearer
    # (`Session.id`) is delivered by the CALLER after this returns, so a retried
    # insert is safe (no double-delivery / registration side-effect).
    Repo.BusyRetry.run(fn ->
      %Session{}
      |> Session.changeset(Map.merge(attrs, extra))
      |> validate_subject_exists()
      |> Repo.insert()
    end)
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

  # A device list a person reads, and a bound on a self-service writer.
  # Neither number is load-bearing on the security boundary; the cap is
  # here so an authenticated caller cannot grow the table without limit,
  # and so `Session.handle/1`'s 48 bits stay collision-free by orders of
  # magnitude within one account's live set.
  @max_client_tokens 20

  @doc """
  Mints a per-client token for `user` (GH #1196) — a `:client`-kind
  session row whose `:id` is the secret the client will present.

  The caller is responsible for the door: a client token may only be
  minted from a session that has already cleared the account's second
  factor, which `GrappaWeb.Plugs.RequireFullSession` enforces by
  refusing the minting route to a `:client` bearer. Any `:web` session
  reached its bearer through the full `/auth/login` ladder, so
  "already cleared the second factor" and "is not itself a client
  token" are the same statement.

  `label` is the human name of the device; it is validated (trimmed,
  1..64 chars, no control characters) at the changeset boundary.
  Refuses with `{:error, :client_token_cap_reached}` once the account
  holds `#{@max_client_tokens}` live tokens.

  The returned `Session.t().id` is the token, and this is the ONLY
  moment it is knowable — `list_client_tokens/1` renders
  `Session.handle/1` instead, so a later read cannot recover it.
  """
  @spec create_client_token(User.t(), String.t(), String.t() | nil, String.t() | nil, keyword()) ::
          {:ok, Session.t()}
          | {:error, Ecto.Changeset.t() | :client_token_cap_reached | :db_unavailable}
  def create_client_token(%User{id: user_id}, label, ip, user_agent, opts)
      when is_binary(user_id) and is_binary(label) do
    if Repo.aggregate(live_client_tokens_query(user_id), :count, :id) >= @max_client_tokens do
      {:error, :client_token_cap_reached}
    else
      do_create_session(
        %{user_id: user_id, ip: ip, user_agent: user_agent, kind: :client, label: label},
        opts
      )
    end
  end

  @doc """
  The account's live per-client tokens, oldest first.

  Returns the rows themselves so the caller keeps a domain type; the
  wire shape (`Grappa.Accounts.Wire.client_token_to_json/1`) is what
  drops the secret `:id` in favour of `Session.handle/1`.
  """
  @spec list_client_tokens(User.t()) :: [Session.t()]
  def list_client_tokens(%User{id: user_id}) when is_binary(user_id) do
    user_id
    |> live_client_tokens_query()
    |> order_by([s], asc: s.created_at)
    |> Repo.all()
  end

  @doc """
  Revokes the caller's client token named by its public `handle`
  (`Session.handle/1`), the one-way digest the device list publishes.

  Addressing the row by handle rather than by id is what lets a token be
  revoked without ever re-presenting the secret — and it is why the
  match runs in Elixir over the account's own live tokens (at most
  #{@max_client_tokens} rows) instead of as a SQL predicate: the digest
  is derived, never stored, so there is no column to compare against and
  nothing to drift out of sync with the id.

  Scoped to `user`'s own rows, so a handle belonging to another account
  is `{:error, :not_found}` and not a cross-account kill switch.
  """
  @spec revoke_client_token(User.t(), String.t()) ::
          :ok | {:error, :not_found | :db_unavailable}
  def revoke_client_token(%User{} = user, handle) when is_binary(handle) do
    case Enum.find(list_client_tokens(user), &(Session.handle(&1) == handle)) do
      nil -> {:error, :not_found}
      %Session{id: id} -> revoke_session(id)
    end
  end

  @doc """
  Resolves a per-client token presented in place of `name`'s password.

  Succeeds only for a live `:client`-kind row that belongs to the
  account named `name` — a `:web` bearer, a revoked token, and a token
  belonging to a different account all return `{:error, :no_match}`, so
  the caller falls through to the ordinary password ladder (and charges
  its throttle) exactly as if the value had been a wrong password.

  The account name is compared the ACCOUNT way — byte-equal, as
  `get_user_by_name/1` looks it up — not the ASCII nick fold: the login
  door already treats the account namespace as case-sensitive, and
  folding here would fork what "the account named X" means.

  On a match the row's `ip`, `user_agent`, `client_id` and
  `last_seen_at` are refreshed so the device list shows where the token
  was last used. That refresh is best-effort: it is audit, and a
  saturated writer must not deny a client whose credential is valid
  (the same posture, and the same log line, as `touch_session/2`).
  """
  @spec authenticate_client_token(
          String.t(),
          String.t(),
          String.t() | nil,
          String.t() | nil,
          keyword()
        ) :: {:ok, {User.t(), Session.t()}} | {:error, :no_match}
  def authenticate_client_token(name, token, ip, user_agent, opts)
      when is_binary(name) and is_binary(token) do
    with {:ok, _} <- Ecto.UUID.cast(token),
         %Session{kind: :client, revoked_at: nil, user_id: user_id} = session
         when is_binary(user_id) <- Repo.get(Session, token),
         %User{name: ^name} = user <- Repo.get(User, user_id) do
      {:ok, {user, record_client_token_use(session, ip, user_agent, opts)}}
    else
      _ -> {:error, :no_match}
    end
  end

  @spec live_client_tokens_query(Ecto.UUID.t()) :: Ecto.Query.t()
  defp live_client_tokens_query(user_id) do
    from(s in Session,
      where: s.user_id == ^user_id and s.kind == :client and is_nil(s.revoked_at)
    )
  end

  # The audit refresh behind `authenticate_client_token/5`. Rides the
  # monotonic guard in `Session.touch_changeset/2` for the same reason
  # `touch_session/2` does, and degrades the same way: the contract
  # returns a `Session.t()`, so a rejected write logs and the caller
  # continues with the row it already read.
  @spec record_client_token_use(Session.t(), String.t() | nil, String.t() | nil, keyword()) ::
          Session.t()
  defp record_client_token_use(%Session{} = session, ip, user_agent, opts) do
    changes = [ip: ip, user_agent: user_agent, client_id: Keyword.get(opts, :client_id)]

    changeset =
      session
      |> Session.touch_changeset(DateTime.utc_now())
      |> Ecto.Changeset.change(changes)

    case Repo.update(changeset) do
      {:ok, updated} ->
        updated

      {:error, _} ->
        Logger.warning("client token use not recorded; serving the token anyway",
          session_ref: Session.handle(session),
          reason: :touch_rejected
        )

        session
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
      A `:client`-kind row (#1196) is never `:expired`: the idle window
      does not govern a per-client token, revocation does.

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
  call with an unknown id — both land on `:ok` (no-op for the unknown id)
  so callers don't need to branch on existence. The affected-row count is
  logged so a typo'd revoke (zero matches) remains greppable in operator
  logs without changing the API contract.

  Rides out a transient SQLITE_BUSY via `Repo.BusyRetry` and degrades to
  `{:error, :db_unavailable}` on sustained saturation instead of the
  MatchError-crash a bare `:ok = <update_all>` raises. Every door that
  revokes a single session hits the DB at exactly the wrong moment: the
  #630 SEVER path (`GrappaWeb.RequestBudget.sever/3`) fires at PEAK write
  contention (a flood IS the load) and severs exactly ONCE at the
  crossing, so a crash there both skips the socket close AND permanently
  defeats enforcement for the window; `DELETE /auth/logout` and the
  `Plugs.Authn` co-terminus visitor cleanup are the same shape. A single
  idempotent UPDATE, so a retried statement is safe.

  ## The family contract (#636)

  Every revoke in this module is in exactly one of two roles, and the
  spelling says which:

    * **caller-facing** — `revoke_session/1`, `revoke_sessions_for_user/1`,
      `revoke_sessions_for_visitor/1`. Reached from a plug, a controller,
      or an operator verb with no enclosing retry, so each owns its own
      `Repo.BusyRetry` budget and returns `{:error, :db_unavailable}`.
    * **in-transaction** — the `!` variants
      (`revoke_other_sessions_for_user!/2` and the private
      `revoke_sessions_for_user!/1`). Reached only from inside a
      `Repo.BusyRetry.run(fn -> Repo.transaction(…) end)`, where the
      enclosing engine retries the WHOLE transaction. They deliberately do
      NOT retry: a nested retry would sleep while holding the open
      transaction's connection, extending the very contention it waits on,
      and would convert a raise the transaction needs into a return value.
      The bang is the contract — it raises, and its caller owns the budget.

  #636 collapsed the former `revoke_session_resilient/1` into this
  function. There is no fail-hard spelling left to copy by mistake.
  """
  @spec revoke_session(Ecto.UUID.t()) :: :ok | {:error, :db_unavailable}
  def revoke_session(id) when is_binary(id) do
    case Repo.BusyRetry.run(fn ->
           # Resolved BEFORE the UPDATE only because it must be resolved at
           # all: the announcement is keyed by the socket id-topic label, and
           # `revoke_session/1` is the one kill site that is handed an opaque
           # session id rather than the subject. Read-then-write is safe here
           # — a row deleted in between yields an announcement for a subject
           # whose sessions are dead anyway.
           subject = session_subject(id)
           {:ok, {subject, Repo.update_all(session_by_id_query(id), set: [revoked_at: DateTime.utc_now()])}}
         end) do
      {:ok, {subject, {affected, _}}} ->
        Logger.info("session revoked", session_ref: Session.handle(id), affected: affected)
        if subject, do: Revocations.announce(subject)
        :ok

      {:error, :db_unavailable} = err ->
        err
    end
  end

  @spec session_by_id_query(Ecto.UUID.t()) :: Ecto.Query.t()
  defp session_by_id_query(id), do: from(s in Session, where: s.id == ^id)

  # The session's owner, as the socket id-topic label parts. `nil` when the
  # row is gone — nothing to announce.
  #
  # The user branch selects `users.name` rather than `sessions.user_id`: the
  # socket is keyed by name (`Grappa.Subject.label/1`), and resolving the id
  # later would fail on exactly the paths that matter most, where the user
  # row is being deleted.
  @spec session_subject(Ecto.UUID.t()) :: Revocations.subject() | nil
  defp session_subject(id) do
    query =
      from(s in Session,
        left_join: u in User,
        on: u.id == s.user_id,
        where: s.id == ^id,
        select: {u.name, s.visitor_id}
      )

    case Repo.one(query) do
      {name, nil} when is_binary(name) -> {:user, name}
      {nil, visitor_id} when is_binary(visitor_id) -> {:visitor, visitor_id}
      _ -> nil
    end
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
  @spec revoke_sessions_for_visitor(Ecto.UUID.t()) :: :ok | {:error, :db_unavailable}
  def revoke_sessions_for_visitor(visitor_id) when is_binary(visitor_id) do
    query =
      from(s in Session, where: s.visitor_id == ^visitor_id and is_nil(s.revoked_at))

    # #523/#518 — ride out a transient SQLITE_BUSY on the bulk revoke; sustained
    # saturation degrades to {:error, :db_unavailable} → a clean 503 at the
    # /auth/login re-login door (preempt/rotate) instead of the MatchError-crash
    # the `:ok =` call sites would raise. A single idempotent UPDATE (a re-run
    # re-matches `is_nil(revoked_at)`, so the now-already-revoked rows set to
    # zero), so a retried statement is safe.
    case Repo.BusyRetry.run(fn ->
           {:ok, Repo.update_all(query, set: [revoked_at: DateTime.utc_now()])}
         end) do
      {:ok, {affected, _}} ->
        Logger.info(
          "visitor sessions revoked",
          visitor_id: visitor_id,
          affected: affected
        )

        # Unconditional, not gated on `affected > 0`: the UPDATE only matches
        # rows still `is_nil(revoked_at)`, so a subject whose row was already
        # revoked by an earlier door — while its socket stayed up — would
        # otherwise be announced zero times, forever.
        :ok = Revocations.announce({:visitor, visitor_id})

      {:error, :db_unavailable} = err ->
        err
    end
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

  Caller-facing, so it owns its `Repo.BusyRetry` budget and degrades to
  `{:error, :db_unavailable}` — see the family contract on
  `revoke_session/1`. The in-transaction users of the same UPDATE call
  `revoke_sessions_for_user!/1` instead.
  """
  @spec revoke_sessions_for_user(User.t()) :: :ok | {:error, :db_unavailable}
  def revoke_sessions_for_user(%User{} = user) do
    case Repo.BusyRetry.run(fn -> {:ok, revoke_sessions_for_user!(user)} end) do
      {:ok, :ok} -> :ok
      {:error, :db_unavailable} = err -> err
    end
  end

  # In-transaction twin of `revoke_sessions_for_user/1`: no retry of its
  # own, RAISES on SQLITE_BUSY so the raise aborts the enclosing
  # transaction and reaches the outer `Repo.BusyRetry`, which re-runs the
  # whole unit. See the family contract on `revoke_session/1`.
  @spec revoke_sessions_for_user!(User.t()) :: :ok
  defp revoke_sessions_for_user!(%User{id: user_id, name: name}) do
    query = from(s in Session, where: s.user_id == ^user_id and is_nil(s.revoked_at))

    {affected, _} = Repo.update_all(query, set: [revoked_at: DateTime.utc_now()])

    Logger.info(
      "user sessions revoked",
      user_id: user_id,
      affected: affected
    )

    # Announced from INSIDE the enclosing transaction — see the
    # over-firing-is-safe note on `Grappa.Accounts.Revocations`. A rollback
    # or a `Repo.BusyRetry` replay costs a reconnect blip; deferring to the
    # commit would put the call back at each call-site.
    :ok = Revocations.announce({:user, name})
  end

  @doc """
  Revokes every live WEB bearer for `user` except the current session.

  It does NOT revoke the account's `:client` tokens (GH #1284). Every
  caller here is a door the account holder has just proven they hold —
  arming TOTP, disarming it under password, changing passkey mode — and a
  client token is the credential #1196 exists to keep alive ACROSS such a
  change. Sweeping by `user_id` alone made the documented order (mint the
  token, then arm the factor) lock the client out at the moment the factor
  was confirmed, with a `401` the operator could not tell from a wrong
  password. The kill switch for a token is `revoke_client_token/2`, and
  operator recovery still burns everything through the whole-account
  `revoke_sessions_for_user!/1` — which is a different function, and
  deliberately carries no `kind` filter.

  In-transaction only — every caller (TOTP enrolment/disable, the passkey
  mode transaction) already runs inside a
  `Repo.BusyRetry.run(fn -> Repo.transaction(…) end)`, so this RAISES on
  SQLITE_BUSY rather than retrying: the raise is what aborts the
  transaction and hands the retry to the enclosing engine. See the family
  contract on `revoke_session/1`. A caller with no such enclosure wants a
  caller-facing revoke, not this one.
  """
  @spec revoke_other_sessions_for_user!(User.t(), Ecto.UUID.t()) :: :ok
  def revoke_other_sessions_for_user!(%User{id: user_id, name: name}, current_session_id)
      when is_binary(current_session_id) do
    # `!= :client` rather than `== :web`: a future third kind is swept until
    # someone rules otherwise, which is the fail-closed direction for a
    # revoke. Only `:client` has an argument for surviving, and it is above.
    query =
      from(s in Session,
        where:
          s.user_id == ^user_id and s.id != ^current_session_id and is_nil(s.revoked_at) and
            s.kind != :client
      )

    Repo.update_all(query, set: [revoked_at: DateTime.utc_now()])

    # The socket id-topic is keyed by SUBJECT, not by session, so this closes
    # the acting device's socket too even though its bearer survives. That
    # device reconnects on its own (`phoenix.js` retries a 1001 close) — the
    # cost is a blip, and per-session granularity is the open question
    # documented on `Grappa.Accounts.Revocations`.
    :ok = Revocations.announce({:user, name})
  end

  @doc "Atomically enables TOTP and revokes every other bearer session."
  @spec confirm_totp_enrollment(User.t(), Ecto.UUID.t(), String.t(), String.t(), integer()) ::
          {:ok, [String.t()]} | {:error, term()}
  def confirm_totp_enrollment(user, current_session_id, secret, code, unix_seconds) do
    Repo.BusyRetry.run(fn ->
      Repo.transaction(fn ->
        confirm_totp_transaction(user, current_session_id, secret, code, unix_seconds)
      end)
    end)
  end

  @doc """
  Checks a plaintext password against an account's stored hash.

  The ONE place a password is compared. Two callers need it for different
  reasons and both belong here: `get_user_by_credentials/2` at login, and
  every privileged mutation that re-asks "prove it is still you" — a bearer
  alone must never be enough to change how the account authenticates, since
  an enrolment, a mode switch or a credential deletion each outlives the
  token that requested it.

  Takes a `%User{}`, so it says nothing about accounts that do not exist;
  that timing oracle is `get_user_by_credentials/2`'s to close, with
  `Argon2.no_user_verify/0`.
  """
  @spec verify_password(User.t(), String.t()) :: :ok | {:error, :invalid_credentials}
  def verify_password(%User{} = user, password) when is_binary(password) do
    if Argon2.verify_pass(password, user.password_hash),
      do: :ok,
      else: {:error, :invalid_credentials}
  end

  @doc "Atomically disables TOTP and revokes every other bearer session."
  @spec disable_totp(User.t(), Ecto.UUID.t(), String.t()) ::
          {:ok, User.t()} | {:error, term()}
  def disable_totp(user, current_session_id, password) do
    with :ok <- verify_password(user, password) do
      run_disable_totp_transaction(user, current_session_id)
    end
  end

  @doc "Consumes one account recovery code for passwordless login."
  @spec consume_recovery_code(User.t(), String.t()) ::
          :ok | {:error, :invalid_recovery_code | :db_unavailable}
  def consume_recovery_code(%User{id: user_id}, code) when is_binary(code) do
    case Repo.BusyRetry.run(fn -> consume_recovery_code_once(user_id, code) end) do
      {:ok, :consumed} -> :ok
      {:error, _} = error -> error
    end
  end

  @doc """
  Spends one post-password second factor: the TOTP code when TOTP is armed,
  a recovery code otherwise.

  The recovery set is ONE account-level credential shared by every factor,
  so the door that spends it cannot be owned by TOTP. `TOTP.verify/3` speaks
  for the account only while `totp_enabled_at` is set and otherwise refuses
  the whole exchange — which stranded an account in passkey `second_factor`
  with TOTP disarmed, holding codes no door would read (#766). Its
  not-enabled answer is the branch condition here rather than a
  `TOTP.enabled?/1` pre-check: one read decides, so a disarm racing the
  redemption cannot land between the question and the answer.

  The oracle stays as opaque as `TOTP.verify/3`'s own: a wrong recovery code
  is `:invalid_two_factor`, indistinguishable from a wrong TOTP code.
  """
  @spec verify_second_factor(User.t(), String.t(), integer()) ::
          {:ok, :totp | :recovery}
          | {:error, :invalid_two_factor | :two_factor_replayed | :db_unavailable}
  def verify_second_factor(%User{} = user, code, unix_seconds)
      when is_binary(code) and is_integer(unix_seconds) do
    case TOTP.verify(user, code, unix_seconds) do
      {:error, :two_factor_not_enabled} -> spend_recovery_code(user, code)
      result -> result
    end
  end

  defp spend_recovery_code(user, code) do
    case consume_recovery_code(user, code) do
      :ok -> {:ok, :recovery}
      {:error, :invalid_recovery_code} -> {:error, :invalid_two_factor}
      {:error, :db_unavailable} = error -> error
    end
  end

  @doc "Whether the account still holds an unspent recovery code."
  @spec recovery_codes_armed?(User.t()) :: boolean()
  def recovery_codes_armed?(%User{id: user_id}), do: RecoveryCodes.armed?(user_id)

  @doc "Generates an unarmed recovery set for passwordless activation."
  @spec prepare_recovery_codes() :: [String.t()]
  def prepare_recovery_codes, do: RecoveryCodes.generate()

  @doc """
  Operator recovery: removes passkeys, passwordless mode, and live sessions.

  The recovery set is account-level and shared, so it goes only if nothing
  is left armed to redeem it — see `RecoveryCodes.drop_if_orphaned/1` and
  the `reset_totp/1` sibling.
  """
  @spec reset_passkeys(String.t()) :: {:ok, User.t()} | {:error, :not_found | :db_unavailable}
  def reset_passkeys(name) when is_binary(name) do
    case get_user_by_name(name) do
      nil ->
        {:error, :not_found}

      user ->
        run_passkey_reset(user)
    end
  end

  @doc """
  Operator recovery: disarms TOTP and revokes live sessions.

  The undo for an enrolment the account owner did not make. `reset_passkeys/1`
  deliberately does NOT cover this — it clears the passkey side and leaves
  `totp_secret_encrypted` armed, so before this existed an operator with shell
  access still could not restore password-only login.

  The recovery set is account-level and shared, so it survives exactly as
  long as some factor can still redeem it: it stays when passkey login is
  armed, and goes with the last factor standing. See
  `Grappa.Accounts.RecoveryCodes.drop_if_orphaned/1`.
  """
  @spec reset_totp(String.t()) :: {:ok, User.t()} | {:error, :not_found | :db_unavailable}
  def reset_totp(name) when is_binary(name) do
    case get_user_by_name(name) do
      nil ->
        {:error, :not_found}

      user ->
        run_totp_reset(user)
    end
  end

  defp run_totp_reset(user),
    do: Repo.BusyRetry.run(fn -> Repo.transaction(fn -> totp_reset_transaction(user) end) end)

  defp totp_reset_transaction(user) do
    user_query = from(u in User, where: u.id == ^user.id)

    {1, _} =
      Repo.update_all(
        user_query,
        set: [
          totp_secret_encrypted: nil,
          totp_enabled_at: nil,
          totp_last_used_step: nil,
          updated_at: DateTime.utc_now()
        ]
      )

    :ok = RecoveryCodes.drop_if_orphaned(user.id)
    :ok = revoke_sessions_for_user!(user)
    Repo.get!(User, user.id)
  end

  defp consume_recovery_code_once(user_id, code) do
    case RecoveryCodes.consume(user_id, code) do
      :ok -> {:ok, :consumed}
      {:error, _} = error -> error
    end
  end

  defp run_passkey_reset(user) do
    Repo.BusyRetry.run(fn -> Repo.transaction(fn -> reset_passkeys_transaction(user) end) end)
  end

  defp reset_passkeys_transaction(user) do
    Passkey |> where([p], p.user_id == ^user.id) |> Repo.delete_all()
    user |> User.passkey_mode_changeset(%{passkey_mode: :disabled}) |> Repo.update!()
    :ok = RecoveryCodes.drop_if_orphaned(user.id)
    :ok = revoke_sessions_for_user!(user)
    Repo.get!(User, user.id)
  end

  defp confirm_totp_transaction(user, current_session_id, secret, code, unix_seconds) do
    case TOTP.confirm_enrollment(user, secret, code, unix_seconds) do
      {:ok, recovery_codes} ->
        :ok = revoke_other_sessions_for_user!(user, current_session_id)
        recovery_codes

      {:error, reason} ->
        Repo.rollback(reason)
    end
  end

  defp run_disable_totp_transaction(user, current_session_id) do
    Repo.BusyRetry.run(fn ->
      Repo.transaction(fn -> disable_totp_transaction(user, current_session_id) end)
    end)
  end

  defp disable_totp_transaction(user, current_session_id) do
    now = DateTime.utc_now()
    user_query = from(u in User, where: u.id == ^user.id)

    {1, _} =
      Repo.update_all(
        user_query,
        set: [
          totp_secret_encrypted: nil,
          totp_enabled_at: nil,
          totp_last_used_step: nil,
          updated_at: now
        ]
      )

    recovery_query = from(r in TOTPRecoveryCode, where: r.user_id == ^user.id)
    Repo.delete_all(recovery_query)
    :ok = revoke_other_sessions_for_user!(user, current_session_id)
    Repo.get!(User, user.id)
  end

  @doc """
  Physically deletes every USER session whose `last_seen_at` is older
  than the idle window (`@idle_timeout_seconds`, 7d) — the #223
  housekeeping GC that bounds unbounded `sessions` growth.

  This materializes in the DB the exact policy `authenticate/1` already
  enforces at read-time: a row idle past the window returns
  `{:error, :expired}` and can never authenticate again (every auth path
  — REST `Plugs.Authn`, WS `UserSocket`, `Visitors.Login` — routes
  through `authenticate/1`). Deleting such a row therefore removes only
  material that is already un-reusable; the threshold reuses the SAME
  `@idle_timeout_seconds` so the GC and the auth gate can never drift.

  `revoked_at` is NOT part of the predicate: a revoked row is dead
  regardless, and `last_seen_at` is the single liveness signal (bumped
  on every use, cadence-capped at 60s). Any use would refresh it out of
  the window, so a stale timestamp is proof-of-non-use.

  Scoped to `kind == :web` for the same drift-proofing reason it reuses
  `@idle_timeout_seconds`: `authenticate/1` exempts a `:client` row from
  the idle window (#1196), so sweeping one here would delete a
  credential that is still perfectly able to authenticate — the GC and
  the auth gate must agree on which rows the window governs, not just on
  how wide it is.

  Scoped to `user_id IS NOT NULL` on purpose. Visitor sessions are NOT
  swept here — a visitor's `sessions` rows are removed by
  `Grappa.Visitors.Reaper` via the `sessions.visitor_id ON DELETE
  CASCADE` FK when the visitor row itself expires. Sweeping them here
  would double-own the visitor lifecycle across two domains.

  Idempotent — a second call finds no candidate rows and deletes zero.
  Returns `{:ok, count}` with the number of rows removed; the count
  rides the audit log so a no-op sweep stays distinguishable from a
  productive one.
  """
  @spec delete_expired_sessions() :: {:ok, non_neg_integer()} | {:error, :db_unavailable}
  def delete_expired_sessions do
    cutoff = DateTime.add(DateTime.utc_now(), -@idle_timeout_seconds, :second)

    query =
      from(s in Session,
        where: not is_nil(s.user_id) and s.kind == :web and s.last_seen_at < ^cutoff
      )

    # #590 — this is a BACKGROUND writer (the #223 idle-session reaper is the
    # only caller). Ride out a transient SQLITE_BUSY on the bulk delete via
    # the shared engine, and on sustained saturation degrade to
    # `{:error, :db_unavailable}` rather than letting the raise escape and
    # crash the reaper GenServer. Uniform with every other background-writer
    # context fn: the atom is returned here, the reaper (`Accounts.Reaper`)
    # owns the best-effort-DROP terminal — NO 503 (no web caller). Wrap the
    # `delete_all` in an `{:ok, _}` so it honours the `BusyRetry.run/1`
    # contract.
    case Repo.BusyRetry.run(fn -> {:ok, {expired_user_names(query), Repo.delete_all(query)}} end) do
      {:ok, {names, {deleted, _}}} ->
        # Suppressed on count=0: the reaper calls this every 60s, so an
        # unconditional line would flood the log with 1440 idle "reaped 0"
        # entries/day. A productive sweep logs once so the lifecycle stays
        # greppable — same suppression the sibling reapers use for their
        # AdminEvents summary. (CLAUDE.md log-honesty: the line states what
        # was observed — N rows past the idle window — not merely "ran".)
        if deleted > 0, do: Logger.info("expired sessions reaped", affected: deleted)

        Enum.each(names, &Revocations.announce({:user, &1}))

        {:ok, deleted}

      {:error, :db_unavailable} = err ->
        err
    end
  end

  # The distinct owners of the rows `delete_expired_sessions/0` is about to
  # remove, as socket id-topic labels. Read BEFORE the DELETE: the user rows
  # survive the sweep, but the sessions that name them do not, so afterwards
  # there is nothing left to join.
  #
  # A second statement on a 60s timer whose usual result is the empty list.
  # `delete_all(returning: …)` would avoid it, but the sweep is the reaper's
  # whole tick — there is no hot path to protect here.
  @spec expired_user_names(Ecto.Query.t()) :: [String.t()]
  defp expired_user_names(query) do
    query
    |> join(:inner, [s], u in User, on: u.id == s.user_id)
    |> distinct(true)
    |> select([_s, u], u.name)
    |> Repo.all()
  end

  # #1196 — a client token does not age out. The whole failure this
  # feature exists to remove is an unattended client coming back after a
  # long silence to a credential that died while it was away, so the
  # idle window is not merely lengthened here, it does not apply. The
  # `last_seen_at` bump still runs: it is what makes the device list
  # honest about which tokens are actually in use, and it is the signal
  # an operator reads before revoking one.
  defp check_idle(%Session{kind: :client} = session) do
    now = DateTime.utc_now()

    if DateTime.diff(now, session.last_seen_at, :second) > @last_seen_bump_threshold_seconds do
      {:ok, touch_session(session, now)}
    else
      {:ok, session}
    end
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
          session_ref: Session.handle(session),
          reason: :backward_clock
        )

        session
    end
  end
end
