defmodule Grappa.Networks do
  @moduledoc """
  Operator-managed IRC network bindings.

  Networks + servers are shared per-deployment infra (one Azzurra row,
  many users bind it). Credentials are per-(user, network) and carry
  the Cloak-encrypted upstream password. Public surface:

    * networks (this module): `find_or_create_network/1`,
      `get_network_by_slug/1`, `get_network!/1`
    * servers (`Grappa.Networks.Servers`): `add_server/2`,
      `list_servers/1`, `pick_server!/1`, `remove_server/3`
    * credentials (`Grappa.Networks.Credentials`): `bind_credential/3`,
      `update_credential!/3`, `get_credential!/2`, `get_credential/2`,
      `unbind_credential/2` (cascade-on-empty),
      `list_credentials_for_user/1`, `list_credentials_for_all_users/0`,
      `list_users_for_network/1`
    * session-plan resolver: `session_plan/1` (this module — flattens a
      credential into the primitive opts map `Grappa.Session.start_session/3`
      consumes).
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
    exports: [Network, NoServerError, Server, Credential, Credentials, Servers, Wire]

  alias Grappa.{Accounts, Session}
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
    # `Credentials.list_credentials_for_all_users/0` (network preloaded
    # already) or one fresh from `Credentials.get_credential!/2` (assoc
    # not loaded). Both paths are valid — `Repo.preload` is a no-op on
    # already-loaded assocs, so no extra query for the Bootstrap path.
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
