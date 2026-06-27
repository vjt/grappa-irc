defmodule Grappa.Visitors.SessionPlan do
  @moduledoc """
  Mirror of `Grappa.Networks.SessionPlan` for visitor-row input.
  Resolves a `%Visitor{}` + the matching network's lowest-priority
  enabled server into the primitive `t:Grappa.Session.start_opts/0`
  map for `Grappa.Session.start_session/3`.

  Visitor-specific shape:

    * `subject = {:visitor, visitor.id}`
    * `subject_label = "visitor:" <> visitor.id` (Q1=a — UUID stable
      across NickServ rename, no collision with user.name since `:`
      is invalid in user names)
    * `sasl_user = visitor.nick` (Q2=c — populated even though SASL
      never fires for visitors; visitor `auth_method` is always
      `:none | :nickserv_identify`)
    * `auth_method = :none` if `password_encrypted` is nil (anon)
    * `auth_method = :nickserv_identify` + plaintext password from
      EncryptedBinary roundtrip if registered

  Used by `Grappa.Bootstrap` (visitor respawn at boot, Task 19) and
  `Grappa.Visitors.Login` (synchronous login probe-connect, Task 9).

  Inside the `Grappa.Visitors` boundary — mirror of
  `Grappa.Networks.SessionPlan` inside `Grappa.Networks` (sibling has
  no own boundary either).
  """

  alias Grappa.{Networks, Repo, Session, Visitors}
  alias Grappa.Networks.{NoServerError, Servers}
  alias Grappa.Visitors.Visitor

  @doc """
  Resolve a `%Visitor{}` row into the primitive `Session.start_opts/0`
  plan. Looks up the matching `Networks.Network` by slug, picks the
  lowest-priority enabled server, and threads the visitor's identity
  fields (subject, subject_label, nick, sasl_user, auth_method,
  password) into the plan.

  Returns `{:error, :network_unconfigured}` if the slug doesn't have
  a `Network` row, or `{:error, :no_server}` if the network has no
  enabled server endpoints.
  """
  @spec resolve(Visitor.t()) ::
          {:ok, Session.start_opts()} | {:error, :network_unconfigured | :no_server}
  def resolve(%Visitor{} = visitor) do
    with {:ok, network} <- fetch_network(visitor.network_slug) do
      network = Repo.preload(network, :servers)

      try do
        server = Servers.pick_server!(network)
        {:ok, build_plan(visitor, network, server)}
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

  defp fetch_network(slug) do
    case Networks.get_network_by_slug(slug) do
      {:ok, network} -> {:ok, network}
      {:error, :not_found} -> {:error, :network_unconfigured}
    end
  end

  defp build_plan(%Visitor{} = visitor, network, server) do
    autojoin = Visitors.list_autojoin_channels(visitor)

    %{
      subject: {:visitor, visitor.id},
      subject_label: "visitor:" <> visitor.id,
      network_slug: network.slug,
      nick: visitor.nick,
      realname: "Grappa Visitor",
      sasl_user: visitor.nick,
      auth_method: auth_method(visitor),
      password: visitor.password_encrypted,
      autojoin_channels: autojoin,
      host: server.host,
      port: server.port,
      tls: server.tls,
      source_address: server.source_address,
      # Task 15: opaque function-reference indirection. Session.Server
      # cannot statically alias Grappa.Visitors (closes a Boundary
      # cycle — Visitors deps Session via Login). Every visitor plan
      # carries the commit-callback so the +r-MODE-observed effect
      # path can reach commit_password/2 without a module reference
      # in the Session boundary.
      visitor_committer: &Grappa.Visitors.commit_password/2,
      # V9 (visitor-parity cluster, 2026-05-15): mirror of
      # `visitor_committer` for the upstream NICK self-echo. Server's
      # `apply_effects/2` invokes this on `{:visitor_nick_changed, new}`
      # to rotate `visitors.nick` after EventRouter confirms the
      # rename was accepted (state.nick == old_nick path). Same opaque
      # function-ref indirection — Visitors deps Session via Login,
      # so a static alias would close a Boundary cycle.
      visitor_nick_persister: &Grappa.Visitors.update_nick/2,
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
      # `Map.keys(state.members)` snapshot to `visitors.last_joined_channels`
      # via the context helper so a graceful or crash restart rehydrates
      # the channel list. Closure captures the visitor id; a concurrent
      # reap between snapshot write and Repo round-trip surfaces as
      # `{:error, :not_found}` inside `update_last_joined_channels/2`,
      # which `Session.Server`'s logger swallows non-fatally — the next
      # mutation overwrites and the row is gone anyway.
      last_joined_persister: fn channels ->
        Visitors.update_last_joined_channels(visitor.id, channels)
      end,
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
      # cases that `resolve/1` itself returns when the surrounding
      # config went away: in all three the subject is no longer
      # viable, so `Server.init/1` returns `:ignore` and the
      # supervisor drops the child permanently. Operator manually
      # re-spawns once the underlying config is fixed.
      refresh_plan: fn ->
        case Visitors.get(visitor.id) do
          nil ->
            {:error, :not_found}

          fresh ->
            case resolve(fresh) do
              {:ok, _} = ok -> ok
              {:error, _} -> {:error, :not_found}
            end
        end
      end
    }
  end

  defp auth_method(%Visitor{password_encrypted: nil}), do: :none
  defp auth_method(%Visitor{password_encrypted: _}), do: :nickserv_identify

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
