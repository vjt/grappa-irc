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
      policy (`add_server/2`, `list_servers/1`, `pick_server!/2`,
      `remove_server/3`).
    * `Grappa.Networks.Credentials` — per-(user, network) credential
      lifecycle; `unbind_credential/2` detaches a credential + stops the
      live session (never deletes the network — GH #105).
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
      Grappa.Ecto.Like,
      Grappa.EncryptedBinary,
      Grappa.IRC,
      Grappa.LiveIntrospection,
      Grappa.PubSub,
      Grappa.Repo,
      Grappa.Scrollback,
      # #543 INC-4 — SessionPlan reads the global addressing config
      # (mode + static-mapping prefix) once per plan build and threads it
      # into `Vhosts.effective_source/3`, so Vhosts stays off ServerSettings.
      Grappa.ServerSettings,
      # #543 INC-5 — SessionPlan folds the platform arm gate
      # (SourceAliasManager.armed?/0, a lock-free persistent_term read) into
      # the addressing config so effective_source/3 stays the single decision
      # point (a disarmed mode 2 HOLDs :mode2_disarmed).
      Grappa.Net.SourceAliasManager,
      Grappa.Session,
      Grappa.Subject,
      Grappa.Vault,
      Grappa.Vhosts,
      Grappa.Visitors.Visitor,
      Grappa.Wire.Time
    ],
    exports: [
      AdminWire,
      Credential,
      Credentials,
      Credentials.AdminWire,
      FeaturedChannel,
      FeaturedChannels,
      FeaturedChannels.AdminWire,
      FeaturedChannels.Wire,
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
  alias Grappa.Networks.{Credential, Credentials, Network, NoServerError, Servers, Wire}
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
  @spec find_or_create_network(%{
          required(:slug) => String.t(),
          optional(:services_flavor) => Network.services_flavor() | String.t() | nil
        }) ::
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
  Grants `user` access to a network, and guarantees the access is
  DIALABLE. The operator-facing verb (#1158): "credential" is the
  internal noun for the row this writes, and stops being the word any
  operator surface uses.

  `network_spec` names the network by `:slug` (created on first use,
  like `find_or_create_network/1`), optionally classifies it
  (`:services_flavor`) and optionally ensures one server
  (`:server` — `%{host:, port:, tls:, source_address:}`, idempotent
  per `(network, host, port)`). `settings` is what that network means
  for that user — nick, ident, realname, auth method, SASL user,
  autojoin, secrets — and goes through `Credentials.bind_credential/3`
  unchanged, so every validation and the at-rest encryption stay where
  they are. There is one write path for a credential row, not two.

  ## Why it refuses on `:no_enabled_server`

  A user plus a credential still cannot connect: `SessionPlan.resolve/1`
  picks a server with `Servers.pick_server!/2`, which raises
  `NoServerError` when the network owns none that is enabled. Binding
  anyway produces a row that READS as access in every listing and
  fails only at spawn time — so the check happens here, at the
  boundary, and no half-access is ever written. The dialability test is
  `pick_server!/2` itself, not a re-derived predicate, so the two
  cannot drift apart.

  Not atomic across the three writes, and deliberately so: a network
  and a server are shared per-deployment infra that outlive any one
  binding (#105), so a failed credential leaves them in place for the
  retry rather than rolling back rows another user may already hold.
  """
  @spec add_network(
          User.t(),
          %{
            required(:slug) => String.t(),
            optional(:services_flavor) => Network.services_flavor() | String.t() | nil,
            optional(:server) => map()
          },
          map()
        ) :: {:ok, Credential.t()} | {:error, :no_enabled_server | Ecto.Changeset.t()}
  def add_network(%User{} = user, %{slug: slug} = network_spec, settings)
      when is_binary(slug) and is_map(settings) do
    with {:ok, network} <-
           find_or_create_network(Map.take(network_spec, [:slug, :services_flavor])),
         :ok <- ensure_server(network, Map.get(network_spec, :server)),
         {:ok, network} <- ensure_dialable(network) do
      Credentials.bind_credential(user, network, settings)
    end
  end

  defp ensure_server(%Network{}, nil), do: :ok

  defp ensure_server(%Network{} = network, %{} = server_spec) do
    case Servers.add_server(network, server_spec) do
      {:ok, _} -> :ok
      # Same `(network, host, port)` already registered — the row keeps its
      # prior attributes, as `add_server/2` documents.
      {:error, :already_exists} -> :ok
      {:error, %Ecto.Changeset{}} = error -> error
    end
  end

  defp ensure_dialable(%Network{} = network) do
    network = Repo.preload(network, :servers, force: true)
    _ = Servers.pick_server!(network, 0)
    {:ok, network}
  rescue
    NoServerError -> {:error, :no_enabled_server}
  end

  @doc """
  Revokes `user`'s access to `network`, stopping any live session first.

  The other half of `add_network/3`, and the operator-facing name for
  `Credentials.unbind_credential/2` — which keeps the whole teardown
  contract, including that the network itself survives its last
  binding (#105).
  """
  @spec remove_network(User.t(), Network.t()) :: :ok
  def remove_network(%User{} = user, %Network{} = network) do
    Credentials.unbind_credential(user, network)
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
  #211 phase 3 — every network with `visitor_enabled = true`, ordered by
  slug. This is the runtime visitor allowlist that replaces the
  compile-time `:visitor_network` pin: a visitor may attach ONLY these
  networks, and `Grappa.Visitors.Login` reads this at request time
  (naturally hot — an admin toggle takes effect without a restart).

  Ordered by slug for a deterministic "sole enabled network" default +
  a stable multi-network picker order.
  """
  @spec list_visitor_enabled() :: [Network.t()]
  def list_visitor_enabled do
    query = from(n in Network, where: n.visitor_enabled == true, order_by: [asc: n.slug])
    Repo.all(query)
  end

  @doc """
  #211 phase 6 — every network flagged `visitor_autoconnect = true`,
  ordered by slug. The SUBSET of the visitor allowlist that login
  auto-connects (ruling C: "NO picker, NO extra login step"). A visitor
  logging in gets a Session.Server on EACH of these (multi-network from
  first login, zero friction); the wider `visitor_enabled` set is the
  AVAILABLE tier shown on the home page for on-demand connect.

  Ordered by slug for a deterministic auto-connect order (the anchor
  network — the sync identity proof — is the first; the rest spawn
  async). Reads the flag AND'd with `visitor_enabled` at the login/home
  layer, not here — this reader returns the raw autoconnect set;
  callers that need the strict subset intersect with
  `list_visitor_enabled/0` (the seed guarantees the invariant at rest,
  and a stale `visitor_autoconnect=true` on a disabled network is a
  benign no-op the login filter drops).
  """
  @spec list_visitor_autoconnect() :: [Network.t()]
  def list_visitor_autoconnect do
    query = from(n in Network, where: n.visitor_autoconnect == true, order_by: [asc: n.slug])
    Repo.all(query)
  end

  @doc """
  #211 phase 3 — the visitor-attach allowlist gate. Resolves `slug` to a
  network only when it is `visitor_enabled`.

    * `{:ok, network}` — the slug exists AND accepts visitors.
    * `{:error, :not_visitor_enabled}` — the slug exists but visitors
      are not allowed (admin has not opted it in).
    * `{:error, :not_found}` — no such slug.

  The two distinct error tags let `Grappa.Visitors.Login` surface a
  precise reason (403 not-enabled vs unconfigured) without leaking
  network existence beyond what the visitor already named.
  """
  @spec get_visitor_enabled_network_by_slug(String.t()) ::
          {:ok, Network.t()} | {:error, :not_found | :not_visitor_enabled}
  def get_visitor_enabled_network_by_slug(slug) when is_binary(slug) do
    case Repo.get_by(Network, slug: slug) do
      %Network{visitor_enabled: true} = net -> {:ok, net}
      %Network{} -> {:error, :not_visitor_enabled}
      nil -> {:error, :not_found}
    end
  end

  @doc """
  Look up an accretable network by slug and translate the raw lookup errors
  into the self-serve accretion contract.

  A network may be accreted (visitor OR user, #481) only when the operator
  opted it into the `visitor_enabled` self-serve tier. Shared by BOTH
  accretion doors — `Grappa.Visitors.accrete_network/3` and the user twin
  `GrappaWeb.SessionController.add_user_network/3` — so the two cannot drift
  on the allowlist gate or its error mapping (they were byte-identical
  copies before this lift). The `:network_*` tags are the FallbackController
  wire tokens: 403 not-enabled vs 404/503 unconfigured.
  """
  @spec fetch_accretable_network(String.t()) ::
          {:ok, Network.t()}
          | {:error, :network_not_visitor_enabled | :network_unconfigured}
  def fetch_accretable_network(slug) when is_binary(slug) do
    case get_visitor_enabled_network_by_slug(slug) do
      {:ok, %Network{} = network} -> {:ok, network}
      {:error, :not_visitor_enabled} -> {:error, :network_not_visitor_enabled}
      {:error, :not_found} -> {:error, :network_unconfigured}
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
  archival messages would be orphaned — the `messages.network_id` FK is
  `:restrict` (S29 C2). This is the ONLY path that deletes a network;
  `Credentials.unbind_credential/2` never does (GH #105). Servers
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
    # #211 — count by the surrogate `:id` (always present), NOT `:user_id`.
    # SQL COUNT(user_id) skips NULLs, so a network bound only by visitor
    # credentials (`user_id IS NULL`) would count 0, the delete-guard
    # would pass, and `Repo.delete` would then crash on the visitor
    # credential's FK `ON DELETE RESTRICT`. Counting `:id` guards against
    # BOTH subjects — a network with any credential (user or visitor)
    # refuses deletion, which is the intended invariant.
    query = from(c in Credential, where: c.network_id == ^network_id)
    Repo.aggregate(query, :count, :id)
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
  Returns `%{slug => {network_id, live_nick}}` for every network `subject`
  holds a credential on — the LIVE IRC nick (live session nick, falling
  back to the configured `network_credentials.nick` when no session is up),
  resolved through the ONE reader `resolve_network_nick/2`.

  #498 — the shared own-nick index behind BOTH notify-count doors:
  `Grappa.Push.BadgeCount`'s badge count AND the `/me` unread-count seed
  (`GrappaWeb.MeController.build_unread_counts/2`), plus the read-cursor
  settle recompute. It USED to read the configured `c.nick` off-`Session`
  to dodge a per-network `Session.current_nick/2` GenServer round-trip on
  those hot paths — but nothing rewrites a user's credential nick after a
  `/nick`, so the mention match went permanently stale (matched the old
  nick, missed the new). `current_nick/2` is now a cheap `Registry` value
  lookup (no round-trip), so converging on the live nick is free: the
  count follows the rename immediately, both halves. See DESIGN_NOTES
  2026-07-28 (which retires the 2026-06-21 accepted-staleness tradeoff).

  Subject-polymorphic (ruling E parity): the credential's XOR FK
  (`user_id` / `visitor_id`) drives the `WHERE`. One credentials⋈networks
  query, bounded by the subject's credential count (~tens), then a cheap
  per-credential registry read.
  """
  @spec live_nick_index(Session.subject()) :: %{String.t() => {integer(), String.t()}}
  def live_nick_index({:user, user_id} = subject) when is_binary(user_id) do
    query =
      from(c in Credential,
        join: n in Network,
        on: n.id == c.network_id,
        where: c.user_id == ^user_id,
        select: {n.slug, c.network_id, c.nick}
      )

    query
    |> Repo.all()
    |> nick_index(subject)
  end

  def live_nick_index({:visitor, visitor_id} = subject) when is_binary(visitor_id) do
    query =
      from(c in Credential,
        join: n in Network,
        on: n.id == c.network_id,
        where: c.visitor_id == ^visitor_id,
        select: {n.slug, c.network_id, c.nick}
      )

    query
    |> Repo.all()
    |> nick_index(subject)
  end

  # #498 — the single joined query returns exactly the three scalars the
  # index needs (`{slug, network_id, configured_nick}`); the live nick is
  # then resolved per row via a cheap `Registry` read (`live_nick_or/3`),
  # falling back to the configured nick when no session is up. This is ONE
  # DB query (was a `preload: :network` split into two) — the hot notify
  # doors (#498) run `live_nick_index/1` on the per-message push path, so a
  # second query per call was a real regression.
  @spec nick_index([{String.t(), integer(), String.t()}], Session.subject()) ::
          %{String.t() => {integer(), String.t()}}
  defp nick_index(rows, subject) do
    Map.new(rows, fn {slug, network_id, cred_nick} ->
      {slug, {network_id, live_nick_or(subject, network_id, cred_nick)}}
    end)
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
  Updates the operator-tunable network settings on a network row — the
  admission caps (`max_concurrent_visitor_sessions`,
  `max_concurrent_user_sessions`, `max_per_ip`) AND the #211 phase-3
  runtime visitor allowlist flag (`visitor_enabled`). Operator-side
  entry point used by `mix grappa.set_network_caps` (any DB the
  container can reach), the `PATCH /admin/networks/:slug` admin console,
  and live IEx mutations (`scripts/iex.sh`) — single source for the
  validation + Repo.update round-trip.

  #211 phase 3 renamed this from `update_network_settings/2`: the verb now
  owns the whole editable-network-settings surface (caps + the visitor
  allowlist toggle), not just caps. `visitor_enabled` is a plain boolean
  — no three-valued contract; `Network.changeset/2` casts it.

  Three-valued contract per cap (decision F, B5.3):

    * `nil` — explicitly clears the cap (means "unlimited"). The
      `--clear-max-visitor-sessions` / `--clear-max-user-sessions` /
      `--clear-max-per-ip` mix flags surface this from the
      operator side.
    * `0` — degenerate lock-down (means "allow none"). Explicit
      operator intent, distinct from "unlimited".
    * `N > 0` — the cap itself.

  Negative integers and non-integers are rejected by
  `Network.changeset/2`'s `validate_non_negative_or_nil/2` rule.
  Unsupplied keys keep their current value (changeset only casts the
  allowlist `[:slug, :visitor_enabled, :max_concurrent_visitor_sessions,
  :max_concurrent_user_sessions, :max_per_ip]`).
  """
  # B5.3 review-fix: tightened from `integer() | nil` to
  # `non_neg_integer() | nil` so the typespec matches the changeset's
  # `validate_non_negative_or_nil/2` rule + the schema's
  # `non_neg_integer() | nil` field type. Drift between the spec
  # (loose) and the runtime contract (strict) misled callers into
  # thinking negative values were a runtime concern; they're rejected
  # at the changeset boundary unconditionally.
  @spec update_network_settings(Network.t(), %{
          optional(:services_flavor) => Network.services_flavor() | nil,
          optional(:visitor_enabled) => boolean(),
          optional(:visitor_autoconnect) => boolean(),
          optional(:max_concurrent_visitor_sessions) => non_neg_integer() | nil,
          optional(:max_concurrent_user_sessions) => non_neg_integer() | nil,
          optional(:max_per_ip) => non_neg_integer() | nil
        }) :: {:ok, Network.t()} | {:error, Ecto.Changeset.t()}
  def update_network_settings(%Network{} = network, attrs) when is_map(attrs) do
    network
    |> Network.changeset(attrs)
    |> Repo.update()
  end

  @doc """
  UX-4 bucket B / #211 phase 6: builds the `home_data` envelope returned
  from `GET /me` for a USER subject. Nested
  `%{networks: [...], available_networks: []}` per
  `Networks.Wire.home_data/2`.

  Per-row nick is resolved live via `resolve_network_nick/2`.

  #211 phase 6 — visitors ALSO get a populated `home_data` (via
  `home_data_for_visitor/1`); the two home pages are the SAME
  data-driven component (ruling A).

  #481 — users ALSO get a populated `available_networks` (the retired
  "users get an EMPTY list, ruling C" premise was a #461 relic). Both
  subjects share the on-demand-connect tier: every `visitor_enabled`
  network MINUS the ones already attached. `visitor_enabled` is the
  operator-approved self-serve allowlist — a property of the NETWORK, not
  visitor identity — so the same bound applies to users. (The
  `visitor_enabled` NAME is now a misnomer; rename is schema+wire-touching
  and deferred — see DESIGN_NOTES 2026-07-27.) This is the byte-for-byte
  twin of `home_data_for_visitor/1`'s available computation; the two
  functions differ only in HOW they list attached credentials.
  """
  @spec home_data_for_user(User.t()) :: Wire.home_data()
  def home_data_for_user(%User{id: user_id} = user) do
    credentials = Credentials.list_credentials_for_user(user)

    pairs =
      Enum.map(credentials, fn cred ->
        {cred, resolve_network_nick({:user, user_id}, cred)}
      end)

    attached_slugs = MapSet.new(credentials, fn cred -> cred.network.slug end)

    available_slugs =
      list_visitor_enabled()
      |> Enum.map(& &1.slug)
      |> Enum.reject(&MapSet.member?(attached_slugs, &1))

    Wire.home_data(pairs, available_slugs)
  end

  @doc """
  #211 phase 6 (ruling A): the VISITOR twin of `home_data_for_user/1`.
  Builds the `home_data` envelope for a visitor subject so the user +
  visitor home pages render from the SAME data-driven component.

    * `networks` — one `home_network_row` per attached network
      (`list_visitor_credentials/1`), live-nick + the (now-real)
      `connection_state`. The visitor twin of the user rows.
    * `available_networks` — the on-demand-connect tier: every
      `visitor_enabled` network MINUS the ones already attached (ruling
      C: "home page shows connected + available"). A visitor one-taps one
      to `POST /session/networks` (accretion).

  Subject-scoped (`WHERE visitor_id ==`) — never surfaces another
  subject's credential.
  """
  @spec home_data_for_visitor(Ecto.UUID.t()) :: Wire.home_data()
  def home_data_for_visitor(visitor_id) when is_binary(visitor_id) do
    credentials = Credentials.list_visitor_credentials(visitor_id)

    pairs =
      Enum.map(credentials, fn cred ->
        {cred, resolve_network_nick({:visitor, visitor_id}, cred)}
      end)

    attached_slugs = MapSet.new(credentials, fn cred -> cred.network.slug end)

    available_slugs =
      list_visitor_enabled()
      |> Enum.map(& &1.slug)
      |> Enum.reject(&MapSet.member?(attached_slugs, &1))

    Wire.home_data(pairs, available_slugs)
  end

  @doc """
  Resolves the live IRC nick for a `(subject, credential)` pair. Asks
  the running `Session.Server` for its current nick — which may
  differ from `cred.nick` after NickServ ghost/regain or an explicit
  `/nick`. Falls back to the credential's configured nick when the
  session is parked, failed, or not yet bootstrapped.

  #211 phase 6 — subject-polymorphic (ruling A R1: "visitors as equal
  to users as possible"). Takes a `Session.subject()` tuple so BOTH the
  user `GET /networks` branch (`{:user, id}`) and the new visitor branch
  (`{:visitor, id}`) resolve the live-vs-configured nick through ONE
  reader — a NickServ ghost/regain nick reaches cic's DM topic for a
  visitor exactly as it does for a user (the `networks.ex:508` note
  anticipated "visitor parity for live-nick is one edit").

  Single-sourced for `GET /networks` (`NetworksController.index/2`),
  `home_data_for_user/1`, `home_data_for_visitor/1`, and
  `broadcast_state_change/4`.
  """
  @spec resolve_network_nick(Session.subject(), Credential.t()) :: String.t()
  def resolve_network_nick(subject, %Credential{} = cred) do
    live_nick_or(subject, cred.network_id, cred.nick)
  end

  # #498 — the ONE live-or-fallback nick resolver: the live session nick (a
  # cheap `Session.current_nick/2` Registry lookup), falling back to the
  # configured credential nick when no session is up. Shared by
  # `resolve_network_nick/2` (per `%Credential{}` — the /networks index +
  # home_data) and `nick_index/2` (per query-row — `live_nick_index/1`'s
  # single JOIN), so both read own_nick identically and `live_nick_index/1`
  # needs no second (preload) query to carry a `%Credential{}` into it.
  @spec live_nick_or(Session.subject(), integer(), String.t()) :: String.t()
  defp live_nick_or(subject, network_id, cred_nick) do
    case Session.current_nick(subject, network_id) do
      {:ok, nick} -> nick
      {:error, :no_session} -> cred_nick
    end
  end

  @doc """
  Transitions a credential to `:connected`. Idempotent if already
  `:connected` (no DB write, no broadcast).

  Does NOT spawn the `Session.Server` — see the moduledoc T32 boundary
  note. The caller (`NetworkController` for `/connect`, `Bootstrap` at
  boot) handles admission + `Session.start_session/3`.

  `:parked | :failed → :connected`. Clears the prior `reason` (the
  user reconnecting overrides the prior parked/failed cause). Emits
  `{:connection_state_changed, event}` on `Topic.user(subject_label)`.

  #211 phase 6 — subject-polymorphic (ruling D: visitors carry a real
  `connection_state` now, park/reconnect via the SAME PATCH users do).
  The credential's XOR FK (`user_id` / `visitor_id`) drives the subject;
  the broadcast fans out on the subject's own user-rooted topic.
  """
  @spec connect(Credential.t()) :: {:ok, Credential.t()}
  def connect(%Credential{connection_state: :connected} = cred) do
    {:ok, preload_subject_and_network(cred)}
  end

  def connect(%Credential{connection_state: from} = cred) when from in [:parked, :failed] do
    cred = preload_subject_and_network(cred)
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
    cred = preload_subject_and_network(cred)
    subject = subject_of(cred)

    _ = best_effort_quit(subject, cred.network_id, reason)
    :ok = Session.stop_session(subject, cred.network_id)

    updated = transition!(cred, :parked, reason)
    # GH #417 — a DELIBERATE park clears the persisted explicit away (see
    # clear_away_on_manual_park/1 for the manual-vs-automatic rationale).
    :ok = clear_away_on_manual_park(cred)
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
    cred = preload_subject_and_network(cred)
    subject = subject_of(cred)

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

  Called from a supervised Task (`Task.Supervisor.start_child`) inside
  `Session.Server` to avoid a deadlock:
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

  # GH #417 — a DELIBERATE park clears the persisted explicit away; an
  # AUTOMATIC one keeps it (vjt ruling). The away is tied to the connection
  # the user chose to tear down, so a manual `/disconnect` / `/quit` (this is
  # `disconnect/2`, whose only callers are NetworksController's user-driven
  # disconnect + Operator's CLI verb — both deliberate) drops it. Automatic
  # paths never reach here: a transient backoff/crash/network loss stays
  # `:connected` (the session reconnects and re-asserts the away at 001), and
  # a hard upstream failure goes `:failed` via `mark_failed/2`, which does NOT
  # clear — so a recovering row resumes its away. USER-only: visitor away is
  # never persisted, so there is nothing to clear.
  #
  # Routes through `Credentials.update_away/4` (a FRESH `Repo.get_by` + null),
  # NOT a changeset on the passed struct: a caller could pass a `cred` whose
  # in-memory `away_reason` predates the user's `/away` (today's two callers
  # happen to reload fresh), and a nil-over-stale-nil changeset would no-op
  # while the DB still held the away. The fresh read is the robust clear
  # regardless of caller freshness.
  @spec clear_away_on_manual_park(Credential.t()) :: :ok
  defp clear_away_on_manual_park(%Credential{user_id: uid, network_id: nid})
       when is_binary(uid) do
    case Credentials.update_away(uid, nid, nil, nil) do
      :ok ->
        :ok

      {:error, reason} ->
        # A concurrent unbind in the window after `transition!` already
        # parked the row — the away died with the row, so this is benign.
        # Log (don't silently swallow) for symmetry with
        # `mark_failed_by_ids/3`'s `:not_found` handling.
        Logger.warning("clear_away_on_manual_park: away not cleared",
          user_id: uid,
          network_id: nid,
          reason: inspect(reason)
        )

        :ok
    end
  end

  defp clear_away_on_manual_park(%Credential{}), do: :ok

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

  # #211 phase 6 — the subject a credential belongs to, from its XOR FK.
  # `connect/1` / `disconnect/2` are subject-polymorphic now (visitors
  # carry a real connection_state, ruling D), so the session
  # spawn/stop key + the broadcast topic derive from whichever FK is set.
  @spec subject_of(Credential.t()) :: Session.subject()
  defp subject_of(%Credential{user_id: uid}) when is_binary(uid), do: {:user, uid}
  defp subject_of(%Credential{visitor_id: vid}) when is_binary(vid), do: {:visitor, vid}

  # The user-rooted PubSub topic segment for a credential's subject —
  # the shared `Grappa.Subject.label/1` codec (#413): `user.name` for
  # users, `"visitor:" <> visitor_id` for visitors (the SAME label
  # `UserSocket`/`Visitors.SessionPlan`/`GrappaWeb.Subject` use). A
  # visitor needs no `%Visitor{}` load — the id alone builds the label.
  @spec subject_label_of(Credential.t()) :: String.t()
  defp subject_label_of(%Credential{user: %User{name: name}}) when is_binary(name),
    do: Grappa.Subject.label({:user, name})

  defp subject_label_of(%Credential{visitor_id: vid}) when is_binary(vid),
    do: Grappa.Subject.label({:visitor, vid})

  # Preload the network (both subjects) + the User struct (user
  # credentials only — a visitor credential needs no struct load; its
  # topic label + subject tuple come from the `visitor_id` FK directly,
  # keeping `Networks` off a `Grappa.Visitors` dep, the dirty_xref).
  @spec preload_subject_and_network(Credential.t()) :: Credential.t()
  defp preload_subject_and_network(%Credential{} = cred) do
    cred
    |> maybe_preload_user()
    |> maybe_preload_network()
  end

  defp maybe_preload_user(%Credential{user: %User{}} = cred), do: cred
  # Visitor credential (user_id IS NULL) — nothing to preload; the
  # visitor_id FK is all the broadcast + subject derivation need.
  defp maybe_preload_user(%Credential{user_id: nil} = cred), do: cred

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
  defp broadcast_state_change(%Credential{} = cred, from, to, reason) do
    # #211 phase 6 — subject-polymorphic. Topic = the subject's own
    # user-rooted segment (`user.name` / `"visitor:" <> id`); the nick is
    # the per-subject live-nick-with-fallback. Both derive from the
    # credential's XOR FK, so a visitor park/reconnect fans out on its
    # own topic exactly as a user's does. cic's `userTopic.ts`
    # `connection_state_changed` handler acts only on `payload.network`
    # (patchHomeNetwork + refetchNetworks) — subject-agnostic.
    topic = Topic.user(subject_label_of(cred))
    nick = resolve_network_nick(subject_of(cred), cred)

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
