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
      Grappa.Accounts.User,
      Grappa.Ecto.Like,
      Grappa.EncryptedBinary,
      Grappa.IRC,
      Grappa.LiveIntrospection,
      Grappa.PubSub,
      Grappa.Repo,
      Grappa.Scrollback,
      # M3a — the credential's per-network avatar is a `belongs_to`
      # onto `Grappa.Uploads.Upload` (a permanent, `expires_at: nil`
      # row). `Grappa.Uploads`'s own deps are [Repo, Subject,
      # HardenedCmd] — no edge back to `Grappa.Networks` — so this is a
      # one-way dependency, not a cycle.
      Grappa.Uploads,
      # #543 INC-4 — SessionPlan reads the global addressing config
      # (mode + static-mapping prefix) once per plan build and threads it
      # into `Vhosts.effective_source/3`, so Vhosts stays off ServerSettings.
      Grappa.ServerSettings,
      # #543 INC-5 — SessionPlan folds the platform arm gate
      # (SourceAliasManager.armed?/0, a lock-free persistent_term read) into
      # the addressing config so effective_source/3 stays the single decision
      # point (a disarmed mode 2 HOLDs :mode2_disarmed).
      Grappa.Net.SourceAliasManager,
      # The schemas are their own boundaries (#1398): this umbrella holds the
      # context verbs and reaches its own schemas across a declared edge.
      Grappa.Networks.Credential,
      Grappa.Networks.FeaturedChannel,
      Grappa.Networks.Network,
      Grappa.Networks.Server,
      Grappa.Session,
      # #1398 §7 — added alongside `Grappa.Session`, not instead of it:
      # `SessionPlan` reads `Backoff.failure_count/2`, but this boundary makes
      # nine other references into the session context.
      Grappa.Session.Backoff,
      Grappa.Subject,
      Grappa.Vault,
      Grappa.Vhosts,
      Grappa.Visitors.Visitor,
      Grappa.Wire.Time
    ],
    exports: [
      AdminWire,
      Credentials,
      Credentials.AdminWire,
      FeaturedChannels,
      FeaturedChannels.AdminWire,
      FeaturedChannels.Wire,
      NoServerError,
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
  Deletes a network row TOGETHER WITH its scrollback (issue 2320: the
  admin has confirmed, and the confirm names the row count). Refuses with
  `{:error, {:credentials_present, N}}` when any subject has a credential
  bound — operator must unbind every credential first (per admin-panel
  A-5: no silent cascade across other users' sessions). The guard runs
  BEFORE any row goes, so a refused delete loses nothing. This is the ONLY
  path that deletes a network; `Credentials.unbind_credential/2` never
  does (GH #105).

  `messages.network_id` is `ON DELETE RESTRICT` (S29 C2), so the rows are
  purged explicitly — in batches, by `Scrollback.purge_network/1`, because
  one statement over a large network holds the write lock for seconds.
  Every other table referencing `networks` cascades from the final
  `DELETE`, and the only reference INTO `messages`
  (`read_cursors.last_read_message_id`) is `ON DELETE SET NULL`. The
  purge is therefore not atomic with the row delete: the final
  transaction re-checks the guard and sweeps any residue, and a failure
  in between leaves the network with less scrollback, retryable. A
  sustained write-lock contention surfaces as `{:error, :db_unavailable}`.

  Returns `{:error, :not_found}` for an unknown / stale id —
  idempotency-by-rejection (matches `Networks.disconnect/2`'s
  `:not_connected` posture).
  """
  @spec delete_network(Network.t()) ::
          :ok
          | {:error,
             :not_found
             | :db_unavailable
             | {:credentials_present, non_neg_integer()}}
  def delete_network(%Network{id: network_id}) when is_integer(network_id) do
    with %Network{} = net <- Repo.get(Network, network_id) || {:error, :not_found},
         :ok <- ensure_no_credentials(network_id),
         {:ok, _} <- Scrollback.purge_network(network_id) do
      delete_purged_network(net)
    end
  end

  # The last step, in ONE transaction: the guard again (a credential bound
  # while the batches ran would have a session writing rows), the residue
  # of the purge (whatever landed after its last batch — nothing, unless
  # that guard was crossed and uncrossed meanwhile), then the row, whose FK
  # cascades take the rest.
  defp delete_purged_network(%Network{} = net) do
    tx = fn -> Repo.immediate_transaction(fn -> delete_purged_row(net) end) end

    case Repo.BusyRetry.run(tx) do
      {:ok, :ok} -> :ok
      {:error, _} = err -> err
    end
  end

  # The transaction body, extracted so the `BusyRetry.run →
  # immediate_transaction` wrapper stays within credo's max nesting (the
  # `Visitors.create_anon/4` shape). A crossed guard rolls back.
  defp delete_purged_row(%Network{id: network_id} = net) do
    case ensure_no_credentials(network_id) do
      :ok ->
        _ = Scrollback.purge_network_residue(network_id)
        {:ok, _} = Repo.delete(net)
        :ok

      {:error, reason} ->
        Repo.rollback(reason)
    end
  end

  defp ensure_no_credentials(network_id) do
    case count_credentials_for_network(network_id) do
      0 -> :ok
      n -> {:error, {:credentials_present, n}}
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
  def home_data_for_user(%User{id: user_id}) do
    # issue 2219 — ONE read of the partition, split here rather than
    # asked for twice. See `list_every_credential_for_user_id/1` for why
    # a second query was not an option.
    {credentials, detached} =
      user_id
      |> Credentials.list_every_credential_for_user_id()
      |> Enum.split_with(&is_nil(&1.detached_at))

    pairs =
      Enum.map(credentials, fn cred ->
        {cred, resolve_network_nick({:user, user_id}, cred)}
      end)

    attached_slugs = MapSet.new(credentials, fn cred -> cred.network.slug end)

    # issue 2219 — a network this user DETACHED is offered back here, and
    # it is offered whether or not the operator put it in the
    # `visitor_enabled` self-serve tier. The tier answers "may a stranger
    # attach this"; the detached row answers "did this subject already
    # have it", and the second question is the one re-attaching asks. An
    # admin-bound network left out of this union would be hideable and
    # never restorable, which is a delete wearing a hide's label.
    detached_slugs = Enum.map(detached, & &1.network.slug)

    available_slugs =
      list_visitor_enabled()
      |> Enum.map(& &1.slug)
      |> Enum.concat(detached_slugs)
      |> Enum.uniq()
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

  @typedoc """
  One `GET /networks` row before rendering: the network, the LIVE-or-fallback
  nick, the credential of record, and the live upstream facts (`nil` when no
  session is up).
  """
  @type network_row ::
          {Network.t(), String.t(), Credential.t(), Session.connection_info() | nil}

  @doc """
  Every network row the subject can see, tagged with the subject kind the
  wire discriminator is built from.

  #1679 — extracted from `GrappaWeb.NetworksController.index/2` so the boot
  endpoint answers with the SAME rows rather than a second assembly that
  drifts. The two branches were already byte-identical apart from the tag;
  keeping one copy is what makes "`/boot`'s networks are `GET /networks`'s
  networks" a fact a test can assert rather than a claim.

  Constant in the number of networks: the credential read preloads
  `:network`, and both live lookups (`resolve_network_nick/2`,
  `Session.connection_info/2`) are `Registry`/GenServer reads, not queries.
  `GrappaWeb.BootCostTest` measures that.
  """
  @spec subject_network_rows(Session.subject()) ::
          {:user, [network_row()]} | {:visitor, [network_row()]}
  def subject_network_rows({:user, user_id} = subject) when is_binary(user_id) do
    {:user, rows_for(subject, Credentials.list_credentials_for_user_id(user_id))}
  end

  def subject_network_rows({:visitor, visitor_id} = subject) when is_binary(visitor_id) do
    {:visitor, rows_for(subject, Credentials.list_visitor_credentials(visitor_id))}
  end

  @spec rows_for(Session.subject(), [Credential.t()]) :: [network_row()]
  defp rows_for(subject, credentials) do
    Enum.map(credentials, fn cred ->
      {cred.network, resolve_network_nick(subject, cred), cred, live_connection_info(subject, cred.network_id)}
    end)
  end

  # #474 B — the LIVE upstream facts for a row, or `nil` when there is no live
  # connected session (parked / failed / no pid): the honest "no connection"
  # the server-window rail renders as an absent card. Same live-vs-DB split as
  # `resolve_network_nick/2` — these come from the running Session.Server,
  # never the credential row of record.
  @spec live_connection_info(Session.subject(), integer()) :: Session.connection_info() | nil
  defp live_connection_info(subject, network_id) do
    case Session.connection_info(subject, network_id) do
      {:ok, info} -> info
      {:error, _} -> nil
    end
  end

  @typedoc "One channel-tree entry: the name, whether we are IN it, and why we know about it."
  @type channel_entry :: %{name: String.t(), joined: boolean(), source: :autojoin | :joined}

  @doc """
  The channel tree for one network: the persisted autojoin list unioned with
  what the LIVE session says it is actually in.

  Q3 pinned: a channel in BOTH is sourced `:autojoin`. Sorted by
  `{name, source}` for wire-shape stability — name is the primary key and
  unique under the `MapSet.difference/2` dedup, but tie-breaking on `:source`
  makes the ordering contract TOTAL, so a future widening that admitted
  duplicates would still give clients deterministic order instead of
  source-dependent churn (M-web-4).

  #1679 — lifted out of `GrappaWeb.ChannelsController` so the boot endpoint
  builds the SAME tree rather than a second copy. The per-network endpoint
  and the boot endpoint answering different channel lists is precisely the
  silent half of this change, so there is one function and both doors call
  it.
  """
  @spec merge_channel_sources([String.t()], [String.t()]) :: [channel_entry()]
  def merge_channel_sources(autojoin, session) when is_list(autojoin) and is_list(session) do
    autojoin_set = MapSet.new(autojoin)
    session_set = MapSet.new(session)

    autojoin_entries =
      Enum.map(autojoin_set, fn name ->
        %{name: name, joined: MapSet.member?(session_set, name), source: :autojoin}
      end)

    session_only_entries =
      session_set
      |> MapSet.difference(autojoin_set)
      |> Enum.map(fn name -> %{name: name, joined: true, source: :joined} end)

    Enum.sort_by(autojoin_entries ++ session_only_entries, &{&1.name, &1.source})
  end

  @doc """
  The persisted channel list a credential contributes to its network's tree —
  and it is a DIFFERENT COLUMN per subject kind, which is the whole reason
  this function exists rather than a field access at each call site.

    * a USER declares `autojoin_channels`: an intention, edited by the
      operator, honoured on every connect.
    * a VISITOR carries `last_joined_channels`: a per-network SNAPSHOT the
      live session writes so a returning visitor lands back where it was.
      (#211 phase 4c moved it off the `visitors` scalar onto the
      `(visitor_id, network_id)` credential — a multi-network visitor has one
      per network, and two concurrent sessions would clobber a single one.)

  #1679 — measured, not assumed: reading `autojoin_channels` for BOTH kinds
  compiles, passes the user tests, and hands every visitor an EMPTY channel
  tree. The column choice lives here so the boot endpoint and the
  per-network endpoint cannot answer differently.
  """
  @spec autojoin_channels(:user | :visitor, Credential.t()) :: [String.t()]
  def autojoin_channels(:user, %Credential{autojoin_channels: channels}),
    do: channels || []

  def autojoin_channels(:visitor, %Credential{last_joined_channels: channels}),
    do: channels || []

  @doc """
  The live session's channel list for `(subject, network_id)`.

  `{:ok, []}` when NO session is up — a parked network has an autojoin list and
  no live joins, and that is a normal answer rather than an error.

  `{:error, :timeout}` when a session IS registered and did not answer inside
  `Session.list_channels/2`'s 5s budget. Ruled (2239) to travel as a VALUE
  rather than collapse to `[]` right here, and the one-line `_ -> []` was
  considered and rejected: `[]` asserts "joined nothing", which is a different
  statement from "could not ask", and this function's callers sit on surfaces
  that do not want the same answer out of it. A wrapper that flattens the two
  is deciding for all of them at the altitude with the least context, so it
  does not decide at all.

  Before 2239 the `{:error, :timeout}` arm was simply absent, so a stuck
  session raised `CaseClauseError` here and 500'd every caller — the return was
  reachable the whole time and `Session.list_channels/2`'s `@spec` denied it.
  """
  @spec session_channels(Session.subject(), integer()) ::
          {:ok, [String.t()]} | {:error, :timeout}
  def session_channels(subject, network_id) when is_integer(network_id) do
    case Session.list_channels(subject, network_id) do
      {:ok, list} -> {:ok, list}
      {:error, :no_session} -> {:ok, []}
      {:error, :timeout} = err -> err
    end
  end

  @doc """
  `session_channels/2` for the two CHANNEL-TREE doors, which were both ruled
  (2239) to degrade rather than fail: `GET /boot` (per network row) and
  `GET /networks/:nid/channels`. A timeout yields `[]` here, so the caller
  composes an AUTOJOIN-ONLY tree from the credential column — the half it holds
  without asking anybody.

  This is the POLICY; `session_channels/2` above is the FACT, and they are two
  functions on purpose. `Grappa.Scrollback`'s archive door reads the fact and
  propagates, because on that page an empty live set asserts "nothing is
  active" and archives the windows the user is sitting in. One shared policy
  function rather than the same `case` at both doors: they were ruled to answer
  identically, so the thing that must not drift is exactly this.

  `door` is the caller's own label (`"GET /boot"`) and only reaches the log,
  which keeps the warning greppable per door.

  **The degrade is never silent.** `[]` for a timeout is indistinguishable on
  the wire from `[]` for a parked network — telling them apart needs a wire
  marker and a `protocol_version` bump — so the operator-visible line is the
  only thing separating "we could not ask" from "there was nothing to ask
  about" until then.
  """
  @spec session_channels_degrading(Session.subject(), Network.t(), String.t()) :: [String.t()]
  def session_channels_degrading(subject, %Network{} = network, door) when is_binary(door) do
    case session_channels(subject, network.id) do
      {:ok, list} ->
        list

      {:error, :timeout} ->
        # `network:` is the one configured metadata key that fits; the subject
        # rides in the message, as `NetworksController` already does, because
        # `config/config.exs` configures no key for it.
        Logger.warning(
          "#{door}: session did not answer in time — degrading #{network.slug} " <>
            "to autojoin only for #{inspect(subject)}",
          network: network.slug,
          reason: :timeout
        )

        []
    end
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
  `:connected` OR `:failing` (no DB write, no broadcast).

  #1675 — `:failing` is idempotent here rather than a transition,
  because `connect/1` states the operator's INTENT ("I want this
  network up") and a `:failing` row is already wanted-up: the session
  exists and its backoff ladder is retrying. Writing `:connected` would
  re-assert the exact claim this issue is about — that a row says
  registered while the link is not — and the honest correction arrives
  on its own at 001 via `mark_registered/1`. The caller's spawn step
  still runs first and is what repairs a `:failing` row whose session
  died, so the door is not a no-op end to end.

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
  def connect(%Credential{connection_state: state} = cred) when state in [:connected, :failing] do
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
  or `/quit`). `:connected | :failing → :parked`; rejects from
  `:parked | :failed` with `{:error, :not_connected}`
  (idempotency-by-rejection, not silent no-op — the caller is asking to
  disconnect a row that's already not connected, surface that).

  #1675 — `:failing` parks like `:connected` does, and that is not a
  nicety: a network hammering a dead upstream is precisely the one an
  operator reaches for the disconnect button on (it is what vjt did by
  hand on 2026-08-22). Both states own a live session and a running
  backoff ladder, so both need the QUIT + `stop_session` this verb does;
  only `:parked` and `:failed` have nothing left to stop.

  Issues an explicit `QUIT :<reason>` upstream first (best-effort —
  no live session is fine) so the upstream sees a clean disconnect
  message rather than the abrupt socket close from the supervised
  stop. Then terminates `Session.Server` via `Session.stop_session/2`,
  writes the DB transition, and broadcasts.
  """
  @spec disconnect(Credential.t(), String.t()) ::
          {:ok, Credential.t()} | {:error, :not_connected}
  def disconnect(%Credential{connection_state: from} = cred, reason)
      when from in [:connected, :failing] and is_binary(reason) do
    cred = preload_subject_and_network(cred)
    subject = subject_of(cred)

    _ = best_effort_quit(subject, cred.network_id, reason)
    :ok = Session.stop_session(subject, cred.network_id)

    updated = transition!(cred, :parked, reason)
    # GH #417 — a DELIBERATE park clears the persisted explicit away (see
    # clear_away_on_manual_park/1 for the manual-vs-automatic rationale).
    :ok = clear_away_on_manual_park(cred)
    broadcast_state_change(updated, from, :parked, reason)
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
  issue 2219 — DETACHES a credential: the subject stops holding this
  binding, and every field they authored survives for the day they put
  it back.

  The inverse of `POST /session/networks`, which had none. The rail has
  hidden a parked network since #1985, but `$home` kept listing it and
  the row kept the nick, `sasl_user`, the three encrypted secrets, the
  perform list and the autojoin set — so "I joined the wrong network"
  had no answer short of `DELETE /me`.

  Ordered park-then-mark, and the order is load-bearing. The session is
  stopped and the row transitioned BEFORE it is marked. Marking first
  would leave a live session behind a binding no subject-facing reader
  returns — a session nobody can see, stop or reconnect, which is the
  wedge `spawn_or_rollback/4` exists to prevent on the way in.

  **A detached credential always comes to rest `:parked`, from every
  starting state**, so `reattach/1` hands the accretion door the same
  shape a freshly bound credential has. Three arms reach that rest:

    * `:connected` / `:failing` → `disconnect/2`, which QUITs upstream,
      stops the session, writes the transition and broadcasts it.
    * `:failed` → no QUIT (there is no link to say goodbye on) but the
      row still moves, and the move is BROADCAST. That broadcast is not
      bookkeeping: `networkParked.ts` deliberately keeps a `:failed`
      network IN the sidebar (#1985 — a failure is something the
      operator must see), so the operator may be looking at a window on
      it right now, and the `:failed → :parked` event is what drives
      cic's bucket-D redirect home before the row goes.
    * `:parked` → nothing to move and nothing to announce; #1985 already
      took it out of the sidebar, so no selection can be pointing at it.

  **The session stop is UNCONDITIONAL**, not gated on the state, for the
  reason `Credentials.unbind_credential/2` gives for doing the same: the
  column and the live pid are separate sources of truth and they can
  disagree (CLAUDE.md). A row reading `:parked` whose `Session.Server` is
  in fact alive is exactly the case this verb must not wave through — it
  would hide the session behind an invisible binding. `stop_session/3` is
  idempotent, so on the two arms that have already stopped one it costs a
  no-op.

  Idempotent on an already-detached credential: re-detaching rewrites the
  timestamp rather than refusing. No production caller reaches that arm —
  `SessionController.detach_network/2` resolves through
  `get_attached_credential/2` and 404s first — so it is a property of the
  function rather than a case being handled.
  """
  @spec detach(Credential.t(), String.t()) ::
          {:ok, Credential.t()} | {:error, Ecto.Changeset.t() | :db_unavailable}
  def detach(%Credential{} = cred, reason) when is_binary(reason) do
    cred = preload_subject_and_network(cred)

    with {:ok, detached} <- cred |> park_for_detach(reason) |> Credentials.mark_detached() do
      broadcast_network_detached(detached)
      {:ok, detached}
    end
  end

  # The three arms onto `:parked`. Each returns a credential whose
  # associations are still loaded — `disconnect/2` preloads the same ones
  # and `Repo.update!` carries them onto what it returns — so the caller
  # never has to rebuild a struct for the broadcast.
  @spec park_for_detach(Credential.t(), String.t()) :: Credential.t()
  defp park_for_detach(%Credential{connection_state: state} = cred, reason)
       when state in [:connected, :failing] do
    {:ok, updated} = disconnect(cred, reason)
    updated
  end

  defp park_for_detach(%Credential{connection_state: :failed} = cred, reason) do
    :ok = Session.stop_session(subject_of(cred), cred.network_id, reason)
    updated = transition!(cred, :parked, reason)
    broadcast_state_change(updated, :failed, :parked, reason)
    updated
  end

  defp park_for_detach(%Credential{connection_state: :parked} = cred, reason) do
    :ok = Session.stop_session(subject_of(cred), cred.network_id, reason)
    cred
  end

  @doc """
  issue 2219 — the inverse of `detach/2`: the subject holds this binding
  again, with everything it was detached with.

  Writes the column and nothing else — no QUIT, no spawn, no broadcast.
  The caller that revives a credential is the accretion door
  (`GrappaWeb.SessionController.add_network/2`), which then runs the
  SAME `spawn_or_rollback/4` a freshly bound credential runs, and that
  path already emits `connection_state_changed` at `:parked →
  :connected`. A broadcast here would be a second event for one change,
  the REV-J M15 shape this codebase folded away once already.

  The credential comes back `:parked` from EVERY starting state, because
  `detach/2` brings all three onto that rest — including `:failed`, which
  it parks rather than preserving, so a re-attach never resumes carrying a
  failure the subject already chose to put away. That is also where the
  accretion door binds a new credential, so revive and bind hand the spawn
  path the same shape.
  """
  @spec reattach(Credential.t()) ::
          {:ok, Credential.t()} | {:error, Ecto.Changeset.t() | :db_unavailable}
  def reattach(%Credential{} = cred), do: Credentials.mark_attached(cred)

  @doc """
  issue 2219 — announces that a network JOINED the subject's set, on the
  subject's own user-rooted topic.

  The twin of the detach broadcast, and it is not symmetry for its own
  sake. Without it the detach announces and the attach does not, which is
  worse than neither announcing: a second tab that did not initiate the
  re-attach keeps the network under `available_networks` with no attached
  row, and a third-party client gets no signal at all.

  `connection_state_changed` does NOT cover this. It fires on the
  `:parked → :connected` flip, but the only surface it drives a refresh of
  is `GET /networks`; the `$home` rows come from the `/me` envelope, and
  nothing refetches that. The detach arm is the one place in `userTopic.ts`
  that calls `refetchUser()`, and this event is what gives the other
  direction the same reach.

  Called from the accretion door rather than from `reattach/1`, and the
  distinction is the ordering: a revive that then fails to spawn is rolled
  back by re-detaching it, so announcing at the write would announce an
  attachment that does not survive the request. The door announces once,
  after the session is live.
  """
  @spec broadcast_network_attached(Credential.t()) :: :ok
  def broadcast_network_attached(%Credential{} = cred) do
    cred = preload_subject_and_network(cred)
    topic = Topic.user(subject_label_of(cred))
    :ok = Grappa.PubSub.broadcast_event(topic, Wire.network_attached_event(cred))
  end

  @doc """
  Server-internal: marks a credential `:failed` after a hard upstream
  failure (k-line / permanent SASL — see plan S1.4 lenient triggers).
  Terminates the `Session.Server` (the `:transient` restart strategy
  doesn't restart on `:normal`-shape stops; the supervisor terminating
  the child achieves the same).

  `:connected | :failing → :failed`. Idempotent if already `:failed`
  (no DB write, no broadcast). Rejects from `:parked` with
  `{:error, :user_parked}` — `:parked` is explicit user intent
  ("don't reconnect this row"), and a server-set terminal failure
  shouldn't quietly overwrite that. The caller (Session.Server's
  `handle_terminal_failure`) is expected to log + drop the
  transition rather than retry.

  #1675 — `:failing → :failed` is the escalation edge: a link that was
  merely down (backoff running) can then earn a k-line or a permanent
  SASL rejection, and terminal must win over non-terminal. The reverse
  edge does not exist; see `mark_failing/2`.
  """
  @spec mark_failed(Credential.t(), String.t()) ::
          {:ok, Credential.t()} | {:error, :user_parked}
  def mark_failed(%Credential{connection_state: :failed} = cred, _), do: {:ok, cred}

  def mark_failed(%Credential{connection_state: from} = cred, reason)
      when from in [:connected, :failing] and is_binary(reason) do
    cred = preload_subject_and_network(cred)
    subject = subject_of(cred)

    :ok = Session.stop_session(subject, cred.network_id, reason)

    updated = transition!(cred, :failed, reason)
    broadcast_state_change(updated, from, :failed, reason)
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

  @doc """
  Server-internal, NON-TERMINAL: marks a credential `:failing` — "the
  session process is alive and the reconnect backoff is running, but the
  upstream link is not registered" (#1675).

  `:connected | :failing → :failing`, carrying `reason` (the ACTUAL
  cause: `tls: …`, `connect refused`, a source-family mismatch — see
  `Grappa.IRC.Client.describe_connect_failure/1`). Does **NOT** stop the
  session, which is the whole point and the reason this is a second verb
  rather than a widened `mark_failed/2`: the ladder underneath has to
  keep retrying, and the 001 that ends the outage arrives on the process
  `mark_failed/2` would have killed.

  Idempotent on `:failing`: no DB write, no broadcast, and the FIRST
  cause is kept. Re-entering backoff happens once per attempt on an
  exponential ladder, and a row + broadcast per attempt is churn the
  operator learns nothing from; the first cause is also the one closest
  to the misconfiguration (EFNet rotated a bad certificate into four
  timeouts — the certificate is the diagnosis). The per-attempt detail
  is not lost: it lands in the `$server` window and the session log.

  Rejects `:parked` with `{:error, :user_parked}` (a deliberate park
  outranks a server observation — same posture as `mark_failed/2`) and
  `:failed` with `{:error, :terminal}` (terminal never decays into
  non-terminal; a `:failed` row has no session to be failing).

  ## 🔴 KNOWN HOLE — the `:parked` rejection also eats the FIRST failure

  **Not intentional. Measured on the integration stack 2026-08-22, not
  reasoned about:** every operator-initiated connect SPAWNS BEFORE it
  writes `:connected` (`Operator.connect_credential/1` and the post-U-0
  `NetworksController` order both do `resolve → spawn → connect/1`, and
  that ordering is #642's cure — a refused SPAWN must not report
  success). So there is a window, between the spawn and that write, in
  which the row still reads `:parked`. An upstream that refuses
  instantly closes it inside that window:

      21:49:35.464  credential_bound
      21:49:35.466  report_link_state: {:failing, "connection refused"}
                    declined (user_parked)          <- 2 ms after the bind
      21:49:35.470  INSERT INTO messages            <- the $server row DOES land

  The `user_parked` diagnosis is then **wrong**: nobody parked the row,
  the writer had not committed yet. The two surfaces disagree for the
  rest of the window — the `$server` scrollback says the connect was
  refused while the network row says `connected` with a null reason —
  and the row only self-corrects on the NEXT attempt, i.e. after
  `@connect_failure_sleep_ms` (30 s, `config/config.exs`) plus one
  backoff rung (~5 s): **~35 s of exactly the lie #1675 exists to
  remove**, bounded but real, and reachable in production by the
  commonest misconfiguration there is (a wrong port).

  It is NOT fixed here because the fix is an ordering change to the U-0
  sequence #642 established, which is a separate decision with a
  separate blast radius. It is written down because the next reader
  would otherwise have to re-derive it from a log line that lies.
  """
  @spec mark_failing(Credential.t(), String.t()) ::
          {:ok, Credential.t()} | {:error, :user_parked | :terminal}
  def mark_failing(%Credential{connection_state: :failing} = cred, _), do: {:ok, cred}

  def mark_failing(%Credential{connection_state: :connected} = cred, reason)
      when is_binary(reason) do
    cred = preload_subject_and_network(cred)
    updated = transition!(cred, :failing, reason)
    broadcast_state_change(updated, :connected, :failing, reason)
    {:ok, updated}
  end

  def mark_failing(%Credential{connection_state: :parked}, _), do: {:error, :user_parked}
  def mark_failing(%Credential{connection_state: :failed}, _), do: {:error, :terminal}

  # REV-B / H6: see `connect/1`. Raises on a future enum addition rather
  # than silently `FunctionClauseError`-ing — the four clauses above are
  # exhaustive on TODAY's set, and #1675 is itself the proof that this
  # set grows.
  def mark_failing(%Credential{connection_state: other}, _),
    do: raise(ArgumentError, "Networks.mark_failing: unhandled connection_state #{inspect(other)}")

  @doc """
  Server-internal: the return edge of `mark_failing/2` — 001 RPL_WELCOME
  proved the link is registered, so the row goes back to `:connected`
  with the failure cause CLEARED (#1675).

  `:failing → :connected`. Idempotent on `:connected` (no DB write, no
  broadcast) — 001 fires on every reconnect, including the overwhelming
  majority that were never failing, so the no-op arm is the hot path and
  must not churn the row.

  Rejects `:parked | :failed` with `{:error, :not_failing}`: both mean a
  teardown already won the race (`disconnect/2` and `mark_failed/2` both
  stop the session BEFORE writing), and resurrecting the row from a late
  001 would undo an operator's decision.
  """
  @spec mark_registered(Credential.t()) :: {:ok, Credential.t()} | {:error, :not_failing}
  def mark_registered(%Credential{connection_state: :connected} = cred), do: {:ok, cred}

  def mark_registered(%Credential{connection_state: :failing} = cred) do
    cred = preload_subject_and_network(cred)
    updated = transition!(cred, :connected, nil)
    broadcast_state_change(updated, :failing, :connected, nil)
    {:ok, updated}
  end

  def mark_registered(%Credential{connection_state: state}) when state in [:parked, :failed],
    do: {:error, :not_failing}

  # REV-B / H6 fallthrough — see `mark_failing/2`.
  def mark_registered(%Credential{connection_state: other}),
    do: raise(ArgumentError, "Networks.mark_registered: unhandled connection_state #{inspect(other)}")

  @doc """
  The door `Grappa.Session.Server` reaches through its injected
  `link_state_reporter` closure (#1675): reports what the UPSTREAM LINK
  is doing to the credential row for `(subject, network_id)`.

  `{:failing, reason}` → `mark_failing/2`; `:registered` →
  `mark_registered/1`. Always returns `:ok` — the caller is a session on
  its connect path and has nothing to do with a refusal but log it, so
  every non-write outcome is logged HERE (never silently swallowed) and
  the session carries on.

  Subject-polymorphic, unlike its terminal sibling `mark_failed_by_ids/3`.
  The write set of `connection_state` has no subject branch, so the drift
  this issue is about is not user-specific: a visitor credential goes
  through the same `Networks.connect/1` and lands in the same lie. The
  visitor row carries a real `connection_state` since #211 ruling D.
  """
  @spec report_link_state(Session.subject(), integer(), {:failing, String.t()} | :registered) ::
          :ok
  def report_link_state(subject, network_id, link_state) when is_integer(network_id) do
    case fetch_credential_for_subject(subject, network_id) do
      {:ok, cred} ->
        log_link_state_outcome(apply_link_state(cred, link_state), subject, network_id, link_state)

      {:error, :not_found} ->
        # Unbound between spawn and the connect failure (an admin unbind,
        # a reaped visitor). The session is about to die with it; nothing
        # to write, but say so rather than drop it.
        Logger.info(
          "report_link_state: no credential — unbound or reaped " <>
            "(subject=#{inspect(subject)} network_id=#{network_id})"
        )

        :ok
    end
  end

  @spec apply_link_state(Credential.t(), {:failing, String.t()} | :registered) ::
          {:ok, Credential.t()} | {:error, atom()}
  defp apply_link_state(cred, {:failing, reason}) when is_binary(reason),
    do: mark_failing(cred, reason)

  defp apply_link_state(cred, :registered), do: mark_registered(cred)

  @spec log_link_state_outcome(
          {:ok, Credential.t()} | {:error, atom()},
          Session.subject(),
          integer(),
          {:failing, String.t()} | :registered
        ) :: :ok
  defp log_link_state_outcome({:ok, _}, _, _, _), do: :ok

  defp log_link_state_outcome({:error, why}, subject, network_id, link_state) do
    # Not a warning: every one of these is a legitimate race with a
    # teardown that already won (park / terminal failure), and the row is
    # correct as it stands. Logged because a silent drop here is how a
    # future genuinely-wrong transition would hide.
    Logger.info(
      "report_link_state: #{inspect(link_state)} declined (#{why}) " <>
        "(subject=#{inspect(subject)} network_id=#{network_id})"
    )

    :ok
  end

  @spec fetch_credential_for_subject(Session.subject(), integer()) ::
          {:ok, Credential.t()} | {:error, :not_found}
  defp fetch_credential_for_subject({:user, user_id}, network_id),
    do: Credentials.get_credential_by_ids(user_id, network_id)

  defp fetch_credential_for_subject({:visitor, visitor_id}, network_id),
    do: Credentials.get_visitor_credential(visitor_id, network_id)

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

  # issue 2219 — a detach is not a state transition, so it cannot ride
  # `connection_state_changed`. Detaching an already-parked network moves
  # no state at all, and inventing a transition to carry the news would
  # put a lie on the wire for the sake of reusing a payload.
  #
  # What a second tab does with it: `GET /networks` and the `$home`
  # envelope both stop returning the network, so a tab still showing its
  # `[Reconnect]` chip is one tap from a 404 — `Plugs.ResolveNetwork`
  # answers the iso 404 for a detached binding by design. The event is
  # what turns that into a row that simply goes away.
  @spec broadcast_network_detached(Credential.t()) :: :ok
  defp broadcast_network_detached(%Credential{} = cred) do
    topic = Topic.user(subject_label_of(cred))
    :ok = Grappa.PubSub.broadcast_event(topic, Wire.network_detached_event(cred))
  end
end
