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
    deps: [Grappa.IRC, Grappa.Log, Grappa.PubSub, Grappa.Scrollback],
    exports: [Backoff, Server]

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
          required(:realname) => String.t(),
          required(:sasl_user) => String.t(),
          required(:auth_method) => AuthFSM.auth_method(),
          required(:password) => String.t() | nil,
          required(:autojoin_channels) => [String.t()],
          required(:host) => String.t(),
          required(:port) => :inet.port_number(),
          required(:tls) => boolean(),
          optional(:notify_pid) => pid(),
          optional(:notify_ref) => reference(),
          optional(:visitor_committer) => Server.visitor_committer(),
          optional(:credential_failer) => Server.credential_failer()
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
              "session refused to die within #{@stop_down_timeout_ms}ms stop budget " <>
                "(subject=#{inspect(subject)} network_id=#{network_id})",
              pid: inspect(pid)
            )

            Process.demonitor(ref, [:flush])
            :ok
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
          | {:error, :no_session | :invalid_line}
          | {:error, Ecto.Changeset.t()}
  def send_privmsg(subject, network_id, target, body)
      when is_subject(subject) and is_integer(network_id) and is_binary(target) and
             is_binary(body) do
    # CRLF/NUL check fires BEFORE the registry lookup so an injection
    # attempt against a non-existent session still surfaces as
    # :invalid_line — input-shape error beats not-found. The Scrollback
    # row is never persisted on rejection (the call_session never runs).
    if Identifier.safe_line_token?(target) and Identifier.safe_line_token?(body) do
      call_session(subject, network_id, {:send_privmsg, target, body})
    else
      {:error, :invalid_line}
    end
  end

  @doc """
  Queues a JOIN upstream through the session. Cast — returns `:ok` as
  soon as the message is in the Session.Server mailbox; the actual
  socket write happens asynchronously. The REST surface returns 202
  Accepted to mirror this. `{:error, :no_session}` if not registered.
  """
  @spec send_join(subject(), integer(), String.t()) ::
          :ok | {:error, :no_session | :invalid_line}
  def send_join(subject, network_id, channel)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) do
    if Identifier.safe_line_token?(channel) do
      cast_session(subject, network_id, {:send_join, channel})
    else
      {:error, :invalid_line}
    end
  end

  @doc """
  Queues a PART upstream through the session. Cast (see `send_join/3`
  for the rationale). `{:error, :no_session}` if not registered.
  """
  @spec send_part(subject(), integer(), String.t()) ::
          :ok | {:error, :no_session | :invalid_line}
  def send_part(subject, network_id, channel)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) do
    if Identifier.safe_line_token?(channel) do
      cast_session(subject, network_id, {:send_part, channel})
    else
      {:error, :invalid_line}
    end
  end

  @doc """
  Sets the topic on `channel` for the session's `(subject, network_id)`.
  Synchronously persists a `:topic` scrollback row, broadcasts on the
  per-channel PubSub topic, and writes `TOPIC <chan> :<body>` upstream —
  single-source path, mirror of `send_privmsg/4`.

  Returns `{:ok, message}` with the persisted row, `{:error, :no_session}`
  if no session is registered, `{:error, :invalid_line}` for CRLF/NUL
  injection, or `{:error, Ecto.Changeset.t()}` on validation failure.
  """
  @spec send_topic(subject(), integer(), String.t(), String.t()) ::
          {:ok, Grappa.Scrollback.Message.t()}
          | {:error, :no_session | :invalid_line}
          | {:error, Ecto.Changeset.t()}
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
          :ok | {:error, :no_session | :invalid_line}
  def send_nick(subject, network_id, new_nick)
      when is_subject(subject) and is_integer(network_id) and is_binary(new_nick) do
    if Identifier.safe_line_token?(new_nick) do
      call_session(subject, network_id, {:send_nick, new_nick})
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
          :ok | {:error, :no_session | :invalid_line}
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
  reason string contains CR/LF/NUL.

  S3.2 (channel-client-polish). Symmetric with `unset_explicit_away/2`.
  """
  @spec set_explicit_away(subject(), integer(), String.t()) ::
          :ok | {:error, :no_session | :invalid_line}
  def set_explicit_away(subject, network_id, reason)
      when is_subject(subject) and is_integer(network_id) and is_binary(reason) do
    if Identifier.safe_line_token?(reason) do
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
          :ok | {:error, :no_session | :invalid_line}
  def set_explicit_away(subject, network_id, reason, origin_window)
      when is_subject(subject) and is_integer(network_id) and is_binary(reason) and
             is_map(origin_window) do
    if Identifier.safe_line_token?(reason) do
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

  Driven internally by the WSPresence `:ws_connected` event. Exposed on
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
  Returns a snapshot of the channel's member list in mIRC sort order
  (`@` ops alphabetical → `+` voiced alphabetical → plain alphabetical).
  Each entry: `%{nick: String.t(), modes: [String.t()]}`.

  Returns `{:ok, []}` if the session is registered but has no members
  recorded for the channel (operator joined but NAMES hasn't completed,
  or unknown channel). Returns `{:error, :no_session}` if no session
  is registered for `(subject, network_id)`.
  """
  @spec list_members(subject(), integer(), String.t()) ::
          {:ok, [%{nick: String.t(), modes: [String.t()]}]}
          | {:error, :no_session}
  def list_members(subject, network_id, channel)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) do
    call_session(subject, network_id, {:list_members, channel})
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
  Returns the cached userhost entry for `nick` in the given session.

  Serves from the in-memory WHOIS-userhost cache — no upstream WHOIS query
  is issued. The cache is populated from JOIN's `nick!user@host` prefix,
  311 RPL_WHOISUSER, and 352 RPL_WHOREPLY. Returns `{:ok, entry}` where
  `entry` is a `Grappa.Session.EventRouter.userhost_entry()` map,
  `{:error, :not_cached}` if the nick is not in the cache (no JOIN/WHOIS/WHO
  data seen for this nick since the session started), or `{:error,
  :no_session}` if no session is registered for `(subject, network_id)`.

  Nick lookup is case-insensitive (RFC 2812 §2.2) — callers may pass the
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
          :ok | {:error, :no_session}
  def send_op(subject, network_id, channel, nicks)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) and
             is_list(nicks) do
    call_session(subject, network_id, {:send_op, channel, nicks})
  end

  @doc "Sends `MODE <channel> -ooo... <nicks>` upstream, chunked per ISUPPORT MODES=."
  @spec send_deop(subject(), integer(), String.t(), [String.t()]) ::
          :ok | {:error, :no_session}
  def send_deop(subject, network_id, channel, nicks)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) and
             is_list(nicks) do
    call_session(subject, network_id, {:send_deop, channel, nicks})
  end

  @doc "Sends `MODE <channel> +vvv... <nicks>` upstream, chunked per ISUPPORT MODES=."
  @spec send_voice(subject(), integer(), String.t(), [String.t()]) ::
          :ok | {:error, :no_session}
  def send_voice(subject, network_id, channel, nicks)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) and
             is_list(nicks) do
    call_session(subject, network_id, {:send_voice, channel, nicks})
  end

  @doc "Sends `MODE <channel> -vvv... <nicks>` upstream, chunked per ISUPPORT MODES=."
  @spec send_devoice(subject(), integer(), String.t(), [String.t()]) ::
          :ok | {:error, :no_session}
  def send_devoice(subject, network_id, channel, nicks)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) and
             is_list(nicks) do
    call_session(subject, network_id, {:send_devoice, channel, nicks})
  end

  @doc """
  Sends `KICK <channel> <nick> :<reason>` upstream.
  Returns `:ok` or `{:error, :no_session}`.
  """
  @spec send_kick(subject(), integer(), String.t(), String.t(), String.t()) ::
          :ok | {:error, :no_session}
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
          :ok | {:error, :no_session}
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
          :ok | {:error, :no_session}
  def send_unban(subject, network_id, channel, mask)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) and
             is_binary(mask) do
    call_session(subject, network_id, {:send_unban, channel, mask})
  end

  @doc """
  Sends `INVITE <nick> <channel>` upstream (RFC 2812 order: nick first, then channel).
  Returns `:ok` or `{:error, :no_session}`.
  """
  @spec send_invite(subject(), integer(), String.t(), String.t()) ::
          :ok | {:error, :no_session}
  def send_invite(subject, network_id, channel, nick)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) and
             is_binary(nick) do
    call_session(subject, network_id, {:send_invite, channel, nick})
  end

  @doc """
  Sends `MODE <channel> b` upstream — the banlist query form (no sign).
  Numerics 367 RPL_BANLIST + 368 RPL_ENDOFBANLIST reply with the ban list.
  Returns `:ok` or `{:error, :no_session}`.
  """
  @spec send_banlist(subject(), integer(), String.t()) ::
          :ok | {:error, :no_session}
  def send_banlist(subject, network_id, channel)
      when is_subject(subject) and is_integer(network_id) and is_binary(channel) do
    call_session(subject, network_id, {:send_banlist, channel})
  end

  @doc """
  Sends `MODE <own_nick> <modes>` upstream — user-mode change on own nick.
  The own nick is read from Session.Server state (populated at 001).
  Returns `:ok` or `{:error, :no_session}`.
  """
  @spec send_umode(subject(), integer(), String.t()) ::
          :ok | {:error, :no_session}
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
          :ok | {:error, :no_session}
  def send_mode(subject, network_id, target, modes, params)
      when is_subject(subject) and is_integer(network_id) and is_binary(target) and
             is_binary(modes) and is_list(params) do
    call_session(subject, network_id, {:send_mode, target, modes, params})
  end

  @doc """
  Adds the correct subject FK column to a `Grappa.Scrollback` /
  `Accounts` attrs map — `:user_id` for `{:user, _}` subjects,
  `:visitor_id` for `{:visitor, _}` subjects. Mirror of the
  `messages.user_id` / `messages.visitor_id` XOR check
  (Task 4 migration) and `sessions.user_id` / `sessions.visitor_id`
  XOR check (Task 5 migration).

  Single source of truth for the subject → FK column mapping —
  callers in `Grappa.Session.Server` (outbound PRIVMSG / TOPIC
  attrs) and `Grappa.Session.EventRouter` (inbound `:persist`
  effects) all go through this helper, so a future third subject
  kind requires one place to change.
  """
  @spec put_subject_id(map(), subject()) :: map()
  def put_subject_id(attrs, {:user, uid}) when is_map(attrs) and is_binary(uid),
    do: Map.put(attrs, :user_id, uid)

  def put_subject_id(attrs, {:visitor, vid}) when is_map(attrs) and is_binary(vid),
    do: Map.put(attrs, :visitor_id, vid)

  defp call_session(subject, network_id, request) do
    case whereis(subject, network_id) do
      nil -> {:error, :no_session}
      pid -> GenServer.call(pid, request)
    end
  end

  defp cast_session(subject, network_id, request) do
    case whereis(subject, network_id) do
      nil -> {:error, :no_session}
      pid -> GenServer.cast(pid, request)
    end
  end
end
