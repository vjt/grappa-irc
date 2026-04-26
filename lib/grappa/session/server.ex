defmodule Grappa.Session.Server do
  @moduledoc """
  GenServer that owns one `(user_id, network_id)` upstream IRC session.

  Supervises one `Grappa.IRC.Client` (linked via `start_link`) which owns
  the TCP/TLS socket. Inbound parsed `Grappa.IRC.Message` structs arrive
  in this GenServer's mailbox as `{:irc, msg}` tuples; outbound
  protocol-level work (handshake on init, PONG on PING, JOIN on autojoin)
  is performed via the high-level `Grappa.IRC.Client` helpers.

  Registered under `{:via, Registry, {Grappa.SessionRegistry, {:session,
  user_id, network_id}}}` so the public `Grappa.Session.whereis/2`
  facade can resolve a pid from the internal identifiers (UUID +
  integer FK) that every authn'd request handler already has.

  ## Sub-task 2g — DB-backed configuration

  `init/1` takes only `%{user_id, network_id}` and resolves everything
  else from the DB:

    * `Grappa.Accounts.get_user!/1` for the operator-facing user name
      (logger metadata + topic discriminator).
    * `Grappa.Networks.get_network!/1 |> Repo.preload(:servers)` for
      the slug + the list of server endpoints.
    * `Grappa.Networks.get_credential!/2` for the per-(user, network)
      nick / realname / sasl_user / encrypted password / auth_method
      / autojoin list.

  The first enabled server (sorted by `:priority asc`) becomes the
  upstream connect target — fail-over policy across the rest of the
  list is deferred to Phase 5 reconnect/backoff. Empty enabled-server
  list raises `Grappa.Session.Server.NoServerError`; missing credential
  row raises `Ecto.NoResultsError`. Both crash init → DynamicSupervisor
  `:transient` → restart → same wall — operator must intervene
  (`mix grappa.add_server` / `mix grappa.bind_network`).

  ## Phase 1 protocol scope

  This is the walking-skeleton implementation:

    * Upstream registration handshake (PASS, CAP LS, NICK, USER,
      AUTHENTICATE, CAP END) is owned by `Grappa.IRC.Client` —
      `init/1` drives the state machine per `:auth_method`.
    * Autojoin fires on `001 RPL_WELCOME`. Phase 5 hardens this to also
      handle `376 RPL_ENDOFMOTD` / `422 ERR_NOMOTD` and a watchdog
      timeout in case neither arrives.
    * `PRIVMSG` is the only inbound event that gets persisted to
      `Grappa.Scrollback` AND broadcast over `Phoenix.PubSub`. Other
      event types (`JOIN`, `PART`, `QUIT`, `NICK`, `MODE`, `TOPIC`,
      `KICK`) get a `Logger.info` line only — broadcasting them
      requires channel-membership tracking that lands in Phase 5.
    * No reconnect/backoff. A socket close stops the linked Client,
      which kills this Session via the link signal; the
      `DynamicSupervisor` restart policy (`:transient`) brings it back
      with a fresh socket. Phase 5 adds exponential backoff inside
      the Client's connect path.

  ## Wire shape (broadcast contract)

  PRIVMSG broadcasts emit `Grappa.Scrollback.Wire.message_event/1` on
  the per-(user, network, channel) topic built via
  `Grappa.PubSub.Topic.channel/3`. `state.user_name` is the first
  segment (sub-task 2h) so multi-user instances cannot leak broadcasts
  across users — payload-level iso (decision G3 dropped `user_id` from
  the wire) needed routing-level iso to actually keep alice and vjt's
  PubSub mailboxes separate.

  ## Outbound API (Task 9)

  `handle_call({:send_privmsg, target, body}, _, state)` persists a
  scrollback row with `sender = state.nick`, broadcasts on the
  per-channel PubSub topic, AND sends the PRIVMSG upstream — atomic
  from the caller's view, single source for the row + wire event.
  `{:send_join, ch}` / `{:send_part, ch}` are upstream-only
  (channel-membership tracking lands in Phase 5 alongside JOIN/PART
  persistence).
  """
  use GenServer, restart: :transient

  alias Grappa.{Accounts, Log, Networks, Repo, Scrollback}
  alias Grappa.IRC.{Client, Message}
  alias Grappa.Networks.Credential
  alias Grappa.PubSub.Topic
  alias Grappa.Scrollback.Wire

  require Logger

  @type opts :: %{required(:user_id) => Ecto.UUID.t(), required(:network_id) => integer()}

  @type state :: %{
          user_id: Ecto.UUID.t(),
          user_name: String.t(),
          network_id: integer(),
          network_slug: String.t(),
          nick: String.t(),
          autojoin: [String.t()],
          client: pid()
        }

  @logged_event_commands [:join, :part, :quit, :nick, :mode, :topic, :kick]

  defmodule NoServerError do
    @moduledoc """
    Raised at `Grappa.Session.Server` boot when the network resolves to
    zero enabled server endpoints. The operator must add at least one
    via `mix grappa.add_server` before the session can boot.
    """
    defexception [:network_id, :network_slug]

    @impl Exception
    def message(%{network_id: id, network_slug: slug}) do
      "network ##{id} (#{slug}) has no enabled server endpoints"
    end
  end

  ## API

  @spec start_link(opts()) :: GenServer.on_start()
  def start_link(%{user_id: user_id, network_id: network_id} = opts)
      when is_binary(user_id) and is_integer(network_id) do
    GenServer.start_link(__MODULE__, opts, name: via(user_id, network_id))
  end

  @doc """
  Returns the registry key for `(user_id, network_id)`. Single source
  of truth for the `{:session, user_id, network_id}` shape — every
  caller that needs to look up or terminate a session by key must go
  through this. Adding a discriminator (workspace, shard) becomes a
  one-place change.
  """
  @spec registry_key(Ecto.UUID.t(), integer()) :: {:session, Ecto.UUID.t(), integer()}
  def registry_key(user_id, network_id) when is_binary(user_id) and is_integer(network_id) do
    {:session, user_id, network_id}
  end

  @doc "Returns the via-tuple for the session registered for `(user_id, network_id)`."
  @spec via(Ecto.UUID.t(), integer()) ::
          {:via, Registry, {atom(), {:session, Ecto.UUID.t(), integer()}}}
  def via(user_id, network_id) when is_binary(user_id) and is_integer(network_id) do
    {:via, Registry, {Grappa.SessionRegistry, registry_key(user_id, network_id)}}
  end

  ## GenServer callbacks

  @impl GenServer
  def init(%{user_id: user_id, network_id: network_id}) do
    user = Accounts.get_user!(user_id)
    network = network_id |> Networks.get_network!() |> Repo.preload(:servers)
    credential = Networks.get_credential!(user, network)
    server = pick_server(network)

    :ok = Log.set_session_context(user.name, network.slug)

    case Client.start_link(client_opts(server, credential, user.name, network.slug)) do
      {:ok, client} ->
        {:ok,
         %{
           user_id: user_id,
           user_name: user.name,
           network_id: network_id,
           network_slug: network.slug,
           nick: credential.nick,
           autojoin: credential.autojoin_channels,
           client: client
         }}

      {:error, reason} ->
        {:stop, {:client_start_failed, reason}}
    end
  end

  # Persist-then-send is intentional Phase 1. Rationale: if the persist
  # fails (validation), we surface the changeset error to the caller
  # without ever touching the wire — clean rollback. If the persist
  # succeeds and the upstream send subsequently fails, the linked
  # Client crashes, kills this Session via the link, the
  # DynamicSupervisor (`:transient`) restarts a fresh Session — but
  # the row is already in scrollback so the sender's view is
  # consistent (they see what they typed). Reversing the order would
  # give worse UX: message visible to other users on the channel but
  # absent from the sender's own scrollback after refresh. Phase 5
  # reconnect/backoff inside Client may revisit this when send
  # gains an error return.
  @impl GenServer
  def handle_call({:send_privmsg, target, body}, _, state)
      when is_binary(target) and is_binary(body) do
    case persist_and_broadcast(state, target, state.nick, body) do
      {:ok, message} ->
        # `Client.send_privmsg` returns `:ok | {:error, :invalid_line}`
        # since S29 C1. The Session facade pre-validates so the error
        # branch is unreachable on the documented path; the case below
        # is forward-compat insurance against a future caller that
        # bypasses the facade. If it ever fires, surface the typed
        # error to the caller — a MatchError here would crash the
        # session GenServer + trip the transient restart loop, much
        # worse than a 400-shaped error tuple.
        case Client.send_privmsg(state.client, target, body) do
          :ok ->
            {:reply, {:ok, message}, state}

          {:error, :invalid_line} = err ->
            Logger.error("client rejected privmsg AFTER persist — facade bypass?",
              channel: target
            )

            {:reply, err, state}
        end

      {:error, _} = err ->
        {:reply, err, state}
    end
  end

  @impl GenServer
  def handle_cast({:send_join, channel}, state) when is_binary(channel) do
    :ok = Client.send_join(state.client, channel)
    {:noreply, state}
  end

  def handle_cast({:send_part, channel}, state) when is_binary(channel) do
    :ok = Client.send_part(state.client, channel)
    {:noreply, state}
  end

  @impl GenServer
  def handle_info({:irc, %Message{command: {:numeric, 1}}}, state) do
    # autojoin_channels is validated at the credential boundary
    # (`Networks.Credential.changeset/2` — Identifier.valid_channel?
    # per entry) so the happy path never sees `{:error, :invalid_line}`
    # back from Client.send_join. The defensive log+skip below catches
    # any future code path that mutates state.autojoin without going
    # through the changeset (REPL, raw Repo.update, etc.).
    Enum.each(state.autojoin, fn channel ->
      case Client.send_join(state.client, channel) do
        :ok ->
          :ok

        {:error, :invalid_line} ->
          Logger.warning("autojoin skipped: invalid channel name", channel: inspect(channel))
      end
    end)

    {:noreply, state}
  end

  def handle_info({:irc, %Message{command: :ping, params: [token | _]}}, state) do
    :ok = Client.send_pong(state.client, token)
    {:noreply, state}
  end

  def handle_info(
        {:irc, %Message{command: :privmsg, params: [target, body]} = msg},
        state
      )
      when is_binary(body) do
    case persist_and_broadcast(state, target, Message.sender_nick(msg), body) do
      {:ok, _} ->
        :ok

      {:error, changeset} ->
        Logger.error("scrollback insert failed",
          command: :privmsg,
          channel: target,
          error: inspect(changeset.errors)
        )
    end

    {:noreply, state}
  end

  def handle_info(
        {:irc, %Message{command: cmd, params: params} = msg},
        state
      )
      when cmd in @logged_event_commands do
    Logger.info("irc event",
      command: cmd,
      sender: Message.sender_nick(msg),
      channel: List.first(params)
    )

    {:noreply, state}
  end

  def handle_info({:irc, %Message{}}, state), do: {:noreply, state}

  ## Internals

  # Build the IRC.Client opts map from credential + chosen server + the
  # operator-facing names for log metadata. Nick-fallback for realname
  # and sasl_user goes through `Credential.effective_*` so the `||
  # nick` pattern stays in one place — the 2f code review (I1) flagged
  # inline `||` as a violation of CLAUDE.md "no defaults via \\\\".
  @spec client_opts(Networks.Server.t(), Credential.t(), String.t(), String.t()) :: map()
  defp client_opts(server, credential, user_name, network_slug) do
    %{
      host: server.host,
      port: server.port,
      tls: server.tls,
      dispatch_to: self(),
      logger_metadata: Log.session_context(user_name, network_slug),
      nick: credential.nick,
      realname: Credential.effective_realname(credential),
      sasl_user: Credential.effective_sasl_user(credential),
      auth_method: credential.auth_method,
      password: Credential.upstream_password(credential)
    }
  end

  # Lowest-priority enabled server wins. Tie-broken by row id (insertion
  # order) — `Networks.list_servers/1` orders the same way; this filter
  # exists to enforce `:enabled` because the preload doesn't filter.
  # Raises if every server is disabled OR the network has none — the
  # operator misconfiguration should be loud, not silent.
  @spec pick_server(Networks.Network.t()) :: Networks.Server.t()
  defp pick_server(%Networks.Network{servers: servers, id: nid, slug: slug}) do
    case servers |> Enum.filter(& &1.enabled) |> Enum.sort_by(&{&1.priority, &1.id}) do
      [server | _] -> server
      [] -> raise NoServerError, network_id: nid, network_slug: slug
    end
  end

  # Helper does not log — caller decides. Inbound `handle_info`
  # logs because nothing else surfaces the failure; outbound
  # `handle_call` returns the error tuple so the controller (via
  # `FallbackController`) renders the HTTP error.
  @spec persist_and_broadcast(state(), String.t(), String.t(), String.t()) ::
          {:ok, Scrollback.Message.t()} | {:error, Ecto.Changeset.t()}
  defp persist_and_broadcast(state, target, sender, body) do
    case Scrollback.persist_privmsg(state.user_id, state.network_id, target, sender, body) do
      {:ok, message} ->
        # Topic shape is `(user_name, network_slug, channel)` —
        # sub-task 2h roots every Grappa topic in the user
        # discriminator so two users on the same (network, channel)
        # land in different topic strings + different PubSub mailboxes.
        # `:network` is preloaded by `Scrollback.persist_privmsg/5`
        # itself — Wire.message_event pattern-matches on it.
        :ok =
          Phoenix.PubSub.broadcast(
            Grappa.PubSub,
            Topic.channel(state.user_name, state.network_slug, target),
            Wire.message_event(message)
          )

        {:ok, message}

      {:error, _} = err ->
        err
    end
  end
end
