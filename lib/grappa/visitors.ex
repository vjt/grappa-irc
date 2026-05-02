defmodule Grappa.Visitors do
  @moduledoc """
  Self-service visitor identity context — collapsed M2 (NickServ-as-IDP)
  + M3a (anon) per cluster/visitor-auth.

  ## Public surface

    * `find_or_provision_anon/3` — entry point at `POST /auth/login`
      no-`@` branch. Idempotent — returns existing row if (nick, network)
      already exists; creates a fresh anon row otherwise. Per-IP cap
      enforcement is the caller's responsibility (Task 9 Login orchestrator
      composes `count_active_for_ip/1` before invoking this function).
    * `commit_password/2` — atomic password+expires_at write triggered
      ONLY by +r MODE observation in `Grappa.Session.Server`. Bumps
      `expires_at` to now+7d (registered TTL).
    * `touch/1` — sliding-TTL bump on user-initiated REST/WS verbs,
      ≥1h cadence. No-op if <1h since last bump (W9).
    * `count_active_for_ip/1` — per-IP cap check primitive (W3).
    * `list_active/0` — `Grappa.Bootstrap` respawn enumeration.
    * `list_expired/0` — `Grappa.Visitors.Reaper` sweep enumeration.
    * `delete/1` — Reaper + operator path. The DB-level FK ON DELETE
      CASCADE on `visitor_channels`, `messages`, and `sessions` wipes
      the dependent rows in a single transaction.
    * `purge_if_anon/1` — co-terminus-with-session deletion verb (W11).
      Anon visitor → `Repo.delete` → CASCADE wipes everything.
      Registered visitor → no-op (password gate keeps the data alive
      across logouts). Missing row → no-op. Called from every
      accounts_sessions deletion site (Login preempt in Task 9,
      logout in Task 25.5, expiry in Plugs.Authn).
    * `get!/1` — bang-style fetch for invariant-violation paths.

  ## Boundary

  Deps: `Grappa.IRC` (Identifier validators on the child schema) +
  `Grappa.Repo` (CRUD). `Grappa.Accounts` is NOT a dep — session
  CASCADE happens at the DB level (Task 5 migration's FK ON DELETE
  CASCADE), no application-layer call needed. `Grappa.Networks` is
  NOT a dep — slug existence checks at boot live in `Grappa.Bootstrap`.

  ## TTL cadence

  Anon TTL is 48h, registered TTL is 7d. `touch/1` is the sole
  sliding-refresh verb per W9 — called from `Plugs.Authn` on
  user-initiated REST/WS only. Inbound-IRC events and idle WebSocket
  heartbeats do NOT bump the TTL.
  """

  use Boundary,
    top_level?: true,
    deps: [
      Grappa.Accounts,
      Grappa.Auth.IdentifierClassifier,
      Grappa.IRC,
      Grappa.Networks,
      Grappa.Repo,
      Grappa.Session
    ],
    exports: [Login, SessionPlan, Visitor, VisitorChannel]

  import Ecto.Query

  alias Grappa.Repo
  alias Grappa.Visitors.Visitor

  @anon_ttl_seconds 48 * 3600
  @registered_ttl_seconds 7 * 24 * 3600
  @touch_cadence_seconds 3600

  @doc """
  Find an existing anon visitor by `(nick, network_slug)`, or create
  a fresh one. The fresh row carries `expires_at = now + 48h` and
  `password_encrypted = nil`.

  `ip` is recorded on creation for the per-IP cap (W3) and for
  operator audit. `nil` is acceptable when the caller has no IP
  (mix-task driven provisioning, future internal flows).
  """
  @spec find_or_provision_anon(String.t(), String.t(), String.t() | nil) ::
          {:ok, Visitor.t()} | {:error, Ecto.Changeset.t()}
  def find_or_provision_anon(nick, network_slug, ip)
      when is_binary(nick) and is_binary(network_slug) do
    case Repo.get_by(Visitor, nick: nick, network_slug: network_slug) do
      %Visitor{} = existing -> {:ok, existing}
      nil -> create_anon(nick, network_slug, ip)
    end
  end

  defp create_anon(nick, network_slug, ip) do
    expires_at = DateTime.add(DateTime.utc_now(), @anon_ttl_seconds, :second)

    %{nick: nick, network_slug: network_slug, expires_at: expires_at, ip: ip}
    |> Visitor.create_changeset()
    |> Repo.insert()
  end

  @doc """
  Atomically write a NickServ password (encrypted at rest by Cloak)
  and bump `expires_at` to the registered-user TTL (now + 7d). Called
  from `Grappa.Session.Server` after the +r MODE observation
  confirmed the visitor's nick is identified.
  """
  @spec commit_password(Ecto.UUID.t(), String.t()) ::
          {:ok, Visitor.t()} | {:error, :not_found | Ecto.Changeset.t()}
  def commit_password(visitor_id, password)
      when is_binary(visitor_id) and is_binary(password) and password != "" do
    expires_at = DateTime.add(DateTime.utc_now(), @registered_ttl_seconds, :second)

    case Repo.get(Visitor, visitor_id) do
      nil ->
        {:error, :not_found}

      visitor ->
        visitor
        |> Visitor.commit_password_changeset(password, expires_at)
        |> Repo.update()
    end
  end

  @doc """
  Slide `expires_at` forward on user-initiated REST/WS verbs. Anon
  visitors slide to now + 48h; registered visitors (with
  `password_encrypted` set) slide to now + 7d. No-op if the resulting
  bump would extend the row by less than 1h (`@touch_cadence_seconds`)
  — keeps the per-request DB-write cost negligible under sustained
  traffic.
  """
  @spec touch(Ecto.UUID.t()) ::
          {:ok, Visitor.t()} | {:error, :not_found | :expired | Ecto.Changeset.t()}
  def touch(visitor_id) when is_binary(visitor_id) do
    case Repo.get(Visitor, visitor_id) do
      nil ->
        {:error, :not_found}

      %Visitor{expires_at: exp} = visitor ->
        # Without this gate, `maybe_bump/1` would slide an EXPIRED row
        # 48h into the future on the next REST/WS verb — silently
        # resurrecting a visitor the Reaper hadn't yet purged. The
        # Reaper (Task 22) remains the deletion verb; `touch/1`'s job
        # is to gate read access.
        if DateTime.compare(exp, DateTime.utc_now()) == :gt do
          maybe_bump(visitor)
        else
          {:error, :expired}
        end
    end
  end

  defp maybe_bump(%Visitor{password_encrypted: pwd} = visitor) do
    extension = if is_nil(pwd), do: @anon_ttl_seconds, else: @registered_ttl_seconds
    target = DateTime.add(DateTime.utc_now(), extension, :second)

    if DateTime.diff(target, visitor.expires_at, :second) >= @touch_cadence_seconds do
      visitor
      |> Visitor.touch_changeset(target)
      |> Repo.update()
    else
      {:ok, visitor}
    end
  end

  @doc """
  Count visitors with `expires_at > now()` from the given `ip`.
  Per-IP cap (W3, default 5) enforcement primitive — composed by the
  Login orchestrator (Task 9) before calling
  `find_or_provision_anon/3`.
  """
  @spec count_active_for_ip(String.t()) :: non_neg_integer()
  def count_active_for_ip(ip) when is_binary(ip) do
    now = DateTime.utc_now()
    query = from(v in Visitor, where: v.ip == ^ip and v.expires_at > ^now)
    Repo.aggregate(query, :count, :id)
  end

  @doc """
  All visitors with `expires_at > now()`. Used by `Grappa.Bootstrap`
  to enumerate sessions to respawn at app start.
  """
  @spec list_active() :: [Visitor.t()]
  def list_active do
    now = DateTime.utc_now()
    query = from(v in Visitor, where: v.expires_at > ^now)
    Repo.all(query)
  end

  @doc """
  All visitors with `expires_at <= now()`. Used by
  `Grappa.Visitors.Reaper` to enumerate rows due for deletion.
  """
  @spec list_expired() :: [Visitor.t()]
  def list_expired do
    now = DateTime.utc_now()
    query = from(v in Visitor, where: v.expires_at <= ^now)
    Repo.all(query)
  end

  @doc """
  Delete a visitor row. The DB-level FK ON DELETE CASCADE on
  `visitor_channels`, `messages`, and `sessions` wipes dependents
  in the same transaction.
  """
  @spec delete(Ecto.UUID.t()) :: :ok | {:error, :not_found}
  def delete(visitor_id) when is_binary(visitor_id) do
    case Repo.get(Visitor, visitor_id) do
      nil ->
        {:error, :not_found}

      visitor ->
        {:ok, _} = Repo.delete(visitor)
        :ok
    end
  end

  @doc """
  Fetch a visitor by id. Raises `Ecto.NoResultsError` on miss — used
  on paths where the id has already been validated upstream and a
  miss is an invariant violation worth crashing on.
  """
  @spec get!(Ecto.UUID.t()) :: Visitor.t()
  def get!(visitor_id) when is_binary(visitor_id), do: Repo.get!(Visitor, visitor_id)

  @doc """
  Bulk-delete every visitor row pinned to `network_slug`. Returns
  `{:ok, count}` with the deleted-row count. Operator path —
  surfaces through `mix grappa.reap_visitors --network=<slug>` to
  unblock the `Grappa.Bootstrap` W7 hard-error path (Task 20) when
  the operator has intentionally dropped a network from the DB.

  CASCADE: the `visitor_id` FKs on `visitor_channels`, `messages`,
  and `accounts_sessions` all carry `ON DELETE CASCADE`; the bulk
  delete fires those at the DB layer in a single transaction.
  """
  @spec reap_by_network_slug(String.t()) :: {:ok, non_neg_integer()}
  def reap_by_network_slug(slug) when is_binary(slug) do
    query = from(v in Visitor, where: v.network_slug == ^slug)
    {count, _} = Repo.delete_all(query)
    {:ok, count}
  end

  @doc """
  Visitor-side autojoin channel list — names of `visitor_channels` rows
  pinned to `(visitor.id, visitor.network_slug)`. Mirror of
  `Networks.Credential.autojoin_channels` for user subjects (single
  source consumed by `Grappa.Visitors.SessionPlan` for Bootstrap-respawn
  rejoin AND `GrappaWeb.ChannelsController.index/2` for the cicchetto
  sidebar render).
  """
  @spec list_autojoin_channels(Visitor.t()) :: [String.t()]
  def list_autojoin_channels(%Visitor{id: visitor_id, network_slug: slug})
      when is_binary(visitor_id) and is_binary(slug) do
    query =
      from c in Grappa.Visitors.VisitorChannel,
        where: c.visitor_id == ^visitor_id and c.network_slug == ^slug,
        select: c.name

    Repo.all(query)
  end

  @doc """
  Lookup a visitor by `(nick, network_slug)`. Returns the row or `nil`.
  Used by `GrappaWeb.AuthController` to compute the `Retry-After` hint
  on `:anon_collision` responses without exposing `Repo` to the web
  boundary.
  """
  @spec get_by_nick_and_network(String.t(), String.t()) :: Visitor.t() | nil
  def get_by_nick_and_network(nick, network_slug)
      when is_binary(nick) and is_binary(network_slug) do
    Repo.get_by(Visitor, nick: nick, network_slug: network_slug)
  end

  @doc """
  Anon-only co-terminus delete (W11). If the visitor exists and
  `password_encrypted` is nil, delete the row — CASCADE wipes the
  associated accounts_sessions, visitor_channels, and messages in a
  single transaction. Registered visitor (`password_encrypted` set):
  no-op, the NickServ-password identity persists across logouts.
  Missing row: no-op (idempotent under concurrent deletion).

  Called from every accounts_sessions deletion site. Anon visitors'
  data dies with their session row; registered visitors' data
  persists past session death and is gated on the next login by the
  `Visitors.Login` password match.
  """
  @spec purge_if_anon(Ecto.UUID.t()) :: :ok
  def purge_if_anon(visitor_id) when is_binary(visitor_id) do
    case Repo.get(Visitor, visitor_id) do
      nil ->
        :ok

      %Visitor{password_encrypted: nil} = visitor ->
        {:ok, _} = Repo.delete(visitor)
        :ok

      %Visitor{} ->
        :ok
    end
  end
end
