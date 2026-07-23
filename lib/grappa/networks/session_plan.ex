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
  alias Grappa.{Accounts, Networks, Session}
  alias Grappa.Accounts.User
  alias Grappa.IRC.{Identifier, Identity}
  alias Grappa.Networks.{Credential, Credentials, Network, NoServerError, Server, Servers}
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
    base = base_plan({:user, user.id}, user.name, cred, network, server, cred.nick)

    Map.merge(base, %{
      # Opaque callback injected so Session.Server can transition the
      # credential to :failed on hard upstream errors (k-line, permanent
      # SASL) without a static Networks dependency from Session. Session
      # is already a dep of Networks — adding the reverse would create a
      # Boundary cycle. The closure captures the IDs; Session.Server
      # calls it inside a supervised Task (Task.Supervisor.start_child) so
      # the GenServer has already exited before mark_failed_by_ids calls
      # stop_session (which finds the session gone and is a no-op).
      credential_failer: fn reason ->
        Networks.mark_failed_by_ids(user.id, cred.network_id, reason)
      end,
      # #131 — optimistic SET PASSWD commit. User-side mirror of
      # `Visitors.SessionPlan`'s `visitor_committer`. Session.Server can't
      # statically alias `Grappa.Networks.Credentials` (Networks already
      # deps Session — the reverse closes a Boundary cycle), so the closure
      # captures (user_id, network_id) and forwards to
      # `Credentials.commit_password/3`. Invoked synchronously from the
      # outbound NickServ-secret capture choke point when a well-formed
      # in-session SET PASSWD leaves the wire (no `+r` fires to stage
      # against). Returns `{:ok, cred} | {:error, _}`; Session.Server logs
      # the outcome and never retries — #124 re-auth recovers a failed
      # commit on the next identify.
      credential_committer: fn password ->
        Credentials.commit_password(user.id, cred.network_id, password)
      end,
      # CP22 cluster B (channel-client-polish #14, B-restart) — opaque
      # closure that forwards `Map.keys(state.members)` snapshots to
      # the per-credential `last_joined_channels` column. Wraps the
      # (user_id, network_id) pair so Session.Server stays
      # boundary-clean (Networks deps Session, not the reverse).
      last_joined_persister: fn channels ->
        Credentials.update_last_joined_channels(user.id, cred.network_id, channels)
      end,
      # Re-resolve the plan from the DB on every `Session.Server.init/1`
      # invocation — both first boot AND `:transient` restart.
      # `DynamicSupervisor` caches the spawn-time child spec; without
      # this closure, `state.nick` / `state.autojoin` / credentials
      # freeze at the boot-time values even after the operator rotated
      # the credential row. Symmetric with the visitor-side
      # `Visitors.SessionPlan.refresh_plan` closure — same shape, same
      # `Server.init/1` `Map.merge(opts, plan)` reception.
      #
      # `{:error, :not_found}` subsumes the prior `subject_row_present?`
      # fail-fast (credential unbound between spawn and restart) AND
      # `resolve/1`'s `:no_server` / `:user_not_found` rescues: in all
      # cases the subject is no longer viable, so `Server.init/1`
      # returns `:ignore` and the supervisor drops the child
      # permanently. Operator re-spawns once the underlying config
      # is fixed.
      refresh_plan: fn ->
        case Credentials.get_credential_by_ids(user.id, cred.network_id) do
          {:ok, fresh_cred} ->
            case resolve(fresh_cred) do
              {:ok, _} = ok -> ok
              {:error, _} -> {:error, :not_found}
            end

          {:error, :not_found} = err ->
            err
        end
      end
    })
  end

  @doc """
  #211 phase 3 — the shared fields-only plan builder for BOTH subjects.

  Flattens the ~14 identity/connect fields that are **identical** for a
  user and a visitor credential (subject/label/network_slug/nick/ident/
  realname/sasl_user/auth_method/password/autojoin/host/port/tls/
  source_address) into the primitive opts map. Each subject's resolver
  merges its OWN subject-specific callbacks on top (user: 4; visitor: 6
  + the anon→IDENTIFY login dance) — those genuinely differ and live in
  different context modules, so they stay per-resolver.

  This is exactly the phase-2 ruling ("reuse the VERBS, not the nouns"):
  the shared verb is the field-flatten (identical bytes); the wiring is
  the per-subject callbacks. `realname_fallback` is a parameter (user →
  its own nick; visitor → `"Grappa Visitor"`, ruling E), one rule two
  call sites — the same shape phase 2 gave `Identity.effective_realname/2`.

  Public (exported from the `Grappa.Networks` boundary) so
  `Grappa.Visitors.SessionPlan` can build on it. Takes a `%Credential{}`
  for BOTH subjects — the visitor read-cutover means a visitor now
  resolves from its Credential too. Returns a plain map (no leaky
  struct ref) so the Session boundary stays Networks-independent.
  """
  @spec base_plan(
          Session.subject(),
          String.t(),
          Credential.t(),
          Network.t(),
          Server.t(),
          String.t()
        ) :: map()
  def base_plan(
        subject,
        subject_label,
        %Credential{} = cred,
        %Network{} = network,
        %Server{} = server,
        realname_fallback
      ) do
    %{
      subject: subject,
      subject_label: subject_label,
      network_slug: network.slug,
      nick: cred.nick,
      ident: Credential.effective_ident(cred),
      realname: Identity.effective_realname(cred.realname, realname_fallback),
      sasl_user: Credential.effective_sasl_user(cred),
      auth_method: cred.auth_method,
      password: Credential.upstream_password(cred),
      # CP22 cluster B (channel-client-polish #14, B-restart) — boot
      # channel list is the union of operator config + last-live snapshot.
      # `autojoin_channels` = "channels you ALWAYS want auto-joined no
      # matter what" (operator-bound at credential creation, never
      # changes).  `last_joined_channels` = "channels you were in last
      # time the session was alive" (Session.Server overwrites on every
      # self-JOIN/PART/KICK, so a restart rehydrates the live state).
      # Dedupe at the merge site; order preference: autojoin first
      # (operator intent stable), then snapshot extras (runtime growth).
      # For a visitor credential `autojoin_channels` is empty ('[]'), so
      # the merge is exactly the `last_joined` list the pre-cutover
      # visitor plan produced via `Visitors.list_autojoin_channels/1`.
      autojoin_channels: merge_autojoin(cred.autojoin_channels, cred.last_joined_channels),
      host: server.host,
      port: server.port,
      tls: server.tls,
      # #228 / #266 — resolve the source-bind through `effective_source/2`.
      # #266 inverts the precedence: an admin-configured per-network
      # `server.source_address` WINS (absolute bind), else the per-subject
      # vhost selection, else nil → the DB-driven rotation pool / kernel
      # default. The connect path in `Grappa.IRC.Client` is UNCHANGED — this
      # only chooses WHICH value it binds. Re-resolved on every
      # `Session.Server.init/1` via `refresh_plan`, so a live source/vhost
      # change takes effect on the next (re)connect.
      source_address: Grappa.Vhosts.effective_source(subject, server.source_address)
    }
  end

  # CP22 cluster B (channel-client-polish #14, B-restart) — merge
  # operator autojoin (stable) with last-live snapshot (runtime). Order:
  # operator entries first to preserve operator-intent join order; then
  # snapshot entries the operator didn't already cover. Dedupe folds via
  # `Identifier.canonical_channel/1` (rfc1459, #364) — NOT bare
  # `String.downcase`, which left `#foo[1]`/`#foo{1}` distinct and forked
  # the snapshot into a duplicate autojoin on bahamut. We preserve the
  # case of the EARLIER entry (operator wins on case style).
  @spec merge_autojoin([String.t()], [String.t()]) :: [String.t()]
  defp merge_autojoin(autojoin, last_joined) when is_list(autojoin) and is_list(last_joined) do
    seen =
      autojoin
      |> Enum.map(&Identifier.canonical_channel/1)
      |> MapSet.new()

    extras = Enum.reject(last_joined, &MapSet.member?(seen, Identifier.canonical_channel(&1)))
    autojoin ++ extras
  end

  @doc false
  # Test-only hook for the dedupe+order rule. Production callers go
  # through build_plan/4 which inlines the merge at the credential
  # boundary. Test surface kept narrow — the function is `@doc false`
  # so it doesn't appear in public docs and is greppable as a test-only
  # entry point.
  @spec __merge_autojoin_for_test__([String.t()], [String.t()]) :: [String.t()]
  def __merge_autojoin_for_test__(autojoin, last_joined),
    do: merge_autojoin(autojoin, last_joined)
end
