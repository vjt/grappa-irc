defmodule Grappa.AuthFixtures do
  @moduledoc """
  Shared user + session fixtures for the controller / channel tests
  that now traverse the `:authn` pipeline.

  The plain `user_fixture/1` bypasses `Grappa.Accounts.create_user/1`
  and inserts a `%User{}` directly with a placeholder `password_hash`
  — the ~100 ms Argon2 cost is the dominant sqlite-contention
  contributor under the test suite (see `config/test.exs` busy_timeout
  comment + `test/test_helper.exs` `max_cases: 2` cap). Tests that
  exercise the real password-verification path call
  `user_fixture_with_password/1` instead.

  `session_fixture/1` mints a live `%Session{}` and returns it; the
  bearer token IS `session.id`. `put_bearer/2` is the conn helper that
  attaches the `Authorization: Bearer <token>` header.
  """
  use Boundary,
    top_level?: true,
    deps: [Grappa.Accounts, Grappa.Networks, Grappa.Repo, Grappa.Session]

  alias Grappa.{Accounts, Accounts.Session, Accounts.User, Networks, Repo}
  alias Grappa.Networks.{Credential, Network, Server, Servers}

  @doc """
  Inserts a `%User{}` directly with `password_hash: "x"` — does NOT
  hash a real password. Use this when the test only needs a user row
  to attach a session to.
  """
  @spec user_fixture(keyword()) :: User.t()
  def user_fixture(attrs \\ []) do
    name = Keyword.get(attrs, :name, "vjt-#{System.unique_integer([:positive])}")

    {:ok, user} =
      Repo.insert(%User{
        name: name,
        password_hash: "x"
      })

    user
  end

  @doc """
  Creates a `%User{}` via `Accounts.create_user/1` so the stored
  `password_hash` is a real Argon2 hash that
  `Accounts.get_user_by_credentials/2` can verify against. Slow
  (~100 ms) — reserve for tests that exercise the login path.
  """
  @spec user_fixture_with_password(keyword()) :: {User.t(), String.t()}
  def user_fixture_with_password(attrs \\ []) do
    name = Keyword.get(attrs, :name, "vjt-#{System.unique_integer([:positive])}")
    password = Keyword.get(attrs, :password, "correct-horse-battery-staple")
    {:ok, user} = Accounts.create_user(%{name: name, password: password})
    {user, password}
  end

  @doc """
  Mints a live session for `user`. `ip` and `user_agent` default to
  `nil` (mirrors the mix-task call shape).
  """
  @spec session_fixture(User.t()) :: Session.t()
  def session_fixture(%User{} = user) do
    {:ok, session} = Accounts.create_session(user.id, nil, nil)
    session
  end

  @doc "Attaches `Authorization: Bearer <token>` to `conn`."
  @spec put_bearer(Plug.Conn.t(), String.t()) :: Plug.Conn.t()
  def put_bearer(conn, token) do
    Plug.Conn.put_req_header(conn, "authorization", "Bearer " <> token)
  end

  @doc """
  Convenience: builds a user + session in one call and returns
  `{user, session}`. Use when the test needs both refs.
  """
  @spec user_and_session(keyword()) :: {User.t(), Session.t()}
  def user_and_session(attrs \\ []) do
    user = user_fixture(attrs)
    session = session_fixture(user)
    {user, session}
  end

  @doc """
  Total `sessions` row count. Used by login tests to assert the
  failure paths do NOT mint a session row, without leaking a raw
  `Repo.aggregate/3` call into the test body.

  This intentionally lives here (test-support) rather than as a
  public `Accounts` API: counting all sessions has no production
  use case — Phase 2j's revocation surface will list-by-user
  instead.
  """
  @spec session_count() :: non_neg_integer()
  def session_count, do: Repo.aggregate(Session, :count, :id)

  @doc """
  Builds a network row with one server endpoint. `slug` defaults to a
  unique generated value; `host` / `port` / `tls` describe the server
  the test's IRC fake is listening on.
  """
  @spec network_with_server(keyword()) :: {Network.t(), Server.t()}
  def network_with_server(attrs \\ []) do
    slug = Keyword.get(attrs, :slug, "test-#{System.unique_integer([:positive])}")
    host = Keyword.get(attrs, :host, "127.0.0.1")
    port = Keyword.fetch!(attrs, :port)
    tls = Keyword.get(attrs, :tls, false)

    {:ok, network} = Networks.find_or_create_network(%{slug: slug})
    {:ok, server} = Servers.add_server(network, %{host: host, port: port, tls: tls})
    {network, server}
  end

  @doc """
  Binds `user` to `network` with sensible defaults (auth_method `:none`,
  no password, autojoin `["#sniffo"]`). Override any field via `attrs`.
  Returns the credential with `password_encrypted` already round-tripped
  through Cloak.
  """
  @spec credential_fixture(User.t(), Network.t(), map()) :: Credential.t()
  def credential_fixture(%User{} = user, %Network{} = network, attrs \\ %{}) do
    base = %{
      nick: "grappa-test",
      auth_method: :none,
      autojoin_channels: ["#sniffo"]
    }

    {:ok, credential} = Networks.bind_credential(user, network, Map.merge(base, attrs))
    credential
  end

  @doc """
  Test convenience: resolve `(user, network)` into the
  `Session.start_opts/0` plan via `Networks.session_plan/1` and
  spawn a `Session.Server` under the singleton supervisor. Mirrors
  `Bootstrap`'s production spawn path so the test surface stays
  honest about what `Session.start_session/3` actually consumes —
  no test-only convenience that bypasses the plan resolution.

  Returns the spawned pid on success; raises with a useful tag if
  `session_plan/1` fails (`:no_server` / `:user_not_found` are
  test-setup bugs the test should fix, not silently absorb).
  """
  @spec start_session_for(User.t(), Network.t()) :: pid()
  def start_session_for(%User{} = user, %Network{} = network) do
    credential = Networks.get_credential!(user, network)
    {:ok, plan} = Networks.session_plan(credential)
    {:ok, pid} = Grappa.Session.start_session(user.id, network.id, plan)
    pid
  end
end
