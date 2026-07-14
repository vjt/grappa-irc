defmodule Grappa.Vhosts do
  @moduledoc """
  Per-subject vhost (source-bind address) selection — #228.

  Extends the existing source-bind path (`network_servers.source_address`
  → `Grappa.IRC.Client` `ifaddr` bind) with a per-SUBJECT layer that sits
  ABOVE it: a subject (user OR visitor, post-#211) can be pinned to a
  fixed vhost or self-select from an allowed set. The connect path is
  UNCHANGED — this context only decides WHICH address resolves into the
  session plan (`effective_source/2`), which `Grappa.Networks.SessionPlan`
  threads through exactly as it does the per-server `source_address` today.

  ## Inventory model

    * `vhosts` rows — curated from the host's bound addresses
      (`Grappa.Net.HostAddresses.list/0`). `in_pool` = auto-rotation pool
      member (replaces the `GRAPPA_OUTBOUND_V6_POOL` env var, vjt
      2026-07-14); `generally_available` = any subject may self-select.
    * `vhost_grants` rows — per-subject grants. `pinned = true` is an
      admin-forced fixed bind; `pinned = false` is a curated-availability
      grant the subject may self-select. Visitor grants CASCADE on reap.

  ## Resolution precedence (`effective_source/2`, per connect)

    1. a `pinned` grant for the subject → that vhost (admin-forced).
    2. the subject's selection (`UserSettings` `"vhost_selection"`)
       INTERSECTED with its allowed set → random pick (spec: "random per
       connection" when >1 active).
    3. the passed `server_source` fallback (`network_servers.source_address`
       — the existing per-network fixed bind, or `nil` → pool/kernel).

  The allowed set = generally-available vhosts ∪ vhosts granted to the
  subject. Selection is authz-clamped to this set at write
  (`set_selection/2`), and re-clamped at read so a revoked grant can't
  leak a stale selection.
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
    Repo.all(from(v in Vhost, order_by: [asc: v.address]))
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
  Grants `vhost` to `subject`. `pinned: true` makes it an admin-forced
  fixed bind — use `pin_vhost/2` for that (it enforces the one-pin rule).
  `{:error, :already_exists}` when the (vhost, subject) grant exists.
  """
  @spec grant_vhost(Vhost.t(), Subject.t(), keyword()) ::
          {:ok, Grant.t()} | {:error, :already_exists | Ecto.Changeset.t()}
  def grant_vhost(%Vhost{id: vhost_id}, {_, _} = subject, opts) when is_list(opts) do
    attrs =
      %{vhost_id: vhost_id, pinned: Keyword.get(opts, :pinned, false)}
      |> Subject.put_subject_id(subject)

    case %Grant{} |> Grant.changeset(attrs) |> Repo.insert() do
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

  @doc """
  Pins `subject` to `vhost` (admin-forced fixed bind). Enforces at most
  one pin per subject: any existing pin for the subject is deleted first,
  then this vhost is pinned (upserting the grant to `pinned: true` if a
  non-pinned grant already exists).
  """
  @spec pin_vhost(Vhost.t(), Subject.t()) :: {:ok, Grant.t()} | {:error, Ecto.Changeset.t()}
  def pin_vhost(%Vhost{id: vhost_id}, {_, _} = subject) do
    Repo.transaction(fn ->
      # Drop every existing pin for the subject (one-pin invariant).
      subject
      |> grants_for_subject_query()
      |> where([g], g.pinned == true)
      |> Repo.delete_all()

      case upsert_pinned_grant(vhost_id, subject) do
        {:ok, grant} -> grant
        {:error, cs} -> Repo.rollback(cs)
      end
    end)
  end

  defp upsert_pinned_grant(vhost_id, subject) do
    case get_grant(vhost_id, subject) do
      %Grant{} = existing -> existing |> Grant.changeset(%{pinned: true}) |> Repo.update()
      nil -> grant_row(vhost_id, subject, true)
    end
  end

  defp grant_row(vhost_id, subject, pinned) do
    attrs =
      %{vhost_id: vhost_id, pinned: pinned}
      |> Subject.put_subject_id(subject)

    %Grant{} |> Grant.changeset(attrs) |> Repo.insert()
  end

  @doc "Every grant for `subject` (both pinned + curated-availability)."
  @spec list_grants_for_subject(Subject.t()) :: [Grant.t()]
  def list_grants_for_subject({_, _} = subject) do
    subject |> grants_for_subject_query() |> Repo.all()
  end

  @doc "Every grant in the system, newest first. Admin index surface."
  @spec list_grants() :: [Grant.t()]
  def list_grants do
    Repo.all(from(g in Grant, order_by: [desc: g.id]))
  end

  @doc """
  Fetches a grant by id, or `{:error, :not_found}`. Admin
  revoke/unpin surface.
  """
  @spec get_grant_by_id(integer()) :: {:ok, Grant.t()} | {:error, :not_found}
  def get_grant_by_id(id) when is_integer(id) do
    case Repo.get(Grant, id) do
      %Grant{} = g -> {:ok, g}
      nil -> {:error, :not_found}
    end
  end

  @doc "The subject's pinned vhost, or `nil` when none is pinned."
  @spec pinned_vhost(Subject.t()) :: Vhost.t() | nil
  def pinned_vhost({_, _} = subject) do
    query =
      from(g in Grant,
        join: v in Vhost,
        on: v.id == g.vhost_id,
        where: g.pinned == true,
        select: v
      )

    query |> Subject.subject_where(subject) |> Repo.one()
  end

  defp get_grant(vhost_id, subject) do
    from(g in Grant, where: g.vhost_id == ^vhost_id)
    |> Subject.subject_where(subject)
    |> Repo.one()
  end

  defp grants_for_subject_query(subject) do
    Grant |> Subject.subject_where(subject)
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
  The subject's allowed vhosts = generally-available ∪ granted-to-subject.
  Ordered by address, de-duplicated.
  """
  @spec allowed_vhosts(Subject.t()) :: [Vhost.t()]
  def allowed_vhosts({_, _} = subject) do
    granted_ids =
      subject
      |> grants_for_subject_query()
      |> select([g], g.vhost_id)
      |> Repo.all()

    query =
      from(v in Vhost,
        where: v.generally_available == true or v.id in ^granted_ids,
        order_by: [asc: v.address]
      )

    Repo.all(query)
  end

  @doc """
  The subject's persisted self-selection, RE-CLAMPED to the currently
  allowed set (a revoked grant silently drops its address). Stored in
  `UserSettings` under `"vhost_selection"` as a list of addresses.
  """
  @spec get_selection(Subject.t()) :: [String.t()]
  def get_selection({_, _} = subject) do
    allowed = allowed_vhosts(subject) |> MapSet.new(& &1.address)

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
    allowed = allowed_vhosts(subject) |> MapSet.new(& &1.address)
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

  Precedence:

    1. a `pinned` grant → that vhost's address (admin-forced).
    2. the subject's selection (∩ allowed) → random pick (spec: "random
       per connection" when more than one is active).
    3. `server_source` (the existing per-network fixed bind or `nil` →
       `Grappa.IRC.Client` falls through to the DB-driven pool / kernel
       default, exactly as today).

  Returns a canonical IP-literal string or `nil`. The connect path
  (`Grappa.IRC.Client.source_bind/2`) is UNCHANGED — this only chooses
  the value that `SessionPlan` threads through.
  """
  @spec effective_source(Subject.t(), String.t() | nil) :: String.t() | nil
  def effective_source({_, _} = subject, server_source) do
    case pinned_vhost(subject) do
      %Vhost{address: address} ->
        address

      nil ->
        case get_selection(subject) do
          [] -> server_source
          selected -> Enum.random(selected)
        end
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
    Repo.all(from(v in Vhost, where: v.in_pool == true, select: v.address))
  end
end
