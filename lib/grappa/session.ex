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
      Grappa.PubSub,
      Grappa.Push,
      Grappa.Scrollback,
      Grappa.Subject,
      Grappa.UserSettings,
      Grappa.Version
    ],
    exports: [Backoff, Server, Wire]

  alias Grappa.IRC.{AuthFSM, Identifier}
  alias Grappa.Session.Server

  require Logger

  # `stop_session/2` synchronisation budgets. The `:DOWN` window is the
  # OTP `terminate_child` round-trip plus a `terminate/2` callback ceiling;
  # the Registry-unregister window is the BEAM scheduler swap to drain the
  # Registry process's own `{:DOWN, ...}` mailbox entry. 5s × 100 × 5ms is
  # generous; in practice the budgets are exhausted in <10ms total.
  @stop_down_timeout_ms 5_000
  @registry_unregister_attempts 100
  @registry_unregister_poll_ms 5

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
          optional(:notify_pid) => pid(),
          optional(:notify_ref) => reference(),
          optional(:visitor_committer) => Server.visitor_committer(),
          optional(:visitor_password_rotator) => Server.visitor_password_rotator(),
          optional(:visitor_nick_persister) => Server.visitor_nick_persister(),
          optional(:credential_failer) => Server.credential_failer(),
          optional(:credential_committer) => Server.credential_committer(),
          optional(:last_joined_persister) => Server.last_joined_persister(),
          optional(:refresh_plan) => Server.refresh_plan_check()
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
    full_opts = Map.put(opts, :network_id, network_id)

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
  Stops the running `Grappa.Session.Server` for `(subject, network_id)`,
  if any. Idempotent: returns `:ok` whether or not a session was
  registered for the key.

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
    case whereis(subject, network_id) do
      nil ->
        :ok

      pid ->
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

        # `Process.monitor` DOWN guarantees the process is dead, but
        # `Grappa.SessionRegistry`'s OWN monitor on `pid` runs in the
        # Registry process — it may not have unregistered the dead pid
        # yet. Spin a tiny `Registry.lookup`-poll until the entry is
        # gone or the budget expires; without this, callers chaining
        # `stop_session/2` → `start_session/3` race a transient
        # `:already_started` shape backed by a dead pid.
        wait_until_unregistered(subject, network_id, @registry_unregister_attempts)
        :ok
    end
  end

  defp wait_until_unregistered(_, _, 0), do: :ok

  defp wait_until_unregistered(subject, network_id, attempts) do
    case whereis(subject, network_id) do
      nil ->
        :ok

      _ ->
        Process.sleep(@registry_unregister_poll_ms)
        wait_until_unregistered(subject, network_id, attempts - 1)
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
      # UX-4 A: lowercase channel-shape targets; nicks pass through.
      call_session(subject, network_id, {:send_privmsg, Identifier.canonical_channel(target), body})
    else
      {:error, :invalid_line}
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
    if Identifier.safe_line_token?(channel) and Identifier.valid_channel?(channel) and
         safe_join_key?(key) do
      call_session(
        subject,
        network_id,
        {:send_join, Identifier.canonical_channel(channel), normalize_join_key(key)}
      )
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
      cast_session(subject, network_id, {:send_part, Identifier.canonical_channel(channel)})
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
      call_session(subject, network_id, {:send_topic, Identifier.canonical_channel(channel), body})
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

  @doc """
  Returns the live IRC nick for the session at `(subject, network_id)`.

  The live nick may differ from the credential's configured nick after
  NickServ ghost recovery, nick collision suffixing, or an explicit /nick
  change. Returns `{:error, :no_session}` when the session is parked,
  failed, or not yet bootstrapped — callers should fall back to the
  credential's configured nick in that case.

  Exposed on the facade so `GrappaWeb.NetworksController.index` can
  advertise the real IRC nick to cicchetto without coupling the controller
  directly to Session.Server internals.
  """
  @spec current_nick(subject(), integer()) :: {:ok, String.t()} | {:error, :no_session}
  def current_nick(subject, network_id)
      when is_subject(subject) and is_integer(network_id) do
    call_session(subject, network_id, {:current_nick})
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
    call_session(subject, network_id, {:list_members, Identifier.canonical_channel(channel)})
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
    call_session(subject, network_id, {:get_topic, Identifier.canonical_channel(channel)})
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
    call_session(subject, network_id, {:get_channel_modes, Identifier.canonical_channel(channel)})
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
            required(:state) => String.t(),
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
    call_session(subject, network_id, {:get_window_state, Identifier.canonical_channel(channel)})
  end

  @doc """
  Returns the cached userhost entry for `nick` in the given session.

  Serves from the in-memory WHOIS-userhost cache — no upstream WHOIS query
  is issued. The cache is populated from JOIN's `nick!user@host` prefix,
  311 RPL_WHOISUSER, and 352 RPL_WHOREPLY. Returns `{:ok, entry}` where
  `entry` is a `Grappa.Session.EventRouter.userhost_entry()` map,
  `{:error, :not_cached}` if the nick is not in the cache (no JOIN/WHOIS/WHO
  data seen for this nick since the session started), or `{:error,
  :no_session}` if no session is registered for `(subject, network_id)`.

  Nick lookup is case-insensitive (rfc1459, #121) — callers may pass the
  nick in any case. This cache is consumed by S5's `/ban` mask derivation
  and is NOT broadcast over PubSub (the data goes stale and WHOIS remains
  the authoritative fallback when the cache misses).
  """
  @spec lookup_userhost(subject(), integer(), String.t()) ::
          {:ok, Grappa.Session.EventRouter.userhost_entry()}
          | {:error, :not_cached | :no_session}
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
    call_session(subject, network_id, {:send_op, Identifier.canonical_channel(channel), nicks})
  end

  @doc "Sends `MODE <channel> -ooo... <nicks>` upstream, chunked per ISUPPORT MODES=."
  @spec send_deop(subject(), integer(), String.t(), [String.t()]) ::
          :ok | {:error, :no_session | send_transport_error()}
  def send_deop(subject, network_id, channel, nicks)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) and
             is_list(nicks) do
    call_session(subject, network_id, {:send_deop, Identifier.canonical_channel(channel), nicks})
  end

  @doc "Sends `MODE <channel> +vvv... <nicks>` upstream, chunked per ISUPPORT MODES=."
  @spec send_voice(subject(), integer(), String.t(), [String.t()]) ::
          :ok | {:error, :no_session | send_transport_error()}
  def send_voice(subject, network_id, channel, nicks)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) and
             is_list(nicks) do
    call_session(subject, network_id, {:send_voice, Identifier.canonical_channel(channel), nicks})
  end

  @doc "Sends `MODE <channel> -vvv... <nicks>` upstream, chunked per ISUPPORT MODES=."
  @spec send_devoice(subject(), integer(), String.t(), [String.t()]) ::
          :ok | {:error, :no_session | send_transport_error()}
  def send_devoice(subject, network_id, channel, nicks)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) and
             is_list(nicks) do
    call_session(subject, network_id, {:send_devoice, Identifier.canonical_channel(channel), nicks})
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
    call_session(subject, network_id, {:send_kick, Identifier.canonical_channel(channel), nick, reason})
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
    call_session(subject, network_id, {:send_ban, Identifier.canonical_channel(channel), mask_or_nick})
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
    call_session(subject, network_id, {:send_unban, Identifier.canonical_channel(channel), mask})
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
    call_session(subject, network_id, {:send_invite, Identifier.canonical_channel(channel), nick})
  end

  @doc """
  Sends bare `LUSERS` upstream. Server replies with the 7-numeric
  bundle (251/252/253?/254/255/265/266) which `EventRouter` folds and
  emits as a typed `:lusers_bundle` wire event on `Topic.user/1`.
  Returns `:ok` or `{:error, :no_session}`.
  """
  @spec send_lusers(subject(), integer()) ::
          :ok | {:error, :no_session | send_transport_error()}
  def send_lusers(subject, network_id)
      when is_subject(subject) and is_integer(network_id) do
    call_session(subject, network_id, :send_lusers)
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
  #127 — sends bare `MOTD` upstream (primes `motd_pending`). The 375/372/376
  (or 422) burst is drained as a typed `:server_reply` (source `:motd`) wire
  event on `Topic.user/1` — cic renders a dismissable modal. Connect-time
  MOTD is NOT affected (no pending flag → stays on `$server`). Returns `:ok`
  or `{:error, :no_session}`.
  """
  @spec send_motd(subject(), integer()) ::
          :ok | {:error, :no_session | send_transport_error()}
  def send_motd(subject, network_id)
      when is_subject(subject) and is_integer(network_id) do
    call_session(subject, network_id, :send_motd)
  end

  @doc """
  Sends `MODE <channel> b` upstream — the banlist query form (no sign).
  Numerics 367 RPL_BANLIST + 368 RPL_ENDOFBANLIST reply with the ban list.
  Returns `:ok`, `{:error, :no_session}`, or `{:error, :invalid_line}`
  if the channel syntax is rejected by `Grappa.IRC.Client.send_banlist/2`.
  """
  @spec send_banlist(subject(), integer(), String.t()) ::
          :ok | {:error, :no_session | :invalid_line | send_transport_error()}
  def send_banlist(subject, network_id, channel)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) do
    call_session(subject, network_id, {:send_banlist, Identifier.canonical_channel(channel)})
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

  Returns `:ok`, `{:error, :no_session}`, or `{:error, :invalid_line}`
  if the nick or server syntax is rejected by
  `Grappa.IRC.Client.send_whois/3`.
  """
  @spec send_whois(subject(), integer(), String.t(), String.t() | nil) ::
          :ok | {:error, :no_session | :invalid_line | send_transport_error()}
  def send_whois(subject, network_id, nick, server)
      when is_subject(subject) and is_integer(network_id) and is_binary(nick) and
             (is_binary(server) or is_nil(server)) do
    call_session(subject, network_id, {:send_whois, nick, server})
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
  Sends `WHO <channel>` upstream and primes the per-target accumulator
  in `state.who_pending` so EventRouter folds 352 RPL_WHOREPLY rows
  into a bundle. The bundle is persisted as N+1 `:notice` scrollback
  rows when 315 RPL_ENDOFWHO arrives — one row per WHO reply plus one
  terminator row, routed to the WHO target channel if joined,
  otherwise the synthetic `$server` window.

  Per CP22 cluster B (channel-client-polish #14): rows are persisted
  in scrollback (NOT ephemeral) and replay on next page load. Wire
  payload carries structured `meta.who = {nick, modes, user, host,
  server, hops, realname}` so cic renders irssi-shape tabular without
  re-parsing IRC.

  Returns `:ok`, `{:error, :no_session}`, or `{:error, :invalid_line}`
  if the channel syntax is rejected by `Grappa.IRC.Client.send_who/2`.
  """
  @spec send_who(subject(), integer(), String.t()) ::
          :ok | {:error, :no_session | :invalid_line | send_transport_error()}
  def send_who(subject, network_id, channel)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) do
    call_session(subject, network_id, {:send_who, Identifier.canonical_channel(channel)})
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
    call_session(subject, network_id, {:send_names, Identifier.canonical_channel(channel)})
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
    call_session(subject, network_id, {:send_mode, Identifier.canonical_channel(target), modes, params})
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
    call_session(subject, network_id, {:send_topic_clear, Identifier.canonical_channel(channel)})
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
end
