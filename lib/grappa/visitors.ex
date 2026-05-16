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
    * `commit_password/2` — atomic password write triggered ONLY by +r
      MODE observation in `Grappa.Session.Server`. Clears `expires_at`
      to NULL — NickServ-identified visitors persist forever
      (operator-driven deletion is the only removal path).
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

  Anon TTL is 48h sliding (`touch/1` on user-initiated REST/WS verbs,
  ≥1h cadence per W9). NickServ-identified visitors (`password_encrypted`
  set) have no expiry — `commit_password/2` writes `expires_at = NULL`
  and `touch/1` is a no-op for them. Inbound-IRC events and idle
  WebSocket heartbeats do NOT bump the TTL.
  """

  use Boundary,
    top_level?: true,
    deps: [
      Grappa.Accounts,
      Grappa.Admission,
      Grappa.Auth.IdentifierClassifier,
      Grappa.IRC,
      Grappa.LiveIntrospection,
      Grappa.Networks,
      Grappa.Repo,
      Grappa.Session
    ],
    exports: [AdminWire, Login, SessionPlan, Visitor, VisitorChannel, Wire]

  import Ecto.Query

  alias Grappa.Repo
  alias Grappa.Visitors.Visitor

  require Logger

  @anon_ttl_seconds 48 * 3600
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
  and clear `expires_at` to NULL. Called from `Grappa.Session.Server`
  after the +r MODE observation confirmed the visitor's nick is
  identified.

  V7: identified visitors persist forever — only operator-driven
  `delete/1` removes them. Reaper's IS-NOT-NULL guard in
  `list_expired/0` skips NULL rows.
  """
  @spec commit_password(Ecto.UUID.t(), String.t()) ::
          {:ok, Visitor.t()} | {:error, :not_found | Ecto.Changeset.t()}
  def commit_password(visitor_id, password)
      when is_binary(visitor_id) and is_binary(password) and password != "" do
    case Repo.get(Visitor, visitor_id) do
      nil ->
        {:error, :not_found}

      visitor ->
        visitor
        |> Visitor.commit_password_changeset(password, nil)
        |> Repo.update()
    end
  end

  @doc """
  Slide `expires_at` forward on user-initiated REST/WS verbs. Anon
  visitors slide to now + 48h; NickServ-identified visitors
  (`password_encrypted` set + `expires_at IS NULL`) are no-ops —
  they don't expire. No-op if the resulting bump on an anon row would
  extend by less than 1h (`@touch_cadence_seconds`) — keeps the
  per-request DB-write cost negligible under sustained traffic.
  """
  @spec touch(Ecto.UUID.t()) ::
          {:ok, Visitor.t()} | {:error, :not_found | :expired | Ecto.Changeset.t()}
  def touch(visitor_id) when is_binary(visitor_id) do
    case Repo.get(Visitor, visitor_id) do
      nil ->
        {:error, :not_found}

      %Visitor{expires_at: nil} = visitor ->
        # V7: identified visitor — no expiry, no-op.
        {:ok, visitor}

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

  defp maybe_bump(%Visitor{password_encrypted: nil} = visitor) do
    target = DateTime.add(DateTime.utc_now(), @anon_ttl_seconds, :second)

    if DateTime.diff(target, visitor.expires_at, :second) >= @touch_cadence_seconds do
      visitor
      |> Visitor.touch_changeset(target)
      |> Repo.update()
    else
      {:ok, visitor}
    end
  end

  @doc """
  Count visitors active for the given `ip`. A visitor is "active" if
  either `expires_at IS NULL` (V7 NickServ-identified — never expires)
  or `expires_at > now()` (anon, sliding 48h TTL not yet elapsed).
  Per-IP cap (W3, default 5) enforcement primitive — composed by the
  Login orchestrator (Task 9) before calling
  `find_or_provision_anon/3`.
  """
  @spec count_active_for_ip(String.t()) :: non_neg_integer()
  def count_active_for_ip(ip) when is_binary(ip) do
    now = DateTime.utc_now()

    query =
      from(v in Visitor,
        where: v.ip == ^ip and (is_nil(v.expires_at) or v.expires_at > ^now)
      )

    Repo.aggregate(query, :count, :id)
  end

  @doc """
  All active visitors — `expires_at IS NULL` (V7 identified) or
  `expires_at > now()` (anon, not yet elapsed). Used by
  `Grappa.Bootstrap` to enumerate sessions to respawn at app start.
  Identified visitors must always respawn; otherwise an operator
  bounce silently destroys their session presence.
  """
  @spec list_active() :: [Visitor.t()]
  def list_active do
    now = DateTime.utc_now()
    query = from(v in Visitor, where: is_nil(v.expires_at) or v.expires_at > ^now)
    Repo.all(query)
  end

  @doc """
  Every visitor row, regardless of expiry state, ordered by
  `inserted_at` ascending. Operator-facing — the M-4 admin console
  needs the not-yet-reaped expired sliver too, to answer "why is
  this visitor not being reaped?" `list_active/0` is the
  Bootstrap-respawn filter; `list_all/0` is the admin view.
  """
  @spec list_all() :: [Visitor.t()]
  def list_all do
    query = from(v in Visitor, order_by: [asc: v.inserted_at, asc: v.id])
    Repo.all(query)
  end

  @doc """
  Every visitor row joined to its live `Grappa.Session.Server`
  introspection, or `nil` when no pid is registered for
  `{:visitor, v.id} × network.id`. The `nil` IS the U-0 honesty
  signal — admin console renders it prominently so the operator
  sees "DB intent exists, BEAM doesn't" rather than a quietly
  empty row.

  One DB roundtrip for the visitor list + one for the
  `slug → network_id` index; N registry lookups (one per
  visitor) at O(1) each. Each lookup also fetches
  `joined_channels` via a `GenServer.call` with a 250ms-per-pid
  timeout — worst-case latency is `O(N × 250ms)` when every
  pid is stuck, gracefully degraded to `live_state` with
  `joined_channels: nil` + `introspection_degraded: [:joined_channels]`.
  Orphan visitors (network_slug not in `networks`) get `nil` live
  state with no live-lookup attempted.

  ## Wire shape note

  Returns a flat `{visitor, live_state}` tuple — the visitor row's
  fields are NOT wrapped under a `db_state` key (cf. MD2 example
  in `docs/plans/2026-05-16-tmu-cluster-arc.md`). The flatter
  shape was chosen for simpler cic rendering; the visitor schema
  IS the DB intent, no additional wrapper needed.
  """
  @spec list_all_with_live_state() ::
          [{Visitor.t(), Grappa.LiveIntrospection.SessionEntry.t() | nil}]
  def list_all_with_live_state do
    index = Grappa.Networks.network_id_by_slug_index()

    for v <- list_all() do
      live =
        case Map.fetch(index, v.network_slug) do
          {:ok, network_id} ->
            Grappa.LiveIntrospection.lookup_session({:visitor, v.id}, network_id)

          :error ->
            nil
        end

      {v, live}
    end
  end

  @doc """
  All visitors with `expires_at <= now()`. Used by
  `Grappa.Visitors.Reaper` to enumerate rows due for deletion.

  The `expires_at IS NOT NULL` guard is essential post-V7: NickServ-
  identified visitors carry `expires_at = NULL` to mark "never
  expires" — without this guard, the Reaper would delete every
  identified visitor on the first tick. The V5 commit
  (6ef59a0) added the guard pre-staging V7's column-flip migration;
  the V7 migration (`20260515111331_visitors_expires_at_nullable`)
  flipped the column to nullable, completing the design.
  """
  @spec list_expired() :: [Visitor.t()]
  def list_expired do
    now = DateTime.utc_now()
    query = from(v in Visitor, where: not is_nil(v.expires_at) and v.expires_at <= ^now)
    Repo.all(query)
  end

  @doc """
  Mark a visitor row as permanently failed by setting `expires_at` to
  now. The next `Grappa.Visitors.Reaper` sweep (60s cadence) will
  delete the row; until then `Grappa.Visitors.list_active/0` already
  filters on `expires_at > now()` so respawn stops immediately.

  Used by `Grappa.Visitors.SessionPlan` as the visitor-side equivalent
  of `Networks.SessionPlan`'s `credential_failer` callback —
  K-line / permanent-SASL on a visitor session calls this with the
  upstream rejection reason, expires the row, and emits a structured
  `Logger.error` so the operator dashboard surfaces the
  permanently-rejected visitor (cluster-wide rule per memory
  `feedback_silent_retry_anti_pattern`: any reconnecting client must
  surface a UI signal above threshold).

  Idempotent: a second call on an already-expired row succeeds with
  `:ok` (the changeset just re-writes the same `expires_at`). Returns
  `{:error, :not_found}` if the visitor row has been reaped between
  the failure detection and this call.
  """
  @spec mark_failed(Ecto.UUID.t(), String.t()) :: :ok | {:error, :not_found}
  def mark_failed(visitor_id, reason)
      when is_binary(visitor_id) and is_binary(reason) do
    case Repo.get(Visitor, visitor_id) do
      nil ->
        {:error, :not_found}

      visitor ->
        now = DateTime.utc_now()

        Logger.error("visitor permanently rejected — expiring row",
          user: "visitor:" <> visitor.id,
          network: visitor.network_slug,
          reason: inspect(reason)
        )

        {:ok, _} =
          visitor
          |> Visitor.touch_changeset(now)
          |> Repo.update()

        :ok
    end
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
  Fetch a visitor by id, typed-error sibling of `get!/1`. Used by
  callers that need a non-raising lookup (e.g. controllers that map
  `nil` → 404 via `FallbackController`). Returns `nil` on miss so the
  caller pattern-matches symmetrically with `Repo.get/2`.
  """
  @spec get(Ecto.UUID.t()) :: Visitor.t() | nil
  def get(visitor_id) when is_binary(visitor_id), do: Repo.get(Visitor, visitor_id)

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
  Visitor-side NICK rename pre-check (V9). Returns `true` if a
  DIFFERENT visitor row already holds `target_nick` on
  `network_slug`; the caller surfaces that as 409 nick_in_use BEFORE
  sending NICK upstream. False if the slot is free, or if the only
  occupant IS the visitor itself (idempotent rename to current nick).
  """
  @spec nick_in_use?(Ecto.UUID.t(), String.t(), String.t()) :: boolean()
  def nick_in_use?(visitor_id, target_nick, network_slug)
      when is_binary(visitor_id) and is_binary(target_nick) and is_binary(network_slug) do
    case Repo.get_by(Visitor, nick: target_nick, network_slug: network_slug) do
      nil -> false
      %Visitor{id: ^visitor_id} -> false
      %Visitor{} -> true
    end
  end

  @doc """
  Rotate `visitor.nick` after upstream confirmed the rename via NICK
  self-echo (V9, visitor-parity cluster, 2026-05-15). Called from
  `Grappa.Session.Server`'s `apply_effects/2` (private) on the
  `{:visitor_nick_changed, new_nick}` effect emitted by EventRouter
  when `state.subject == {:visitor, _}` and `old_nick == state.nick`.

  The `(nick, network_slug)` UNIQUE constraint catches concurrent
  collisions (two visitors racing for the same nick on the same
  network) — the controller-boundary `nick_in_use?/3` pre-check is the
  fast path; this function is the second line of defense for the
  near-zero-probability race.

  `{:error, :not_found}` on a reaped row (terminal — Reaper got the
  row between `send_nick` and the upstream echo). Logged + dropped at
  the call site.
  """
  @spec update_nick(Ecto.UUID.t(), String.t()) ::
          {:ok, Visitor.t()} | {:error, :not_found | Ecto.Changeset.t()}
  def update_nick(visitor_id, new_nick)
      when is_binary(visitor_id) and is_binary(new_nick) do
    case Repo.get(Visitor, visitor_id) do
      nil ->
        {:error, :not_found}

      visitor ->
        visitor
        |> Visitor.nick_changeset(new_nick)
        |> Repo.update()
    end
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
