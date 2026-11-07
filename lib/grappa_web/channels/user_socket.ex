defmodule GrappaWeb.UserSocket do
  @moduledoc """
  WebSocket entry point at `/socket/websocket`.

  Sub-task 2h roots every Grappa topic in the user discriminator
  (`grappa:user:{name}/...`); the legacy Phase 1 `grappa:network:*`
  route is gone — any client subscribing on that prefix would not
  resolve to a channel module and Phoenix returns the standard
  unknown-topic error. `grappa:user:*` is the only routed prefix
  because join semantics differ only in topic shape, not in behavior;
  `GrappaWeb.GrappaChannel` does the topic discrimination + per-subject
  authz on join.

  ## Connect-time auth (sub-task 2i + visitor-auth Task 12 + #95 + #202)

  `connect/3` verifies a bearer token against
  `Grappa.Accounts.authenticate/1` — same UUID PK that the REST
  surface consumes via `Authorization: Bearer ...`. The bearer's ONLY
  source is the `Sec-WebSocket-Protocol` subprotocol (#95): it rides the
  WS handshake's subprotocol as `base64url.bearer.phx.<token>`, which
  Phoenix's websocket transport decodes into `connect_info.auth_token`
  (`auth_token: true` in `endpoint.ex`). This keeps the token OFF the WS
  upgrade URL (`?token=…`, which was pre-redaction visible in access
  logs).

  #95 also retained the legacy `params["token"]` query-string bearer as
  a one-deploy-cycle fallback so a stale bundle mid-cold-deploy still
  connected; #202 dropped it once prod telemetry showed sustained zero
  query-string auth. A bearer supplied via the query string is now
  ignored entirely — the token's ONLY source is the subprotocol.

  ## Protocol-version handshake (#447)

  `connect/3` runs a pre-auth protocol-version gate BEFORE auth. A client
  MAY declare the wire protocol version it speaks via the `client_proto`
  QUERY PARAM (`connect/3`'s `params` — no longer unused). Query param, not
  subprotocol, because the version is PUBLIC discovery data (also at
  `GET /api/config`), not a credential: the #95/#202 off-the-URL rule
  applies only to the secret bearer, which keeps riding the subprotocol
  exclusively — so the two channels stay orthogonal and never collide
  (DESIGN_NOTES 2026-07-27).

  A client declaring below `Grappa.Protocol.min_version/0` is refused with
  `{:error, :upgrade_required}`, which the endpoint's custom `error_handler`
  (`handle_ws_error/2`) turns into a clean `426 Upgrade Required` — NOT an
  accepted socket fed frames it will mangle, and NOT the opaque 403 an auth
  failure gets. Absent or unparseable → treated as current, so existing
  clients keep working untouched.

  **The gate REPORTS its reading (#1416).** Because absent and unparseable
  land on the same accept, the connect RESULT cannot distinguish a client
  that negotiated from one whose declaration the server could not read —
  and until #1416 nothing else could either, which is how #1379 shipped a
  cicchetto dialling `client_proto=1/websocket` for a whole release with no
  operator-visible signal. `check_protocol_version/1` therefore returns a
  closed `t:declaration/0` and both connect emissions carry it. The
  decision is untouched; only the observability is new.

  Every authenticated connect emits a `[:grappa, :ws, :connect]`
  telemetry counter (`%{count: 1}`, metadata `%{client_proto:
  declaration}`) + a greppable Logger line carrying the same key — a cheap
  ops signal for connect churn and for declarations the server could not
  read. Neither carries the token value (the raw bearer IS the session
  credential — S9). #95's `auth_method` tag is gone (#202): once the
  query-string fallback was removed it collapsed to a constant
  `:subprotocol`; #1416 refilled the metadata with a key that does carry
  information.

  The authenticated `Session` row carries an XOR FK (`user_id` xor
  `visitor_id`, per Q-A). `connect/3` dispatches on that XOR:

    * **User session** — assigns `:user_name = user.name` (from the
      User row).
    * **Visitor session** — assigns
      `:user_name = "visitor:" <> visitor.id` mirroring
      `Visitors.SessionPlan.build/1`'s `subject_label` rule (Q1=a)
      so `Session.Server`'s broadcasts under
      `Topic.channel("visitor:" <> visitor.id, ...)` route to the
      same value the channel-side authz check uses. Also assigns
      `:current_visitor_id` and `:current_visitor` for downstream
      channel handlers. The branch runs `Visitors.touch/1` for the
      W9 sliding-TTL refresh — visitor activity over the WS surface
      counts as user-initiated traffic, same as Plugs.Authn for REST.

  Both branches assign `:current_session_id` (for future revocation
  hooks) at the connect boundary AND `:current_subject` — the bare-id
  `Grappa.Subject.t()` tuple (`{:user, uuid}` or `{:visitor, uuid}`)
  consumed directly by channel arms that hit subject-scoped contexts
  (UserSettings, ReadCursor, QueryWindows, Push). Mirror of the
  controller-side `Subject.from_assigns/1` lift — V4 visitor-parity
  (2026-05-15).

  Both branches also assign `:socket_ref` (#1088) — a per-CONNECTION
  reference, distinct from every subject-level identifier on the socket,
  used to address an informational reply back to the client that asked
  for it instead of fanning it out to every device of the subject.

  Any failure (missing / empty subprotocol token, malformed UUID,
  unknown row, revoked, expired user session, expired or vanished
  visitor) returns `:error`
  — Phoenix surfaces the WS rejection with no body; distinct error
  strings would just leak enumeration info on what went wrong with
  the token.
  """
  use Phoenix.Socket

  alias Grappa.{Accounts, Visitors, WSPresence}
  alias Grappa.Accounts.Session
  alias Grappa.Visitors.Visitor
  alias GrappaWeb.Subject

  require Logger

  channel "grappa:user:*", GrappaWeb.GrappaChannel
  channel "grappa:admin:events", GrappaWeb.AdminChannel

  @typedoc """
  What the connect boundary made of the client's `client_proto`
  declaration (#1416) — a closed set, ridden verbatim by both connect
  signals.

    * `:absent` — no `client_proto` at all. The deliberate zero-friction
      path (#447): served as current.
    * `:declared` — read as an integer at or above
      `Grappa.Protocol.min_version/0`. (A readable value BELOW the floor
      never becomes a declaration: it returns `{:error, :upgrade_required}`
      and there is no connect to report on.)
    * `:unreadable` — present and not readable as a version. Served as
      current, exactly like `:absent`, and that is the point: the two are
      indistinguishable in the RESULT, so they must not be in the SIGNAL.
  """
  @type declaration :: :absent | :declared | :unreadable

  @impl Phoenix.Socket
  def connect(params, socket, connect_info) do
    # #447 — the protocol-version gate runs BEFORE auth: a client that
    # cannot speak the wire protocol is refused regardless of whether its
    # token is valid (a too-old client would only mangle the frames a
    # successful auth unlocks). A below-floor client returns
    # `{:error, :upgrade_required}` → the endpoint's custom `error_handler`
    # (`handle_ws_error/2`) sends a clean 426; a bare `:error` (missing /
    # bad token, or an absent-but-fine version) still gets the transport's
    # own 403. The two failures stay distinct on the wire (426 vs 403).
    with {:ok, declaration} <- check_protocol_version(params),
         {:ok, token} <- extract_token(connect_info),
         {:ok, socket} <- authenticate_and_assign(token, socket, declaration) do
      maybe_record_client_source(socket, connect_info)
      {:ok, socket}
    end
  end

  # #543 Part C — capture the subject's client network prefix at connect so
  # the static-mapping addressing mode (INC-4) has a last-known `/64` to
  # derive an outbound source from. The trusted client IP is resolved via the
  # `RemoteIpFromProxy` SSOT (peer-loopback + XFF ⇒ trust the header chain;
  # else the peer) from `connect_info.peer_data.address` + `.x_headers` — the
  # SAME trust matrix the HTTP plug applies, one door.
  #
  # Best-effort by construction — capture must NEVER fail a connect:
  # `record_client_source/2` already returns `:ok` even on a persist failure
  # (logged, not swallowed), and the guards here SKIP capture (return `:ok`)
  # for every shape the real transport can't produce: an absent / non-map
  # `peer_data`, or a `peer_data.address` that isn't an IP-arity tuple (4 v4
  # / 8 v6 — the arities `SourceMapping.client_key/1` accepts). A non-list
  # `x_headers` degrades to `[]` (resolves to the peer), it doesn't skip.
  # `:current_subject` is always assigned post-auth (both branches), but the
  # `{_, _}` match keeps it honest. The real Phoenix transport always
  # supplies a valid `:inet.ip_address()` peer + a list of x-headers, so the
  # happy path is the only one it exercises.
  #
  # The resolution above stays HERE, in the connect process: reading
  # `peer_data` / `x_headers` and folding them through
  # `RemoteIpFromProxy.trusted_client_ip/2` is pure map work with no DB in
  # it, and keeping it inline means a connect that has nothing to capture
  # spawns nothing at all. Only the PERSIST detaches (#1618, below).
  @spec maybe_record_client_source(Phoenix.Socket.t(), map()) :: :ok
  defp maybe_record_client_source(socket, connect_info) do
    with %{address: peer_ip} <- Map.get(connect_info, :peer_data),
         true <- ip_tuple?(peer_ip),
         {_, _} = subject <- socket.assigns[:current_subject] do
      x_headers =
        case Map.get(connect_info, :x_headers) do
          headers when is_list(headers) -> headers
          _ -> []
        end

      client_ip = GrappaWeb.Plugs.RemoteIpFromProxy.trusted_client_ip(peer_ip, x_headers)

      # Issue 2597 — the same resolved address, kept beside this transport's
      # pid for as long as it lives (it was registered in
      # `authenticate_and_assign/3`), for the WHOIS an IRC operator or a
      # grappa admin receives. Synchronous: a GenServer write, no DB.
      :ok = WSPresence.record_client_ip(socket.assigns.user_name, self(), GrappaWeb.RemoteIP.format(client_ip))

      detach_client_source_capture(subject, client_ip)
    else
      _ -> :ok
    end
  end

  # #1618 — the persist runs OFF the upgrade path, in a supervised
  # fire-and-forget task.
  #
  # #523 already declared this sample droppable: `record_client_source/2`
  # swallows `:db_unavailable` specifically so it can never fail a connect.
  # What that contract did not cover is LATENCY. The call used to sit between
  # authentication and `{:ok, socket}`, Phoenix holds the WebSocket upgrade
  # open until `connect/3` returns, and the persist is a `BEGIN IMMEDIATE`
  # write transaction on `user_settings` — so a writer holding the SQLite
  # write lock made the upgrade wait the entire `busy_timeout` (31 575 ms
  # measured on one `scripts/integration.sh` run) and then DROP the write it
  # had waited for. A sample nobody is allowed to depend on was allowed to
  # delay every new WebSocket by half a minute.
  #
  # `Grappa.TaskSupervisor` is the same door `ReadCursorController.create/2`
  # (#273) uses for the same shape of problem at the same kind of boundary:
  # request-critical work stays inline, eventually-consistent work moves off
  # it. No NEW supervision child, so the fix is hot-deployable.
  # `Task.Supervisor.start_child/2` and not the `Task.start_link/1` that
  # CLAUDE.md's fire-and-forget line names, because a LINKED task would take
  # the transport down with it on a crash — reinstating exactly the
  # never-fail-a-connect hole #523 closed, one layer up.
  #
  # DETACHED HERE, NOT INSIDE `Vhosts.record_client_source/2`, and that is
  # the domain boundary rather than a convenience: the verb's other callers
  # are ordering-critical. `Visitors.Login` (#645) must have the sample
  # PERSISTED before it spawns the anchor session in the same request, and
  # `Vhosts.last_known_client_key/1` (#647) re-persists inside a read a
  # session spawn is already blocking on. Detaching in the context would
  # break both in silence.
  #
  # What the deferral costs, stated honestly: a session spawned in the window
  # between the connect and the task's commit reads the PREVIOUS sample. The
  # cold case cannot be hit — a subject with nothing recorded falls back to
  # `sessions.ip` / `visitor.ip` (#647), which on a fresh login is the very
  # address this connect would have written. The remaining case is an
  # established subject that ROAMED, and there the synchronous path was not
  # better: under the contention that makes the window wide it waited the
  # full `busy_timeout` and then dropped the write, leaving the same stale
  # value plus half a minute of upgrade.
  #
  # A `start_child/2` that does not return `{:ok, pid}` is logged, never
  # matched: `{:ok, _} = ` here would crash the transport and fail the
  # connect over a diagnostic sample, which is the one thing this call site
  # must never do. The log keeps it off the silent-swallow list — the
  # operator sees a skipped sample rather than nothing.
  @spec detach_client_source_capture(Grappa.Subject.t(), :inet.ip_address()) :: :ok
  defp detach_client_source_capture(subject, client_ip) do
    task = fn -> Grappa.Vhosts.record_client_source(subject, client_ip) end

    case Task.Supervisor.start_child(Grappa.TaskSupervisor, task) do
      {:ok, _} ->
        :ok

      other ->
        Logger.warning(
          "ws connect: could not detach client-source capture for " <>
            "#{inspect(subject)} — #{inspect(other)} (sample skipped)"
        )

        :ok
    end
  end

  # An IP tuple of an arity `SourceMapping.client_key/1` handles (v4 /32,
  # v6 /64). Guards the derive+persist path from a structurally-invalid
  # `peer_data.address` so capture can't crash a connect.
  @spec ip_tuple?(term()) :: boolean()
  defp ip_tuple?(ip), do: is_tuple(ip) and tuple_size(ip) in [4, 8]

  # #447 — pre-auth protocol-version gate. A client MAY declare the wire
  # protocol version it speaks via the `client_proto` QUERY PARAM on the WS
  # upgrade URL. Query param (not subprotocol) is deliberate: the version
  # is PUBLIC discovery data (also served unauth at `GET /api/config`), not
  # a credential — the #95/#202 "keep it off the URL" rule applies only to
  # the bearer, which is a secret and keeps riding `Sec-WebSocket-Protocol`
  # exclusively. Two orthogonal channels, no collision with the token
  # (query-vs-subprotocol ruling, DESIGN_NOTES 2026-07-27).
  #
  # A client declaring any parseable version BELOW
  # `Grappa.Protocol.min_version/0` (a negative included — it is below any
  # floor) is refused with `{:error, :upgrade_required}` (→ 426). Absent OR
  # unparseable → treated as CURRENT: the server sends nothing new to a
  # silent client, so
  # cicchetto/shottino (which declare no version) keep working untouched —
  # negotiation is opt-in on the client side.
  #
  # A version ABOVE what the server speaks is still accepted — there is no
  # upper bound and there will not be one. The DECISION is unchanged; its
  # justification is not. This comment used to read "additive-only means a
  # newer client tolerates an older server", and #1393d withdrew that
  # sentence everywhere it appeared: additivity describes what the SERVER
  # emits and says nothing about what a CLIENT requires, and cic now DOES
  # require fields an older BEAM never sends. The reason the ceiling is
  # absent is a different one, and it is load-bearing rather than an
  # oversight: what a client made mandatory is not a fact this server
  # holds, so refusing a newer-than-us client here would be the server
  # ruling on a floor that is the CLIENT's to rule on — and it would
  # refuse the one socket that carries the evidence. The user-topic JOIN
  # REPLY publishes `Grappa.Protocol.version/0`, cic compares it against
  # its own `MIN_SERVER_PROTOCOL_VERSION` (`serverProtocol.ts`) and raises
  # the "server outdated" banner. That banner exists only because this
  # gate lets the connection through.
  # #1416 — the gate also REPORTS what it made of the declaration, because
  # the accept/reject answer alone cannot: `:declared` and `:unreadable`
  # are the same `{:ok, _}` by design, so a client bug that discards the
  # whole negotiation used to be byte-identical, in every emission of this
  # module, to a client that negotiated correctly. That is the shape that
  # hid #1379 for a full release. The decision is unchanged — this is a
  # signal, not a policy.
  @spec check_protocol_version(map()) ::
          {:ok, declaration()} | {:error, :upgrade_required}
  defp check_protocol_version(%{"client_proto" => raw}) when is_binary(raw) do
    case Integer.parse(raw) do
      {version, ""} ->
        if version < Grappa.Protocol.min_version() do
          {:error, :upgrade_required}
        else
          {:ok, :declared}
        end

      _ ->
        # Unparseable `client_proto` — a client bug, not a reason to refuse
        # a socket that might otherwise work. Treat as current (silent),
        # same as absent (unknown-is-never-fatal) — but SAY SO.
        {:ok, :unreadable}
    end
  end

  # A `client_proto` that is present but not a binary — `?client_proto[]=1`
  # decodes to a list, `?client_proto[a]=1` to a map. Same class as an
  # unparseable string and NOT the same as absent: the client declared
  # something and the server could not read it. Folding this into the
  # absent clause would reinstate the exact lie #1416 removes, one costume
  # over.
  defp check_protocol_version(%{"client_proto" => _}), do: {:ok, :unreadable}

  defp check_protocol_version(_), do: {:ok, :absent}

  @doc false
  # #447 — custom WS error_handler wired in `endpoint.ex`'s `socket`
  # `websocket:` opts. Phoenix's WebSocket transport invokes this MFA ONLY
  # when `connect/3` returns `{:error, reason}` (a bare `:error` still gets
  # the transport's own 403). Today the sole `{:error, _}` `connect/3`
  # returns is `:upgrade_required`, so this maps it to a clean 426 Upgrade
  # Required with a JSON body naming the floor — a too-old client learns
  # WHY the upgrade was refused (vs an opaque 403 auth failure). NO
  # catch-all clause by design: a future new `{:error, reason}` with no
  # clause here crashes loudly (per CLAUDE.md "no silent-swallow" — a net
  # that absorbs an unknown reason hides the next bug).
  @spec handle_ws_error(Plug.Conn.t(), :upgrade_required) :: Plug.Conn.t()
  def handle_ws_error(conn, :upgrade_required) do
    body =
      Jason.encode!(%{
        error: "upgrade_required",
        protocol_version: Grappa.Protocol.version(),
        min_protocol_version: Grappa.Protocol.min_version()
      })

    conn
    |> Plug.Conn.put_resp_content_type("application/json")
    |> Plug.Conn.send_resp(426, body)
  end

  # #95 + #202 — the bearer's ONLY source is the `Sec-WebSocket-Protocol`
  # subprotocol (`connect_info.auth_token`, decoded by Phoenix's websocket
  # transport from `base64url.bearer.phx.<token>`). #95 introduced this
  # header path and kept the legacy `params["token"]` query-string bearer
  # as a one-deploy-cycle fallback so a stale bundle mid-cold-deploy still
  # connected; #202 dropped that fallback once prod telemetry showed
  # sustained zero query-string auth. A bearer in the query string is now
  # ignored entirely, so `connect/3`'s `params` argument is unused and the
  # token never rides the WS upgrade URL again.
  @spec extract_token(map()) :: {:ok, String.t()} | :error
  defp extract_token(connect_info) do
    case connect_info do
      %{auth_token: token} when is_binary(token) and token != "" ->
        {:ok, token}

      _ ->
        :error
    end
  end

  @spec authenticate_and_assign(String.t(), Phoenix.Socket.t(), declaration()) ::
          {:ok, Phoenix.Socket.t()} | :error
  defp authenticate_and_assign(token, socket, declaration) do
    with {:ok, session} <- Accounts.authenticate(token),
         {:ok, socket} <- assign_subject(socket, session) do
      socket =
        socket
        |> assign(:current_session_id, session.id)
        # #1196 — the WS twin of the `Plugs.Authn` assign. `AdminChannel`
        # reads it to keep the operator console off a per-client token:
        # the REST admin gate would otherwise be the only one, and the
        # console's live feed rides this socket, not REST.
        |> assign(:current_session_kind, session.kind)
        # #1088 — the per-CONNECTION discriminator. Minted here, at the one
        # boundary where "a WebSocket" is created, so every channel process
        # of this socket shares it and it dies with the transport.
        #
        # Nothing already on the socket can stand in for it, which is the
        # whole reason it exists: `:current_session_id` is the
        # `accounts_sessions` row, so two tabs of one login share it, and
        # `Grappa.ClientId` is admission policy keyed per (client, network),
        # not per connection. Both would re-create the fan-out they were
        # asked to remove.
        #
        # Opaque and server-only: `GrappaChannel` subscribes the user-topic
        # channel to `Topic.socket/2` on join, and a request carries it to
        # the session implicitly (it is read off the socket that carried the
        # command), so it never rides the wire in either direction.
        |> assign(:socket_ref, Ecto.UUID.generate())

      # S3.1 + CP24 bucket E web/S5: register every WS pid (user AND
      # visitor) with WSPresence. The transport process (self() at
      # connect time) is the pid that owns the WS connection; when it
      # exits, the WS is gone.
      #
      # Three consumers care:
      #   * Auto-away (user-only): user `Session.Server` subscribes to
      #     `Topic.ws_presence/1` and debounces auto-away on
      #     `:ws_all_hidden` (no visible device) / cancels on `:ws_visible`
      #     (#182). Visitor `Session.Server` does NOT subscribe (see
      #     `Session.Server.init/1`'s `match?({:user, _}, opts.subject)`
      #     guard) so the registration is a harmless no-op on the
      #     auto-away path for visitors.
      #   * Foreground push suppression (user + visitor, #182): the page
      #     reports `document.visibilitychange` over the `"visibility"`
      #     channel event → `WSPresence.set_visibility/3` keyed by this
      #     same transport pid; `Push.Triggers` reads `any_visible?/1`.
      #   * cic-bundle-changed broadcast (user + visitor): the admin
      #     endpoint iterates `WSPresence.list_user_names/0` to fan out
      #     the new bundle hash on every connected user-topic. Pre-fix
      #     visitor sockets were skipped at register-time so visitors
      #     with long-lived tabs never saw the refresh banner trigger.
      :ok = WSPresence.register(socket.assigns.user_name, self())

      # #1499 — a SECOND teardown address for this transport, keyed by
      # SESSION, alongside the per-SUBJECT one Phoenix subscribes us to
      # from the `id/1` callback. Both are plain id-topics carrying the
      # same `"disconnect"` event, and `Phoenix.Socket.__info__/2` stops
      # the transport on that event whatever topic it arrived on — so a
      # door that wants ONE bearer's socket closed now has an address for
      # it, and the doors that want the whole account off every device
      # keep using the subject topic untouched.
      #
      # Strictly additive on purpose. Re-keying `id/1` itself was the
      # other way to get per-session granularity (it is the one #1499's
      # body names), and it is the wrong one: `id/1` yields ONE topic, so
      # moving it to the session would leave the five account-wide doors
      # — `delete_user/1`, `revoke_sessions_for_user/1`, the two
      # `revoke_other_sessions_*`, the visitor destroy — with no address
      # for a subject at all, and they would have to enumerate live
      # sessions to rebuild one. Under-firing a revoke is the failure
      # that matters (see `Grappa.Accounts.Revocations`), so the coarse
      # address stays and the fine one is added beside it.
      #
      # Subscribed HERE rather than in `init/1` because `init/1` is
      # generated non-overridably by `use Phoenix.Socket`. That makes
      # this rest on the same guarantee `WSPresence.register/2` above
      # already rests on — that `connect/3` runs in the process that will
      # own the WebSocket. It holds for both transports Phoenix ships
      # (the upgrade keeps the request process), and auto-away has been
      # riding it in production since #182.
      :ok = GrappaWeb.Endpoint.subscribe(id_for_session(session.id))

      # #95 + #202 — connect observability (NEVER the token). The Logger
      # line is greppable; the `[:grappa, :ws, :connect]` counter is a
      # cheap ops signal (a Phase-5 exporter can aggregate connect churn).
      # #95's `auth_method` tag is gone (#202): it had collapsed to a
      # constant `:subprotocol` once the query-string fallback was
      # removed, so it carried no information. The token VALUE is never
      # logged or emitted — the raw bearer IS the session credential (S9).
      #
      # #1416 — both carry the ONE thing the connect result cannot say:
      # what this boundary made of the client's `client_proto`. The
      # MESSAGE stays byte-identical so #95's grep keeps working and the
      # new fact rides the metadata prefix.
      #
      # The declared VALUE is deliberately NOT repeated here. Phoenix's
      # own `[:phoenix, :socket_connected]` handler already prints
      # `Parameters: <inspect>` from this same transport process at
      # `log: :info` (`deps/phoenix/lib/phoenix/logger.ex:363`; the
      # default is set at `socket.ex:524`, `endpoint.ex` overrides
      # nothing, and prod runs at `:info`), and `:pid` is in the Logger
      # metadata allowlist, so the value is one correlated line away.
      # Repeating it would put unbounded attacker-controlled text into a
      # second log site for no fact the operator does not already have.
      #
      # What did NOT exist anywhere, and is what these two now state, is
      # the server's READING of that value. That half is pinned by tests.
      # The other half is not: no test in this repo can witness the
      # phoenix line's production configuration, because
      # `Phoenix.ChannelTest.__connect__/4` synthesises its own socket
      # options and never passes the endpoint's. So a future `log: false`
      # here would silently take the value away with no gate firing —
      # a known, declared gap, and the reason this comment names the
      # dependency instead of leaving it implicit.
      Logger.info("ws connect authenticated", client_proto: declaration)

      :telemetry.execute([:grappa, :ws, :connect], %{count: 1}, %{client_proto: declaration})

      {:ok, socket}
    else
      _ -> :error
    end
  end

  @impl Phoenix.Socket
  def id(socket), do: id_for_user_name(socket.assigns.user_name)

  @doc """
  W6: socket-id helper. Single source of truth for the topic shape
  Phoenix uses to drive `Endpoint.broadcast(socket_id, "disconnect", _)`
  — the broadcast site (`AuthController.maybe_disconnect_socket/1`)
  goes through this helper so a future change to the id shape
  automatically propagates to disconnect.

  The user_name segment comes from `Subject.topic_label/1` (the single
  source of the "user → `user.name`, visitor → `"visitor:" <> id`"
  invariant, bucket I web/S7), wrapped in the `"user_socket:"` id-topic
  prefix:

    * `{:user, %Accounts.User{name: name}}` → `"user_socket:" <> name`
    * `{:visitor, %Visitor{id: id}}` → `"user_socket:visitor:" <> id`

  Both shapes match the `user_name` assignment that `assign_subject/2`
  installs on the socket at connect time (same `topic_label/1` source).
  Symmetric with the `id/1` callback above so the runtime topic Phoenix
  subscribes the transport process to is the topic the disconnect
  publishes on.
  """
  @spec id_for_subject(Subject.t()) :: String.t()
  def id_for_subject(subject), do: id_for_user_name(Subject.topic_label(subject))

  @doc """
  #1499: the teardown topic of ONE bearer session, as opposed to
  `id_for_subject/1`'s topic for every socket of a subject.

  Every authenticated transport subscribes to this at connect
  (`authenticate_and_assign/2`), user and visitor alike — the session id
  is the one identifier both branches always have.

  It cannot collide with a subject topic, and not by luck: a user name
  matches `~r/^[a-zA-Z][a-zA-Z0-9_\\-]*$/` (`Grappa.Accounts.User`) so it
  can never contain a `:`, which is the same argument the pre-existing
  `"user_socket:visitor:" <> id` shape already rests on.
  """
  @spec id_for_session(Ecto.UUID.t()) :: String.t()
  def id_for_session(session_id) when is_binary(session_id),
    do: id_for_user_name("session:" <> session_id)

  @doc """
  Close the live WebSocket for `subject` by broadcasting `"disconnect"`
  to its id-topic (the topic the transport process subscribes to at
  connect time). Phoenix's socket `__info__` catch-all maps the event to
  `{:stop, {:shutdown, :disconnected}, _}`, terminating the transport.

  Shared by `AuthController.logout/2` (#126 detach) and
  `MeController.delete/2` (#157 account wipe) — bearer revocation /
  account deletion is mid-flight enforcement, not just connect-time:
  without this push a logged-out / deleted browser keeps receiving PubSub
  fan-out until its next message is rejected.

  Fire-and-forget: a PubSub-server-unreachable `{:error, _}` is logged and
  swallowed (the caller has already revoked / deleted the session row, so
  the WS is rejected on its next message anyway) — never blocks the
  teardown response.
  """
  @spec disconnect_subject(GrappaWeb.Subject.t()) :: :ok
  def disconnect_subject(subject), do: disconnect_user_name(Subject.topic_label(subject))

  @doc """
  Close the live WebSocket(s) for a subject addressed by its `user_name`
  (the id-topic label `assign_subject/2` installs — `user.name` for a
  user, `"visitor:" <> id` for a visitor). The WS-layer twin of
  `disconnect_subject/1` for callers that hold the `user_name` (the
  channel socket assign) but not the struct subject — GH #630's flood
  sever runs inside `GrappaChannel.handle_in`, where only `user_name` is
  in scope. Both go through the SAME id-topic broadcast so there is ONE
  socket-teardown code path.

  Fire-and-forget: a PubSub-server-unreachable `{:error, _}` is logged and
  swallowed (the caller has already revoked the session, so the socket is
  rejected on its next connect anyway).
  """
  @spec disconnect_user_name(String.t()) :: :ok
  def disconnect_user_name(user_name) when is_binary(user_name),
    do: user_name |> id_for_user_name() |> push_disconnect()

  @doc """
  Close the live WebSocket(s) carrying ONE bearer session, leaving every
  other socket of the same subject serving (#1499).

  The narrow twin of `disconnect_user_name/1`, for the doors that kill a
  single row rather than an account: the idle-session reaper is the
  first, and it is the one that made the difference visible, because it
  fires on a timer with nobody behind it. Same id-topic broadcast, a
  different address — one teardown code path, two granularities.

  Usually one socket, not necessarily: two transports opened with the
  same bearer share the session and both go down, which is correct —
  the row under them is what died.

  Fire-and-forget on the same terms as `disconnect_user_name/1`.
  """
  @spec disconnect_session(Ecto.UUID.t()) :: :ok
  def disconnect_session(session_id) when is_binary(session_id),
    do: session_id |> id_for_session() |> push_disconnect()

  # The ONE socket-teardown broadcast, shared by both granularities. A
  # PubSub-unreachable `{:error, _}` is logged and swallowed: the caller
  # has already revoked or deleted the row, so the socket is refused at
  # its next connect regardless, and a failed accelerator must never turn
  # a completed revocation into a failed one.
  @spec push_disconnect(String.t()) :: :ok
  defp push_disconnect(socket_id) do
    case GrappaWeb.Endpoint.broadcast(socket_id, "disconnect", %{}) do
      :ok ->
        :ok

      {:error, reason} ->
        Logger.warning("socket disconnect broadcast failed",
          socket_id: socket_id,
          reason: inspect(reason)
        )

        :ok
    end
  end

  @spec id_for_user_name(String.t()) :: String.t()
  defp id_for_user_name(user_name) when is_binary(user_name),
    do: "user_socket:" <> user_name

  defp assign_subject(socket, %Session{user_id: user_id, visitor_id: nil})
       when is_binary(user_id) do
    # FK guarantees the user row exists (ON DELETE CASCADE);
    # `Ecto.NoResultsError` here would be an invariant violation
    # worth crashing on.
    user = Accounts.get_user!(user_id)

    socket =
      socket
      |> assign(:user_name, Subject.topic_label({:user, user}))
      |> assign(:current_subject, {:user, user.id})
      # M-11: surface the `is_admin` bit at the socket boundary so
      # `GrappaWeb.AdminChannel.authorize/1` can gate on it without
      # widening `current_subject` away from the bare-id tuple
      # contract (V4 visitor-parity: `Grappa.Subject.t()` is
      # `{:user, uuid} | {:visitor, uuid}`, NOT `{:user, %User{}}`).
      # Reading the bit here keeps the WS authz a constant-time
      # assigns check — no per-join Repo lookup.
      |> assign(:is_admin, user.is_admin)

    {:ok, socket}
  end

  defp assign_subject(socket, %Session{user_id: nil, visitor_id: visitor_id})
       when is_binary(visitor_id) do
    case Visitors.touch(visitor_id) do
      {:ok, %Visitor{} = visitor} ->
        socket =
          socket
          |> assign(:user_name, Subject.topic_label({:visitor, visitor}))
          |> assign(:current_visitor_id, visitor.id)
          |> assign(:current_visitor, visitor)
          |> assign(:current_subject, {:visitor, visitor.id})
          # M-11: visitors are NEVER admins by construction
          # (`is_admin` lives on `User` only); set the assign
          # explicitly so AdminChannel can pattern-match on a
          # single shape across both subject kinds.
          |> assign(:is_admin, false)

        {:ok, socket}

      {:error, _} ->
        # `:expired` (W9 sliding TTL elapsed) and `:not_found`
        # (FK CASCADE invariant violation) both reject the connect —
        # uniform failure surface mirrors `Plugs.Authn` (Task 11).
        :error
    end
  end
end
