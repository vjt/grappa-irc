defmodule Grappa.Vhosts do
  @moduledoc """
  Per-subject vhost (source-bind address) selection — #228.

  Extends the existing source-bind path (`network_servers.source_address`
  → `Grappa.IRC.Client` `ifaddr` bind) with a per-SUBJECT layer that sits
  ABOVE it: a subject (user OR visitor, post-#211) self-selects from an
  allowed set. The connect path is UNCHANGED — this context only decides
  WHICH address resolves into the session plan (`effective_source/3`),
  which `Grappa.Networks.SessionPlan` threads through exactly as it does
  the per-server `source_address` today.

  ## Principle (#251, vjt 2026-07-15)

  **Admin decides AVAILABILITY; the user decides SELECTION.** The admin
  curates which vhosts a subject *can* use (`generally_available` /
  `in_pool` / a per-subject grant); the user freely picks among that set.
  No admin hard-pin, no admin default — EXCEPT a network-pinned
  `source_address`, which #266 makes an ABSOLUTE bind that overrides the
  user's selection entirely (see the `effective_source/3` NOTE below).

  ## Inventory model

    * `vhosts` rows — curated from the host's bound addresses
      (`Grappa.Net.HostAddresses.list/0`). `in_pool` = auto-rotation pool
      member (replaces the `GRAPPA_OUTBOUND_V6_POOL` env var, vjt
      2026-07-14) AND self-selectable by any subject (#251);
      `generally_available` = any subject may self-select.
    * `vhost_grants` rows — per-subject grants: a grant means "`subject`
      may select this vhost even if it isn't generally-available / in the
      pool." Visitor grants CASCADE on reap.

  ## Resolution precedence (`effective_source/3`, per connect)

    1. the passed `server_source` (`network_servers.source_address` — the
       admin-configured per-network bind). #266: when set, it WINS. Bind
       it, full stop — over the subject's vhost selection, the pool, and
       #271 RR-DNS leaf distribution.
    2. else the subject's selection (`UserSettings` `"vhost_selection"`)
       INTERSECTED with its allowed set → random pick (spec: "random per
       connection" when >1 active).
    3. else `nil` → the `Grappa.IRC.Client` DB-driven rotation pool /
       kernel default (zero-config still binds nothing).

  The allowed set is mode-dependent (#596): mode 1 = generally-available ∪
  in_pool ∪ granted-to-subject; mode 2 = granted-to-subject ONLY (in_pool /
  generally-available are inert at bind, so they are not self-selectable).
  Selection is authz-clamped to this set at write (`set_selection/3`), and
  re-clamped at read (`get_selection/2`) so a revoked grant — or, in mode 2,
  a non-granted address — can't leak a stale selection.

  NOTE (#266 — REVERSES the #251 nuance): pre-#266, a subject's vhost
  self-selection OVERRODE `server_source` (`server_source` was only the
  no-selection default). #266 inverts this: an admin-set per-network
  `source_address` is an ABSOLUTE bind that wins over everything, so a
  network with a pinned source egresses ALL its subjects from that source
  regardless of their vhost selection. The subject's selection/pool is the
  fallback ONLY when no admin source is pinned. Rationale (Libera go-live):
  a user-driven rotating vhost reads as ban-evasion; an admin-pinned,
  accountable, single egress per network is the honest posture.

  ## No admin hard-pin (#251)

  #228 shipped an admin `pinned` grant (a forced, non-self-changeable
  bind). #251 removed it: a grant is now availability-only. The
  `vhost_grants.pinned` column is left in place as a dead no-op so V1
  ships HOT; a trailing COLD cleanup migration drops it later (see
  `docs/DESIGN_NOTES.md` 2026-07-15).
  """
  use Boundary,
    top_level?: true,
    deps: [
      Grappa.Accounts,
      Grappa.Net.HostAddresses,
      Grappa.Net.IpLiteral,
      Grappa.OutboundV6Pool,
      Grappa.Repo,
      Grappa.Subject,
      Grappa.UserSettings,
      Grappa.Visitors.Visitor
    ],
    exports: [Vhost, Grant, AdminWire]

  import Ecto.Query

  alias Grappa.Accounts.Session
  alias Grappa.{Repo, Subject, UserSettings}
  alias Grappa.Vhosts.{Grant, SourceMapping, Vhost}
  alias Grappa.Visitors.Visitor

  require Logger

  # ---------------------------------------------------------------------------
  # Inventory CRUD
  # ---------------------------------------------------------------------------

  @doc "Every vhost row, ordered by address."
  @spec list_vhosts() :: [Vhost.t()]
  def list_vhosts do
    query = from(v in Vhost, order_by: [asc: v.address])
    Repo.all(query)
  end

  @doc """
  Creates a curated vhost. `{:error, :already_exists}` on a duplicate
  address (operator re-adding is an operator-side mistake); other
  validation errors come back as a changeset for FallbackController.
  """
  @spec create_vhost(map()) ::
          {:ok, Vhost.t()} | {:error, :already_exists | Ecto.Changeset.t()}
  def create_vhost(attrs) when is_map(attrs) do
    case %Vhost{} |> Vhost.changeset(attrs) |> Repo.insert() do
      {:ok, vhost} -> {:ok, vhost}
      {:error, %Ecto.Changeset{errors: errors} = cs} -> classify_vhost_error(errors, cs)
    end
  end

  @doc "Updates a vhost's address / availability flags. Same `:already_exists` mapping as create."
  @spec update_vhost(Vhost.t(), map()) ::
          {:ok, Vhost.t()} | {:error, :already_exists | Ecto.Changeset.t()}
  def update_vhost(%Vhost{} = vhost, attrs) when is_map(attrs) do
    case vhost |> Vhost.changeset(attrs) |> Repo.update() do
      {:ok, updated} -> {:ok, updated}
      {:error, %Ecto.Changeset{errors: errors} = cs} -> classify_vhost_error(errors, cs)
    end
  end

  @doc "Fetches a vhost by id or `{:error, :not_found}`."
  @spec get_vhost(integer()) :: {:ok, Vhost.t()} | {:error, :not_found}
  def get_vhost(id) when is_integer(id) do
    case Repo.get(Vhost, id) do
      %Vhost{} = v -> {:ok, v}
      nil -> {:error, :not_found}
    end
  end

  @doc """
  Deletes a vhost. Grants CASCADE via the FK; idempotent on a
  stale/already-gone row (mirror of `Servers.delete_server/1`).
  """
  @spec delete_vhost(Vhost.t()) :: :ok
  def delete_vhost(%Vhost{} = vhost) do
    case Repo.delete(vhost, stale_error_field: :id) do
      {:ok, _} -> :ok
      {:error, %Ecto.Changeset{errors: [{:id, _}]}} -> :ok
    end
  end

  # A future second unique constraint on Vhost should fall through to a
  # normal changeset error rather than collapse to `:already_exists`.
  @vhosts_address_index "vhosts_address_index"
  defp classify_vhost_error(errors, cs) do
    dup? =
      Enum.any?(errors, fn {_, {_, opts}} ->
        Keyword.get(opts, :constraint) == :unique and
          Keyword.get(opts, :constraint_name) == @vhosts_address_index
      end)

    if dup?, do: {:error, :already_exists}, else: {:error, cs}
  end

  # ---------------------------------------------------------------------------
  # Grants
  # ---------------------------------------------------------------------------

  @doc """
  Grants `vhost` to `subject` — makes it available for self-selection
  (#251: a grant is availability-only, no admin pin).
  `{:error, :already_exists}` when the (vhost, subject) grant exists.
  """
  @spec grant_vhost(Vhost.t(), Subject.t()) ::
          {:ok, Grant.t()} | {:error, :already_exists | Ecto.Changeset.t()}
  def grant_vhost(%Vhost{id: vhost_id}, {_, _} = subject) do
    attrs = Subject.put_subject_id(%{vhost_id: vhost_id}, subject)

    case Repo.insert(Grant.changeset(%Grant{}, attrs)) do
      {:ok, grant} -> {:ok, grant}
      {:error, %Ecto.Changeset{errors: errors} = cs} -> classify_grant_error(errors, cs)
    end
  end

  @doc "Revokes a grant. Idempotent on an already-gone row."
  @spec revoke_grant(Grant.t()) :: :ok
  def revoke_grant(%Grant{} = grant) do
    case Repo.delete(grant, stale_error_field: :id) do
      {:ok, _} -> :ok
      {:error, %Ecto.Changeset{errors: [{:id, _}]}} -> :ok
    end
  end

  @doc "Every grant for `subject`."
  @spec list_grants_for_subject(Subject.t()) :: [Grant.t()]
  def list_grants_for_subject({_, _} = subject) do
    subject |> grants_for_subject_query() |> Repo.all()
  end

  @doc "Every grant in the system, newest first. Admin index surface."
  @spec list_grants() :: [Grant.t()]
  def list_grants do
    query = from(g in Grant, order_by: [desc: g.id])
    Repo.all(query)
  end

  @doc """
  Fetches a grant by id, or `{:error, :not_found}`. Admin revoke surface.
  """
  @spec get_grant_by_id(integer()) :: {:ok, Grant.t()} | {:error, :not_found}
  def get_grant_by_id(id) when is_integer(id) do
    case Repo.get(Grant, id) do
      %Grant{} = g -> {:ok, g}
      nil -> {:error, :not_found}
    end
  end

  defp grants_for_subject_query(subject) do
    Subject.subject_where(Grant, subject)
  end

  @vhost_grants_user_index "vhost_grants_vhost_id_user_id_index"
  @vhost_grants_visitor_index "vhost_grants_vhost_id_visitor_id_index"
  defp classify_grant_error(errors, cs) do
    dup? =
      Enum.any?(errors, fn {_, {_, opts}} ->
        Keyword.get(opts, :constraint) == :unique and
          Keyword.get(opts, :constraint_name) in [
            @vhost_grants_user_index,
            @vhost_grants_visitor_index
          ]
      end)

    if dup?, do: {:error, :already_exists}, else: {:error, cs}
  end

  # ---------------------------------------------------------------------------
  # Allowed set + selection (self-service pick)
  # ---------------------------------------------------------------------------

  @doc """
  The subject's allowed (self-selectable) vhosts, mode-dependent (#596):

    * mode `:static_mapping_with_reservations` (mode 2) — ONLY the vhosts
      the subject holds a grant for. `in_pool` / `generally_available` are
      INERT at bind time in mode 2 (the resolver ignores them), so offering
      them for self-selection would let the UI present options that silently
      do nothing AND let a write persist an address the resolver drops. The
      granted set IS the selectable set.
    * any other mode (mode 1, default) — generally-available ∪ in_pool ∪
      granted-to-subject (#251 — in_pool joins the self-selectable set).

  Ordered by address, de-duplicated. `mode` is passed IN by the caller
  (`Grappa.ServerSettings.addressing_mode/0` at the web edge; the resolver
  threads `addressing.mode`) so `Vhosts` stays OFF a `ServerSettings` dep —
  the same pass-config-in shape as `effective_source/3`. No default
  argument: a defaulted mode would silently degrade a mode-2 server to
  mode-1 selectability, re-introducing #596 from the write side.
  """
  @spec allowed_vhosts(Subject.t(), atom()) :: [Vhost.t()]
  def allowed_vhosts({_, _} = subject, :static_mapping_with_reservations) do
    granted_ids = granted_vhost_ids(subject)

    query = from(v in Vhost, where: v.id in ^granted_ids, order_by: [asc: v.address])

    Repo.all(query)
  end

  def allowed_vhosts({_, _} = subject, _) do
    granted_ids = granted_vhost_ids(subject)

    query =
      from(v in Vhost,
        where: v.generally_available == true or v.in_pool == true or v.id in ^granted_ids,
        order_by: [asc: v.address]
      )

    Repo.all(query)
  end

  @doc """
  The vhost ids the subject holds an explicit grant row for (#251). Used
  by the self-service view to mark the per-option `granted` flag —
  distinct from allow-set membership, which now also includes in_pool +
  generally-available vhosts the subject was never granted.
  """
  @spec granted_vhost_ids(Subject.t()) :: [integer()]
  def granted_vhost_ids({_, _} = subject) do
    subject
    |> grants_for_subject_query()
    |> select([g], g.vhost_id)
    |> Repo.all()
  end

  @doc """
  The ADDRESSES of the vhosts the subject holds an explicit grant row for
  (#543 INC-4). This is the mode-2 (`static_mapping_with_reservations`)
  reservation set: in mode 2 a grant WINS over derivation, so
  `effective_source/3` random-picks from these before ever consulting the
  derived `::cb` address.

  Distinct from `granted_vhost_ids/1` (ids, for the self-service `granted`
  flag) and from `allowed_vhosts/2` (which in mode 1 also folds in `in_pool`
  + generally-available — both INERT in mode 2). Reserved grant addresses
  live OUTSIDE the derivation `/80` by operator convention, so
  a grant can never collide with a derived address.
  """
  @spec granted_vhost_addresses(Subject.t()) :: [String.t()]
  def granted_vhost_addresses({_, _} = subject) do
    subject
    |> grants_for_subject_query()
    |> join(:inner, [g], v in Vhost, on: v.id == g.vhost_id)
    |> select([_g, v], v.address)
    |> Repo.all()
  end

  @doc """
  The subject's persisted self-selection, RE-CLAMPED to the currently
  allowed set for `mode` (a revoked grant silently drops its address; in
  mode 2 an address that is not granted drops too — #596). Stored in
  `UserSettings` under `"vhost_selection"` as a list of addresses. In mode
  2 the allowed set IS the granted set, so this is exactly selection ∩
  granted — what `effective_source/3` binds.
  """
  @spec get_selection(Subject.t(), atom()) :: [String.t()]
  def get_selection({_, _} = subject, mode) do
    allowed = MapSet.new(allowed_vhosts(subject, mode), & &1.address)

    subject
    |> raw_selection()
    |> Enum.filter(&MapSet.member?(allowed, &1))
  end

  @doc """
  Sets the subject's self-selection. Every address MUST be in the
  subject's allowed set for `mode` — `{:error, :forbidden_vhost}` otherwise
  (authz at the boundary, not just the UI). In mode 2 the allowed set is
  the granted set, so a non-granted address is rejected here, not silently
  ignored at bind (#596). Returns the persisted (canonical) selection list.
  """
  @spec set_selection(Subject.t(), [String.t()], atom()) ::
          {:ok, [String.t()]} | {:error, :forbidden_vhost | Ecto.Changeset.t() | :db_unavailable}
  def set_selection({_, _} = subject, addresses, mode) when is_list(addresses) do
    allowed = MapSet.new(allowed_vhosts(subject, mode), & &1.address)
    requested = Enum.uniq(addresses)

    if Enum.all?(requested, &MapSet.member?(allowed, &1)) do
      persist_selection(subject, requested)
    else
      {:error, :forbidden_vhost}
    end
  end

  defp persist_selection(subject, addresses) do
    case UserSettings.put_vhost_selection(subject, addresses) do
      {:ok, _} -> {:ok, addresses}
      {:error, _} = err -> err
    end
  end

  defp raw_selection(subject) do
    UserSettings.get_vhost_selection(subject)
  end

  # ---------------------------------------------------------------------------
  # Resolution — the value that feeds the session plan
  # ---------------------------------------------------------------------------

  @typedoc """
  The outbound-addressing config read ONCE at plan build and threaded into
  `effective_source/3` (#543 INC-4). Passed IN by the caller (the session
  plan, which deps `ServerSettings`) so `Vhosts` stays OFF a
  `ServerSettings` dep — the same "pass-config-in" shape as
  `effective_pool/1`'s `fixed_sources`. `mode` is a plain atom (the
  authoritative closed set is `ServerSettings.addressing_mode/0`); any mode
  other than `:static_mapping_with_reservations` resolves mode-1 (today's
  behaviour, byte-for-byte).
  """
  @type addressing :: %{mode: atom(), prefix: String.t() | nil, armed?: boolean()}

  @typedoc """
  Why a mode-2 subject could NOT be given a derived source (#543 INC-4).
  A closed set — `effective_source/3` returns `{:hold, hold_reason()}` and
  the session refuses to connect from a shared pool rather than silently
  egress from the wrong address:

    * `:no_client_source` — mode 2, no grant, and the subject has no
      captured client `/64` to derive from (`last_client_prefix64/1` nil).
    * `:no_static_prefix` — mode 2 is selected but the configured prefix is
      missing (`nil`) or unparseable (`SourceMapping.derive/2` error) —
      an admin misconfiguration.
    * `:mode2_disarmed` — mode 2 is selected but the platform adapter refused
      to arm (#543 INC-5): no FreeBSD sudo wrapper, no Linux AnyIP route /
      `ip_nonlocal_bind`, or the Disabled substrate. The arm gate
      (`Grappa.Net.SourceAliasManager.armed?/0`, folded into `addressing.armed?`
      at plan build) sits in the no-grant branch — a grant-holder egresses from
      a curated reserved address that never touches the alias manager, so a
      disarmed platform must not hold them.
  """
  @type hold_reason :: :no_client_source | :no_static_prefix | :mode2_disarmed

  @doc """
  Resolves the effective source address for `subject` on this connect,
  given the admin-configured per-network `server_source`
  (`network_servers.source_address`, or `nil`) and the global `addressing`
  config (#543 INC-4).

  Precedence (#266 admin pin is absolute; #543 adds the mode-2 branch):

    1. `server_source` (the admin-configured per-network bind) — when set,
       WINS in BOTH modes. Returns it verbatim, overriding the subject's
       vhost selection, the pool/derivation, AND #271 RR-DNS leaf
       distribution.
    2. mode `:static_mapping_with_reservations` — a subject with grants
       resolves the SAME shape as mode 1 with the granted set standing in
       for the allowed set (#596): its selection ∩ granted random-picks,
       else ALL granted random-picks (availability given, no preference —
       reservations still win over derivation);
       mode `:pool_with_reservations` (default) — the subject's selection
       (∩ allowed) random-picks (spec: "random per connection").
    3. mode 2, no grants — the subject's captured client `/64`
       (`last_client_prefix64/1`) derives a deterministic `::cb` address
       (`SourceMapping.derive/2`); when no client `/64` is known, or the
       prefix is missing/unparseable, returns `{:hold, reason}` — the
       session is HELD (parked-with-reason), NEVER egressed from a shared
       pool. mode 1, no selection — `nil` → `Grappa.IRC.Client` falls
       through to `OutboundV6Pool.pick/0` / kernel default (UNCHANGED).

  Mode 1 is byte-for-byte the pre-#543 behaviour: `in_pool` /
  `generally_available` still feed the selection + pool; `nil` still means
  "let the Client pick from the rotation pool." Mode 2 replaces the pool
  fallback with derivation and NEVER returns `nil` (a missing input HOLDs
  instead). The connect path (`Grappa.IRC.Client.source_bind/2`) is
  UNCHANGED for a resolved address; `Session.Server.init/1` intercepts a
  `{:hold, _}` and marks the credential failed-with-reason.
  """
  @spec effective_source(Subject.t(), String.t() | nil, addressing()) ::
          String.t() | nil | {:hold, hold_reason()}
  # #266 — an admin-set per-network source is ABSOLUTE in BOTH modes: it
  # wins over the subject's selection, the pool, and mode-2 derivation.
  # Return it before consulting the (potentially expensive) lookups.
  def effective_source({_, _}, server_source, _) when is_binary(server_source),
    do: server_source

  # Mode 2 (#543) — grants-only reservations, else deterministic derivation
  # from the subject's own client /64; NO random pool. `in_pool` /
  # `generally_available` are inert here.
  def effective_source({_, _} = subject, nil, %{mode: :static_mapping_with_reservations} = addressing) do
    # Defense-in-depth for the #1 Global Constraint (never fall through to a
    # shared source): key mode-2 detection ONLY on `mode:`, then read `prefix`
    # / `armed?` with HOLD-safe defaults. A malformed addressing map (missing
    # either key) therefore HOLDs — `armed? = false` ⇒ `:mode2_disarmed`,
    # `prefix = nil` ⇒ `:no_static_prefix` — rather than matching the mode-1
    # clause below and silently egressing from the pool. The canonical map
    # (`Networks.SessionPlan.addressing_config/0`) always supplies both.
    prefix = Map.get(addressing, :prefix)
    armed? = Map.get(addressing, :armed?, false)

    case granted_vhost_addresses(subject) do
      [] ->
        derive_or_hold(subject, prefix, armed?)

      granted ->
        # #596 — honour the subject's persisted vhost_selection: selection ∩
        # granted wins (random per connection when more than one is active),
        # else ALL granted (availability given, no preference expressed — the
        # prior behaviour). Granting a subject the whole reserved pool must NOT
        # destroy a choice they deliberately made; the more availability given,
        # the LESS the selection meant under the old `Enum.random(granted)`.
        # This is mode-1's shape with the granted set standing in for the
        # allowed set. `get_selection/2` in mode 2 is ALREADY clamped to the
        # granted set (`allowed_vhosts == granted`), so it IS selection ∩
        # granted — no re-intersection needed.
        case get_selection(subject, :static_mapping_with_reservations) do
          [] -> Enum.random(granted)
          selected -> Enum.random(selected)
        end
    end
  end

  # Mode 1 (default / any non-mode-2 config) — byte-for-byte pre-#543:
  # selection ∩ allowed random-picks, else nil → the Client's rotation pool.
  # `Map.get(addressing, :mode)` keeps the defensive posture: a malformed
  # addressing map (no `:mode`) → nil → the non-mode-2 clause of
  # `allowed_vhosts/2` (the union) → today's behaviour; it never crashes.
  def effective_source({_, _} = subject, nil, addressing) do
    case get_selection(subject, Map.get(addressing, :mode)) do
      [] -> nil
      selected -> Enum.random(selected)
    end
  end

  # Mode-2 no-grant path: derive from the captured client /64, or HOLD.
  # Gate order (#543 INC-5): the platform arm gate FIRST — a disarmed adapter
  # (no sudo wrapper / no AnyIP route / Disabled substrate) HOLDs with
  # `:mode2_disarmed` regardless of prefix or client, because no derived
  # address can be bound at all. Then: a nil prefix is an admin misconfig (mode
  # selected, no block set); a derive error (unparseable prefix) is the SAME
  # class — both map to `:no_static_prefix`. An absent client /64 is
  # `:no_client_source`. NONE fall through to a shared source (Global Constraint).
  @spec derive_or_hold(Subject.t(), String.t() | nil, boolean()) ::
          String.t() | {:hold, hold_reason()}
  defp derive_or_hold(_, _, false), do: {:hold, :mode2_disarmed}
  defp derive_or_hold(_, nil, true), do: {:hold, :no_static_prefix}

  defp derive_or_hold(subject, prefix, true) when is_binary(prefix) do
    case last_client_prefix64(subject) do
      nil ->
        {:hold, :no_client_source}

      key ->
        case SourceMapping.derive(key, prefix) do
          {:ok, address} -> address
          {:error, _} -> {:hold, :no_static_prefix}
        end
    end
  end

  @doc """
  True when `source` is a DERIVED `::cb` alias that the session must
  acquire/release via `Grappa.Net.SourceAliasManager` for its upstream
  lifetime (#543 INC-6).

  The single decision point for "is this an alias I own?", kept HERE (not in
  `Session.Server`) so the mode+prefix+membership logic lives next to
  `effective_source/3` and `SourceMapping` stays internal to this boundary —
  the Session boundary takes no `Vhosts`/`ServerSettings` dep and never
  re-derives.

  A source is a managed alias iff ALL hold: the config is mode
  `:static_mapping_with_reservations`, `source` is a bound literal (not `nil`
  and not a `{:hold, _}` outcome), AND it sits inside the configured `::cb`
  prefix. Only the no-grant derivation branch of `effective_source/3` produces
  such an address: an admin `server_source` pin, a grant, and every mode-1
  pool/selection address live OUTSIDE `::cb` (Global Constraint), so
  `in_prefix?/2` uniquely fingerprints a derived source. A malformed
  `addressing` map (missing prefix) yields `false` — `in_prefix?(_, nil)` is
  `false`, so a broken config never spuriously marks a source managed.
  """
  @spec derived_source?(String.t() | nil | {:hold, hold_reason()}, addressing()) :: boolean()
  def derived_source?(source, %{mode: :static_mapping_with_reservations, prefix: prefix})
      when is_binary(source) and is_binary(prefix) do
    SourceMapping.in_prefix?(source, prefix)
  end

  def derived_source?(_, _), do: false

  # ---------------------------------------------------------------------------
  # Client-source capture (#543 INC-3 — last-known client /64 per subject)
  # ---------------------------------------------------------------------------

  @doc """
  Records the subject's client network prefix, sampled from `remote_ip`
  at client-connect.

  Normalises the IP to its `/64` (v6) or `/32` (v4) mapping key via
  `SourceMapping.client_key/1` (interface id dropped, RFC 8981) and
  persists it base16 in `UserSettings`. Idempotent per connect;
  last-write-wins on roam. Read back at upstream-connect by
  `last_client_prefix64/1` when no client is attached then — the #543
  mode-2 (`static_mapping_with_reservations`) "last-known /64" fallback.

  Always returns `:ok`: a capture failure must never fail the client
  connect. A persist error (e.g. the subject row vanished mid-connect)
  is best-effort but LOGGED, never silently swallowed (CLAUDE.md
  boundary rule).
  """
  @spec record_client_source(Subject.t(), :inet.ip_address()) :: :ok
  def record_client_source({_, _} = subject, remote_ip) do
    hex = Base.encode16(SourceMapping.client_key(remote_ip))

    case UserSettings.put_last_client_prefix64(subject, hex) do
      {:ok, _} ->
        :ok

      # #523 — a transient DB saturation is best-effort-dropped here (this is a
      # client-connect sample that must NEVER fail the connect, #590 policy),
      # NOT surfaced as a 503. Handled distinctly BEFORE the changeset clause:
      # `:db_unavailable` is an atom, so `.errors` on it would crash.
      {:error, :db_unavailable} ->
        Logger.warning(
          "record_client_source: db unavailable persisting client prefix for " <>
            "#{inspect(subject)} — dropped (best-effort)"
        )

        :ok

      {:error, changeset} ->
        Logger.warning(
          "record_client_source: failed to persist client prefix for " <>
            "#{inspect(subject)} — #{inspect(changeset.errors)}"
        )

        :ok
    end
  end

  @doc """
  The subject's last-known client prefix key — the RAW decoded `/64`|`/32`
  binary — or `nil` when the subject was never seen OR the stored value is
  malformed.

  Decodes the base16 string `record_client_source/2` persisted. A decode
  failure (a miscoded writer) falls back to `nil` rather than raising
  (`Base.decode16/1`, never `decode16!/1`). The returned binary equals
  `SourceMapping.client_key/1` of the originally-recorded IP.
  """
  @spec last_client_prefix64(Subject.t()) :: binary() | nil
  def last_client_prefix64({_, _} = subject) do
    case UserSettings.get_last_client_prefix64(subject) do
      nil ->
        last_known_client_key(subject)

      hex ->
        case Base.decode16(hex) do
          {:ok, key} -> key
          :error -> last_known_client_key(subject)
        end
    end
  end

  # #647 — a subject with no usable RECORDED sample can still have an address
  # on record: the visitor row's `ip` (written at login) or the newest
  # `sessions.ip` of an account. Mode 2 holds any session it cannot derive a
  # source for, so stopping at the missing sample stranded every subject whose
  # capture predates #543 Part C (or was never taken) — while the operator
  # could SEE that subject's source IP in admin. Whatever address we have is
  # the address we reconnect from.
  #
  # This is NOT a shared-source fallback: the key still comes from THAT
  # subject's own client network and derives that subject's own address, which
  # is the Global Constraint mode 2 exists to enforce. A subject with no
  # address anywhere still returns nil and is still held.
  #
  # The sample is persisted on the way through (best-effort — the writer never
  # fails a caller), so the next connect reads a recorded value and this path
  # is walked once per subject, not on every reconnect.
  @spec last_known_client_key(Subject.t()) :: <<_::32, _::_*32>> | nil
  defp last_known_client_key(subject) do
    with ip when is_binary(ip) <- last_known_ip(subject),
         {:ok, tuple} <- :inet.parse_address(String.to_charlist(ip)) do
      :ok = record_client_source(subject, tuple)
      SourceMapping.client_key(tuple)
    else
      _ -> nil
    end
  end

  @spec last_known_ip(Subject.t()) :: String.t() | nil
  defp last_known_ip({:visitor, id}) do
    case Repo.get(Visitor, id) do
      %Visitor{ip: ip} -> ip
      nil -> nil
    end
  end

  defp last_known_ip({:user, id}) do
    query =
      from(s in Session,
        where: s.user_id == ^id and not is_nil(s.ip),
        order_by: [desc: s.last_seen_at],
        limit: 1,
        select: s.ip
      )

    Repo.one(query)
  end

  # ---------------------------------------------------------------------------
  # Pool (DB-driven rotation set — replaces GRAPPA_OUTBOUND_V6_POOL)
  # ---------------------------------------------------------------------------

  @doc """
  Addresses flagged `in_pool` — the auto-rotation set
  `Grappa.OutboundV6Pool` draws from. Replaces the env-var pool
  (vjt 2026-07-14).
  """
  @spec pool_addresses() :: [String.t()]
  def pool_addresses do
    query = from(v in Vhost, where: v.in_pool == true, select: v.address)
    Repo.all(query)
  end

  @doc """
  The EFFECTIVE rotation pool = `in_pool` vhosts MINUS `fixed_sources`
  (the per-server `network_servers.source_address` set). Spec §3 safety
  net: an auto-allocated session must never `pick/0` a dedicated source.
  Single source of truth for the subtraction — Bootstrap + the admin
  controllers all install `OutboundV6Pool.apply_pool(effective_pool(...))`.

  `fixed_sources` is passed IN (not read here) so `Vhosts` stays off a
  `Grappa.Networks` dep — the caller (which already deps Networks) reads
  `Servers.list_source_addresses/0`. Set-difference on canonical strings
  (both stores canonicalize via `Grappa.Net.IpLiteral`).
  """
  @spec effective_pool([String.t()]) :: [String.t()]
  def effective_pool(fixed_sources) when is_list(fixed_sources) do
    fixed = MapSet.new(fixed_sources)
    Enum.reject(pool_addresses(), &MapSet.member?(fixed, &1))
  end

  @doc """
  Installs the effective rotation pool into `Grappa.OutboundV6Pool`
  (`effective_pool/1` → `apply_pool/1`). Call after any inventory OR
  per-server-source change so a hot edit takes effect on the next
  connect without a restart. `fixed_sources` is passed IN by the caller
  (which deps `Grappa.Networks`) — keeps `Vhosts` off a Networks dep.
  """
  @spec resync_pool([String.t()]) :: :ok
  def resync_pool(fixed_sources) when is_list(fixed_sources) do
    Grappa.OutboundV6Pool.apply_pool(effective_pool(fixed_sources))
  end
end
