defmodule Grappa.Visitors.SessionPlan do
  @moduledoc """
  Mirror of `Grappa.Networks.SessionPlan` for visitor input.
  Resolves a `%Visitor{}` + an explicit `%Network{}`'s lowest-priority
  enabled server into the primitive `t:Grappa.Session.start_opts/0`
  map for `Grappa.Session.start_session/3`.

  #211 phase 7 — identity (nick/ident/realname/password/auth_method) lives
  PER-NETWORK on the `(visitor_id, network_id)` Credential; the visitor
  row is a pure identity/TTL row. So resolution is credential-first + always
  network-explicit (`resolve/2` — there is no `resolve/1`), and the plan's
  identity fields come from the credential, not the visitor scalars.

  Visitor-specific shape:

    * `subject = {:visitor, visitor.id}`
    * `subject_label = "visitor:" <> visitor.id` (Q1=a — UUID stable
      across NickServ rename, no collision with user.name since `:`
      is invalid in user names)
    * `sasl_user = credential.nick` (Q2=c — populated even though SASL
      never fires for visitors; visitor `auth_method` is always
      `:none | :nickserv_identify`)
    * `auth_method = :none` if the credential's `password_encrypted` is nil
      (anon on this network)
    * `auth_method = :nickserv_identify` + plaintext password from
      EncryptedBinary roundtrip if identified on this network

  Used by `Grappa.Bootstrap` (visitor respawn at boot, Task 19) and
  `Grappa.Visitors.Login` (synchronous login probe-connect, Task 9).

  Inside the `Grappa.Visitors` boundary — mirror of
  `Grappa.Networks.SessionPlan` inside `Grappa.Networks` (sibling has
  no own boundary either).
  """

  alias Grappa.{Networks, Repo, Session, Visitors}
  alias Grappa.Networks.{Credential, Credentials, NoServerError, Servers}
  alias Grappa.Networks.SessionPlan, as: NetworksSessionPlan
  alias Grappa.Session.Backoff
  alias Grappa.Visitors.Visitor

  @doc """
  #211 phase 4c/7 — resolve a `%Visitor{}` for an EXPLICIT `%Network{}`
  (login / accretion / per-network reconnect / Bootstrap). A visitor's
  identity + credentials are per-network now (the `visitors.network_slug`
  scalar is gone), so EVERY resolve is network-explicit — there is no
  singular-network `resolve/1` anymore. A visitor whose credentials span
  networks resolves the RIGHT one from the passed `%Network{}`.

  Resolves the visitor's `(visitor_id, network_id)` Credential (the
  identity source of truth), picks the lowest-priority enabled server, and
  builds the plan. `{:error, :no_server}` when the network has no enabled
  endpoints; `{:error, :network_unconfigured}` when the visitor holds no
  credential on this network.
  """
  @spec resolve(Visitor.t(), Networks.Network.t()) ::
          {:ok, Session.start_opts()} | {:error, :network_unconfigured | :no_server}
  def resolve(%Visitor{} = visitor, %Networks.Network{} = network),
    do: resolve_attempt(visitor, network, 0)

  # #93 — the ring-aware resolver behind `resolve/2`, mirroring
  # `Grappa.Networks.SessionPlan.resolve_attempt/2` field for field:
  # `attempt` indexes the enabled endpoint ring, `resolve/2` pins it to 0
  # because its callers are the spawn doors (Bootstrap, `Visitors.Login`,
  # `Operator`) which clear the failure ladder before spawning, and only
  # the `refresh_plan` closure below — the respawn door — walks it.
  @spec resolve_attempt(Visitor.t(), Networks.Network.t(), non_neg_integer()) ::
          {:ok, Session.start_opts()} | {:error, :network_unconfigured | :no_server}
  defp resolve_attempt(%Visitor{} = visitor, %Networks.Network{} = network, attempt) do
    with {:ok, credential} <- fetch_credential(visitor, network) do
      network = Repo.preload(network, :servers)

      try do
        server = Servers.pick_server!(network, attempt)
        {:ok, build_plan(visitor, credential, network, server)}
      rescue
        NoServerError -> {:error, :no_server}
      end
    end
  end

  @doc """
  Rewrite a resolved fresh-visitor `plan` so the session identifies to
  NickServ at 001 using the login-form `password`, and so that override
  survives `Grappa.Session.Server.init/1`'s DB-wins `refresh_plan`
  re-resolve while the visitor row is still anon.

  `init/1` re-resolves the plan from the DB on every spawn AND
  `:transient` restart, merging the fresh DB plan OVER the cached spawn
  opts (`Map.merge(opts, fresh_plan)` — the 2026-05-27 Azzurra
  zombie-respawn fix). For a fresh anon visitor that re-resolved row
  carries `auth_method: :none`, which would clobber a plain field
  override on the very first init and defeat the IDENTIFY-at-001. So we
  both set the fields directly AND wrap the injected `refresh_plan`
  closure: while the row is anon the wrapper re-applies the override;
  once `+r` commits the password to the DB (`commit_password/2`) the
  re-resolved plan carries `:nickserv_identify` naturally and we defer
  to it (DB wins again, the login-form secret drops out).

  The top-level field merge is load-bearing only on the no-`refresh_plan`
  path (test fixtures / `Grappa.Bootstrap`); Login-spawned sessions
  always carry the closure, so the wrapper is what actually threads the
  override through `init/1`.

  A non-binary / empty `password` returns `plan` unchanged.
  """
  @spec with_login_identify(Session.start_opts(), String.t() | nil) :: Session.start_opts()
  def with_login_identify(plan, password) when is_binary(password) and password != "" do
    plan
    |> Map.merge(%{auth_method: :nickserv_identify, password: password})
    |> rewrap_refresh_for_login_identify(password)
  end

  def with_login_identify(plan, _), do: plan

  # #211 phase 7 — resolve the visitor's `(visitor_id, network_id)`
  # Credential (the identity source of truth — the visitor row is a pure
  # identity/TTL row now, nothing to self-heal from). A missing credential
  # collapses to `:network_unconfigured` — the same "subject no longer
  # viable" surface the `refresh_plan` closure ends the respawn loop on.
  defp fetch_credential(%Visitor{} = visitor, network) do
    case Visitors.resolve_credential(visitor, network.id) do
      {:ok, %Credential{} = cred} -> {:ok, cred}
      {:error, :not_found} -> {:error, :network_unconfigured}
    end
  end

  # #581 — resolve the /recover secret SOURCE from the LIVE persistent
  # `(visitor_id, network_id)` credential: `Credential.recover_secret/1` (the
  # SSOT the `recoverable` button gate also reads) + the registered nick to
  # reclaim, from ONE fetch. `:nothing_to_recover` when the credential is gone
  # or carries no secret. Injected as the `recover_source` closure by
  # `build_plan/4`; extracted here so that closure body stays a one-liner.
  @spec recover_secret_source(Ecto.UUID.t(), pos_integer()) ::
          {:ok, {String.t(), String.t()}} | {:error, :nothing_to_recover}
  defp recover_secret_source(visitor_id, network_id) do
    # `is_binary` guards on BOTH nick and secret narrow the success tuple to
    # `{String.t(), String.t()}` — the schema types `nick` as `String.t() | nil`
    # and `recover_secret/1` as `binary() | nil`, so without the guards Dialyzer
    # infers `{:ok, {nil | binary(), ...}}`, which is NOT a subtype of the
    # `recover_source()` @type on `Session.start_opts` → build_plan's return
    # stops matching `start_opts()` → `resolve/2` loses its `{:ok, plan}` success
    # typing → every `{:ok, _plan}` caller (Bootstrap/Operator/Visitors/Login)
    # dead-patterns. A persisted credential always has a non-nil nick
    # (validate_required), so the guard is belt-and-braces, not a real branch.
    with {:ok, %Credential{nick: nick} = cred} when is_binary(nick) <-
           Credentials.get_visitor_credential(visitor_id, network_id),
         secret when is_binary(secret) <- Credential.recover_secret(cred) do
      {:ok, {nick, secret}}
    else
      _ -> {:error, :nothing_to_recover}
    end
  end

  defp build_plan(%Visitor{} = visitor, %Credential{} = credential, network, server) do
    # Shared fields-only builder (user + visitor identical bytes). The
    # visitor's realname falls back to the "Grappa Visitor" anon branding
    # (ruling E) — passed as the parameter, one rule two call sites.
    base =
      NetworksSessionPlan.base_plan(
        {:visitor, visitor.id},
        Grappa.Subject.label({:visitor, visitor.id}),
        credential,
        network,
        server,
        "Grappa Visitor"
      )

    Map.merge(base, %{
      # Task 15 / #561: opaque function-reference indirection. Session.Server
      # cannot statically alias Grappa.Visitors (closes a Boundary
      # cycle — Visitors deps Session via Login). Every visitor plan carries
      # the commit-callback so the +r-MODE-observed effect path can reach
      # `commit_identity/4` without a module reference in the Session
      # boundary. #561 — the +r commit binds BOTH the password AND the nick
      # held at the identify instant (the identified nick is NOT persisted on
      # a later voluntary NICK echo — see `update_nick/3`'s anon gate). #211
      # phase 7 — password + nick live PER-NETWORK on the credential, so the
      # closure captures THIS session's `network.id` and presents the arity-3
      # shape Session.Server passes `(visitor_id, password, nick)`.
      visitor_committer: fn visitor_id, password, nick ->
        Grappa.Visitors.commit_identity(visitor_id, network.id, password, nick)
      end,
      # #131: visitor-side SET PASSWD committer. NOT `commit_password/3`
      # (that one promotes anon→permanent, correct only behind the +r
      # identity proof) — `rotate_password/3` is identity-gated so an
      # optimistic on-send commit of a SET PASSWD from an unidentified anon
      # visitor (which services would reject) can't pin the credential
      # permanent. Parallel to the user-side
      # `Networks.SessionPlan.credential_committer`. #211 phase 7 —
      # per-network on the credential; captures `network.id`.
      visitor_password_rotator: fn visitor_id, password ->
        Grappa.Visitors.rotate_password(visitor_id, network.id, password)
      end,
      # V9 (visitor-parity cluster, 2026-05-15): mirror of
      # `visitor_committer` for the upstream NICK self-echo. Server's
      # `apply_effects/2` invokes this on `{:visitor_nick_changed, new}` to
      # rotate the visitor's nick after EventRouter confirms the rename was
      # accepted (state.nick == old_nick path). #211 phase 7 — the nick
      # lives PER-NETWORK on the credential now, so the closure captures
      # `network.id` and presents the arity-2 shape Session.Server expects.
      visitor_nick_persister: fn visitor_id, new_nick ->
        Grappa.Visitors.update_nick(visitor_id, network.id, new_nick)
      end,
      # CP24 bucket E lifecycle/S1: visitor-side equivalent of the
      # user-side `Networks.SessionPlan.credential_failer` callback.
      # K-line / permanent-SASL on the visitor session calls this
      # with the upstream rejection reason; `mark_failed/2` expires
      # the row immediately so `Bootstrap.spawn_visitors/1` stops
      # respawning. The closure captures the visitor id rather than
      # the full struct so a delete-between-spawn-and-failure race
      # surfaces as `{:error, :not_found}` (handled inside
      # `mark_failed/2`) instead of stale-row write.
      credential_failer: fn reason ->
        case Visitors.mark_failed(visitor.id, reason) do
          :ok -> :ok
          # Visitor row was reaped between spawn and failure. The
          # operator-observable signal already fired via the
          # `Logger.error` inside `mark_failed/2` (which is skipped
          # on `:not_found`); log the race here so it is not lost.
          {:error, :not_found} -> :ok
        end
      end,
      # Visitor-parity rejoin-on-restart: mirror of the user-side
      # `Networks.SessionPlan`'s `last_joined_persister`. Forwards the
      # `Map.keys(state.members)` snapshot to the visitor's PER-NETWORK
      # `(visitor_id, network_id)` Credential (#211 phase 4c — NOT the
      # single `visitors.last_joined_channels` scalar, which two concurrent
      # sessions on different networks would clobber). Captures THIS
      # session's `network.id` so an accreted network-B session persists to
      # B's credential. A concurrent unbind between snapshot write and Repo
      # round-trip surfaces as `{:error, :not_found}` inside
      # `update_last_joined_channels/3`, which `Session.Server`'s logger
      # swallows non-fatally. The read side (`base_plan` +
      # `resolve/2`) already reads `cred.last_joined_channels` per-network,
      # so write + read are now symmetric per-network.
      last_joined_persister: fn channels ->
        Visitors.update_last_joined_channels(visitor.id, network.id, channels)
      end,
      # #581 — the "recover my identity" secret SOURCE. Session.Server cannot
      # statically alias Networks/Visitors (Boundary cycle — Visitors deps
      # Session via Login), so the reader is injected here as an opaque
      # closure, mirroring `visitor_committer`. Body extracted to
      # `recover_secret_source/2` (keeps build_plan under the cyclomatic
      # budget). Captures `visitor.id` + `network.id` (immutable) like
      # `last_joined_persister`.
      recover_source: fn -> recover_secret_source(visitor.id, network.id) end,
      # Re-resolve the plan from the DB on every `Session.Server.init/1`
      # invocation — both first boot AND `:transient` restart.
      # `DynamicSupervisor` caches the spawn-time child spec; without
      # this closure, `state.nick` / `state.autojoin` / credentials
      # freeze at the boot-time values even after `update_nick/2` or
      # `update_last_joined_channels/2` rotated the DB row. The
      # 2026-05-27 Azzurra `kazamobile`/`kazam02` incident.
      #
      # `{:error, :not_found}` subsumes the prior `subject_row_present?`
      # fail-fast (visitor row reaped / operator-deleted between spawn
      # and restart) AND the `:network_unconfigured` / `:no_server`
      # cases that `resolve/2` itself returns when the surrounding
      # config went away: in all three the subject is no longer
      # viable, so `Server.init/1` returns `:ignore` and the
      # supervisor drops the child permanently. Operator manually
      # re-spawns once the underlying config is fixed.
      #
      # #211 phase 4c — re-resolve the SAME network this session was spawned
      # for, NOT the visitor's primary `network_slug`. A visitor's
      # credentials can span multiple networks (accretion); the network-B
      # session's `:transient` restart must re-resolve network B. Capture
      # its id and reload it fresh (so a mid-session config change is picked
      # up) then `resolve/2` against it.
      refresh_plan: fn ->
        case Visitors.get(visitor.id) do
          nil ->
            {:error, :not_found}

          fresh ->
            case Networks.get_network(network.id) do
              nil ->
                {:error, :not_found}

              %Networks.Network{} = fresh_network ->
                # #93 — the respawn door walks the endpoint ring. Same
                # derivation as the user side: the `:transient` restart that
                # lands here has already had its failure recorded, so the
                # counter IS the connect-attempt ordinal.
                attempt = Backoff.failure_count({:visitor, visitor.id}, network.id)

                case resolve_attempt(fresh, fresh_network, attempt) do
                  {:ok, _} = ok -> ok
                  {:error, _} -> {:error, :not_found}
                end
            end
        end
      end
    })
  end

  # Wrap the injected `refresh_plan` closure so the login IDENTIFY
  # survives `init/1`'s DB-wins re-resolve WHILE the visitor row is
  # anon; defer to the DB once a `+r` commit upgrades the row to
  # `:nickserv_identify`. The fallback clause keeps the no-`refresh_plan`
  # test/Bootstrap path intact.
  defp rewrap_refresh_for_login_identify(%{refresh_plan: refresh} = plan, password)
       when is_function(refresh, 0) do
    wrapped = fn ->
      case refresh.() do
        {:ok, %{auth_method: :none} = fresh} ->
          {:ok, Map.merge(fresh, %{auth_method: :nickserv_identify, password: password})}

        {:ok, _} = ok ->
          ok

        {:error, _} = err ->
          err
      end
    end

    %{plan | refresh_plan: wrapped}
  end

  defp rewrap_refresh_for_login_identify(plan, _), do: plan
end
