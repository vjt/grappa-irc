defmodule Grappa.Networks do
  @moduledoc """
  Operator-managed IRC network bindings — slim core: network slug CRUD
  + T32 connection-state transitions (`connect/1`, `disconnect/2`,
  `mark_failed/2`).

  Networks + servers are shared per-deployment infra (one Azzurra row,
  many users bind it). Credentials are per-(user, network) and carry
  the Cloak-encrypted upstream password. The umbrella context is split
  into four cohesive sub-modules:

    * `Grappa.Networks` (this module) — network slug CRUD +
      T32 connection-state transitions.
    * `Grappa.Networks.Servers` — server-endpoint CRUD + selection
      policy (`add_server/2`, `list_servers/1`, `pick_server!/1`,
      `remove_server/3`).
    * `Grappa.Networks.Credentials` — per-(user, network) credential
      lifecycle including the cascade-on-empty `unbind_credential/2`
      transaction (Session/Scrollback orchestration).
    * `Grappa.Networks.SessionPlan` — pure resolver: credential →
      primitive `t:Grappa.Session.start_opts/0` map.

  ## T32 connection-state boundary note

  `connect/1`, `disconnect/2`, `mark_failed/2` do **DB transition +
  PubSub broadcast + (for the stop-shape paths) `Session.stop_session/2`
  + an explicit upstream QUIT before stop**. They do NOT spawn
  `Session.Server` — that orchestration (admission + start_session)
  lives at the caller. Pre-S1.2 the plan called for an
  in-`Networks` `spawn_session/1` helper, which would have created a
  `Networks ↔ Admission` boundary cycle (`Admission` deps `Networks`
  for cap reads); keeping spawn at the caller (`NetworkController` for
  `/connect`, `Bootstrap` at boot) sidesteps the cycle and matches how
  `Visitors.Login` already orchestrates admission+spawn for the
  visitor side.

  Boundary deps + exports remain at this umbrella; sub-modules share
  the same Boundary contract by default.
  """
  use Boundary,
    top_level?: true,
    deps: [
      Grappa.Accounts,
      Grappa.EncryptedBinary,
      Grappa.IRC,
      Grappa.LiveIntrospection,
      Grappa.PubSub,
      Grappa.Repo,
      Grappa.Scrollback,
      Grappa.Session,
      Grappa.Vault,
      Grappa.Wire.Time
    ],
    exports: [
      AdminWire,
      Credential,
      Credentials,
      Credentials.AdminWire,
      Network,
      NoServerError,
      Server,
      Servers,
      Servers.AdminWire,
      SessionPlan,
      Wire
    ]

  import Ecto.Query, only: [from: 2]

  alias Grappa.{Accounts, Repo, Scrollback, Session}
  alias Grappa.Accounts.User
  alias Grappa.Networks.{Credential, Network, Wire}
  alias Grappa.PubSub.Topic

  require Logger

  @doc """
  Idempotently fetches-or-creates a network by slug. Concurrent
  callers race on the unique index — the loser retries the
  `Repo.get_by/2` once and returns the just-inserted row. Genuine
  validation failures (bad slug) still return `{:error, changeset}`.

  The retry lives here, not at every call site, so callers can do the
  one-armed `{:ok, network} = ...` match without each one re-deriving
  the race-handling rule.

  B5.4 M-pers-6: validate the slug at the entry point BEFORE the
  `Repo.get_by/2` fast-path, so a bad-slug row that landed via raw
  SQL (or a pre-validation ancestor of this code) doesn't get
  returned as `{:ok, _}` — that would mask the operator-side typo
  the changeset is supposed to surface. The recovery step
  (`insert_or_recover/2`) ALSO tightens its fall-through to fire only
  on a uniqueness violation, so a non-uniqueness changeset error
  (FK miss, validate_number, etc. — none today, but hardened for
  future cap fields) surfaces directly instead of being masked by a
  racing get_by.
  """
  @spec find_or_create_network(%{required(:slug) => String.t()}) ::
          {:ok, Network.t()} | {:error, Ecto.Changeset.t()}
  def find_or_create_network(%{slug: slug} = attrs) when is_binary(slug) do
    cs = Network.changeset(%Network{}, attrs)

    if cs.valid? do
      lookup_or_insert(attrs, slug)
    else
      {:error, cs}
    end
  end

  defp lookup_or_insert(attrs, slug) do
    case Repo.get_by(Network, slug: slug) do
      %Network{} = net -> {:ok, net}
      nil -> insert_or_recover(attrs, slug)
    end
  end

  # Insert; on changeset error, discriminate by error type:
  #
  #   * uniqueness violation on `:slug` — we lost the race against a
  #     concurrent insert. Retry `Repo.get_by/2` to return the
  #     just-inserted row.
  #   * any other error — genuine validation failure (FK miss, future
  #     cap field, etc.). Surface the changeset directly. Pre-B5.4 the
  #     fall-through retried `get_by` for ANY changeset error, which
  #     could mask a validation failure as `{:ok, _}` if a racing
  #     process happened to land a row in the meantime.
  defp insert_or_recover(attrs, slug) do
    case %Network{} |> Network.changeset(attrs) |> Repo.insert() do
      {:ok, net} ->
        {:ok, net}

      {:error, %Ecto.Changeset{} = cs} ->
        if uniqueness_violation?(cs, :slug) do
          recover_race(cs, slug)
        else
          {:error, cs}
        end
    end
  end

  defp recover_race(cs, slug) do
    case Repo.get_by(Network, slug: slug) do
      %Network{} = net -> {:ok, net}
      # Racy: the row vanished between insert + recovery. Surface the
      # uniqueness changeset; caller can decide to retry.
      nil -> {:error, cs}
    end
  end

  defp uniqueness_violation?(%Ecto.Changeset{errors: errors}, field) do
    Enum.any?(errors, fn
      {^field, {_, opts}} -> Keyword.get(opts, :constraint) == :unique
      _ -> false
    end)
  end

  @doc """
  Fetches a network by slug or returns `{:error, :not_found}`. The
  REST surface uses this to translate the URL `:network_id` slug into
  the integer FK that Scrollback rows are keyed on; the operator-side
  mix tasks use `Repo.get_by!/2` directly because a typo there should
  fail loudly.
  """
  @spec get_network_by_slug(String.t()) :: {:ok, Network.t()} | {:error, :not_found}
  def get_network_by_slug(slug) when is_binary(slug) do
    case Repo.get_by(Network, slug: slug) do
      %Network{} = net -> {:ok, net}
      nil -> {:error, :not_found}
    end
  end

  @doc """
  Strict-create sibling of `find_or_create_network/1` for the admin
  REST surface (`POST /admin/networks`, admin-panel bucket 1). Returns
  `{:error, :already_exists}` when the slug is taken — operator
  POSTing an existing slug is an operator-side mistake, not the
  idempotent fall-through `find_or_create_network/1` carries for
  bootstrap-path callers. Other validation errors come back as a
  changeset for FallbackController's `validation_failed` shape.
  """
  @spec create_network(map()) ::
          {:ok, Network.t()} | {:error, :already_exists | Ecto.Changeset.t()}
  def create_network(attrs) when is_map(attrs) do
    changeset = Network.changeset(%Network{}, attrs)

    case Repo.insert(changeset) do
      {:ok, net} ->
        {:ok, net}

      {:error, %Ecto.Changeset{} = cs} ->
        if uniqueness_violation?(cs, :slug),
          do: {:error, :already_exists},
          else: {:error, cs}
    end
  end

  @doc """
  Deletes a network row. Refuses with `{:error, {:credentials_present, N}}`
  when any user has a credential bound — operator must unbind every
  credential first (per admin-panel A-5: no silent cascade across other
  users' sessions). Refuses with `{:error, :scrollback_present}` when
  archival messages would be orphaned — same gate as
  `Credentials.unbind_credential/2`'s cascade-on-empty path. Servers
  cascade via the FK `:delete_all` from `network_servers`.

  Returns `{:error, :not_found}` for an unknown / stale id —
  idempotency-by-rejection (matches `Networks.disconnect/2`'s
  `:not_connected` posture).
  """
  @spec delete_network(Network.t()) ::
          :ok
          | {:error,
             :not_found
             | :scrollback_present
             | {:credentials_present, non_neg_integer()}}
  def delete_network(%Network{id: network_id}) when is_integer(network_id) do
    case Repo.get(Network, network_id) do
      nil ->
        {:error, :not_found}

      %Network{} = net ->
        cred_count = count_credentials_for_network(network_id)

        cond do
          cred_count > 0 ->
            {:error, {:credentials_present, cred_count}}

          Scrollback.has_messages_for_network?(network_id) ->
            {:error, :scrollback_present}

          true ->
            {:ok, _} = Repo.delete(net)
            :ok
        end
    end
  end

  defp count_credentials_for_network(network_id) do
    query = from(c in Credential, where: c.network_id == ^network_id)
    Repo.aggregate(query, :count, :user_id)
  end

  @doc """
  Like `get_network_by_slug/1` but preloads `:servers` on the returned
  Network. Bucket H lifecycle/S2 unification: `Grappa.Bootstrap`'s
  servers-bound invariant validator needs the in-memory server list
  per visitor-pinned network; piping through Networks keeps the
  Repo dependency where it belongs (Networks owns Network preload
  semantics) and avoids forcing Bootstrap to add a Repo Boundary
  edge for one preload site.
  """
  @spec get_network_with_servers_by_slug(String.t()) ::
          {:ok, Network.t()} | {:error, :not_found}
  def get_network_with_servers_by_slug(slug) when is_binary(slug) do
    case Repo.get_by(Network, slug: slug) do
      %Network{} = net -> {:ok, Repo.preload(net, :servers)}
      nil -> {:error, :not_found}
    end
  end

  @doc """
  Like `get_network_by_slug/1` but raises `Ecto.NoResultsError` when
  the slug isn't bound. The operator-side mix tasks
  (`grappa.add_server`, `grappa.remove_server`,
  `grappa.unbind_network`, `grappa.update_network_credential`) want
  loud failure on a typo; this function lets them go through the
  Networks boundary instead of `Repo.get_by!(Network, slug: ...)` —
  Networks owns slug lookup semantics so future evolutions
  (case-insensitive, soft-delete filter, telemetry) stay
  single-sourced.
  """
  @spec get_network_by_slug!(String.t()) :: Network.t()
  def get_network_by_slug!(slug) when is_binary(slug),
    do: Repo.get_by!(Network, slug: slug)

  @doc """
  Fetches a network by integer id. Raises `Ecto.NoResultsError` on miss.

  Used by callers that already hold a network id (from URL params,
  Bootstrap loops, etc.) and want to crash loudly on a stale FK.
  `Grappa.Networks.SessionPlan.resolve/1` doesn't go through this —
  it preloads servers off the credential's `:network` association
  directly.
  """
  @spec get_network!(integer()) :: Network.t()
  def get_network!(id) when is_integer(id), do: Repo.get!(Network, id)

  @doc """
  Typed-error sibling of `get_network!/1` for HTTP / programmatic
  callers (M-cluster M-5 `POST /admin/circuit/:network_id/reset`).
  Returns `nil` when the id doesn't exist; callers translate to
  `{:error, :not_found}` at their boundary.
  """
  @spec get_network(integer()) :: Network.t() | nil
  def get_network(id) when is_integer(id), do: Repo.get(Network, id)

  @doc """
  Returns `%{slug => id}` for every networks row. Operator surface
  (M-cluster M-4) needs to resolve N visitor `network_slug`s to
  integer FKs for live-registry lookups; one DB roundtrip beats N
  per-slug fetches. Tiny tables — networks is operator-curated,
  not user-driven, so the full materialization is fine.
  """
  @spec network_id_by_slug_index() :: %{String.t() => integer()}
  def network_id_by_slug_index do
    query = from(n in Network, select: {n.slug, n.id})

    query
    |> Repo.all()
    |> Map.new()
  end

  @doc """
  Returns `%{slug => {network_id, configured_nick}}` for every network
  `user_id` holds a credential on.

  This is the CONFIGURED (`network_credentials.nick`) nick, NOT the live
  Session nick — deliberately off-`Session.Server`. Sole consumer is
  `Grappa.Push.BadgeCount`, whose count runs on the read-cursor settle
  hot path (door #3); a `Session.current_nick/2` GenServer round-trip
  per network there is unacceptable, and the badge's mention match only
  needs an approximation of own_nick. Accepted staleness: after a
  `/nick` rename the badge's mention match uses the configured nick
  until the next reconnect rewrites the credential. Documented in
  `BadgeCount`'s moduledoc + DESIGN_NOTES 2026-06-21.

  Single joined query (credentials ⋈ networks); bounded by the user's
  credential count (~tens). Mirrors `resolve_network_nick/2`'s
  fallback branch (`cred.nick`) without the live lookup.
  """
  @spec configured_nick_index(Ecto.UUID.t()) :: %{String.t() => {integer(), String.t()}}
  def configured_nick_index(user_id) when is_binary(user_id) do
    query =
      from(c in Credential,
        join: n in Network,
        on: n.id == c.network_id,
        where: c.user_id == ^user_id,
        select: {n.slug, c.network_id, c.nick}
      )

    query
    |> Repo.all()
    |> Map.new(fn {slug, network_id, nick} -> {slug, {network_id, nick}} end)
  end

  @doc """
  Every network row, ordered by `slug` ascending. Operator-facing —
  the M-5 admin console (`GET /admin/networks`) materializes the
  full table. Networks are operator-curated infra (low cardinality),
  so the full materialization is fine.

  Note: the M-5 controller composes this with
  `Grappa.Admission.NetworkCircuit.entries/0` directly rather than
  taking a `Networks.list_all_with_circuit_state/0` route. Reason: a
  `Networks → Admission` boundary edge would form a cycle
  (`Admission` already deps `Networks` for cap reads at
  `check_capacity/1`). Composition at the controller keeps the
  contexts cycle-free and matches the M-4 precedent
  (`VisitorsController.index/2` composes `Visitors.list_all/0` with
  `LiveIntrospection` lookups itself).
  """
  @spec list_all() :: [Network.t()]
  def list_all do
    query = from(n in Network, order_by: [asc: n.slug])
    Repo.all(query)
  end

  @doc """
  Updates the admission caps (`max_concurrent_visitor_sessions`,
  `max_concurrent_user_sessions`, `max_per_client`) on a network row.
  Operator-side entry point used by `mix grappa.set_network_caps`
  (any DB the container can reach) and live IEx mutations
  (`scripts/iex.sh`) — single source for the validation + Repo.update
  round-trip.

  Three-valued contract per cap (decision F, B5.3):

    * `nil` — explicitly clears the cap (means "unlimited"). The
      `--clear-max-visitor-sessions` / `--clear-max-user-sessions` /
      `--clear-max-per-client` mix flags surface this from the
      operator side.
    * `0` — degenerate lock-down (means "allow none"). Explicit
      operator intent, distinct from "unlimited".
    * `N > 0` — the cap itself.

  Negative integers and non-integers are rejected by
  `Network.changeset/2`'s `validate_non_negative_or_nil/2` rule.
  Unsupplied keys keep their current value (changeset only casts the
  allowlist `[:slug, :max_concurrent_visitor_sessions,
  :max_concurrent_user_sessions, :max_per_client]`).
  """
  # B5.3 review-fix: tightened from `integer() | nil` to
  # `non_neg_integer() | nil` so the typespec matches the changeset's
  # `validate_non_negative_or_nil/2` rule + the schema's
  # `non_neg_integer() | nil` field type. Drift between the spec
  # (loose) and the runtime contract (strict) misled callers into
  # thinking negative values were a runtime concern; they're rejected
  # at the changeset boundary unconditionally.
  @spec update_network_caps(Network.t(), %{
          optional(:max_concurrent_visitor_sessions) => non_neg_integer() | nil,
          optional(:max_concurrent_user_sessions) => non_neg_integer() | nil,
          optional(:max_per_client) => non_neg_integer() | nil
        }) :: {:ok, Network.t()} | {:error, Ecto.Changeset.t()}
  def update_network_caps(%Network{} = network, attrs) when is_map(attrs) do
    network
    |> Network.changeset(attrs)
    |> Repo.update()
  end

  @doc """
  UX-4 bucket B: builds the `home_data` envelope returned from
  `GET /me` for a user subject. Nested
  `%{networks: [home_network_row, ...]}` per
  `Networks.Wire.home_data/1`.

  Per-row nick is resolved live via `resolve_network_nick/2` (live
  IRC nick from the running Session.Server, falling back to
  `cred.nick` on `:no_session`). Same resolution rule the
  `GET /networks` controller uses — single source.

  Visitors do not call this — `MeJSON.show/1` sets
  `home_data: nil` directly for visitor subjects.
  """
  @spec home_data_for_user(User.t()) :: Wire.home_data()
  def home_data_for_user(%User{id: user_id} = user) do
    user
    |> Grappa.Networks.Credentials.list_credentials_for_user()
    |> Enum.map(fn cred -> {cred, resolve_network_nick(user_id, cred)} end)
    |> Wire.home_data()
  end

  @doc """
  Resolves the live IRC nick for a `(user_id, credential)` pair. Asks
  the running `Session.Server` for its current nick — which may
  differ from `cred.nick` after NickServ ghost/regain or an explicit
  `/nick`. Falls back to the credential's configured nick when the
  session is parked, failed, or not yet bootstrapped.

  Single-sourced for `GET /networks` (`NetworksController.index/2`)
  and `home_data_for_user/1` so a future divergence (e.g. visitor
  parity for live-nick) is one edit.
  """
  @spec resolve_network_nick(Ecto.UUID.t(), Credential.t()) :: String.t()
  def resolve_network_nick(user_id, %Credential{} = cred) do
    case Session.current_nick({:user, user_id}, cred.network_id) do
      {:ok, nick} -> nick
      {:error, :no_session} -> cred.nick
    end
  end

  @typedoc """
  PubSub event payload broadcast on every successful (non-idempotent)
  `connection_state` transition. Topic shape is
  `Grappa.PubSub.Topic.user(user_name)` — delivered on the user-level
  channel alongside `channels_changed`, `query_windows_list`,
  `own_nick_changed`, etc., because the cicchetto user-level WS
  channel is the only WS channel cic joins for non-channel events
  (no per-network channel join exists). Network discrimination is
  carried in the `network_slug:` payload field.

  Subscribers (cicchetto via `userTopic.ts`, future Phase 6 listener)
  consume this to render the user-visible state badge + the
  server-messages-window lifecycle line.

  Delivered through `Grappa.PubSub.broadcast_event/2` so cic receives
  it via the framework fastlane (no manual `Phoenix.PubSub.subscribe`
  on `GrappaChannel`). The `kind:` discriminator is a string literal
  matching the cic-side wire-event dispatch contract.
  """
  @type connection_state_changed_event :: %{
          kind: String.t(),
          user_id: Ecto.UUID.t(),
          network_id: integer(),
          network_slug: String.t(),
          from: Credential.connection_state(),
          to: Credential.connection_state(),
          reason: String.t() | nil,
          at: DateTime.t()
        }

  @doc """
  Transitions a credential to `:connected`. Idempotent if already
  `:connected` (no DB write, no broadcast).

  Does NOT spawn the `Session.Server` — see the moduledoc T32 boundary
  note. The caller (`NetworkController` for `/connect`, `Bootstrap` at
  boot) handles admission + `Session.start_session/3`.

  `:parked | :failed → :connected`. Clears the prior `reason` (the
  user reconnecting overrides the prior parked/failed cause). Emits
  `{:connection_state_changed, event}` on
  `Topic.network(user_name, network_slug)`.
  """
  @spec connect(Credential.t()) :: {:ok, Credential.t()}
  def connect(%Credential{connection_state: :connected} = cred) do
    {:ok, preload_user_and_network(cred)}
  end

  def connect(%Credential{connection_state: from} = cred) when from in [:parked, :failed] do
    cred = preload_user_and_network(cred)
    updated = transition!(cred, :connected, nil)
    broadcast_state_change(updated, from, :connected, nil)
    {:ok, updated}
  end

  # REV-B / H6 (2026-05-22 codebase review): explicit fallthrough raises
  # on any future `Credential.connection_state()` addition (e.g. a
  # SASL-gated `:locked`). Without this, the Dialyzer spec lies — the
  # clauses above are exhaustive on the CURRENT enum but not the future
  # one, and runtime falls through as `FunctionClauseError` instead of
  # the typed `{:ok, _}` contract. Per `feedback_no_silent_drops_closed`,
  # we RAISE rather than `{:error, _}`-fallthrough so the enum addition
  # is visible at the call sites that hold a fully-typed credential.
  # Mirrors `Scrollback.subject_where/2` (B5.4 L-pers-2 precedent).
  def connect(%Credential{connection_state: other}),
    do: raise(ArgumentError, "Networks.connect: unhandled connection_state #{inspect(other)}")

  @doc """
  Transitions a credential to `:parked` (user-initiated `/disconnect`
  or `/quit`). `:connected → :parked`; rejects from `:parked | :failed`
  with `{:error, :not_connected}` (idempotency-by-rejection, not
  silent no-op — the caller is asking to disconnect a row that's
  already not connected, surface that).

  Issues an explicit `QUIT :<reason>` upstream first (best-effort —
  no live session is fine) so the upstream sees a clean disconnect
  message rather than the abrupt socket close from the supervised
  stop. Then terminates `Session.Server` via `Session.stop_session/2`,
  writes the DB transition, and broadcasts.
  """
  @spec disconnect(Credential.t(), String.t()) ::
          {:ok, Credential.t()} | {:error, :not_connected}
  def disconnect(%Credential{connection_state: :connected} = cred, reason)
      when is_binary(reason) do
    cred = preload_user_and_network(cred)
    subject = {:user, cred.user_id}

    _ = best_effort_quit(subject, cred.network_id, reason)
    :ok = Session.stop_session(subject, cred.network_id)

    updated = transition!(cred, :parked, reason)
    broadcast_state_change(updated, :connected, :parked, reason)
    {:ok, updated}
  end

  def disconnect(%Credential{connection_state: state}, _)
      when state in [:parked, :failed],
      do: {:error, :not_connected}

  # REV-B / H6 (2026-05-22 codebase review): see `connect/1` fallthrough
  # rationale. Raises on any future `Credential.connection_state()`
  # addition rather than silently `FunctionClauseError`-ing.
  def disconnect(%Credential{connection_state: other}, _),
    do: raise(ArgumentError, "Networks.disconnect: unhandled connection_state #{inspect(other)}")

  @doc """
  Server-internal: marks a credential `:failed` after a hard upstream
  failure (k-line / permanent SASL — see plan S1.4 lenient triggers).
  Terminates the `Session.Server` (the `:transient` restart strategy
  doesn't restart on `:normal`-shape stops; the supervisor terminating
  the child achieves the same).

  `:connected → :failed`. Idempotent if already `:failed` (no DB
  write, no broadcast). Rejects from `:parked` with
  `{:error, :user_parked}` — `:parked` is explicit user intent
  ("don't reconnect this row"), and a server-set terminal failure
  shouldn't quietly overwrite that. The caller (Session.Server's
  `handle_terminal_failure`) is expected to log + drop the
  transition rather than retry.
  """
  @spec mark_failed(Credential.t(), String.t()) ::
          {:ok, Credential.t()} | {:error, :user_parked}
  def mark_failed(%Credential{connection_state: :failed} = cred, _), do: {:ok, cred}

  def mark_failed(%Credential{connection_state: :connected} = cred, reason)
      when is_binary(reason) do
    cred = preload_user_and_network(cred)
    subject = {:user, cred.user_id}

    :ok = Session.stop_session(subject, cred.network_id, reason)

    updated = transition!(cred, :failed, reason)
    broadcast_state_change(updated, :connected, :failed, reason)
    {:ok, updated}
  end

  def mark_failed(%Credential{connection_state: :parked}, _),
    do: {:error, :user_parked}

  # REV-B / H6 (2026-05-22 codebase review): see `connect/1` fallthrough
  # rationale. Raises on any future `Credential.connection_state()`
  # addition rather than silently `FunctionClauseError`-ing.
  def mark_failed(%Credential{connection_state: other}, _),
    do: raise(ArgumentError, "Networks.mark_failed: unhandled connection_state #{inspect(other)}")

  @doc """
  Session-internal variant of `mark_failed/2` for use from
  `Session.Server.handle_terminal_failure/2`. Looks up the credential by
  `user_id` + `network_id` and delegates to `mark_failed/2`.

  Called from a `Task.start` inside `Session.Server` to avoid a deadlock:
  `mark_failed/2` calls `Session.stop_session/2` which calls
  `DynamicSupervisor.terminate_child/2` — if the Session.Server called
  `mark_failed/2` synchronously while still running, the terminate_child
  would block waiting for the server to exit, which can't happen because the
  server is blocked in the `mark_failed` call. The Task runs after `{:stop,
  :normal}` has already exited the GenServer, so `stop_session` finds
  `whereis/2 → nil` and is a no-op.

  Only meaningful for user sessions (`{:user, user_id}`). Visitor sessions
  are ephemeral and have no `connection_state` column to transition.

  Returns `:ok` unconditionally — caller (the Task) does not need the result.
  """
  @spec mark_failed_by_ids(Ecto.UUID.t(), integer(), String.t()) :: :ok
  def mark_failed_by_ids(user_id, network_id, reason)
      when is_binary(user_id) and is_integer(network_id) and is_binary(reason) do
    case Repo.get_by(Credential, user_id: user_id, network_id: network_id) do
      %Credential{} = cred ->
        case mark_failed(cred, reason) do
          {:ok, _} ->
            :ok

          {:error, :user_parked} ->
            Logger.warning(
              "mark_failed_by_ids: credential is :parked, dropping terminal transition " <>
                "(user_id=#{user_id} network_id=#{network_id})",
              reason: reason
            )

            :ok
        end

      nil ->
        Logger.warning(
          "mark_failed_by_ids: credential not found — visitor or already deleted " <>
            "(user_id=#{user_id} network_id=#{network_id})"
        )

        :ok
    end
  end

  # REV-J M13: routes through `Credential.connection_state_changeset/2`
  # so the same `safe_line_token` guard that protects `realname`,
  # `sasl_user`, `password`, and `auth_command_template` from CR/LF/NUL
  # bytes also covers `connection_state_reason`. Pre-fix this used
  # `Ecto.Changeset.change/2` which skipped every changeset rule; today
  # reasons come from controlled internal sources so the gap was
  # defense-in-depth, but the bypass meant a future schema validation
  # (e.g. "auth_method MUST be compatible with current connection_state")
  # would silently NOT fire here. The narrow changeset is the consistent
  # shape with `Accounts.User.admin_changeset/2`.
  @spec transition!(Credential.t(), Credential.connection_state(), String.t() | nil) ::
          Credential.t()
  defp transition!(%Credential{} = cred, new_state, reason) do
    now = DateTime.truncate(DateTime.utc_now(), :second)

    cred
    |> Credential.connection_state_changeset(%{
      connection_state: new_state,
      connection_state_reason: reason,
      connection_state_changed_at: now
    })
    |> Repo.update!()
  end

  # Best-effort upstream QUIT before the supervised stop. `:no_session`
  # means the row's `Session.Server` already isn't running (crashed,
  # never started, or already stopped) — fine, nothing to QUIT. The
  # `Session.send_quit/3` boundary already rejects CR/LF/NUL in the
  # reason via `Identifier.safe_line_token?/1`; well-behaved callers
  # (`NetworkController` validates user-supplied reasons up front,
  # internal callers build their own strings) won't trip that path,
  # so we silently swallow it rather than carry a fallback shape.
  @spec best_effort_quit(Session.subject(), integer(), String.t()) :: :ok
  defp best_effort_quit(subject, network_id, reason) do
    _ = Session.send_quit(subject, network_id, reason)
    :ok
  end

  @spec preload_user_and_network(Credential.t()) :: Credential.t()
  defp preload_user_and_network(%Credential{} = cred) do
    cred
    |> maybe_preload_user()
    |> maybe_preload_network()
  end

  defp maybe_preload_user(%Credential{user: %User{}} = cred), do: cred

  defp maybe_preload_user(%Credential{user_id: uid} = cred) do
    %Credential{cred | user: Accounts.get_user!(uid)}
  end

  defp maybe_preload_network(%Credential{network: %Network{}} = cred), do: cred

  defp maybe_preload_network(%Credential{network_id: nid} = cred) do
    %Credential{cred | network: Repo.get!(Network, nid)}
  end

  # Phoenix.PubSub.broadcast/3 returns `:ok | {:error, term()}` but
  # the local PG2 adapter never errors in practice (distributed adapters
  # would). The state-transition is the authoritative effect; a missed
  # broadcast is at most a stale UI badge, not a correctness problem.
  # Returning `:ok` unconditionally lets callers stay in `{:ok, _}`-only
  # arms without sprinkling `_ =` at every site.
  # Codebase review 2026-05-08 cross-infra H1: pre-fix this used raw
  # `Phoenix.PubSub.broadcast/3` with a 2-tuple `{:connection_state_changed,
  # ...}`. `GrappaChannel` uses ONLY the framework fastlane subscription
  # (no manual `subscribe`), so fastlane fans out only `%Broadcast{}`
  # envelopes — the raw tuple was a no-op for WS clients. Cic JOINED
  # `grappa:network:slug` but never received the event; T32
  # connect/disconnect state was invisible to the live UI (papered over
  # by REST refetch on PATCH return).
  #
  # Fix: route through `Grappa.PubSub.broadcast_event/2` with payload
  # built by `Networks.Wire.connection_state_changed_event/4` (CP16 B3
  # moved the payload behind the Wire fn — the standard wire-event
  # contract every CP15 typed event uses). Fastlane delivers as
  # `phx_msg{event: "event"}` exactly once per WS subscriber.
  @spec broadcast_state_change(
          Credential.t(),
          Credential.connection_state(),
          Credential.connection_state(),
          String.t() | nil
        ) :: :ok
  defp broadcast_state_change(
         %Credential{user: %User{id: user_id, name: user_name}} = cred,
         from,
         to,
         reason
       ) do
    topic = Topic.user(user_name)
    nick = resolve_network_nick(user_id, cred)

    # REV-J M15: pre-fix this co-emitted two events per transition —
    # the wider `connection_state_changed` and a narrow
    # `home_network_state_changed`. Subscribers seeing both arms
    # observed a temporal window where the first event reflected the
    # new state and the second hadn't landed. Folded into one payload
    # carrying both the wide fields (consumed by Sidebar greyed-cascade
    # + query-window store) and the `:network` `home_network_row` shape
    # HomePane patches in-place. One logical event, one wire payload,
    # one broadcast.
    payload = Wire.connection_state_changed_event(cred, from, to, reason, nick)
    :ok = Grappa.PubSub.broadcast_event(topic, payload)
  end
end
