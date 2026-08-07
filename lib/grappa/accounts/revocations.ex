defmodule Grappa.Accounts.Revocations do
  @moduledoc """
  Domain event for "every bearer session of this subject is dead".

  ## The invariant

  **A subject's bearer sessions and its live WebSockets die together.**

  `GrappaWeb.UserSocket` authenticates once, at connect, and holds no
  further tie to the row — so the teardown has to be pushed. It used to
  be pushed BY HAND at each call-site, which is a rule and therefore
  something that drifts: it had, on most of the doors.

  Re-validating on the inbound frame path was considered and rejected.
  It would tie the teardown to the client SENDING something, which is
  the wrong half of a duplex connection to hang a guarantee on.

  ## The shape

  The kill sites announce; a web-layer listener
  (`GrappaWeb.SessionRevocationListener`) translates the announcement
  into the existing `GrappaWeb.UserSocket.disconnect_user_name/1`. The
  indirection is not decoration: calling the socket from here would be a
  context → web dependency that `Boundary` rejects (same reason
  `Grappa.Operator` carries no web deps).

  Announcing is NOT a new rule to remember at each door — that is the
  shape that drifted. Every write to `accounts_sessions` passes one of
  seven chokepoints: the four revoke functions in `Grappa.Accounts`
  (which own the table), plus the three places a parent row's deletion
  cascades onto it
  (`Accounts.delete_user/1`, `Accounts.delete_expired_sessions/0`, and
  the private `destroy_visitor/1` in `Grappa.Visitors`, already the
  single hard-delete mechanic for visitor rows). A new door inherits the
  teardown by construction.

  ## Granularity: per-subject, deliberately

  `UserSocket.id/1` is keyed by subject, not by session, so the teardown
  closes EVERY socket of the subject. On the "revoke all the OTHER
  sessions" paths (TOTP enrolment/disable, passkey mode change) the
  device that performed the operation is disconnected too. Its bearer is
  still valid, so `phoenix.js` reconnects on its own: the cost is a blip.
  Per-session granularity would require re-keying `UserSocket.id/1` and
  teaching `Grappa.WSPresence` to carry `session_id`; it stays an open,
  strictly additive question.

  ## Over-firing is the safe direction

  The in-transaction kill sites announce from INSIDE the transaction, so
  a rolled-back or `Repo.BusyRetry`-replayed transaction can announce a
  revocation that did not commit (or announce it twice). The consequence
  is a socket close whose bearer is still valid — a reconnect blip.
  Announcing only after commit would push the call back out to each
  call-site, which is the drift this module exists to end. Under-firing
  is the failure that matters; over-firing is not.
  """

  use Boundary, top_level?: true, deps: [Grappa.PubSub]

  alias Grappa.PubSub.Topic

  require Logger

  @typedoc """
  The subject whose sessions died — the topic-label PARTS, not a loaded
  struct and not an id.

  The user branch carries `user.name` and the visitor branch carries
  `visitor.id` because that is what the socket id-topic is keyed by
  (`Grappa.Subject.label/1`). It must be resolved BEFORE the row is
  deleted: on the cascade paths the user or visitor row is already gone
  by the time a listener could look it up.

  Structurally the `label_parts` type of `Grappa.Subject`, spelled out
  here rather than aliased: that module depends on `Grappa.Accounts`, so
  naming it from inside this boundary would close a dependency cycle.
  """
  @type subject :: {:user, String.t()} | {:visitor, String.t()}

  @typedoc "The message a subscriber receives."
  @type event :: {:sessions_revoked, subject()}

  @doc """
  Subscribes the calling process to the revocation stream.

  One subscriber in production (the web listener); tests subscribe
  directly to assert the announcement without standing up a socket.

  Returns `:ok` or raises. The only failure `Phoenix.PubSub` reports here
  is `{:already_registered, pid}` — a process subscribing twice, which is
  a bug in that process, not a runtime condition anything could sensibly
  handle. Returning it would invent a failure mode every caller then has
  to pretend to consider.
  """
  @spec subscribe() :: :ok
  def subscribe do
    :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.session_revocations())
  end

  @doc """
  Announces that every bearer session of `subject` is dead.

  Fire-and-forget: a PubSub-unreachable `{:error, _}` is logged and
  swallowed. The caller has already killed the rows, and the announcement
  is an accelerator for a socket that is dead-in-law either way — it must
  never turn a completed revocation into a failed one, and never abort
  the transaction it is called from.
  """
  @spec announce(subject()) :: :ok
  def announce({tag, label} = subject) when tag in [:user, :visitor] and is_binary(label) do
    case Phoenix.PubSub.broadcast(
           Grappa.PubSub,
           Topic.session_revocations(),
           {:sessions_revoked, subject}
         ) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.warning("session revocation announce failed",
          subject_kind: tag,
          reason: inspect(reason)
        )

        :ok
    end
  end
end
