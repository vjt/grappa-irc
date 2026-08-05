defmodule Grappa.Session do
  @moduledoc """
  Public facade for the per-(subject, network) IRC session GenServer
  (`Grappa.Session.Server`). Callers spawn sessions via
  `start_session/3` and look them up by `(subject, network_id)` via
  `whereis/2`.

  ## Subject-tuple identity (Task 6.5)

  A `subject` is a tagged tuple — `{:user, Ecto.UUID.t()}` or
  `{:visitor, Ecto.UUID.t()}` — that identifies who owns the session.
  Both halves of the registry key are internal identifiers (the
  tagged UUID + the integer network FK) that every authn'd request
  handler already has on `conn.assigns`. Sessions for the same
  `network_id` but different subject kinds (a real user and a
  self-service visitor on the same upstream network) coexist on the
  shared `Grappa.SessionRegistry` without key collision — the tag is
  the discriminator.

  Sessions are registered in `Grappa.SessionRegistry` (a `:unique`
  Registry declared in the application supervision tree) under the
  key `{:session, subject, network_id}`. They run as `:transient`
  children of `Grappa.SessionSupervisor` (a `DynamicSupervisor`), so
  abnormal exits trigger a restart while clean shutdowns do not.

  This module is intentionally thin — no business logic. It exists to:

    1. Centralize the registry-key shape so callers don't reinvent it
       (the via-tuple lives in `Grappa.Session.Server`).
    2. Hide the `DynamicSupervisor` + `child_spec` plumbing from
       `Grappa.Bootstrap` and from any future REST/WS surface that
       wants to inspect or terminate a session.

  ## Cluster 2 — A2 cycle inversion

  `start_session/3` takes `(subject, network_id, opts)` where `opts`
  is the fully-resolved primitive plan — no `Credential` / `Network`
  / `Server` / `Visitor` struct refs cross the Session boundary.
  `Grappa.Networks.SessionPlan.resolve/1` (user-side) and
  `Grappa.Visitors.SessionPlan.resolve/1` (visitor-side) are the
  canonical producers of that plan; `Bootstrap` threads the resolved
  opts in. The Server's `init/1` is therefore a pure data consumer
  (no `Repo`, no `Networks`, no `Accounts`, no `Visitors` reads),
  which keeps the Session boundary deps minimal.
  """

  # `Server` is exported for the test path only — `server_test.exs`
  # tweaks per-module log level via `Logger.put_module_level/2`.
  # Runtime callers go through this facade (`start_session/3`,
  # `send_*`, `whereis/2`).
  use Boundary,
    top_level?: true,
    deps: [
      Grappa.ChannelDirectory,
      Grappa.IRC,
      Grappa.Log,
      Grappa.Mentions,
      # #543 INC-6 — Session.Server acquires/releases the derived source alias
      # around the upstream connect. A Session→Net edge (forward): the manager
      # takes NO Session dep (its live-holder source is an injected fn), so no
      # Boundary cycle.
      Grappa.Net.SourceAliasManager,
      Grappa.PubSub,
      Grappa.Push,
      Grappa.QueryWindows,
      Grappa.ReadCursor,
      Grappa.Scrollback,
      Grappa.SessionLog,
      Grappa.Subject,
      Grappa.Notify,
      Grappa.UserSettings,
      Grappa.Version,
      Grappa.WindowCounts
    ],
    exports: [Backoff, Server, Wire]

  alias Grappa.IRC.{AuthFSM, CTCP, Identifier}
  alias Grappa.Session.Server

  require Logger

  # `stop_session/2` synchronisation budgets. The `:DOWN` window is the
  # OTP `terminate_child` round-trip plus a `terminate/2` callback ceiling;
  # the Registry-unregister window is the BEAM scheduler swap to drain the
  # Registry process's own `{:DOWN, ...}` mailbox entry — a CORPSE-only
  # wait since #854. A key held by a *live* pid is not cleanup lag, it is
  # a supervisor restart that refilled the key, and no amount of polling
  # frees it; pre-#854 the poll could not tell the two apart, so it burned
  # its full 500 ms against a restarted session and then returned `:ok`
  # with its post-condition unmet (measured: 63 leaked sessions across a
  # 15-run batch, plateau band tracking this constant).
  @stop_down_timeout_ms 5_000
  @registry_unregister_attempts 100
  @registry_unregister_poll_ms 5

  # How many times a stop re-terminates a key that a restart refilled
  # under it. One round covers the measured case (an abnormal exit
  # restarts the child exactly once); the spares cover a restart that
  # lands after `flush_pending_restarts/0`. Bounded on purpose: a session
  # respawning faster than we can stop it must end in a loud log, not an
  # unbounded chase.
  @stop_chase_rounds 3

  @typedoc """
  Tagged identifier for a session owner — a registered user or a
  self-service visitor. The tag is the discriminator on the shared
  `Grappa.SessionRegistry` so `(user, network_id)` and
  `(visitor, network_id)` for the same `network_id` and even the
  same UUID never collide.
  """
  @type subject :: {:user, Ecto.UUID.t()} | {:visitor, Ecto.UUID.t()}

  @typedoc """
  REV-E (H11): the dead-socket / closed-mid-write error shape that any
  `Session.send_*` wrapper can return once the Session.Server's
  underlying `IRC.Client.send_*` call observes a dead socket. Mirrors
  the transport-error half of `IRC.Client`'s `send_result` type —
  all atoms (`:inet.posix()` per OTP is a set of atom error codes
  like `:einval`). Pre-REV-E this shape was hidden by `:ok =
  Client.send_*` strict-binds that MatchError-crashed Session.Server;
  post-REV-E it propagates cleanly through the wrappers to whichever
  caller surfaces upstream send failures (controllers map to 5xx;
  GrappaChannel's `dispatch_subject_verb` maps to a typed
  `upstream_unavailable` reply).
  """
  @type send_transport_error :: :no_socket | :closed | :inet.posix()

  @typedoc """
  Per-channel member entry as returned by `list_members/3`. The
  per-row shape is the canonical contract that the WS
  `members_seeded` event AND the REST `/members` snapshot both
  surface — `GrappaWeb.MembersJSON` and `Grappa.Session.Wire.members_seeded/3`
  rely on it.
  """
  @type member :: %{nick: String.t(), modes: [String.t()]}

  defguardp is_subject(s)
            when is_tuple(s) and tuple_size(s) == 2 and
                   (elem(s, 0) == :user or elem(s, 0) == :visitor) and
                   is_binary(elem(s, 1))

  @typedoc """
  Pre-resolved primitive opts consumed by `start_session/3` and
  `Grappa.Session.Server`'s `init/1` callback.

  Produced canonically by `Grappa.Networks.SessionPlan.resolve/1`
  (user) or `Grappa.Visitors.SessionPlan.resolve/1` (visitor); the
  field set is the single source of truth for what the Session
  boundary needs to start an upstream IRC connection — adding a
  field requires extending this type AND the producing
  `SessionPlan.resolve/1` AND the Server state struct in lockstep.

  `subject_label` is the opaque PubSub topic root — `user.name` for
  users, `"visitor:" <> visitor.id` for visitors. The Topic module
  treats it as an opaque string so the topic shape stays unchanged
  regardless of subject kind.
  """
  @type start_opts :: %{
          required(:subject) => subject(),
          required(:subject_label) => String.t(),
          required(:network_slug) => String.t(),
          required(:nick) => String.t(),
          required(:ident) => String.t(),
          required(:realname) => String.t(),
          required(:sasl_user) => String.t(),
          required(:auth_method) => AuthFSM.auth_method(),
          required(:password) => String.t() | nil,
          required(:autojoin_channels) => [String.t()],
          required(:host) => String.t(),
          required(:port) => :inet.port_number(),
          required(:tls) => boolean(),
          required(:source_address) => String.t() | nil,
          # #543 INC-6 — the derived `::cb` source alias the session acquires/
          # releases for its upstream lifetime (equals `source_address` when
          # derived), or absent/nil for a non-derived source. Set by
          # `Networks.SessionPlan.base_plan/6` via `Vhosts.derived_source?/2`.
          optional(:managed_source_alias) => String.t() | nil,
          optional(:notify_pid) => pid(),
          optional(:notify_ref) => reference(),
          optional(:visitor_committer) => Server.visitor_committer(),
          optional(:visitor_password_rotator) => Server.visitor_password_rotator(),
          optional(:visitor_nick_persister) => Server.visitor_nick_persister(),
          optional(:credential_failer) => Server.credential_failer(),
          optional(:credential_committer) => Server.credential_committer(),
          optional(:registration_committer) => Server.registration_committer(),
          optional(:last_joined_persister) => Server.last_joined_persister(),
          # #581 — visitor-only /recover secret reader (the visitor plan injects
          # it; user plans omit it). Twin of the `init_opts` entry in
          # `Grappa.Session.Server` — MUST stay in sync (a build_plan map with a
          # key absent here fails `resolve/2`'s `{:ok, start_opts()}` spec →
          # dialyzer `missing_range` cascade across every resolve consumer).
          optional(:recover_source) => Server.recover_source(),
          # GH #417 — persist/restore the EXPLICIT away across crash/reconnect
          # (user-only; the visitor plan omits both). Kept in sync with the
          # `Grappa.Session.Server.start_opts/0` twin.
          optional(:away_persister) => Server.away_persister(),
          optional(:restored_away) => Server.restored_away(),
          optional(:refresh_plan) => Server.refresh_plan_check(),
          # GH #189 / #509 — on-connect perform list + its `$oper_pass` /
          # `$nickserv_pass` secrets, decrypted plaintext from the credential
          # (nil when unset). Set by `SessionPlan.base_plan/6` for BOTH
          # subjects; run at 001 by `Session.Server` before the built-in
          # identify and before autojoin. `nickserv_pass` is the FIRST source
          # for `$nickserv_pass` / the built-in identify, decoupled from
          # `auth_method` (#509).
          optional(:perform_list) => String.t() | nil,
          optional(:oper_pass) => String.t() | nil,
          optional(:nickserv_pass) => String.t() | nil
        }

  @doc """
  Spawns a `Grappa.Session.Server` under `Grappa.SessionSupervisor`
  for `(subject, network_id)` with the pre-resolved `opts` plan.

  Returns whatever `DynamicSupervisor.start_child/2` returns —
  `{:ok, pid}` on success, `{:error, {:already_started, pid}}` if a
  session for the same key is already registered, or `{:error,
  reason}` on init failure (upstream connection refused, etc.).

  The positional `subject` argument is validated against
  `opts.subject` — they must match. The redundancy is intentional:
  the second positional keeps signature symmetry with
  `whereis/2` / `stop_session/2` / `send_*`, which don't take an
  opts map and so can't carry the subject inside one.
  """
  @spec start_session(subject(), integer(), start_opts()) ::
          DynamicSupervisor.on_start_child()
  def start_session(subject, network_id, opts)
      when is_subject(subject) and is_integer(network_id) and is_map(opts) do
    ^subject = Map.fetch!(opts, :subject)

    # #671 — inject the boot-resolved auto-away debounce at the single
    # spawn choke point (the CLAUDE.md start_link-opts pattern for a
    # dynamically-spawned GenServer: boot reads env → persistent_term →
    # the spawn boundary injects). `put_new` so a caller/test that already
    # set the key (a substituted short window) wins.
    full_opts =
      opts
      |> Map.put(:network_id, network_id)
      |> Map.put_new(:auto_away_debounce_ms, Server.auto_away_debounce_ms())

    DynamicSupervisor.start_child(
      Grappa.SessionSupervisor,
      {Server, full_opts}
    )
  end

  @doc """
  Returns the pid of the session for `(subject, network_id)`, or
  `nil` if no such session is registered.
  """
  @spec whereis(subject(), integer()) :: pid() | nil
  def whereis(subject, network_id) when is_subject(subject) and is_integer(network_id) do
    case Registry.lookup(Grappa.SessionRegistry, Server.registry_key(subject, network_id)) do
      [{pid, _}] -> pid
      [] -> nil
    end
  end

  @doc """
  Every derived `::cb` source alias currently held by a live `Session.Server`
  on this node, de-duplicated (#543 INC-6).

  Each session that binds a derived source registers itself under that address
  in the `Grappa.SourceAliasHolders` `:duplicate` Registry (many NAT-collapsed
  sessions sharing one `/64` → many entries under one address key), and the
  BEAM auto-removes the entry when the session dies. This is a PURE ETS read —
  no per-pid `GenServer.call`, so no timeout window and no wedged-mailbox blind
  spot: it cannot mis-report a live holder as gone.

  `Grappa.Net.SourceAliasManager` reads this (via the injected `held_source_fn`)
  at reconcile to rebuild its held set AFTER its own restart, so a manager
  crash never releases an alias out from under a live upstream socket. INC-7's
  prefix-impact scan reuses it as the single live-holder source.
  """
  @spec live_derived_sources() :: [String.t()]
  def live_derived_sources do
    Grappa.SourceAliasHolders
    |> Registry.select([{{:"$1", :_, :_}, [], [:"$1"]}])
    |> Enum.uniq()
  end

  @doc """
  Triggers an upstream `LIST` channel-directory refresh on the live
  session for `(subject, network_id)` (#84).

  The Session.Server puts `LIST` on the wire, nukes the prior
  `Grappa.ChannelDirectory` snapshot, and arms a watchdog timer; the
  streamed 321/322/323 numerics repopulate the snapshot (captured by a
  later task). Returns `:ok` once the refresh is in flight.

  Distinct from the `call_session/*` facades: a missing session pid maps
  to `{:error, :not_connected}` (not `:no_session`) — the directory
  surface only cares whether there's a live upstream to `LIST`, and the
  Server returns the SAME `:not_connected` when the pid exists but the
  IRC socket isn't up yet (`client: nil`). `{:error, :already_refreshing}`
  guards against a concurrent refresh: the in-flight tracker is single-slot
  per session.
  """
  @spec refresh_directory(subject(), integer()) ::
          :ok | {:error, :not_connected | :already_refreshing}
  def refresh_directory(subject, network_id)
      when is_subject(subject) and is_integer(network_id) do
    case whereis(subject, network_id) do
      nil -> {:error, :not_connected}
      pid -> GenServer.call(pid, :refresh_directory)
    end
  end

  @doc """
  #581 — starts the visitor "recover my identity" sequence for
  `(subject, network_id)`: `IDENTIFY` the credential nick → wait for the
  `+r` umode → `NICK` to it (with a `RECOVER`/`RELEASE` detour if it's
  held). The ONE action path both `/recover` and the home button ride
  (A3). Acks immediately; the multi-step outcome arrives asynchronously
  as `recover_progress`/`recover_result` events on the user topic (A1) —
  this call never blocks for the sequence.

  Gating (the Server enforces, being the authority on live state):
  visitor subjects only (`:not_visitor` otherwise); a recoverable
  credential must exist (`:nothing_to_recover` — never blind-`IDENTIFY`,
  #561 pt3); an already-`+r` session has nothing to do
  (`:already_identified`); a concurrent attempt is refused
  (`:in_progress`). A missing live pid maps to `:not_connected` (same as
  `refresh_directory/2`: no upstream, nothing to recover against).
  """
  @spec recover_identity(subject(), integer()) ::
          :ok
          | {:error, :not_connected | :not_visitor | :nothing_to_recover | :already_identified | :in_progress}
  def recover_identity(subject, network_id)
      when is_subject(subject) and is_integer(network_id) do
    case whereis(subject, network_id) do
      nil -> {:error, :not_connected}
      pid -> GenServer.call(pid, :recover_identity)
    end
  end

  @doc """
  Stops the running `Grappa.Session.Server` for `(subject, network_id)`,
  if any. Idempotent: returns `:ok` whether or not a session was
  registered for the key.

  The post-condition is about the KEY, not about one pid: on return no
  session is registered for `(subject, network_id)` — including one a
  `:transient` restart spawned while the stop was running (#854). When
  even that cannot be achieved (something respawns the session faster
  than `@stop_chase_rounds` terminate rounds can remove it) the return
  stays `:ok` — every caller pattern-matches it and none can recover —
  but the unmet post-condition is a `Logger.error`, never silence.

  Used by `Grappa.Networks.Credentials.unbind_credential/2` to tear
  down the GenServer BEFORE the credential row is deleted (S29 H5).
  Without this, an unbind would leave the GenServer running with
  cached `state.network_id` pointing at a deleted FK; the next
  outbound PRIVMSG crashes the server, the `:transient` policy
  restarts it, init fails to load the credential row, and the cycle
  repeats every retry until something else clears the registry.
  """
  @spec stop_session(subject(), integer()) :: :ok
  def stop_session(subject, network_id) when is_subject(subject) and is_integer(network_id) do
    do_stop_session(subject, network_id)
  end

  @doc """
  Same as `stop_session/2`, but sends `QUIT :<quit_reason>` upstream
  BEFORE the supervisor stop so the peer IRC server sees a descriptive
  quit message (`vjt has quit (visitor session expired)`) instead of the
  generic `Session.Server.terminate/2` shutdown fallback
  (`grappa shutting down`, which is reserved for true bouncer-wide
  shutdown — SIGTERM, `Application.stop`).

  `Session.Server.terminate/2` still fires its own QUIT for the no-
  pre-QUIT path (`stop_session/2`), but uses the static `"grappa
  shutting down"` line. Whenever the caller knows WHY the session is
  stopping — visitor TTL reaper, web logout, admin delete-visitor,
  visitor relogin replacing a prior row — use this variant so the
  upstream message reflects intent.

  Best-effort pre-QUIT: a `:no_session` is the happy case (no live pid
  is the whole point of the stop), and a transport error (`:no_socket`,
  `:closed`, an `:inet.posix/0` atom, or `:timeout` from the GenServer
  call) means the socket already broke before we got here — all swallow
  and the supervisor stop still runs.

  `:invalid_line` is NOT swallowed: it means the caller passed bytes
  that fail `Identifier.safe_line_token?/1` (CR/LF/NUL in the reason),
  which is a programming error in the caller, not a runtime condition.
  Mirroring `Operator.best_effort_quit/2`'s loud-fail pattern so a bad
  reason crashes here with a useful match error instead of silently
  reverting to the generic shutdown line.
  """
  @spec stop_session(subject(), integer(), String.t()) :: :ok
  def stop_session(subject, network_id, quit_reason)
      when is_subject(subject) and is_integer(network_id) and is_binary(quit_reason) do
    case send_quit(subject, network_id, quit_reason) do
      :ok -> :ok
      {:error, :no_session} -> :ok
      {:error, transport} when transport != :invalid_line and is_atom(transport) -> :ok
    end

    do_stop_session(subject, network_id)
  end

  defp do_stop_session(subject, network_id) do
    stop_registered(subject, network_id, @stop_chase_rounds)
  end

  # The post-condition is about the KEY ("no session is registered for
  # `(subject, network_id)`"), not about the pid we happened to look up.
  # `Session.Server` is `restart: :transient`, so an abnormal exit — the
  # 433 ladder's `{:client_exit, {:nick_rejected, 433, _}}` is the
  # measured one (#854) — makes `Grappa.SessionSupervisor` restart the
  # child, and the restarted child re-registers the SAME key from inside
  # `GenServer.start_link/3`. Terminating one pid therefore does not free
  # the key: each round re-reads the key and terminates whoever holds it
  # now, and the last round says so out loud if the key is still taken.
  defp stop_registered(subject, network_id, rounds_left) do
    flush_pending_restarts()

    case {whereis(subject, network_id), rounds_left} do
      {nil, _} ->
        :ok

      {pid, 0} ->
        # CLAUDE.md "No silent-swallow at boundaries", and the sibling
        # `:DOWN`-timeout path below already does exactly this. Pre-#854
        # this case returned a bare `:ok`: a session survived its own
        # tear-down and nothing anywhere said so.
        Logger.error(
          "stop_session post-condition FAILED — a session is STILL registered after " <>
            "#{@stop_chase_rounds} terminate rounds; something keeps respawning it " <>
            "(subject=#{inspect(subject)} network_id=#{network_id})",
          pid: inspect(pid)
        )

        :ok

      {pid, rounds} ->
        terminate_and_await_down(pid, subject, network_id)
        wait_until_unregistered(subject, network_id, pid, @registry_unregister_attempts)
        stop_registered(subject, network_id, rounds - 1)
    end
  end

  # A `GenServer.call` into the supervisor is a MAILBOX BARRIER: the
  # supervisor handles its mailbox in order, so any `{:EXIT, child, _}` it
  # has already received — i.e. any `:transient` restart already triggered
  # — is fully applied before this returns, and the restarted child is
  # registered by then (`Session.Server.start_link/1` registers under its
  # `via` name INSIDE `GenServer.start_link/3`, so the supervisor is not
  # done restarting until the key is taken). Without the barrier,
  # `whereis/2` answers `nil` for a key a restart is about to refill
  # microseconds later and the stop returns `:ok` having freed nothing
  # (#854). `count_children/1` is the cheapest such call — the result is
  # deliberately unused, the round-trip IS the point.
  defp flush_pending_restarts do
    _ = DynamicSupervisor.count_children(Grappa.SessionSupervisor)
    :ok
  end

  defp terminate_and_await_down(pid, subject, network_id) do
    # Monitor BEFORE terminate so we never miss the DOWN — even if
    # the child dies between `whereis` and the monitor, the receive
    # below gets an immediate DOWN with reason `:noproc`.
    ref = Process.monitor(pid)

    # `terminate_child` returns `:ok | {:error, :not_found}` for a
    # `DynamicSupervisor` (the `:simple_one_for_one` error tag is
    # impossible here — only plain Supervisor in legacy strategy
    # mode emits it). The `:not_found` branch covers the race where
    # the child died between `whereis` and this call; treat both
    # branches as success since the post-condition (no session for
    # the key) is what we promise. Pattern-match explicitly so an
    # unexpected return shape from a future OTP would crash.
    case DynamicSupervisor.terminate_child(Grappa.SessionSupervisor, pid) do
      :ok -> :ok
      {:error, :not_found} -> :ok
    end

    receive do
      {:DOWN, ^ref, :process, ^pid, _} -> :ok
    after
      @stop_down_timeout_ms ->
        # A Session that refuses to die within the budget is a
        # genuine bug (stuck `terminate/2`, runaway loop, link
        # cycle). Surface it via Logger.error — silent timeout
        # would leave the next `start_session/3` racing a zombie
        # `:already_started` against the Registry. CLAUDE.md "Use
        # infrastructure, don't bypass it." `:subject` and
        # `:network_id` are NOT in the Logger metadata allowlist
        # (see `config/config.exs`'s memory-pinned constraint —
        # canonical session context uses `:user` = subject_label
        # and `:network` = network_slug, threaded by
        # `Log.set_session_context/2`). Inline into message body
        # so allowlist stays tight.
        Logger.error(
          "session refused to die within #{@stop_down_timeout_ms}ms stop budget — " <>
            "escalating to Process.exit :kill " <>
            "(subject=#{inspect(subject)} network_id=#{network_id})",
          pid: inspect(pid)
        )

        # spec-audit cascade hunt (2026-05-26): pre-fix the function
        # demonitored and returned :ok WITHOUT killing the pid.
        # CI run 26445436191 traced the AdminEventsTest cascade
        # back here — visitor login_test's stop_session returned
        # :ok despite the Session.Server still alive in
        # reconnect-backoff (Client GenServer.call inside
        # terminate/2 hangs ~5s on a wedged socket). The zombie
        # then poisoned the SessionRegistry that the next
        # singleton-lane test (AdminEventsTest) drains in setup,
        # cascading 10+ unrelated failures.
        #
        # Fix: escalate to Process.exit/2 :kill — bypasses
        # terminate/2, guarantees the pid dies. Re-wait briefly
        # for the :DOWN so the Registry's own monitor cleanup
        # has a chance to fire before we return, then proceed to
        # wait_until_unregistered/3 below (which polls anyway).
        #
        # Note: this changes the post-condition of stop_session/2
        # from "process MAY still be alive (with Logger.error
        # noise) after 5s timeout" to "process WILL be dead". No
        # caller relied on the zombie-alive case as a feature —
        # the prior shape was always a bug.
        Process.exit(pid, :kill)

        receive do
          {:DOWN, ^ref, :process, ^pid, _} -> :ok
        after
          1_000 ->
            # :kill is unmaskable; if we somehow still don't get
            # :DOWN, the monitor itself is wedged (BEAM bug
            # territory). Demonitor + proceed; downstream
            # wait_until_unregistered/3 will surface the leak.
            Process.demonitor(ref, [:flush])
            :ok
        end
    end
  end

  # `Process.monitor` DOWN guarantees `stopped_pid` is dead, but
  # `Grappa.SessionRegistry`'s OWN monitor on it runs in the Registry
  # process — it may not have unregistered the corpse yet. Spin a tiny
  # `Registry.lookup`-poll until the entry is gone or the budget expires;
  # without this, callers chaining `stop_session/2` → `start_session/3`
  # race a transient `:already_started` shape backed by a dead pid.
  #
  # #854: a DIFFERENT pid on the key is NOT that cleanup lag — it is a
  # `:transient` restart that refilled the key while we were stopping its
  # predecessor. Polling can never outlast a live holder, so return at
  # once and let `stop_registered/3` terminate the newcomer. Pre-fix this
  # clause was `_ ->` and the two cases were indistinguishable: the stop
  # slept out its whole budget against a session that was very much alive,
  # then reported success.
  defp wait_until_unregistered(_, _, _, 0), do: :ok

  defp wait_until_unregistered(subject, network_id, stopped_pid, attempts) do
    case whereis(subject, network_id) do
      nil ->
        :ok

      ^stopped_pid ->
        Process.sleep(@registry_unregister_poll_ms)
        wait_until_unregistered(subject, network_id, stopped_pid, attempts - 1)

      _ ->
        :ok
    end
  end

  @doc """
  Sends a PRIVMSG upstream through the session for `(subject,
  network_id)`. For non-services targets, persists a
  `Grappa.Scrollback.Message` row with `sender = session.nick`,
  broadcasts on the per-channel PubSub topic, AND writes to the
  upstream socket — atomic from the caller's view.

  PRIVMSG to a *Serv-suffixed target (NickServ / ChanServ /
  MemoServ / OperServ / BotServ / HostServ / HelpServ — the
  universal IRC services nick convention) is wire-only: the body
  is sent upstream but NOT persisted to scrollback and NOT
  broadcast over PubSub. This avoids leaking passwords (W12) and
  keeps services traffic out of the scrollback DB. The reply for
  this case is `{:ok, :no_persist}`.

  Returns `{:ok, message}` with the persisted row on success for
  channel targets, `{:ok, :no_persist}` for *Serv targets,
  `{:error, :no_session}` if no session is registered,
  `{:error, :invalid_line}` if target/body fail CRLF/NUL safety,
  or `{:error, Ecto.Changeset.t()}` on validation failure of the
  scrollback row insert.

  ## Telemetry (#357 D1)

  Emits `[:grappa, :session, :send_privmsg, :start | :stop | :exception]` via
  `:telemetry.span/3` around the `GenServer.call` round-trip. Because the span
  runs in the CALLER's process and the call blocks until the reply, its `:stop`
  `duration` is the TOTAL send latency INCLUDING the mailbox queue-wait behind
  synchronous inbound inserts (mechanism 1). Paired with the "pure insert"
  `[:grappa, :scrollback, :persist, :stop]` span (see
  `Grappa.Scrollback.Telemetry`), the gap is the head-of-line blocking. Stop
  metadata: `%{network_id, target, subject, outcome}`. The span is skipped for
  a line rejected by the CRLF/NUL guard (no send happened).
  """
  @spec send_privmsg(subject(), integer(), String.t(), String.t()) ::
          {:ok, Grappa.Scrollback.Message.t()}
          | {:ok, :no_persist}
          | {:error, :no_session | :invalid_line | send_transport_error()}
          | {:error, Ecto.Changeset.t()}
  def send_privmsg(subject, network_id, target, body)
      when is_subject(subject) and is_integer(network_id) and is_binary(target) and
             is_binary(body) do
    # CRLF/NUL check fires BEFORE the registry lookup so an injection
    # attempt against a non-existent session still surfaces as
    # :invalid_line — input-shape error beats not-found. The Scrollback
    # row is never persisted on rejection (the call_session never runs).
    if Identifier.safe_line_token?(target) and Identifier.safe_line_token?(body) do
      # #537 — the `target` ships RAW (wire stays as-typed); the Session.Server
      # folds the persist/broadcast KEY network-aware (only it knows the
      # network's CASEMAPPING from 005). The telemetry tag reports the raw
      # target as-sent.

      # #357 D1 — the "total send" half of the split-span pair. The span
      # wraps the `GenServer.call` round-trip, so its duration INCLUDES the
      # time the call sat in the `Session.Server` mailbox behind synchronous
      # inbound inserts (mechanism 1, head-of-line blocking) — a gap the
      # "pure insert" scrollback span cannot see. It runs in the CALLER's
      # process (controller / channel), NOT the session hot loop, so it adds
      # zero cost to message handling. Placed AFTER the injection guard so a
      # rejected line never opens a meaningless zero-work span.
      metadata = %{network_id: network_id, target: target, subject: subject_kind(subject)}

      :telemetry.span(
        [:grappa, :session, :send_privmsg],
        metadata,
        fn ->
          result = call_session(subject, network_id, {:send_privmsg, target, body})
          # `:telemetry.span` drops start metadata from `:stop` — repeat the
          # tag map (+ outcome) so the STOP event stays target-tagged.
          {result, Map.put(metadata, :outcome, send_outcome(result))}
        end
      )
    else
      {:error, :invalid_line}
    end
  end

  @doc """
  #640 — sends the operator's own outbound CTCP QUERY (`/ctcp`, `/ping`) and
  self-echoes it into the SOURCE window, NEVER a query window for the wire
  recipient.

  `source` is the display/persist window the command was typed in (cic's URL
  `channel_id`); `ctcp_target` is the wire recipient. The Session.Server relays
  `PRIVMSG <ctcp_target> :<body>` upstream, persists the echo keyed to `source`
  with `dm_with: nil` + `meta.ctcp_target`, and does NOT auto-open a query
  window — that server-side auto-open (`handle_persisting_send`) is exactly the
  phantom target window #640 reports.

  `{:error, :invalid_line}` when `source`/`ctcp_target`/`body` carry CRLF/NUL,
  or when `body` is not a non-ACTION CTCP frame (a plain PRIVMSG must go through
  `send_privmsg/4`; a `/me` ACTION rides its own kind). `{:error, :no_session}`
  when no live session. On success `{:ok, %Scrollback.Message{}}` — always
  persisted (no `:no_persist` arm: the source echo is the whole point, even for
  a services recipient, which never opened a window either).
  """
  @spec send_ctcp(subject(), integer(), String.t(), String.t(), String.t()) ::
          {:ok, Grappa.Scrollback.Message.t()}
          | {:error, :no_session | :invalid_line | send_transport_error()}
          | {:error, Ecto.Changeset.t()}
  def send_ctcp(subject, network_id, source, ctcp_target, body)
      when is_subject(subject) and is_integer(network_id) and is_binary(source) and
             is_binary(ctcp_target) and is_binary(body) do
    # Injection + shape gates fire BEFORE the registry lookup (mirror
    # send_privmsg/4): a malformed line against a non-existent session still
    # surfaces as :invalid_line, and the row is never persisted on rejection.
    # `body` MUST be a non-ACTION CTCP frame — ctcp_target is meaningless for a
    # plain PRIVMSG (use send_privmsg/4) or a /me ACTION (rides its own kind).
    if Identifier.safe_line_token?(source) and Identifier.safe_line_token?(ctcp_target) and
         Identifier.safe_line_token?(body) and ctcp_query?(body) do
      call_session(subject, network_id, {:send_ctcp, source, ctcp_target, body})
    else
      {:error, :invalid_line}
    end
  end

  # #640 — a CTCP QUERY frame: `\x01VERB[ args]\x01` where VERB is not ACTION
  # (/me's ACTION rides its own :action kind, never a ctcp_target send). The
  # discriminant is the shared SSOT `Grappa.IRC.CTCP.verb_args/1`, so this
  # facade gate and the Session.Server meta tag agree on what "is a CTCP query."
  @spec ctcp_query?(binary()) :: boolean()
  defp ctcp_query?(body) do
    case CTCP.verb_args(body) do
      {"ACTION", _} -> false
      {_, _} -> true
      :none -> false
    end
  end

  @doc """
  Queues a JOIN upstream through the session. **Synchronous call** — the
  Session.Server processes the message inline: writes
  `window_states[ch] = :pending` AND broadcasts `window_pending` on the
  user-level PubSub topic BEFORE returning. cic's setPending dispatch
  fires (and the synthetic sidebar row appears) by the time the REST
  controller returns 202. The actual upstream socket write
  (`Client.send_join` → `:gen_tcp.send`) is itself a `GenServer.call`
  that the Session.Server issues inside the same handler, but that
  blocking is what we WANT — backpressure surfaces synchronously
  instead of letting cic see "still pending" while the cast sits in
  the mailbox queue.

  Pre-bucket-`post-cr-review-phase1` this was a cast: REST returned 202
  in <30ms and the `window_pending` broadcast was delayed by the
  Session.Server mailbox queue. Under CI load, that queue routinely
  stretched to >5s, which made cp15-b6-kicked.spec.ts time out at line
  71 (`expect(row).toHaveCount(1, { timeout: 5_000 })`) — the synthetic
  pseudo-row never rendered because cic never received `window_pending`
  in the test's polling window. Converting to call makes the broadcast
  observable on the test's wall clock per CLAUDE.md "fix root causes"
  rule and CLAUDE.md "no parallel client-side state machine" — cic
  MUST see the server-driven pending state before the test polls.

  `{:error, :no_session}` if not registered. `{:error, :invalid_line}`
  if the channel name fails IRC-shape gates (CRLF/NUL or non-`#`/`&`
  prefix) OR the key contains CR/LF/NUL/space. Returns `:ok` once the
  broadcast has fired.

  UX-4 bucket F — `key` is the optional +k channel key. Pass `nil`
  (or `""`, normalised) for keyless channels. The key never reaches
  scrollback or storage; it's only forwarded to the upstream JOIN
  wire frame. Server-side 475 ERR_BADCHANNELKEY (when the key is
  wrong/missing) flows through the existing join-failure numeric
  pipeline → `:join_failed` event with numeric=475.
  """
  @spec send_join(subject(), integer(), String.t(), String.t() | nil) ::
          :ok | {:error, :no_session | :invalid_line | send_transport_error()}
  def send_join(subject, network_id, channel, key)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) and
             (is_nil(key) or is_binary(key)) do
    # #382 — split the RFC1459 comma-separated channel list, validate EACH
    # element's IRC shape, and forward ONE `{:send_join, [channels], key}`
    # message. A name with no comma is a list-of-one. Fail the WHOLE line if
    # ANY element is malformed (no partial JOIN). #537 — the elements ship
    # RAW (wire stays as-typed); the Session.Server folds each window KEY
    # network-aware in `record_in_flight_join/2` (only it knows CASEMAPPING).
    with true <- safe_join_key?(key),
         {:ok, channels} <- validate_join_channels(String.split(channel, ",")) do
      call_session(subject, network_id, {:send_join, channels, normalize_join_key(key)})
    else
      _ -> {:error, :invalid_line}
    end
  end

  # Recursive collect-or-bail traverse (CLAUDE.md pattern) over the split
  # channel list: validate each element's IRC shape and accumulate it RAW,
  # or bail on the first malformed member (#537 — the fold moved server-side).
  @spec validate_join_channels([String.t()]) :: {:ok, [String.t()]} | {:error, :invalid_line}
  defp validate_join_channels(channels), do: validate_join_channels(channels, [])
  defp validate_join_channels([], acc), do: {:ok, Enum.reverse(acc)}

  defp validate_join_channels([channel | rest], acc) do
    if Identifier.safe_line_token?(channel) and Identifier.valid_channel?(channel) do
      validate_join_channels(rest, [channel | acc])
    else
      {:error, :invalid_line}
    end
  end

  # Empty-string key is normalised to nil so the wire shape matches the
  # `nil` clause (no trailing key param). Mirrors `Client.send_join/3`.
  defp normalize_join_key(""), do: nil
  defp normalize_join_key(other), do: other

  defp safe_join_key?(nil), do: true
  defp safe_join_key?(""), do: true

  defp safe_join_key?(key) when is_binary(key) do
    Identifier.safe_line_token?(key) and not String.contains?(key, [" ", "\t"])
  end

  @doc """
  Queues a PART upstream through the session. Cast (see `send_join/4`
  for the rationale). `{:error, :no_session}` if not registered.
  """
  @spec send_part(subject(), integer(), String.t()) ::
          :ok | {:error, :no_session | :invalid_line | send_transport_error()}
  def send_part(subject, network_id, channel)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) do
    if Identifier.safe_line_token?(channel) and Identifier.valid_channel?(channel) do
      cast_session(subject, network_id, {:send_part, channel})
    else
      {:error, :invalid_line}
    end
  end

  @doc """
  Sets the topic on `channel` for the session's `(subject, network_id)`.
  Writes `TOPIC <chan> :<body>` upstream; the upstream server echoes the
  TOPIC back and `EventRouter` persists the canonical `:topic` scrollback
  row + broadcasts on the per-channel PubSub topic (single-write path —
  closes #22 duplicate-display).

  Returns `:ok`, `{:error, :no_session}`, or `{:error, :invalid_line}`.
  """
  @spec send_topic(subject(), integer(), String.t(), String.t()) ::
          :ok | {:error, :no_session | :invalid_line | send_transport_error()}
  def send_topic(subject, network_id, channel, body)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) and
             is_binary(body) do
    if Identifier.safe_line_token?(channel) and Identifier.safe_line_token?(body) do
      call_session(subject, network_id, {:send_topic, channel, body})
    else
      {:error, :invalid_line}
    end
  end

  @doc """
  Sends `NICK <new>` upstream for the session's `(subject, network_id)`.
  No scrollback row written here — the upstream replays the NICK back
  and `EventRouter` reconciles `state.nick` + emits per-channel
  `:nick_change` persist effects.

  Returns `:ok`, `{:error, :no_session}`, or `{:error, :invalid_line}`.
  """
  @spec send_nick(subject(), integer(), String.t()) ::
          :ok | {:error, :no_session | :invalid_line | send_transport_error()}
  def send_nick(subject, network_id, new_nick)
      when is_subject(subject) and is_integer(network_id) and is_binary(new_nick) do
    if Identifier.safe_line_token?(new_nick) do
      call_session(subject, network_id, {:send_nick, new_nick})
    else
      {:error, :invalid_line}
    end
  end

  @doc """
  Sends `OPER <name> <password>` upstream for the session's
  `(subject, network_id)`. Both fields go through
  `Identifier.safe_oper_token?/1`: non-empty, no whitespace, no
  CR/LF/NUL. Bouncer DOES NOT log the password — the
  `Session.Server` handler emits a static log message body, threading
  only the operator name through the allowlisted `:nick` metadata key.
  Returns `:ok`, `{:error, :no_session}`, or `{:error, :invalid_line}`
  if either field violates the safe-oper-token predicate.

  Bundle C (#20 follow-up): /oper slash-command implementation.
  """
  @spec send_oper(subject(), integer(), String.t(), String.t()) ::
          :ok | {:error, :no_session | :invalid_line | send_transport_error()}
  def send_oper(subject, network_id, name, password)
      when is_subject(subject) and is_integer(network_id) and is_binary(name) and
             is_binary(password) do
    if Identifier.safe_oper_token?(name) and Identifier.safe_oper_token?(password) do
      call_session(subject, network_id, {:send_oper, name, password})
    else
      {:error, :invalid_line}
    end
  end

  @doc """
  Sends a raw IRC line upstream for the session's `(subject,
  network_id)` — `/quote` escape hatch. The line is shipped verbatim
  with a trailing `\\r\\n`; the IRC server is authoritative on
  whether the verb is valid. Rejects embedded CR/LF/NUL (would let
  callers smuggle additional frames). Returns `:ok`,
  `{:error, :no_session}`, or `{:error, :invalid_line}`.

  Bundle C (#20 follow-up): /quote slash-command implementation.
  """
  @spec send_raw(subject(), integer(), String.t()) ::
          :ok | {:error, :no_session | :invalid_line | send_transport_error()}
  def send_raw(subject, network_id, line)
      when is_subject(subject) and is_integer(network_id) and is_binary(line) do
    if line != "" and Identifier.safe_line_token?(line) do
      call_session(subject, network_id, {:send_raw, line})
    else
      {:error, :invalid_line}
    end
  end

  @doc """
  Sends `QUIT :<reason>` upstream for the session's `(subject,
  network_id)`. Synchronous (`call`) so the QUIT byte is on the wire
  BEFORE callers (notably `Grappa.Networks.disconnect/2`) follow up
  with `stop_session/2` — otherwise the abrupt `:shutdown` exit closes
  the linked Client's socket before `Client.send_quit/2` runs and the
  upstream sees a dropped connection without a QUIT line.

  T32 (channel-client-polish S1.2). Returns `:ok`,
  `{:error, :no_session}`, or `{:error, :invalid_line}` (the reason
  string carrying CR/LF/NUL).
  """
  @spec send_quit(subject(), integer(), String.t()) ::
          :ok | {:error, :no_session | :invalid_line | send_transport_error()}
  def send_quit(subject, network_id, reason)
      when is_subject(subject) and is_integer(network_id) and is_binary(reason) do
    if Identifier.safe_line_token?(reason) do
      call_session(subject, network_id, {:send_quit, reason})
    else
      {:error, :invalid_line}
    end
  end

  @doc """
  Sets explicit away status for the session at `(subject, network_id)`.

  Issues `AWAY :<reason>` upstream and transitions `away_state` to
  `:away_explicit`. Explicit always wins — calling this while in
  `:away_auto` overwrites the auto-away without a no-op check. Returns
  `:ok`, `{:error, :no_session}`, or `{:error, :invalid_line}` if the
  reason is empty or contains CR/LF/NUL.

  An **empty** reason is rejected because `AWAY :\r\n` is the bare-AWAY
  un-away line (RFC 2812 §4.6) — accepting it here would silently CLEAR
  the away instead of setting it. `safe_line_token?/1` only screens
  CR/LF/NUL, so the emptiness check is added here (early, before the
  `whereis` lookup) AND mirrored at the `Client.send_away` byte boundary,
  like `send_pong`. A whitespace-only reason is a valid (if blank-looking)
  set and is NOT rejected — only the empty string is the un-away line.
  Clearing away is `unset_explicit_away/2`.

  S3.2 (channel-client-polish). Symmetric with `unset_explicit_away/2`.
  """
  @spec set_explicit_away(subject(), integer(), String.t()) ::
          :ok | {:error, :no_session | :invalid_line | send_transport_error()}
  def set_explicit_away(subject, network_id, reason)
      when is_subject(subject) and is_integer(network_id) and is_binary(reason) do
    if reason != "" and Identifier.safe_line_token?(reason) do
      call_session(subject, network_id, {:set_explicit_away, reason})
    else
      {:error, :invalid_line}
    end
  end

  @doc """
  Sets explicit away with an `origin_window` for numeric routing (S4.3).

  Identical to `set_explicit_away/3` but also records the originating
  cicchetto window in Session.Server state so that 305/306 reply numerics
  can be routed back to the correct window via `NumericRouter`.

  `origin_window` is `%{kind: atom(), target: String.t() | nil}`.
  """
  @spec set_explicit_away(subject(), integer(), String.t(), map()) ::
          :ok | {:error, :no_session | :invalid_line | send_transport_error()}
  def set_explicit_away(subject, network_id, reason, origin_window)
      when is_subject(subject) and is_integer(network_id) and is_binary(reason) and
             is_map(origin_window) do
    if reason != "" and Identifier.safe_line_token?(reason) do
      call_session(subject, network_id, {:set_explicit_away, reason, origin_window})
    else
      {:error, :invalid_line}
    end
  end

  @doc """
  Clears explicit away for the session at `(subject, network_id)`.

  Issues bare `AWAY` upstream (RFC 2812 §4.6) and transitions
  `away_state` to `:present`. Returns `{:error, :not_explicit}` if
  the session is not currently in `:away_explicit` (prevents silently
  clearing an auto-away when the user issues `/away` bare from the
  `:away_auto` state).

  Returns `:ok`, `{:error, :no_session}`, or `{:error, :not_explicit}`.

  S3.2 (channel-client-polish). Symmetric with `set_explicit_away/3`.
  """
  @spec unset_explicit_away(subject(), integer()) ::
          :ok | {:error, :no_session | :not_explicit}
  def unset_explicit_away(subject, network_id)
      when is_subject(subject) and is_integer(network_id) do
    call_session(subject, network_id, {:unset_explicit_away})
  end

  @doc """
  Unsets explicit away with an `origin_window` for numeric routing (S4.3).

  Identical to `unset_explicit_away/2` but also records the originating
  cicchetto window in Session.Server state so that 305/306 reply numerics
  route back to the correct window via `NumericRouter`.
  """
  @spec unset_explicit_away(subject(), integer(), map()) ::
          :ok | {:error, :no_session | :not_explicit}
  def unset_explicit_away(subject, network_id, origin_window)
      when is_subject(subject) and is_integer(network_id) and is_map(origin_window) do
    call_session(subject, network_id, {:unset_explicit_away, origin_window})
  end

  @doc """
  Triggers auto-away for the session at `(subject, network_id)`.

  Issues `AWAY :<auto-away reason>` upstream and transitions
  `away_state` to `:away_auto`, UNLESS the current state is
  `:away_explicit` (in which case this is a no-op).

  Driven internally by the WSPresence debounce timer
  (`auto_away_debounce_fire`). Exposed on the facade for test
  observability — production callers are the Session.Server's own
  `handle_info` callbacks, not external modules.

  Returns `:ok` or `{:error, :no_session}`.
  """
  @spec set_auto_away(subject(), integer()) :: :ok | {:error, :no_session}
  def set_auto_away(subject, network_id)
      when is_subject(subject) and is_integer(network_id) do
    call_session(subject, network_id, {:set_auto_away})
  end

  @doc """
  Clears auto-away for the session at `(subject, network_id)`.

  Issues bare `AWAY` upstream and transitions `away_state` to `:present`,
  UNLESS the current state is `:away_explicit` (don't touch an explicit
  away on reconnect) or `:present` (no-op).

  Driven internally by the WSPresence `:ws_visible` event. Exposed on
  the facade for test observability — production callers are the
  Session.Server's own `handle_info` callbacks.

  Returns `:ok` or `{:error, :no_session}`.
  """
  @spec unset_auto_away(subject(), integer()) :: :ok | {:error, :no_session}
  def unset_auto_away(subject, network_id)
      when is_subject(subject) and is_integer(network_id) do
    call_session(subject, network_id, {:unset_auto_away})
  end

  @doc """
  Returns a snapshot of currently-joined channels for the session at
  `(subject, network_id)`, sorted alphabetically.

  Source-of-truth: `Map.keys(Session.Server.state.members)`. The
  self-JOIN wipe + self-PART/KICK delete in `Grappa.Session.EventRouter`
  keeps the keys aligned with live membership (Q1 of P4-1 cluster).

  Returns `{:error, :no_session}` if no session is registered for
  `(subject, network_id)`.
  """
  @spec list_channels(subject(), integer()) ::
          {:ok, [String.t()]} | {:error, :no_session}
  def list_channels(subject, network_id)
      when is_subject(subject) and is_integer(network_id) do
    call_session(subject, network_id, {:list_channels})
  end

  @doc """
  Variant of `list_channels/2` accepting an explicit per-call
  receive `timeout_ms`. Returns `{:error, :timeout}` instead of
  exiting when the target Session.Server's mailbox is too deep to
  respond within budget — the operator surface
  (`Grappa.LiveIntrospection`) needs an honest signal for stuck
  pids rather than the default 5s exit cascade.

  `:infinity` is allowed (delegates to the underlying GenServer.call).
  """
  @spec list_channels(subject(), integer(), timeout()) ::
          {:ok, [String.t()]} | {:error, :no_session | :timeout}
  def list_channels(subject, network_id, timeout_ms)
      when is_subject(subject) and is_integer(network_id) and
             (is_integer(timeout_ms) or timeout_ms == :infinity) do
    call_session(subject, network_id, {:list_channels}, timeout_ms)
  end

  @typedoc """
  #474 B — the live upstream connection facts for a session: which box the
  socket dialled (`server` = peer IP string), the transport TLS posture,
  and whether the nick is identified to services (`registered`, from the
  +r umode). Present only while connected; the accessors below degrade to
  `{:error, :no_peer}` otherwise.
  """
  @type connection_info :: %{
          server: String.t(),
          port: :inet.port_number(),
          tls: boolean(),
          registered: boolean()
        }

  @doc """
  Returns the live upstream connection facts for the session at
  `(subject, network_id)` — `%{server, port, tls, registered}` (#474 B,
  the server-window rail card).

  `server` is the peer IP as a string (`:inet.ntoa/1` of the v6/v4 tuple),
  captured once at connect and cached (immutable for the connection), so
  this is an instant state read; `registered` is derived from the live
  umode set (the same +r identity signal #561 keys on).

  Returns `{:error, :no_peer}` in every not-connected window (pre-connect,
  mid-reconnect, socket just closed) — the honest "unknown", never
  fabricated facts — and `{:error, :no_session}` when no session is
  registered for `(subject, network_id)`.
  """
  @spec connection_info(subject(), integer()) ::
          {:ok, connection_info()} | {:error, :no_session | :no_peer}
  def connection_info(subject, network_id)
      when is_subject(subject) and is_integer(network_id) do
    call_session(subject, network_id, {:connection_info})
  end

  @doc """
  Variant of `connection_info/2` accepting an explicit per-call receive
  `timeout_ms` — `{:error, :timeout}` instead of the default 5s exit
  cascade for a mailbox-bloated pid. `:infinity` delegates to the
  underlying GenServer.call.
  """
  @spec connection_info(subject(), integer(), timeout()) ::
          {:ok, connection_info()} | {:error, :no_session | :no_peer | :timeout}
  def connection_info(subject, network_id, timeout_ms)
      when is_subject(subject) and is_integer(network_id) and
             (is_integer(timeout_ms) or timeout_ms == :infinity) do
    call_session(subject, network_id, {:connection_info}, timeout_ms)
  end

  @doc """
  Returns the upstream peer (`{address, port}`) the session at
  `(subject, network_id)` is connected to — the destination the IRC
  socket actually landed on (#550, netsplit triage).

  The `{server, port}` projection of `connection_info/2` — ONE underlying
  accessor, no second overlapping handler. `address` is the peer IP as a
  string. Same `{:error, :no_peer}` / `{:error, :no_session}` degraded
  signals.
  """
  @spec peer_address(subject(), integer()) ::
          {:ok, {String.t(), :inet.port_number()}} | {:error, :no_session | :no_peer}
  def peer_address(subject, network_id)
      when is_subject(subject) and is_integer(network_id) do
    subject |> connection_info(network_id) |> project_peer_address()
  end

  @doc """
  Variant of `peer_address/2` accepting an explicit per-call receive
  `timeout_ms`. Returns `{:error, :timeout}` instead of exiting when the
  target Session.Server's mailbox is too deep to respond within budget —
  the operator surface (`Grappa.LiveIntrospection`) needs an honest signal
  for stuck pids rather than the default 5s exit cascade.

  `:infinity` is allowed (delegates to the underlying GenServer.call).
  """
  @spec peer_address(subject(), integer(), timeout()) ::
          {:ok, {String.t(), :inet.port_number()}}
          | {:error, :no_session | :no_peer | :timeout}
  def peer_address(subject, network_id, timeout_ms)
      when is_subject(subject) and is_integer(network_id) and
             (is_integer(timeout_ms) or timeout_ms == :infinity) do
    subject |> connection_info(network_id, timeout_ms) |> project_peer_address()
  end

  @spec project_peer_address({:ok, connection_info()} | {:error, atom()}) ::
          {:ok, {String.t(), :inet.port_number()}} | {:error, atom()}
  defp project_peer_address({:ok, %{server: server, port: port}}), do: {:ok, {server, port}}
  defp project_peer_address({:error, _} = err), do: err

  @doc """
  Returns the network's IRC `CASEMAPPING` as observed by the LIVE session at
  `(subject, network_id)` — `:ascii | :rfc1459 | :rfc1459_strict`.

  #537 — the stateless web-edge (controllers, `GrappaChannel` topic join) has
  no `state.isupport` to read the network's casemapping from, yet it must fold
  a USER-TYPED channel/nick KEY the SAME way the Server did at write time so
  `#Foo[1]` on an rfc1459 network resolves to the one window the Server already
  keyed folded. This is the ingress source those no-state sites feed into
  `Identifier.canonical_target/2` (the Server + EventRouter read `state.isupport`
  directly instead).

  Returns `:ascii` — the safe, prod-invariant default — whenever there is no
  live session (parked/failed/not-bootstrapped) or the call cannot complete:
  on ASCII the fold is byte-identical to the pure-ASCII `canonical_target/1`, so
  a missing session degrades an rfc1459 web read to the same key the row was
  written under before the network's 005 was seen (pre-connect autojoin is
  ASCII-planned too — DESIGN_NOTES 2026-07-30).
  """
  @spec casemapping(subject(), integer()) :: Identifier.casemapping()
  def casemapping(subject, network_id)
      when is_subject(subject) and is_integer(network_id) do
    case call_session(subject, network_id, :casemapping) do
      mapping when mapping in [:ascii, :rfc1459, :rfc1459_strict] -> mapping
      _ -> :ascii
    end
  end

  @doc """
  Returns the live IRC nick for the session at `(subject, network_id)`.

  The live nick may differ from the credential's configured nick after
  NickServ ghost recovery, nick collision suffixing, or an explicit /nick
  change. Returns `{:error, :no_session}` when the session is parked,
  failed, or not yet bootstrapped — callers should fall back to the
  credential's configured nick in that case.

  #498 — a CHEAP `Registry.lookup/2` read of the session's own registry
  entry VALUE, NOT a `GenServer.call`. `Session.Server` mirrors `state.nick`
  into its own SessionRegistry entry value on init + every reconcile/rename
  (`publish_live_nick/1`), so this reader carries no per-call round-trip.
  That is what lets the badge / `/me` unread seed / read-cursor settle
  resolve own_nick through the ONE live-nick source on their hot path
  without the per-network GenServer round-trip the old off-Session
  configured-nick shortcut existed to avoid (DESIGN_NOTES 2026-07-28).
  A live session always carries a binary value (seeded at init); an entry
  whose value is not yet a binary is treated as no live nick → fall back.

  Exposed on the facade so `GrappaWeb.NetworksController.index` can
  advertise the real IRC nick to cicchetto without coupling the controller
  directly to Session.Server internals.
  """
  @spec current_nick(subject(), integer()) :: {:ok, String.t()} | {:error, :no_session}
  def current_nick(subject, network_id)
      when is_subject(subject) and is_integer(network_id) do
    case Registry.lookup(Grappa.SessionRegistry, Server.registry_key(subject, network_id)) do
      [{_, nick}] when is_binary(nick) -> {:ok, nick}
      _ -> {:error, :no_session}
    end
  end

  @doc """
  Returns a snapshot of the channel's member list in mIRC sort order
  (`@` ops alphabetical → `+` voiced alphabetical → plain alphabetical).
  Each entry: `%{nick: String.t(), modes: [String.t()]}`.

  CP24 bucket E web/S8 — discriminates two states the pre-bucket-E
  shape conflated under `{:ok, []}`:

    * `{:ok, :uninitialized}` — channel has not yet observed a 366
      RPL_ENDOFNAMES (joined but pre-NAMES burst, OR not joined at
      all). REST `/members` maps to HTTP 204; cic shows "loading…".
    * `{:ok, [member()]}` (possibly empty list) — channel has
      received NAMES at least once. REST returns HTTP 200; cic
      renders the list (empty list = "no members" empty state).
    * `{:error, :no_session}` — no `Session.Server` registered for
      `(subject, network_id)`.
  """
  @spec list_members(subject(), integer(), String.t()) ::
          {:ok, :uninitialized | [member()]}
          | {:error, :no_session}
  def list_members(subject, network_id, channel)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) do
    call_session(subject, network_id, {:list_members, channel})
  end

  @doc """
  Returns `%{channel => member_count}` for every channel in this session
  whose NAMES burst has landed — the bulk twin of `list_members/3`.

  #505: the `/me` cold-load resolves the presence-hiding size default for
  EVERY window at once. Doing that through `list_members/3` would be one
  GenServer call per channel at logon, which is precisely the per-window
  fan-out #396 collapsed. One call returns the whole map.

  Carries the SAME seeded discrimination as `list_members/3`, because the
  distinction is load-bearing for the caller: a channel that has not yet
  observed its 366 RPL_ENDOFNAMES has an UNKNOWABLE count, not a count of
  zero, so it is OMITTED from the map rather than reported as `0`. A
  consumer reading `0` would conclude "small channel, show presence" for a
  channel that is about to turn out to have 900 members.

  Channel keys are the members-map keys, i.e. already network-folded at
  ingress (#537) — the same keys `read_cursors.channel` carries.
  """
  @spec list_member_counts(subject(), integer()) ::
          {:ok, %{String.t() => non_neg_integer()}} | {:error, :no_session}
  def list_member_counts(subject, network_id)
      when is_subject(subject) and is_integer(network_id) do
    call_session(subject, network_id, :list_member_counts)
  end

  @doc """
  Returns the cached topic for `channel` in the given session.

  Serves from the in-memory topic cache — no upstream TOPIC query is
  issued. Returns `{:ok, entry}` where `entry` is a
  `Grappa.Session.EventRouter.topic_entry()` map, `{:error, :no_topic}`
  if the channel is joined but no TOPIC has been received yet, or
  `{:error, :no_session}` if no session is registered for
  `(subject, network_id)`.
  """
  @spec get_topic(subject(), integer(), String.t()) ::
          {:ok, Grappa.Session.EventRouter.topic_entry()}
          | {:error, :no_topic | :no_session}
  def get_topic(subject, network_id, channel)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) do
    call_session(subject, network_id, {:get_topic, channel})
  end

  @doc """
  Returns the cached channel modes for `channel` in the given session.

  Serves from the in-memory channel-modes cache — no upstream MODE
  query is issued. Returns `{:ok, entry}` where `entry` is a
  `Grappa.Session.EventRouter.channel_mode_entry()` map,
  `{:error, :no_modes}` if the channel is joined but no MODE snapshot
  has been received yet, or `{:error, :no_session}` if no session is
  registered for `(subject, network_id)`.
  """
  @spec get_channel_modes(subject(), integer(), String.t()) ::
          {:ok, Grappa.Session.EventRouter.channel_mode_entry()}
          | {:error, :no_modes | :no_session}
  def get_channel_modes(subject, network_id, channel)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) do
    call_session(subject, network_id, {:get_channel_modes, channel})
  end

  @doc """
  Returns the per-network ISUPPORT channel-mode capability table (#216).

  Serves the in-memory `Grappa.Session.ISupport.t()` — the CHANMODES +
  PREFIX capability set parsed from 005 RPL_ISUPPORT (or the bahamut
  default when the upstream omitted the tokens). Returns `{:ok, isupport}`
  or `{:error, :no_session}` when no session is registered for
  `(subject, network_id)`. Used by the channel's cold-WS-subscribe
  snapshot to seed the cic `/mode` modal's available toggles.
  """
  @spec get_isupport(subject(), integer()) ::
          {:ok, Grappa.Session.ISupport.t()} | {:error, :no_session}
  def get_isupport(subject, network_id)
      when is_subject(subject) and is_integer(network_id) do
    call_session(subject, network_id, :get_isupport)
  end

  @doc """
  Returns the per-session USER-mode set (#229).

  Serves the in-memory `umodes` list — the operator's own umodes on this
  network, seeded by the 221 RPL_UMODEIS reply to the bare `MODE <nick>`
  query grappa issues at 001 (or `[]` before it arrives). Returns
  `{:ok, modes}` or `{:error, :no_session}` when no session is registered
  for `(subject, network_id)`. Used by the user-topic cold-WS-subscribe
  snapshot to seed the cic `/mode <nick>` modal from connect.
  """
  @spec get_umodes(subject(), integer()) ::
          {:ok, [String.t()]} | {:error, :no_session}
  def get_umodes(subject, network_id)
      when is_subject(subject) and is_integer(network_id) do
    call_session(subject, network_id, :get_umodes)
  end

  @doc """
  Returns the per-session SUPPORTED USER-mode set (#249).

  Serves the in-memory `supported_umodes` list — the umode letters the server
  advertised in 004 RPL_MYINFO (or `[]` before it arrives). Returns
  `{:ok, modes}` or `{:error, :no_session}` when no session is registered for
  `(subject, network_id)`. Used by the user-topic cold-WS-subscribe snapshot
  to seed the cic `/umode` modal's AVAILABLE toggles from connect.
  """
  @spec get_supported_umodes(subject(), integer()) ::
          {:ok, [String.t()]} | {:error, :no_session}
  def get_supported_umodes(subject, network_id)
      when is_subject(subject) and is_integer(network_id) do
    call_session(subject, network_id, :get_supported_umodes)
  end

  @typedoc """
  CP15 B3 — snapshot-ready window-state payload returned by
  `get_window_state/3`. Byte-identical to the event-time broadcast cic
  receives via Phoenix.PubSub for the same transition. One shape per
  window state; cic's event handler does NOT discriminate on
  snapshot-vs-event.
  """
  @type window_state_snapshot ::
          %{
            required(:kind) => :joined | :join_failed | :kicked,
            required(:network) => String.t(),
            required(:channel) => String.t(),
            required(:state) => :joined | :failed | :kicked,
            optional(:reason) => String.t() | nil,
            optional(:numeric) => pos_integer(),
            optional(:by) => String.t()
          }

  @doc """
  Returns the snapshot-ready window-state payload for `channel` in the
  given session.

  Single source of truth for the cold-WS-subscribe push: cic reconnects
  → channel after_join calls this → if the window has a known state,
  push the returned payload as `event` on the socket. Payload shape is
  byte-identical to the event-time broadcast for the same kind so
  cic's renderer doesn't branch on origin.

  Returns `{:error, :not_tracked}` for channels with no recorded
  window state (operator never joined, or the channel is in transient
  `:pending` while an autojoin is in flight).
  """
  @spec get_window_state(subject(), integer(), String.t()) ::
          {:ok, window_state_snapshot()}
          | {:error, :not_tracked | :no_session}
  def get_window_state(subject, network_id, channel)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) do
    call_session(subject, network_id, {:get_window_state, channel})
  end

  @doc """
  Returns the per-session cold-WS-subscribe bundle for the user-topic
  after-join snapshot — the umode set (#229), the server-advertised
  supported umodes (#249), and the `window_invited` payloads for EVERY
  `:invited` window (#482) — in ONE round-trip.

  Folded into a single call so `GrappaWeb.GrappaChannel.push_user_snapshot`
  makes ONE per-network `Session.Server` round-trip on the login hot path
  rather than three serial blocking calls (the #482 latency regression:
  a separate `:invited` call deepened the shared-session mailbox under
  concurrent WS load and slowed user-topic broadcasts). `:invited` is a
  user-topic state (cic subscribes per-channel only AFTER seeing it), so
  it rides this snapshot; re-emitting `window_invited` on cold subscribe is
  what keeps the greyed tab from evaporating on reload (the #482 symptom).
  `{:error, :no_session}` when no live `Session.Server` backs the
  `(subject, network)`.
  """
  @spec session_snapshot(subject(), integer()) ::
          {:ok,
           %{
             umodes: [String.t()],
             supported_umodes: [String.t()],
             invited_windows: [Grappa.Session.Wire.window_invited_payload()]
           }}
          | {:error, :no_session}
  def session_snapshot(subject, network_id)
      when is_subject(subject) and is_integer(network_id) do
    call_session(subject, network_id, :session_snapshot)
  end

  @doc """
  Returns the cached userhost entry for `nick` in the given session.

  Serves from the in-memory WHOIS-userhost cache — no upstream WHOIS query
  is issued. The cache is populated from JOIN's `nick!user@host` prefix,
  311 RPL_WHOISUSER, and 352 RPL_WHOREPLY. Returns `{:ok, entry}` where
  `entry` is a `Grappa.Session.EventRouter.userhost_entry()` map,
  `{:error, :not_cached}` if the nick is not in the cache (no JOIN/WHOIS/WHO
  data seen for this nick since the session started), `{:error, :no_session}`
  if no session is registered for `(subject, network_id)`, or `{:error,
  :timeout}` if the session's mailbox is saturated past the call deadline
  (`call_session/4`) — callers must handle it, not enumerate only the first
  two (#386: an un-handled `:timeout` crashed the channel `with`/`else`).

  Nick lookup is case-insensitive (ASCII, #121/#525) — callers may pass the
  nick in any case. This cache is consumed by S5's `/ban` mask derivation
  and the #386 `/kb` + BanlistModal mask builder (via the `resolve_userhost`
  channel verb), and is NOT broadcast over PubSub (the data goes stale and
  WHOIS remains the authoritative fallback when the cache misses).
  """
  @spec lookup_userhost(subject(), integer(), String.t()) ::
          {:ok, Grappa.Session.EventRouter.userhost_entry()}
          | {:error, :not_cached | :no_session | :timeout}
  def lookup_userhost(subject, network_id, nick)
      when is_subject(subject) and is_integer(network_id) and is_binary(nick) do
    call_session(subject, network_id, {:lookup_userhost, nick})
  end

  # ---------------------------------------------------------------------------
  # S5.2 — Channel-ops facade functions
  # ---------------------------------------------------------------------------

  @doc """
  Sends `MODE <channel> +ooo... <nicks>` upstream, chunked per ISUPPORT MODES=.
  Multi-nick: the Session.Server fans out to N `MODE` lines if the nick list
  exceeds the server's MODES= limit. Returns `:ok` or `{:error, :no_session}`.
  """
  @spec send_op(subject(), integer(), String.t(), [String.t()]) ::
          :ok | {:error, :no_session | send_transport_error()}
  def send_op(subject, network_id, channel, nicks)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) and
             is_list(nicks) do
    call_session(subject, network_id, {:send_op, channel, nicks})
  end

  @doc "Sends `MODE <channel> -ooo... <nicks>` upstream, chunked per ISUPPORT MODES=."
  @spec send_deop(subject(), integer(), String.t(), [String.t()]) ::
          :ok | {:error, :no_session | send_transport_error()}
  def send_deop(subject, network_id, channel, nicks)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) and
             is_list(nicks) do
    call_session(subject, network_id, {:send_deop, channel, nicks})
  end

  @doc "Sends `MODE <channel> +vvv... <nicks>` upstream, chunked per ISUPPORT MODES=."
  @spec send_voice(subject(), integer(), String.t(), [String.t()]) ::
          :ok | {:error, :no_session | send_transport_error()}
  def send_voice(subject, network_id, channel, nicks)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) and
             is_list(nicks) do
    call_session(subject, network_id, {:send_voice, channel, nicks})
  end

  @doc "Sends `MODE <channel> -vvv... <nicks>` upstream, chunked per ISUPPORT MODES=."
  @spec send_devoice(subject(), integer(), String.t(), [String.t()]) ::
          :ok | {:error, :no_session | send_transport_error()}
  def send_devoice(subject, network_id, channel, nicks)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) and
             is_list(nicks) do
    call_session(subject, network_id, {:send_devoice, channel, nicks})
  end

  @doc """
  Sends `KICK <channel> <nick> :<reason>` upstream.
  Returns `:ok`, `{:error, :no_session}`, or `{:error, :invalid_line}`
  if the channel/nick syntax or reason bytes are rejected by
  `Grappa.IRC.Client.send_kick/4`.
  """
  @spec send_kick(subject(), integer(), String.t(), String.t(), String.t()) ::
          :ok | {:error, :no_session | :invalid_line | send_transport_error()}
  def send_kick(subject, network_id, channel, nick, reason)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) and
             is_binary(nick) and is_binary(reason) do
    call_session(subject, network_id, {:send_kick, channel, nick, reason})
  end

  @doc """
  Sends `MODE <channel> +b <mask>` upstream. If `mask_or_nick` is a bare nick
  (no `!` or `@`), the Session.Server derives the mask from the WHOIS cache:
  `*!*@host` on cache hit, `nick!*@*` on miss. An explicit mask (containing
  `!` or `@`) passes through unchanged.
  Returns `:ok` or `{:error, :no_session}`.
  """
  @spec send_ban(subject(), integer(), String.t(), String.t()) ::
          :ok | {:error, :no_session | send_transport_error()}
  def send_ban(subject, network_id, channel, mask_or_nick)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) and
             is_binary(mask_or_nick) do
    call_session(subject, network_id, {:send_ban, channel, mask_or_nick})
  end

  @doc """
  Sends `MODE <channel> -b <mask>` upstream.
  Returns `:ok` or `{:error, :no_session}`.
  """
  @spec send_unban(subject(), integer(), String.t(), String.t()) ::
          :ok | {:error, :no_session | send_transport_error()}
  def send_unban(subject, network_id, channel, mask)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) and
             is_binary(mask) do
    call_session(subject, network_id, {:send_unban, channel, mask})
  end

  @doc """
  Sends `INVITE <nick> <channel>` upstream (RFC 2812 order: nick first, then channel).
  Returns `:ok`, `{:error, :no_session}`, or `{:error, :invalid_line}`
  if the channel/nick syntax is rejected by `Grappa.IRC.Client.send_invite/3`.
  """
  @spec send_invite(subject(), integer(), String.t(), String.t()) ::
          :ok | {:error, :no_session | :invalid_line | send_transport_error()}
  def send_invite(subject, network_id, channel, nick)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) and
             is_binary(nick) do
    call_session(subject, network_id, {:send_invite, channel, nick})
  end

  @doc """
  #571 — sends `LUSERS [<mask> [<server>]]` upstream (RFC 2812 §3.4.2). `nil`
  mask + `nil` server = the current server's cached figures; a `mask` filters
  the reply AND (on bahamut, when non-`*`) forces a live recount past the
  180s cache; a `mask` + `server` routes the query to a named remote server.
  Server replies with the 7-numeric bundle (251/252/253?/254/255/265/266)
  which `EventRouter` folds and emits as a typed `:lusers_bundle` wire event
  on `Topic.user/1`.

  Returns `:ok`, `{:error, :no_session}`, or `{:error, :invalid_line}` if a
  non-nil mask/server's syntax is rejected by `Grappa.IRC.Client.send_lusers/3`
  (mirror of `send_motd/3` + `send_links/3`; the channel door validates first,
  but the context contract stays honest for every door). A `server` with no
  `mask` is `{:error, :invalid_line}` (positional framing, RFC 2812 §3.4.2).
  """
  @spec send_lusers(subject(), integer(), String.t() | nil, String.t() | nil) ::
          :ok | {:error, :no_session | :invalid_line | send_transport_error()}
  def send_lusers(subject, network_id, mask, server)
      when is_subject(subject) and is_integer(network_id) and
             (is_binary(mask) or is_nil(mask)) and (is_binary(server) or is_nil(server)) do
    call_session(subject, network_id, {:send_lusers, mask, server})
  end

  @doc """
  #127 — sends bare `INFO` upstream (primes `info_pending`). Server replies
  with 371 RPL_INFO lines + 374 RPL_ENDOFINFO, which `EventRouter` drains as
  a typed `:server_reply` (source `:info`) wire event on `Topic.user/1` —
  cic renders a dismissable modal. Returns `:ok` or `{:error, :no_session}`.
  """
  @spec send_info(subject(), integer()) ::
          :ok | {:error, :no_session | send_transport_error()}
  def send_info(subject, network_id)
      when is_subject(subject) and is_integer(network_id) do
    call_session(subject, network_id, :send_info)
  end

  @doc """
  #127 — sends bare `VERSION` upstream (primes `version_pending`). Server
  replies with 351 RPL_VERSION, drained as a typed `:server_reply` (source
  `:version`) wire event on `Topic.user/1`. Returns `:ok` or
  `{:error, :no_session}`.
  """
  @spec send_version(subject(), integer()) ::
          :ok | {:error, :no_session | send_transport_error()}
  def send_version(subject, network_id)
      when is_subject(subject) and is_integer(network_id) do
    call_session(subject, network_id, :send_version)
  end

  @doc """
  #127/#374 — sends `MOTD [<target>]` upstream (primes `motd_pending`). `nil`
  = the current server's MOTD; a `target` routes the query through that server
  (RFC 2812 §3.4.1). The 375/372/376 (or 422 ERR_NOMOTD, or 402
  ERR_NOSUCHSERVER for an unknown target) burst is drained as a typed
  `:server_reply` (source `:motd`) wire event on `Topic.user/1` — cic renders
  a dismissable modal. Connect-time MOTD is NOT affected (no pending flag →
  stays on `$server`). Returns `:ok`, `{:error, :no_session}`, or
  `{:error, :invalid_line}` if a non-nil target's syntax is rejected by
  `Grappa.IRC.Client.send_motd/2` (mirror of `send_who/3`; the channel door
  validates first, but the context contract stays honest for every door).
  """
  @spec send_motd(subject(), integer(), String.t() | nil) ::
          :ok | {:error, :no_session | :invalid_line | send_transport_error()}
  def send_motd(subject, network_id, target)
      when is_subject(subject) and is_integer(network_id) and
             (is_binary(target) or is_nil(target)) do
    call_session(subject, network_id, {:send_motd, target})
  end

  @doc """
  #238 — sends `LINKS [<mask>]` upstream (primes `links_pending`). `nil`
  = the full server mesh; a `mask` filters the reply to matching server
  names (RFC 2812 §3.4.5). The 364 RPL_LINKS burst + 365 RPL_ENDOFLINKS
  terminator are folded by `EventRouter` into `state.links_pending` and
  drained as a typed `:links_bundle` wire event on `Topic.user/1` — cic
  renders an interactive topology map. A restricted/oper-only network
  answers with a bare 365 (empty bundle → cic shows "hides topology") or
  481 ERR_NOPRIVILEGES (a red `$server` :notice, not a bundle).

  Returns `:ok`, `{:error, :no_session}`, `{:error, :invalid_line}` if a
  non-nil mask's syntax is rejected by `Grappa.IRC.Client.send_links/2`
  (mirror of `send_motd/3`; the channel door validates first, but the
  context contract stays honest for every door), or `{:error,
  :links_in_flight}` (#513b) when a still-pending /links is in flight — the
  caller surfaces "network map already loading" rather than clobbering the
  in-flight request's bundle. A stuck request (withheld 365 / 481 denial)
  self-heals: past the staleness window a fresh /links clobbers + re-sends.
  """
  @spec send_links(subject(), integer(), String.t() | nil) ::
          :ok
          | {:error, :no_session | :invalid_line | :links_in_flight | send_transport_error()}
  def send_links(subject, network_id, mask)
      when is_subject(subject) and is_integer(network_id) and
             (is_binary(mask) or is_nil(mask)) do
    call_session(subject, network_id, {:send_links, mask})
  end

  @doc """
  #247 — the live /notify presence map for `(subject, network_id)`:
  `%{folded_nick => :online | :offline | :unknown}`. `{:error,
  :no_session}` when no session is running — callers surface the DB
  watch list with unknown presence in that case (DB state and live
  state are separate sources of truth; never fake one from the other).
  """
  @spec presence_snapshot(subject(), integer()) ::
          {:ok, %{String.t() => :online | :offline | :unknown}} | {:error, :no_session | :timeout}
  def presence_snapshot(subject, network_id)
      when is_subject(subject) and is_integer(network_id) do
    case call_session(subject, network_id, :presence_snapshot) do
      {:error, _} = err -> err
      map when is_map(map) -> {:ok, map}
    end
  end

  @doc """
  #247 — live watch-list sync after a `Grappa.Notify` mutation while a
  session is up: sends the MONITOR/WATCH add/remove lines and updates
  the session's presence map. `added`/`removed` are display-form nick
  lists (the caller computed the diff). `:ok` on a no-session miss —
  the next (re)connect's end-of-MOTD arm reads the DB list, which
  already carries the mutation, so a missing live session is the
  expected parked/disconnected case, not an error.
  """
  @spec notify_changed(subject(), integer(), [String.t()], [String.t()]) :: :ok
  def notify_changed(subject, network_id, added, removed)
      when is_subject(subject) and is_integer(network_id) and is_list(added) and
             is_list(removed) do
    case call_session(subject, network_id, {:notify_changed, added, removed}) do
      :ok ->
        :ok

      {:error, :no_session} ->
        :ok

      {:error, reason} ->
        Logger.warning("notify_changed sync failed", reason: inspect(reason))
        :ok
    end
  end

  @doc """
  Sends `MODE <channel> b` upstream — the banlist query form (no sign) —
  and primes the per-channel accumulator in `state.banlist_pending` so
  EventRouter folds the 367 RPL_BANLIST rows into it. On 368
  RPL_ENDOFBANLIST the bundle is broadcast on `Topic.user/1` as a
  `banlist_bundle` event (#376). The accumulator keys on the
  ASCII-folded channel (#364/#525) so the rows drain regardless of upstream
  casing.

  Ephemeral — NOT persisted in scrollback. Bundle replaces any prior
  bundle for the same channel.

  Returns `:ok`, `{:error, :no_session}`, or `{:error, :invalid_line}`
  if the channel syntax is rejected by `Grappa.IRC.Client.send_banlist/2`.
  """
  @spec send_banlist(subject(), integer(), String.t()) ::
          :ok | {:error, :no_session | :invalid_line | send_transport_error()}
  def send_banlist(subject, network_id, channel)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) do
    call_session(subject, network_id, {:send_banlist, channel})
  end

  @doc """
  Sends `WHOIS [<server>] <nick>` upstream and primes the per-target
  accumulator in `state.whois_pending` so EventRouter folds the
  311/312/313/317/319 numerics into a bundle. The bundle is broadcast on
  `Topic.user/1` as a `whois_bundle` event when 318 RPL_ENDOFWHOIS arrives.

  `server` is the optional RFC 2812 §3.6.2 target-server the query routes
  through (`/whois <server> <nick>`, #198): when non-nil the frame is
  `WHOIS <server> <nick>`, when nil it is the byte-identical single-arg
  `WHOIS <nick>`. The accumulator keys on `nick` either way — the routing
  server only changes which server answers, not the bundle's target.

  Per spec #2: ephemeral — NOT persisted in scrollback. Bundle replaces
  any prior bundle for the same target.

  `origin` (#606) marks who asked: `:user` for an operator-issued `/whois`
  (the single-slot scrollback card), `:rail` for the query-rail
  auto-fetch. It rides in the per-target accumulator and re-emerges on the
  `whois_bundle` wire event as `source`, so each cic store consumes only
  what is addressed to it (a rail auto-fetch never forges the /whois card).
  The channel boundary normalizes an unknown/absent client token to
  `:user`, so the atom reaching here is always one of the two.

  Returns `:ok`, `{:error, :no_session}`, or `{:error, :invalid_line}`
  if the nick or server syntax is rejected by
  `Grappa.IRC.Client.send_whois/3`.
  """
  @spec send_whois(subject(), integer(), String.t(), String.t() | nil, :user | :rail) ::
          :ok | {:error, :no_session | :invalid_line | send_transport_error()}
  def send_whois(subject, network_id, nick, server, origin)
      when is_subject(subject) and is_integer(network_id) and is_binary(nick) and
             (is_binary(server) or is_nil(server)) and origin in [:user, :rail] do
    call_session(subject, network_id, {:send_whois, nick, server, origin})
  end

  @doc """
  Sends `WHOWAS <nick>` upstream and primes the per-target accumulator
  in `state.whowas_pending` so EventRouter appends 314 entries + folds
  the 312 reuse (logoff_time) into the last entry. The bundle is
  broadcast on `Topic.user/1` as a `whowas_bundle` event when 369
  RPL_ENDOFWHOWAS arrives, or with `not_found: true` on 406
  ERR_WASNOSUCHNICK.

  Per spec #2: ephemeral — NOT persisted in scrollback. Bundle replaces
  any prior bundle for the same target.

  Returns `:ok`, `{:error, :no_session}`, or `{:error, :invalid_line}`
  if the nick syntax is rejected by `Grappa.IRC.Client.send_whowas/2`.
  """
  @spec send_whowas(subject(), integer(), String.t()) ::
          :ok | {:error, :no_session | :invalid_line | send_transport_error()}
  def send_whowas(subject, network_id, nick)
      when is_subject(subject) and is_integer(network_id) and is_binary(nick) do
    call_session(subject, network_id, {:send_whowas, nick})
  end

  @doc """
  Sends `WHO <target>` upstream and primes the per-target accumulator in
  `state.who_pending` so EventRouter folds 352 RPL_WHOREPLY rows into a
  bundle, drained into ONE ephemeral `{:who_reply, target, users}` event
  when 315 RPL_ENDOFWHO arrives. `<target>` is a channel OR a host/nick
  mask (#221, RFC 2812 §3.6.1).

  The target ships upstream RAW (#540 A2 / #537): it may be a channel, a
  mask (#221), or bahamut's extended-WHO flag args (`+s <server>`), and
  folding it as a channel would corrupt a case-sensitive arg. The Server
  derives the accumulator KEY network-aware (`fold_key/2` — normalise the
  network's CASEMAPPING national chars, then ASCII-fold, so `#Chan`/`#chan`
  share one key for concurrent channel-WHO separation) WITHOUT touching the
  wire form. Reply correlation is robust to a key that never matches the
  echoed 315/352 (mask, flag, unsolicited): EventRouter falls back to the
  single-in-flight-WHO rule (WHO is mailbox-serialized).

  Returns `:ok`, `{:error, :no_session}`, or `{:error, :invalid_line}`
  if the target syntax is rejected by `Grappa.IRC.Client.send_who/2`.
  """
  @spec send_who(subject(), integer(), String.t()) ::
          :ok | {:error, :no_session | :invalid_line | send_transport_error()}
  def send_who(subject, network_id, target)
      when is_subject(subject) and is_integer(network_id) and is_binary(target) do
    # #540 A2 / #537 — the target is NOT necessarily a channel: it may be a
    # mask (#221) or bahamut's extended-WHO flag args (`+s <server>`). Folding
    # it corrupts a case-sensitive arg — the `+`-sigil token `+A HelloWorld`
    # (away-message match) would lowercase to `+a helloworld` before it left
    # the bouncer. The raw target ships upstream; the Server derives the
    # accumulator KEY network-aware (`fold_key/2`, for concurrent channel-WHO
    # separation) separately in its handler.
    call_session(subject, network_id, {:send_who, target})
  end

  @doc """
  Sends `NAMES <channel>` upstream and primes the per-target accumulator
  in `state.names_pending` so EventRouter folds 353 RPL_NAMREPLY rows
  into a roster. On 366 RPL_ENDOFNAMES (gated on this pending request)
  the roster drains into ONE ephemeral `names_reply` event broadcast on
  the user-level topic — NOT persisted to scrollback (mirror of the
  `whois_bundle` accumulator). cic renders it as a grouped, dismissable
  modal; the authoritative member set still flows via `members_seeded`
  on the channel topic. Joined and non-joined targets behave uniformly
  (#140) — the roster is whatever upstream returns.

  Nicks arrive in the 353 trailing param as a space-separated
  `[prefix]nick` list, `prefix ∈ {@, %, +}` (ops/halfops/voice). The
  prefixes are split into `{nick, modes}` at the drain so cic never
  parses IRC; it buckets by mode into modal sections.

  Returns `:ok`, `{:error, :no_session}`, or `{:error, :invalid_line}`
  if the channel syntax is rejected by `Grappa.IRC.Client.send_names/2`.
  """
  @spec send_names(subject(), integer(), String.t()) ::
          :ok | {:error, :no_session | :invalid_line | send_transport_error()}
  def send_names(subject, network_id, channel)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) do
    call_session(subject, network_id, {:send_names, channel})
  end

  @doc """
  Sends `MODE <own_nick> <modes>` upstream — user-mode change on own nick.
  The own nick is read from Session.Server state (populated at 001).
  Returns `:ok`, `{:error, :no_session}`, or `{:error, :invalid_line}`
  if the modes bytes are rejected by `Grappa.IRC.Client.send_umode/3`.
  """
  @spec send_umode(subject(), integer(), String.t()) ::
          :ok | {:error, :no_session | :invalid_line | send_transport_error()}
  def send_umode(subject, network_id, modes)
      when is_subject(subject) and is_integer(network_id) and is_binary(modes) do
    call_session(subject, network_id, {:send_umode, modes})
  end

  @doc """
  Sends `MODE <target> <modes> [params...]` verbatim, with NO chunking.
  This is the raw power-user escape hatch — `/mode #chan +o-v vjt rofl`
  passes the full mixed mode string through as-is. The server is authoritative.
  Returns `:ok` or `{:error, :no_session}`.
  """
  @spec send_mode(subject(), integer(), String.t(), String.t(), [String.t()]) ::
          :ok | {:error, :no_session | send_transport_error()}
  def send_mode(subject, network_id, target, modes, params)
      when is_subject(subject) and is_integer(network_id) and is_binary(target) and
             is_binary(modes) and is_list(params) do
    call_session(subject, network_id, {:send_mode, target, modes, params})
  end

  @doc """
  Sends `TOPIC <channel> :` upstream — empty trailing parameter clears the channel
  topic per RFC 2812 §3.2.4. This is the irssi `/topic -delete` convention.
  The inbound TOPIC event echoed back by the server will update the topic cache
  via EventRouter. Returns `:ok`, `{:error, :no_session}`, or `{:error, :invalid_line}`
  if the channel syntax is rejected by `Grappa.IRC.Client.send_topic_clear/2`.
  """
  @spec send_topic_clear(subject(), integer(), String.t()) ::
          :ok | {:error, :no_session | :invalid_line | send_transport_error()}
  def send_topic_clear(subject, network_id, channel)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) do
    call_session(subject, network_id, {:send_topic_clear, channel})
  end

  @doc """
  Adds the correct subject FK column to a `Grappa.Scrollback` /
  `Accounts` attrs map — `:user_id` for `{:user, _}` subjects,
  `:visitor_id` for `{:visitor, _}` subjects. Mirror of the
  `messages.user_id` / `messages.visitor_id` XOR check
  (Task 4 migration) and `sessions.user_id` / `sessions.visitor_id`
  XOR check (Task 5 migration).

  Delegates to `Grappa.Subject.put_subject_id/2` (visitor-parity V1
  promotion) so non-Session callers don't need a Boundary dep on
  `Grappa.Session` just to thread a subject FK onto a changeset
  attrs map. Existing in-Session callers (`event_router.ex`,
  `server.ex`) keep using this entry point for delegation
  symmetry — no churn.
  """
  @spec put_subject_id(map(), subject()) :: map()
  def put_subject_id(attrs, subject), do: Grappa.Subject.put_subject_id(attrs, subject)

  # REV-J M14: call_session/3 used to do a bare `GenServer.call/2` with
  # the implicit 5s timeout, surfacing `{:exit, {:timeout, _}}` as a
  # Phoenix 500 with no typed envelope. The sibling call_session/4
  # already had the `try/catch :exit, {:timeout, _} -> {:error, :timeout}`
  # wrapper; pre-fix the two sibling functions created inconsistent
  # caller behaviour. Now /3 delegates to /4 with the GenServer default
  # 5_000ms so every REST verb gets the same `{:error, :timeout}` shape
  # for FallbackController to render.
  defp call_session(subject, network_id, request),
    do: call_session(subject, network_id, request, 5_000)

  defp call_session(subject, network_id, request, timeout_ms) do
    case whereis(subject, network_id) do
      nil ->
        {:error, :no_session}

      pid ->
        try do
          GenServer.call(pid, request, timeout_ms)
        catch
          :exit, {:timeout, _} ->
            {:error, :timeout}

          # #211 phase 6 — the callee Session.Server died DURING the call
          # (crash / `:normal` shutdown / already-gone between `whereis`
          # and `GenServer.call`). Without this clause the callee's exit
          # reason propagated to the CALLER — a visitor whose 2nd-network
          # session is mid-crash (e.g. a 433 nick collision on a shared
          # test leaf) 500'd `GET /networks` via `resolve_network_nick`'s
          # `current_nick` call. A dead session looks like "no session" to
          # callers, not a crash. `:noproc` (registry slot freed),
          # `:normal`/`:shutdown` (clean stop), and any wrapped crash
          # reason (`{:client_exit, _}`, etc.) all collapse to no_session.
          :exit, _ ->
            {:error, :no_session}
        end
    end
  end

  defp cast_session(subject, network_id, request) do
    case whereis(subject, network_id) do
      nil -> {:error, :no_session}
      pid -> GenServer.cast(pid, request)
    end
  end

  # #357 D1 — send-path span helpers.
  @spec subject_kind(subject()) :: :user | :visitor
  defp subject_kind({:user, _}), do: :user
  defp subject_kind({:visitor, _}), do: :visitor

  # Collapse the full `send_privmsg/4` return set to a closed outcome atom for
  # the span stop-metadata. `:no_persist` (services target) and `:ok` (channel
  # send) are the success shapes; every atom error (`:no_session`, `:timeout`,
  # `:persist_unavailable`, …) passes through verbatim; a changeset error
  # collapses to `:error` (nothing dashboard-useful to inspect in a tag).
  @spec send_outcome(
          {:ok, Grappa.Scrollback.Message.t()}
          | {:ok, :no_persist}
          | {:error, atom() | Ecto.Changeset.t()}
        ) :: atom()
  defp send_outcome({:ok, :no_persist}), do: :no_persist
  defp send_outcome({:ok, _}), do: :ok
  defp send_outcome({:error, reason}) when is_atom(reason), do: reason
  defp send_outcome({:error, _}), do: :error
end
