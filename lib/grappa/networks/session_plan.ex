defmodule Grappa.Networks.SessionPlan do
  @moduledoc """
  Pure resolver: credential → primitive `t:Grappa.Session.start_opts/0`.

  Reads from `Accounts` for the user name, picks the lowest-priority
  enabled server via `Grappa.Networks.Servers.pick_server!/2`, and
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
  alias Grappa.Session.Backoff

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

    * `{:error, :no_server}` — `Servers.pick_server!/2` raised; the
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
  def resolve(%Credential{} = credential), do: resolve_attempt(credential, 0)

  # #93 — the ring-aware resolver behind `resolve/1`. `attempt` is the
  # connect-attempt ordinal `Servers.pick_server!/2` indexes the enabled
  # endpoint ring with.
  #
  # `resolve/1` pins it to 0 and that is not a default argument in
  # disguise: its callers are the SPAWN doors (Bootstrap, the `/connect`
  # verb via `SpawnOrchestrator`, `Operator`), which mean "start this
  # session now" and clear the failure ladder before spawning. Starting
  # them anywhere but the preferred endpoint would be wrong, and reading
  # the counter there would additionally race — `Backoff.reset/2` is a
  # cast, so a resolve immediately after it can still observe the old
  # count. The RESPAWN door (`refresh_plan` below) is the one that walks
  # the ring, and it runs at the only moment the counter is authoritative:
  # `Backoff.record_failure/2` is a synchronous call from the dying
  # session's `terminate/2`, so the bump has landed before the supervisor's
  # restart reaches `Session.Server.init/1`.
  @spec resolve_attempt(Credential.t(), non_neg_integer()) ::
          {:ok, Session.start_opts()} | {:error, :no_server | :user_not_found}
  defp resolve_attempt(%Credential{} = credential, attempt) do
    # Caller may pass a credential straight from
    # `Credentials.list_credentials_for_all_users/0` (network preloaded
    # already) or one fresh from `Credentials.get_credential!/2` (assoc
    # not loaded). Both paths are valid — `Repo.preload` is a no-op on
    # already-loaded assocs, so no extra query for the Bootstrap path.
    credential = Repo.preload(credential, network: :servers)
    user = Accounts.get_user!(credential.user_id)
    server = Servers.pick_server!(credential.network, attempt)

    {:ok, build_plan(user, credential.network, credential, server)}
  rescue
    NoServerError -> {:error, :no_server}
    Ecto.NoResultsError -> {:error, :user_not_found}
  end

  @spec build_plan(User.t(), Network.t(), Credential.t(), Server.t()) :: Session.start_opts()
  defp build_plan(%User{} = user, %Network{} = network, %Credential{} = cred, %Server{} = server) do
    base =
      base_plan(
        {:user, user.id},
        Grappa.Subject.label({:user, user.name}),
        cred,
        network,
        server,
        cred.nick
      )

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
      # the outcome and never retries; a failed commit is repaired by
      # retyping the password into the per-network password field (#124, Settings -> General).
      credential_committer: fn password ->
        Credentials.commit_password(user.id, cred.network_id, password)
      end,
      # #349 — the registration wizard's commit-on-+r. Sibling of
      # `credential_committer` but a DIFFERENT verb: it promotes the bound
      # credential (password + auth_method → :nickserv_identify) so a nick
      # registered in-session auto-identifies on every future reconnect.
      # Invoked from Session.Server's `+r` observer when a wizard REGISTER
      # is confirmed. Same (user_id, network_id) capture + Boundary-cycle
      # indirection as `credential_committer`.
      registration_committer: fn password ->
        Credentials.commit_registration_password(user.id, cred.network_id, password)
      end,
      # CP22 cluster B (channel-client-polish #14, B-restart) — opaque
      # closure that forwards `Map.keys(state.members)` snapshots to
      # the per-credential `last_joined_channels` column. Wraps the
      # (user_id, network_id) pair so Session.Server stays
      # boundary-clean (Networks deps Session, not the reverse).
      last_joined_persister: fn channels ->
        Credentials.update_last_joined_channels(user.id, cred.network_id, channels)
      end,
      # GH #417 — persist/restore the EXPLICIT away across crash / respawn /
      # upstream reconnect (user-only; the visitor plan omits both). The
      # persister is a Boundary-clean closure (mirror of
      # `last_joined_persister`); `restored_away` threads the DB snapshot
      # (`away_reason` / `away_since`) into `Session.Server.init/1`, which
      # seeds `away_state` and re-emits `AWAY :<reason>` upstream at 001.
      away_persister: fn reason, since ->
        Credentials.update_away(user.id, cred.network_id, reason, since)
      end,
      restored_away: restored_away(cred),
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
      #
      # #93 — this is ALSO the outer loop of the two-level fail-over machine
      # (#271 shipped the inner, per-leaf one inside `Grappa.IRC.Client`).
      # There is no loop to write: a connect failure kills the Client, the
      # linked Session.Server exits abnormally, `terminate/2` bumps
      # `Backoff`, and the `:transient` supervisor lands us right here. So
      # the endpoint advances by resolving at the failure count — attempt 0
      # is the preferred server, attempt 1 the next enabled one, wrapping.
      # The counter is cleared by the #100 sustained-connection gate, so a
      # session that stays up returns the ring to the preferred endpoint.
      refresh_plan: fn ->
        case Credentials.get_credential_by_ids(user.id, cred.network_id) do
          {:ok, fresh_cred} ->
            attempt = Backoff.failure_count({:user, user.id}, cred.network_id)

            case resolve_attempt(fresh_cred, attempt) do
              {:ok, _} = ok -> ok
              {:error, _} -> {:error, :not_found}
            end

          {:error, :not_found} = err ->
            err
        end
      end
    })
  end

  # GH #417 — the away snapshot read back from the credential's away_reason /
  # away_since columns. `{reason, since}` when an explicit away was persisted
  # (both columns set); nil otherwise. `Session.Server.init/1` seeds
  # `away_state` from it via `AwayState.restore_explicit/2`.
  @spec restored_away(Credential.t()) :: {String.t(), DateTime.t()} | nil
  defp restored_away(%Credential{away_reason: reason, away_since: %DateTime{} = since})
       when is_binary(reason),
       do: {reason, since}

  defp restored_away(%Credential{}), do: nil

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
    # #543 — resolve the source ONCE so the derived-alias discriminator sees the
    # SAME address that binds the socket. `addressing` is read once (this module
    # is inside the `Grappa.Networks` boundary, which deps `ServerSettings`), so
    # `Vhosts` stays OFF a `ServerSettings` dep. `managed_source_alias` is the
    # derived `::cb` address the session must acquire/release for its upstream
    # lifetime (INC-6), or `nil` for a non-derived source (mode 1, a
    # reservation, an admin `server_source` pin, a `{:hold, _}` outcome) —
    # `Vhosts.derived_source?/2` is the single decision point, so Session.Server
    # never re-derives + takes no `Vhosts`/`ServerSettings` dep.
    addressing = addressing_config()
    source = Grappa.Vhosts.effective_source(subject, server.source_address, addressing)

    %{
      subject: subject,
      subject_label: subject_label,
      network_slug: network.slug,
      # GH #388 — the operator-set services flavour, threaded into the
      # session so `Session.IdentityState` knows which umode letter means
      # "registered" on this network (uppercase `R` on OFTC, lowercase `r`
      # everywhere else). Set HERE, in the plan shared by the user AND
      # visitor paths, so both subject kinds detect identity identically.
      # nil for an unclassified network — the lowercase default.
      services_flavor: network.services_flavor,
      nick: cred.nick,
      ident: Credential.effective_ident(cred),
      realname: Identity.effective_realname(cred.realname, realname_fallback),
      sasl_user: Credential.effective_sasl_user(cred),
      auth_method: cred.auth_method,
      password: Credential.upstream_password(cred),
      # GH #189 — on-connect perform list + its `$oper_pass` secret. Both
      # decrypted-on-load plaintext (accessors), nil when unset. Threaded into
      # Session.Server state and expanded + run at 001, before the built-in
      # identify and before autojoin. Shared by the user + visitor base plan; a
      # visitor credential normally carries none.
      #
      # `$nickserv_pass` is NOT threaded: #124 collapsed its value onto the
      # credential password above, so the expander binds it from
      # `pending_password` at 001. One secret, one home.
      perform_list: Credential.perform_list_text(cred),
      oper_pass: Credential.upstream_oper_pass(cred),
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
      # #228 / #266 / #543 — resolve the source-bind through
      # `effective_source/3`. #266: an admin-configured per-network
      # `server.source_address` WINS (absolute bind, BOTH modes). Else the
      # global addressing config decides: mode 1 (`pool_with_reservations`,
      # default) → the per-subject vhost selection, else nil → the DB-driven
      # rotation pool / kernel default; mode 2
      # (`static_mapping_with_reservations`, #543) → grants-only
      # reservations, else a deterministic derived `::cb` address, else
      # `{:hold, reason}` (the session is parked-with-reason —
      # `Session.Server.init/1` intercepts, never a shared-pool egress). The
      # connect path in `Grappa.IRC.Client` is UNCHANGED for a resolved
      # address. The addressing config is read ONCE here (`base_plan` is the
      # single build site for BOTH user + visitor plans) and passed IN so
      # `Vhosts` stays OFF a `ServerSettings` dep (the `effective_pool/1`
      # pass-config-in shape). Re-resolved on every `Session.Server.init/1`
      # via `refresh_plan`, so a live source/vhost/mode change takes effect
      # on the next (re)connect.
      source_address: source,
      # #543 INC-6 — the derived `::cb` alias to acquire/release for the upstream
      # lifetime (equals `source` when derived), or `nil` otherwise.
      managed_source_alias: if(Grappa.Vhosts.derived_source?(source, addressing), do: source)
    }
  end

  # #543 INC-4 — the global outbound-addressing config, read ONCE per plan
  # build from `ServerSettings` (the DB k/v canonical store). Lives in this
  # module (inside the `Grappa.Networks` boundary, which deps
  # `ServerSettings`) rather than inside `Grappa.Vhosts` so `Vhosts` stays
  # OFF a `ServerSettings` dep — `effective_source/3` takes the config as a
  # param, mirroring `Vhosts.effective_pool/1`'s `fixed_sources`. The
  # visitor plan reuses this via the shared `base_plan/6`, so the read site
  # is single-sourced and the `Grappa.Visitors` boundary needs no
  # `ServerSettings` edge either.
  @spec addressing_config() :: Grappa.Vhosts.addressing()
  defp addressing_config do
    %{
      mode: Grappa.ServerSettings.addressing_mode(),
      prefix: Grappa.ServerSettings.static_mapping_prefix(),
      # #543 INC-5 — the platform arm gate, read lock-free from the manager's
      # `:persistent_term`. Folded into the addressing map so `effective_source/3`
      # is the single decision point: a disarmed mode 2 HOLDs (:mode2_disarmed)
      # rather than egressing from a shared kernel-default source. `false` when
      # the manager has not booted (safe — mode 2 stays held).
      armed?: Grappa.Net.SourceAliasManager.armed?()
    }
  end

  # CP22 cluster B (channel-client-polish #14, B-restart) — merge
  # operator autojoin (stable) with last-live snapshot (runtime). Order:
  # operator entries first to preserve operator-intent join order; then
  # snapshot entries the operator didn't already cover. Dedupe folds via
  # `Identifier.canonical_target/1` (ASCII, #364/#525/#537) — NOT bare
  # `String.downcase`, which would Unicode-over-fold non-ASCII channels and
  # diverge from the ASCII fold. Brackets `[ ] \ ~` are NOT folded, so
  # `#foo[1]`/`#foo{1}` remain DISTINCT autojoins on bahamut
  # (CASEMAPPING=ascii). We preserve the case of the EARLIER entry
  # (operator wins on case style).
  @spec merge_autojoin([String.t()], [String.t()]) :: [String.t()]
  defp merge_autojoin(autojoin, last_joined) when is_list(autojoin) and is_list(last_joined) do
    seen =
      autojoin
      |> Enum.map(&Identifier.canonical_target/1)
      |> MapSet.new()

    extras = Enum.reject(last_joined, &MapSet.member?(seen, Identifier.canonical_target(&1)))
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
