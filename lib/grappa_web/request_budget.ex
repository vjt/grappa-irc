defmodule GrappaWeb.RequestBudget do
  @moduledoc """
  GH #630 — the web-layer adapter over `Grappa.RateLimit.RequestBudget`
  that BOTH inbound doors share: `GrappaWeb.Plugs.RequestBudget` (every
  REST write) and the `GrappaWeb.GrappaChannel` `handle_in` guard (every
  WS verb) call `guard/3` here. One decision function (`RequestBudget`),
  one sever code path (`sever/3`) — two implementations that drift is the
  failure mode this feature exists to avoid.

  `guard/3` runs the ladder and, on the sever crossing, performs the
  transport-side sever ONCE:

    1. **notify the subject** — broadcast `Grappa.RateLimit.Wire`'s
       `web_session_severed` on the subject's user topic so cic raises a
       persistent "you were disconnected for flooding — sign in again"
       state (best-effort courtesy; the close + revoke below are the real
       enforcement);
    2. **revoke the auth session** — the offending bearer is dead, so a
       reconnect with the old credentials is refused until re-auth;
    3. **close the live socket(s)** via the shared id-topic disconnect;
    4. **operator visibility** — a `Grappa.AdminEvents` record + a
       `[:grappa, :rate_limit, :severed]` telemetry counter + a greppable
       warning. A silent kill is a support ticket nobody can answer.

  🔴 The IRC `Session.Server` is deliberately NOT touched — a client-side
  flood costs the user their web session, never their IRC presence.
  """

  alias Grappa.{Accounts, AdminEvents}
  alias Grappa.PubSub.Topic
  alias Grappa.RateLimit.{RequestBudget, Wire}
  alias GrappaWeb.UserSocket

  require Logger

  @doc """
  Run the shared budget ladder for `subject`, performing the transport
  sever as a side effect on the crossing. `session_id` is the offending
  bearer (revoked on sever); `user_name` is the subject's id-topic label
  (used to notify + disconnect). Returns the raw ladder decision so the
  caller renders the transport-appropriate refusal.
  """
  @spec guard(RequestBudget.subject(), String.t(), String.t()) :: RequestBudget.decision()
  def guard(subject, session_id, user_name)
      when is_binary(session_id) and is_binary(user_name) do
    case RequestBudget.check(subject) do
      :ok ->
        :ok

      {:error, :rate_limited} = refused ->
        refused

      {:error, :severed} = severed ->
        sever(subject, session_id, user_name)
        severed
    end
  end

  @spec sever(RequestBudget.subject(), String.t(), String.t()) :: :ok
  defp sever({kind, id}, session_id, user_name) do
    cfg = RequestBudget.config()

    # 1. Tell the subject (best-effort courtesy) BEFORE the socket dies so
    #    cic can latch the flood-banner state that survives the teardown. A
    #    PubSub hiccup must NOT abort the load-bearing teardown below — the
    #    failure already surfaces via `[:grappa, :pubsub, :broadcast_failed]`
    #    telemetry, so the result is deliberately discarded, not matched.
    _ = Grappa.PubSub.broadcast_event(Topic.user(user_name), Wire.web_session_severed())

    # 2. Kill the offending bearer — reconnect with old creds now refused.
    #    A flood IS peak DB write contention and the ladder severs exactly
    #    ONCE, so a MatchError-crash here would skip the socket close AND
    #    permanently defeat enforcement for the window. The busy-resilient
    #    revoke rides out a transient SQLITE_BUSY; on sustained saturation it
    #    degrades to :db_unavailable — logged, then the teardown CONTINUES so
    #    the live socket still closes (the stale bearer is throttled on its
    #    next request). Never crash the guard.
    case Accounts.revoke_session(session_id) do
      :ok ->
        :ok

      {:error, :db_unavailable} ->
        Logger.warning(
          "web session sever: bearer revoke degraded (db unavailable) — " <>
            "socket still closed, stale bearer throttled on next request",
          subject_kind: kind
        )
    end

    # 3. Close the live socket(s) for this subject.
    :ok = UserSocket.disconnect_user_name(user_name)

    # 4. Operator-visible: ring buffer + telemetry counter + log line.
    :ok =
      AdminEvents.record(AdminEvents.Wire.web_session_severed(kind, id, cfg.sever_after, cfg.sever_window_ms))

    :telemetry.execute([:grappa, :rate_limit, :severed], %{count: 1}, %{subject_kind: kind})

    Logger.warning(
      "web session severed for sustained inbound flood " <>
        "(#{cfg.sever_after} over-budget events in #{cfg.sever_window_ms}ms)",
      subject_kind: kind
    )

    :ok
  end
end
