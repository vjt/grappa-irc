defmodule Grappa.Networks do
  @moduledoc """
  Operator-managed IRC network bindings.

  Networks + servers are shared per-deployment infra (one Azzurra row,
  many users bind it). Credentials are per-(user, network) and carry
  the Cloak-encrypted upstream password. Public surface:

    * networks (this module): `find_or_create_network/1`,
      `get_network_by_slug/1`, `get_network!/1`,
      `list_users_for_network/1`
    * servers (`Grappa.Networks.Servers`): `add_server/2`,
      `list_servers/1`, `pick_server!/1`, `remove_server/3`
    * credentials: `bind_credential/3`, `update_credential!/3`,
      `get_credential!/2`, `unbind_credential/2`,
      `list_credentials_for_user/1`, `list_credentials_for_all_users/0`

  ## Cascade-on-empty

  The credential → network FK is `:restrict`. `unbind_credential/2`
  removes the credential row and, if no other user still references the
  network, also attempts to delete the network + servers. This is the
  only delete-cascade path — there is no "delete this network and orphan
  every credential" operation by design.

  Scrollback messages are archival: `messages.network_id` FK is
  `:restrict` (S29 C2 fix — `priv/repo/migrations/20260426000004*`),
  so the cascade-on-empty path is gated by a scrollback-presence
  check. If the last user has scrollback rows on the network,
  `unbind_credential/2` returns `{:error, :scrollback_present}` and
  the transaction rolls back — credential AND network stay. The
  operator deletes the archival rows explicitly via
  `mix grappa.delete_scrollback --network <slug>` (Phase 5) and then
  re-runs `unbind_credential/2`.

  ## Encrypted password

  `bind_credential/3` writes the plaintext `password` field through
  `Grappa.Networks.Credential`'s changeset, which copies it into the
  `password_encrypted` Cloak column. `get_credential!/2` returns the
  Credential with the column already decrypted by the Ecto type — the
  plaintext lives only in the `:password_encrypted` field after load
  (the virtual `:password` field is input-only and stays nil).
  """
  use Boundary,
    top_level?: true,
    deps: [
      Grappa.Accounts,
      Grappa.EncryptedBinary,
      Grappa.IRC,
      Grappa.Repo,
      Grappa.Scrollback,
      Grappa.Session,
      Grappa.Vault
    ],
    exports: [Network, NoServerError, Server, Credential, Servers, Wire]

  import Ecto.Query

  alias Grappa.{Accounts, Scrollback, Session}
  alias Grappa.Accounts.User
  alias Grappa.Networks.{Credential, Network, NoServerError, Server, Servers}
  alias Grappa.Repo

  @doc """
  Idempotently fetches-or-creates a network by slug. Concurrent
  callers race on the unique index — the loser retries the
  `Repo.get_by/2` once and returns the just-inserted row. Genuine
  validation failures (bad slug) still return `{:error, changeset}`.

  The retry lives here, not at every call site, so callers can do the
  one-armed `{:ok, network} = ...` match without each one re-deriving
  the race-handling rule.
  """
  @spec find_or_create_network(%{required(:slug) => String.t()}) ::
          {:ok, Network.t()} | {:error, Ecto.Changeset.t()}
  def find_or_create_network(%{slug: slug} = attrs) when is_binary(slug) do
    case Repo.get_by(Network, slug: slug) do
      %Network{} = net -> {:ok, net}
      nil -> insert_or_recover(attrs, slug)
    end
  end

  # Insert; on changeset error, look once more — if the row is now
  # there, we lost the race and the unique-index violation isn't a
  # validation failure. If it still isn't there, the changeset really
  # is invalid (bad slug, etc.) — surface it.
  defp insert_or_recover(attrs, slug) do
    case %Network{} |> Network.changeset(attrs) |> Repo.insert() do
      {:ok, net} ->
        {:ok, net}

      {:error, %Ecto.Changeset{} = cs} ->
        case Repo.get_by(Network, slug: slug) do
          %Network{} = net -> {:ok, net}
          nil -> {:error, cs}
        end
    end
  end

  @doc """
  Fetches a network by slug or returns `{:error, :not_found}`. The
  REST surface uses this to translate the URL `:network_id` slug into
  the integer FK that Scrollback rows are keyed on; the operator-side
  mix tasks use `Repo.get_by!/2` directly because a typo there should
  fail loudly.
  """
  @spec get_network_by_slug(String.t()) :: {:ok, Network.t()} | {:error, :not_found}
  def get_network_by_slug(slug) when is_binary(slug) do
    case Repo.get_by(Network, slug: slug) do
      %Network{} = net -> {:ok, net}
      nil -> {:error, :not_found}
    end
  end

  @doc """
  Like `get_network_by_slug/1` but raises `Ecto.NoResultsError` when
  the slug isn't bound. The operator-side mix tasks
  (`grappa.add_server`, `grappa.remove_server`,
  `grappa.unbind_network`, `grappa.update_network_credential`) want
  loud failure on a typo; this function lets them go through the
  Networks boundary instead of `Repo.get_by!(Network, slug: ...)` —
  Networks owns slug lookup semantics so future evolutions
  (case-insensitive, soft-delete filter, telemetry) stay
  single-sourced.
  """
  @spec get_network_by_slug!(String.t()) :: Network.t()
  def get_network_by_slug!(slug) when is_binary(slug),
    do: Repo.get_by!(Network, slug: slug)

  @doc """
  Fetches a network by integer id. Raises `Ecto.NoResultsError` on miss.

  Used by callers that already hold a network id (from URL params,
  Bootstrap loops, etc.) and want to crash loudly on a stale FK.
  `Grappa.Networks.session_plan/1` doesn't go through this — it
  preloads servers off the credential's `:network` association
  directly.
  """
  @spec get_network!(integer()) :: Network.t()
  def get_network!(id) when is_integer(id), do: Repo.get!(Network, id)

  @doc """
  Binds `user` to `network` with the given attrs. Validation rules
  live in `Credential.changeset/2`; the plaintext `:password` (when
  given) is encrypted into `:password_encrypted` before insert.
  """
  @spec bind_credential(User.t(), Network.t(), map()) ::
          {:ok, Credential.t()} | {:error, Ecto.Changeset.t()}
  def bind_credential(%User{id: user_id}, %Network{id: network_id}, attrs) when is_map(attrs) do
    attrs =
      attrs
      |> Map.put(:user_id, user_id)
      |> Map.put(:network_id, network_id)

    %Credential{}
    |> Credential.changeset(attrs)
    |> Repo.insert()
  end

  @doc """
  Updates the credential bound to `(user, network)`. Same validation
  + encryption pipeline as `bind_credential/3`. Raises
  `Ecto.NoResultsError` if the binding doesn't exist (the `!` suffix)
  — callers should unbind+rebind, not update, when reassigning a
  network. The mix-task callsite is `mix grappa.update_network_credential`,
  which surfaces the raise as a non-zero exit; programmatic callers
  should call `get_credential!/2` themselves first if they need a
  pre-flight existence check.
  """
  @spec update_credential!(User.t(), Network.t(), map()) ::
          {:ok, Credential.t()} | {:error, Ecto.Changeset.t()}
  def update_credential!(%User{} = user, %Network{} = network, attrs) when is_map(attrs) do
    user
    |> get_credential!(network)
    |> Credential.changeset(attrs)
    |> Repo.update()
  end

  @doc """
  Returns the credential for `(user, network)` with `password_encrypted`
  already decrypted by Cloak. Raises `Ecto.NoResultsError` on miss —
  the operator-side mix tasks expect a missing binding to fail loudly.
  """
  @spec get_credential!(User.t(), Network.t()) :: Credential.t()
  def get_credential!(%User{id: user_id}, %Network{id: network_id}) do
    Repo.one!(credential_query(user_id, network_id))
  end

  @doc """
  Tagged-tuple sibling of `get_credential!/2` for the REST surface.
  Returns `{:error, :not_found}` when the (user, network) binding
  doesn't exist — used by Phase 3 cicchetto endpoints where a missing
  credential is a per-user iso check (the user is asking about a
  network they don't have access to), not an operator typo.
  """
  @spec get_credential(User.t(), Network.t()) ::
          {:ok, Credential.t()} | {:error, :not_found}
  def get_credential(%User{id: user_id}, %Network{id: network_id}) do
    case Repo.one(credential_query(user_id, network_id)) do
      %Credential{} = c -> {:ok, c}
      nil -> {:error, :not_found}
    end
  end

  defp credential_query(user_id, network_id) do
    from(c in Credential,
      where: c.user_id == ^user_id and c.network_id == ^network_id
    )
  end

  @doc """
  Unbinds `user` from `network`. If no other user has a credential
  on the network after the delete, also deletes the network row +
  cascades to its servers (via the FK `:delete_all` from
  `network_servers`). Idempotent: a non-existent binding still returns
  `:ok`.

  Returns `{:error, :scrollback_present}` if the cascade-on-empty path
  would orphan archival messages — the `messages.network_id` FK is
  `:restrict` (S29 C2 fix) so the operator must explicitly delete the
  scrollback before the network can be torn down. Transaction is
  rolled back on that path: credential AND network stay.
  """
  @spec unbind_credential(User.t(), Network.t()) :: :ok | {:error, :scrollback_present}
  def unbind_credential(%User{id: user_id}, %Network{id: network_id}) do
    # S29 H5: tear down the running Session.Server BEFORE the DB
    # transaction commits. Otherwise the GenServer's cached
    # `state.network_id` outlives the FK row; the next outbound
    # PRIVMSG crashes the call handler and the `:transient` restart
    # loops forever (init re-reads the now-absent credential).
    # Idempotent — :ok if no session was running for the key.
    #
    # A2 cycle inversion (Cluster 2): pre-inversion this called an
    # inlined `stop_session_for_unbind/2` that replicated the
    # registry-key tuple to dodge the Networks↔Session Boundary
    # cycle. Now that `Session.Server.init/1` is a pure data
    # consumer, Session no longer deps Networks → the
    # `Networks → Session` edge is legal and we go through the
    # canonical facade.
    :ok = Session.stop_session(user_id, network_id)

    # Wrap in a transaction so the credential delete + the
    # last-binding check + the network delete are atomic. Without it,
    # a concurrent `bind_credential/3` between the check and the
    # network delete would either get its just-inserted row blown
    # away by the cascade OR trip the `:restrict` FK and abort. sqlite
    # is single-writer so the transaction cost is negligible.
    result =
      Repo.transaction(fn ->
        cred_query =
          from(c in Credential,
            where: c.user_id == ^user_id and c.network_id == ^network_id
          )

        {_, _} = Repo.delete_all(cred_query)

        if list_users_for_network(%Network{id: network_id}) == [] do
          maybe_cascade_network(network_id)
        end
      end)

    case result do
      {:ok, _} -> :ok
      {:error, :scrollback_present} -> {:error, :scrollback_present}
    end
  end

  # Runs inside the unbind transaction. Either deletes the parent
  # network row or rolls back the whole transaction (credential delete
  # included). Partial state — credential gone but network kept —
  # would leave a "ghost network" the operator can't even unbind
  # cleanly afterwards.
  defp maybe_cascade_network(network_id) do
    if Scrollback.has_messages_for_network?(network_id) do
      Repo.rollback(:scrollback_present)
    else
      net_query = from(n in Network, where: n.id == ^network_id)
      Repo.delete_all(net_query)
    end
  end

  @doc """
  Returns every credential bound to `user`, with networks preloaded
  for display.
  """
  @spec list_credentials_for_user(User.t()) :: [Credential.t()]
  def list_credentials_for_user(%User{id: user_id}) do
    query =
      from(c in Credential,
        where: c.user_id == ^user_id,
        preload: [:network]
      )

    Repo.all(query)
  end

  @doc """
  Returns every credential across every user, with `:network` preloaded.

  Used by `Grappa.Bootstrap` to spawn one `Grappa.Session.Server` per
  bound (user, network) at boot. Sub-task 2j swapped the boot path
  from a TOML-driven config into this DB-driven query so that
  operators using `mix grappa.bind_network` can take effect on the
  next deploy without editing a file.

  Ordered by `(inserted_at, user_id, network_id)` so the per-credential
  log lines from Bootstrap are deterministic across reboots — handy
  when triaging "this network failed to start, how far did boot get".
  """
  @spec list_credentials_for_all_users() :: [Credential.t()]
  def list_credentials_for_all_users do
    query =
      from(c in Credential,
        order_by: [asc: c.inserted_at, asc: c.user_id, asc: c.network_id],
        preload: [:network]
      )

    Repo.all(query)
  end

  @doc """
  Returns the user_ids that currently have a credential on `network`.
  Used by `unbind_credential/2` to decide whether to cascade-delete
  the parent network row when the last binding is removed.
  """
  @spec list_users_for_network(Network.t()) :: [Ecto.UUID.t()]
  def list_users_for_network(%Network{id: network_id}) do
    query =
      from(c in Credential,
        where: c.network_id == ^network_id,
        select: c.user_id
      )

    Repo.all(query)
  end

  @doc """
  Resolves a credential into the fully-flat opts map that
  `Grappa.Session.start_session/3` consumes. The map carries only
  primitive fields (no `Credential` / `Network` / `Server` / `User`
  struct refs) so the Session boundary stays Networks-independent —
  the whole point of the A2 cycle inversion.

  Reads from `Accounts` for the user name, picks the lowest-priority
  enabled server via `Grappa.Networks.Servers.pick_server!/1`, and copies the
  Cloak-decrypted upstream password into the plan. The result is
  whatever `Session.Server.init/1` needs to start an `IRC.Client`
  without any further DB lookup.

  Errors surface as tagged tuples instead of exceptions because
  Bootstrap's spawn loop is `Enum.reduce` — a raise from any single
  credential would abort the whole reduce, leaving every subsequent
  credential un-spawned. Translating at this boundary gives
  Bootstrap a `{:ok, plan} | {:error, reason}` shape to drive its
  per-credential `failed` counter without needing its own
  try/rescue around each iteration.

  Two reachable error tags:

    * `{:error, :no_server}` — `Servers.pick_server!/1` raised; the network
      has zero enabled endpoints. Operator action:
      `mix grappa.add_server`.
    * `{:error, :user_not_found}` — `Accounts.get_user!/1` raised;
      the FK from `network_credentials.user_id` to `users.id` makes
      this unrepresentable in normal operation. The catch survives
      a hand-edited DB or a not-yet-imagined future code path that
      could orphan a credential. Bounded scope: the rescue ONLY
      catches `Ecto.NoResultsError`, NOT generic `Exception`, so a
      future bug that adds a `Repo.get!/2` here for an UNRELATED
      lookup will still crash loudly (different from rescuing
      `_`). If we ever add a second `Repo.get!/2` whose miss is a
      legitimate caller-handles condition, that's the moment to
      refactor — not now.
  """
  @spec session_plan(Credential.t()) ::
          {:ok, Session.start_opts()} | {:error, :no_server | :user_not_found}
  def session_plan(%Credential{} = credential) do
    # Caller may pass a credential straight from
    # `list_credentials_for_all_users/0` (network preloaded already)
    # or one fresh from `get_credential!/2` (assoc not loaded). Both
    # paths are valid — `Repo.preload` is a no-op on already-loaded
    # assocs, so no extra query for the Bootstrap path.
    credential = Repo.preload(credential, network: :servers)
    user = Accounts.get_user!(credential.user_id)
    server = Servers.pick_server!(credential.network)

    {:ok, build_plan(user, credential.network, credential, server)}
  rescue
    NoServerError -> {:error, :no_server}
    Ecto.NoResultsError -> {:error, :user_not_found}
  end

  @spec build_plan(User.t(), Network.t(), Credential.t(), Server.t()) :: Session.start_opts()
  defp build_plan(%User{} = user, %Network{} = network, %Credential{} = cred, %Server{} = server) do
    %{
      user_name: user.name,
      network_slug: network.slug,
      nick: cred.nick,
      realname: Credential.effective_realname(cred),
      sasl_user: Credential.effective_sasl_user(cred),
      auth_method: cred.auth_method,
      password: Credential.upstream_password(cred),
      autojoin_channels: cred.autojoin_channels,
      host: server.host,
      port: server.port,
      tls: server.tls
    }
  end
end
