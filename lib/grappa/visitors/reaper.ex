defmodule Grappa.Visitors.Reaper do
  @moduledoc """
  GenServer that periodically sweeps expired visitor rows out of the
  DB. Runs as a `:permanent` child under the main application
  supervision tree.

  ## Cadence

  Default interval is 60s — configurable via the `:interval_ms`
  start option (the test suite uses small intervals to verify the
  tick path without blocking).

  ## Sweep

  Each tick calls `sweep/0`, which enumerates `Visitors.list_expired/0`
  and invokes `Visitors.delete/1` per row. The DB-level FK ON DELETE
  CASCADE on `messages`, `query_windows`,
  `push_subscriptions`, `user_settings`, `read_cursors`, and the
  visitor's PRIVATE `themes` (every table that carries a `visitor_id`
  FK after the visitor-parity cluster + #299) wipes the dependent rows
  in the same transaction. `accounts_sessions` also CASCADEs — the
  bearer token of an expired visitor dies with the row. The one
  non-CASCADE dependent is a reaped visitor's PUBLISHED themes:
  `Visitors.delete/1` re-homes them to the system user (#299) so gallery
  contributions survive the reap. Per-row failures log + continue — one
  bad row does not stop the sweep.

  `Visitors.list_expired/0` carries an explicit `expires_at IS NOT
  NULL` guard so V7 (NickServ-identified visitors persist forever
  via `expires_at = NULL`) requires no coordinated change here —
  the column was flipped to nullable in
  `20260515111331_visitors_expires_at_nullable`. Reaper sees only
  rows that have OPTED IN to expiry by setting a non-NULL timestamp.

  Sweeps that delete zero rows stay quiet (no log line); a non-zero
  sweep logs once at `:info` so operators can grep visitor lifecycle
  across the deletion boundary.

  ## Boundary

  `top_level?: true` — Reaper opts out of `Grappa.Visitors`'s
  boundary so the application supervisor can list it as a child
  without dragging the entire Visitors public surface into the
  application's deps (see `lib/grappa/application.ex`).
  """

  use Boundary,
    top_level?: true,
    deps: [
      Grappa.AdminEvents,
      Grappa.Networks,
      Grappa.Session,
      Grappa.Subject,
      Grappa.Visitors,
      Grappa.Visitors.Visitor,
      Grappa.WSPresence
    ]

  use GenServer

  alias Grappa.{AdminEvents, Session, Subject, Visitors, WSPresence}
  alias Grappa.AdminEvents.Wire, as: AdminWire
  alias Grappa.Networks.{Credential, Credentials}

  require Logger

  @default_interval_ms 60_000

  @type opts :: [interval_ms: pos_integer(), name: GenServer.name()]

  defstruct [:interval_ms]

  @type t :: %__MODULE__{interval_ms: pos_integer()}

  @spec start_link(opts()) :: GenServer.on_start()
  def start_link(opts) do
    {name, opts} = Keyword.pop(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc """
  Synchronous sweep — enumerates expired visitors, stops each visitor's
  live `Session.Server` when its network still exists, then deletes the
  row. Returns `{:ok, count}` with the number of rows successfully
  deleted. Per-row stop/delete failures log + continue; the
  operator-facing failure surface is the `Logger.error` line, not the
  return value.
  """
  @spec sweep() :: {:ok, non_neg_integer()}
  def sweep do
    reconcile_incognito_lingers()
    expired = Visitors.list_expired()

    deleted =
      Enum.reduce(expired, 0, fn v, acc ->
        # #211 phase 7 — capture the representative (anchor) nick BEFORE the
        # delete: the identity nick lives per-network on the credentials,
        # which CASCADE with the visitor row, so it can't be read after.
        reaped_nick = reaped_nick(v)

        case reap_visitor(v) do
          :ok ->
            # M-11: per-row reap event for the admin events stream.
            # Emitted ONLY on successful delete — a failed delete logs
            # but doesn't fire a misleading "reaped" signal.
            :ok = AdminEvents.record(AdminWire.visitor_reaped(v.id, reaped_nick))
            acc + 1

          {:error, reason} ->
            Logger.error("reaper delete failed",
              visitor_id: v.id,
              error: inspect(reason)
            )

            acc
        end
      end)

    {:ok, deleted}
  end

  # #363 — before enumerating expiries, refresh the linger TTL of every
  # incognito visitor that still holds a live browser socket. `WSPresence` is
  # the authoritative "a browser is connected" signal (the visitor
  # `Session.Server` outlives the socket, so process liveness is NOT the
  # signal): its `user_name` set carries one subject label per connected
  # subject. Decode each via `Grappa.Subject.from_label/1` — the #413 SSOT
  # for the `"user → user.name, visitor → "visitor:" <> id"` routing codec —
  # rather than re-stating the `"visitor:"` prefix here (a hand-rolled decode
  # would silently fork from the codec if the label scheme ever changes). The
  # generator pattern keeps only `{:visitor, id}` labels; account names decode
  # to `{:user, name}` and drop out. Sliding these forward BEFORE
  # `list_expired/0` reads keeps a connected incognito visitor out of the
  # sweep; a disconnected one is left to elapse and is collected below.
  # Non-incognito ids in the set are a no-op inside
  # `slide_incognito_lingers/1`.
  @spec reconcile_incognito_lingers() :: :ok
  defp reconcile_incognito_lingers do
    connected_visitor_ids =
      for label <- WSPresence.list_user_names(),
          {:visitor, id} <- [Subject.from_label(label)],
          do: id

    _ = Visitors.slide_incognito_lingers(connected_visitor_ids)
    :ok
  end

  # Representative (identity-anchor) nick for the reap event label, read
  # before the delete cascades the credentials away.
  @spec reaped_nick(Visitors.Visitor.t()) :: String.t() | nil
  defp reaped_nick(%Visitors.Visitor{id: id}),
    do: Credentials.representative_visitor_nick(id)

  # #590 — `Visitors.delete/1` can now degrade a sustained SQLITE_BUSY to
  # `{:error, :db_unavailable}`; the sweep's per-row `{:error, reason}` arm logs
  # + continues (best-effort DROP — the row is left for the next tick), so the
  # reaper rides transient contention rather than crashing.
  @spec reap_visitor(Visitors.Visitor.t()) :: :ok | {:error, :not_found | :db_unavailable}
  defp reap_visitor(v) do
    with :ok <- stop_visitor_session(v),
         :ok <- Visitors.delete(v.id) do
      :ok
    end
  end

  # #211 phase 7 — a visitor is multi-network; stop EVERY attached network's
  # session before the delete cascades the credential rows. Idempotent per
  # network (`stop_session/3` no-ops without a live pid); empty list (no
  # credentials) → nothing to stop. The retired `visitors.network_slug`
  # scalar only ever resolved the primary session.
  @spec stop_visitor_session(Visitors.Visitor.t()) :: :ok
  defp stop_visitor_session(%Visitors.Visitor{id: id}) do
    for %Credential{network_id: network_id} <- Credentials.list_visitor_credentials(id) do
      :ok = Session.stop_session({:visitor, id}, network_id, "visitor session expired")
    end

    :ok
  end

  @impl GenServer
  def init(opts) do
    interval = Keyword.get(opts, :interval_ms, @default_interval_ms)
    schedule_tick(interval)
    {:ok, %__MODULE__{interval_ms: interval}}
  end

  @impl GenServer
  def handle_info(:tick, state) do
    # REV-J M9: schedule the next tick BEFORE running the sweep so the
    # cadence is interval-fixed, not "interval + sweep_duration". Pre-fix
    # the schedule call lived after `sweep/0` returned; a slow Cloak
    # decrypt or a backlog of expired rows (each delete CASCADEs across
    # 7 dependent tables) could realistically take seconds, drifting
    # the wall-clock cadence under load. With the scheduling first,
    # sweep duration is consumed within the interval rather than
    # extending it — if a sweep ever exceeds the interval, the next
    # `:tick` message piles up in the mailbox and runs back-to-back,
    # which is the right shape ("never less frequent than configured").
    schedule_tick(state.interval_ms)
    {:ok, n} = sweep()

    # M-11: scheduled-tick :reaper_swept summary — actor is nil
    # because the scheduler is "the system", not an operator.
    # Suppressed on count=0 to avoid flooding the admin events
    # ring buffer (200-cap) with 1440 idle ticks/day. Operator-
    # triggered sweeps emit unconditionally via Operator.reap_visitors/1
    # because operators care that "I clicked the button and
    # something happened, even if nothing was expired."
    case n do
      0 ->
        :ok

      _ ->
        Logger.info("reaper swept expired visitors", affected: n)
        :ok = AdminEvents.record(AdminWire.reaper_swept(n))
    end

    {:noreply, state}
  end

  defp schedule_tick(interval), do: Process.send_after(self(), :tick, interval)
end
