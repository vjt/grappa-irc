defmodule Grappa.Networks.SessionPlan do
  @moduledoc """
  Pure resolver: credential → primitive `t:Grappa.Session.start_opts/0`.

  Reads from `Accounts` for the user name, picks the lowest-priority
  enabled server via `Grappa.Networks.Servers.pick_server!/1`, and
  copies the Cloak-decrypted upstream password into the resulting
  primitive opts map. The output carries no `Credential` / `Network` /
  `Server` / `User` struct refs, so the Session boundary stays
  Networks-independent — the whole point of the A2 cycle inversion
  this module preserves.

  Extracted from `Grappa.Networks` in the D1 god-context split (step
  3 of the A2 cluster). The umbrella context is now just slug CRUD; the
  resolver lives separately so its single responsibility — flatten a
  credential into the upstream-connect data — is the only thing in this
  module.
  """
  alias Grappa.{Accounts, Session}
  alias Grappa.Accounts.User
  alias Grappa.Networks.{Credential, Network, NoServerError, Server, Servers}
  alias Grappa.Repo

  @doc """
  Resolves `credential` into the fully-flat opts map that
  `Grappa.Session.start_session/3` consumes.

  Errors surface as tagged tuples instead of exceptions because
  Bootstrap's spawn loop is `Enum.reduce` — a raise from any single
  credential would abort the whole reduce, leaving every subsequent
  credential un-spawned. Translating at this boundary gives Bootstrap
  a `{:ok, plan} | {:error, reason}` shape to drive its per-credential
  `failed` counter without needing its own try/rescue around each
  iteration.

  Two reachable error tags:

    * `{:error, :no_server}` — `Servers.pick_server!/1` raised; the
      network has zero enabled endpoints. Operator action:
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
  @spec resolve(Credential.t()) ::
          {:ok, Session.start_opts()} | {:error, :no_server | :user_not_found}
  def resolve(%Credential{} = credential) do
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
      subject: {:user, user.id},
      subject_label: user.name,
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
