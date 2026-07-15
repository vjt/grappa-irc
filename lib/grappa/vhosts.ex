defmodule Grappa.Vhosts do
  @moduledoc """
  Per-subject vhost (source-bind address) selection — #228.

  Extends the existing source-bind path (`network_servers.source_address`
  → `Grappa.IRC.Client` `ifaddr` bind) with a per-SUBJECT layer that sits
  ABOVE it: a subject (user OR visitor, post-#211) self-selects from an
  allowed set. The connect path is UNCHANGED — this context only decides
  WHICH address resolves into the session plan (`effective_source/2`),
  which `Grappa.Networks.SessionPlan` threads through exactly as it does
  the per-server `source_address` today.

  ## Principle (#251, vjt 2026-07-15)

  **Admin decides AVAILABILITY; the user decides SELECTION.** The admin
  curates which vhosts a subject *can* use (`generally_available` /
  `in_pool` / a per-subject grant); the user freely picks among that set.
  No admin hard-pin, no admin default.

  ## Inventory model

    * `vhosts` rows — curated from the host's bound addresses
      (`Grappa.Net.HostAddresses.list/0`). `in_pool` = auto-rotation pool
      member (replaces the `GRAPPA_OUTBOUND_V6_POOL` env var, vjt
      2026-07-14) AND self-selectable by any subject (#251);
      `generally_available` = any subject may self-select.
    * `vhost_grants` rows — per-subject grants: a grant means "`subject`
      may select this vhost even if it isn't generally-available / in the
      pool." Visitor grants CASCADE on reap.

  ## Resolution precedence (`effective_source/2`, per connect)

    1. the subject's selection (`UserSettings` `"vhost_selection"`)
       INTERSECTED with its allowed set → random pick (spec: "random per
       connection" when >1 active).
    2. the passed `server_source` fallback (`network_servers.source_address`
       — the per-network fixed bind, the operator "force egress from X"
       mechanism, admin-only; the MECHANISM + its no-selection default is
       unchanged — or `nil` → the `Grappa.IRC.Client` DB-driven rotation
       pool / kernel default).

  The allowed set = generally-available ∪ in_pool ∪ granted-to-subject.
  Selection is authz-clamped to this set at write (`set_selection/2`), and
  re-clamped at read so a revoked grant can't leak a stale selection.

  NOTE (#251): `server_source` is only the DEFAULT for a no-selection
  subject. A subject who self-selects (step 1) overrides it — and with the
  admin pin removed there is no longer a per-subject *hard* force. A
  network with a mandated `source_address` still egresses from it for any
  subject who has NOT self-selected, but a subject CAN now pick a pool /
  granted address instead. If an operator needs to hard-force a specific
  account's egress, that capability was intentionally removed with the pin
  (#251) and is not replaced in V1.

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
      Grappa.UserSettings
    ],
    dirty_xrefs: [Grappa.Visitors.Visitor],
    exports: [Vhost, Grant, AdminWire]

  import Ecto.Query

  alias Grappa.{Repo, Subject, UserSettings}
  alias Grappa.Vhosts.{Grant, Vhost}

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
  The subject's allowed vhosts = generally-available ∪ in_pool ∪
  granted-to-subject (#251 — in_pool joins the self-selectable set).
  Ordered by address, de-duplicated.
  """
  @spec allowed_vhosts(Subject.t()) :: [Vhost.t()]
  def allowed_vhosts({_, _} = subject) do
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
  The subject's persisted self-selection, RE-CLAMPED to the currently
  allowed set (a revoked grant silently drops its address). Stored in
  `UserSettings` under `"vhost_selection"` as a list of addresses.
  """
  @spec get_selection(Subject.t()) :: [String.t()]
  def get_selection({_, _} = subject) do
    allowed = MapSet.new(allowed_vhosts(subject), & &1.address)

    subject
    |> raw_selection()
    |> Enum.filter(&MapSet.member?(allowed, &1))
  end

  @doc """
  Sets the subject's self-selection. Every address MUST be in the
  subject's allowed set — `{:error, :forbidden_vhost}` otherwise (authz
  at the boundary, not just the UI). Returns the persisted (canonical)
  selection list.
  """
  @spec set_selection(Subject.t(), [String.t()]) ::
          {:ok, [String.t()]} | {:error, :forbidden_vhost | Ecto.Changeset.t()}
  def set_selection({_, _} = subject, addresses) when is_list(addresses) do
    allowed = MapSet.new(allowed_vhosts(subject), & &1.address)
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

  @doc """
  Resolves the effective source address for `subject` on this connect,
  given the per-network `server_source` fallback
  (`network_servers.source_address`, or `nil`).

  Precedence (#251 — the admin hard-pin was removed):

    1. the subject's selection (∩ allowed) → random pick (spec: "random
       per connection" when more than one is active).
    2. `server_source` (the per-network fixed bind — the operator "force
       egress from X" mechanism, admin-only; MECHANISM unchanged — or
       `nil` → `Grappa.IRC.Client` falls through to the DB-driven pool /
       kernel default, exactly as today).

  A network WITH `source_address` set still binds it verbatim for a
  no-selection subject (the no-selection DEFAULT is preserved); a network
  with `nil` routes the no-selection subject to `OutboundV6Pool.pick/0`
  (the in_pool rotation). NOTE (#251): a subject who self-selects (step 1)
  overrides `server_source` — with the pin removed there is no per-subject
  hard-force, so a subject CAN now egress from a pool/granted address
  instead of the mandated one. Returns a canonical IP-literal string or
  `nil`. The connect path (`Grappa.IRC.Client.source_bind/2`) is UNCHANGED
  — this only chooses the value that `SessionPlan` threads through.
  """
  @spec effective_source(Subject.t(), String.t() | nil) :: String.t() | nil
  def effective_source({_, _} = subject, server_source) do
    case get_selection(subject) do
      [] -> server_source
      selected -> Enum.random(selected)
    end
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
