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
    * `commit_password/2` — atomic password write. Two triggers in
      `Grappa.Session.Server`: the +r MODE observation (IDENTIFY/REGISTER
      rendezvous), and the #131 optimistic on-send commit of an
      in-session `SET PASSWD` (no +r fires for a password change). Clears
      `expires_at` to NULL — NickServ-identified visitors persist forever
      (operator-driven deletion is the only removal path).
    * `touch/1` — sliding-TTL bump on user-initiated REST/WS verbs,
      ≥1h cadence. No-op if <1h since last bump (W9).
    * `count_active_for_ip/1` — per-IP cap check primitive (W3).
    * `list_active/0` — `Grappa.Bootstrap` respawn enumeration.
    * `list_expired/0` — `Grappa.Visitors.Reaper` sweep enumeration.
    * `delete/1` — Reaper + operator path. The DB-level FK ON DELETE
      CASCADE on `messages`, and `sessions` wipes
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
      Grappa.Session,
      Grappa.SpawnOrchestrator
    ],
    exports: [AdminWire, Login, SessionPlan, Visitor, Wire]

  import Ecto.Query

  alias Grappa.{Admission, Networks, Repo, Session, SpawnOrchestrator}
  alias Grappa.IRC.Identifier
  alias Grappa.Visitors.{SessionPlan, Visitor}

  # Identifier.nick_fold/1 is a query macro (rfc1459 fold fragment).
  require Identifier
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

  When an existing row is found and the supplied `ip` differs from
  what's persisted, the row's `:ip` is refreshed via
  `ip_changeset/2` so the admin audit value tracks the holder's
  current address. Pre-fix a long-lived NickServ-identified visitor
  surfaced the row's birth IP indefinitely (often the nginx docker-
  bridge address baked in before the `RemoteIpFromProxy` plug
  landed). `nil` supplied with a row carrying a real IP does NOT
  overwrite — refresh is "I have a fresher value," not "forget what
  you knew."
  """
  @spec find_or_provision_anon(String.t(), String.t(), String.t() | nil) ::
          {:ok, Visitor.t()} | {:error, Ecto.Changeset.t()}
  def find_or_provision_anon(nick, network_slug, ip)
      when is_binary(nick) and is_binary(network_slug) do
    case Repo.one(by_folded_nick(nick, network_slug)) do
      %Visitor{} = existing -> maybe_refresh_ip(existing, ip)
      nil -> create_anon(nick, network_slug, ip)
    end
  end

  # Case-insensitive (rfc1459) visitor lookup query (GH #121). Folds the
  # `nick` column and the supplied `nick` through the SAME casemapper so
  # `Mezmerize`/`mezmerize`/`nick[1]`/`nick{1}` resolve to one row. The
  # `Identifier.nick_fold/1` fragment matches the folded unique
  # expression index, so this stays index-eligible.
  @spec by_folded_nick(String.t(), String.t()) :: Ecto.Query.t()
  defp by_folded_nick(nick, network_slug) do
    folded = Identifier.canonical_nick(nick)

    from(v in Visitor,
      where: Identifier.nick_fold(v.nick) == ^folded and v.network_slug == ^network_slug
    )
  end

  defp maybe_refresh_ip(%Visitor{ip: same} = visitor, same), do: {:ok, visitor}
  defp maybe_refresh_ip(%Visitor{} = visitor, nil), do: {:ok, visitor}

  defp maybe_refresh_ip(%Visitor{} = visitor, new_ip) when is_binary(new_ip) do
    visitor
    |> Visitor.ip_changeset(new_ip)
    |> Repo.update()
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
  on either trigger: the +r MODE observation that confirmed the
  visitor's nick is identified (IDENTIFY/REGISTER rendezvous), or the
  #131 optimistic on-send commit of an in-session `SET PASSWD` (a
  password change emits no +r, so the host commits when the well-formed
  line leaves the wire).

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
        # H14 (REV-D 2026-05-22): lookup-then-update races on concurrent
        # delete — between the Repo.get above and Repo.update below, a
        # peer caller (operator delete, Reaper sweep, anon visitor logout)
        # may purge the row. Pre-fix the update would raise
        # `Ecto.StaleEntryError` (caller spec'd `{:error, :not_found}`,
        # so the raise was a silent contract violation: 500 in the web
        # layer instead of a typed result). Map back to the documented
        # return shape so callers handle the concurrent-delete case the
        # same way as the initial Repo.get/2 miss.
        try do
          visitor
          |> Visitor.commit_password_changeset(password, nil)
          |> Repo.update()
        rescue
          Ecto.StaleEntryError -> {:error, :not_found}
        end
    end
  end

  @doc """
  #131 — rotate an ALREADY-identified visitor's NickServ password from an
  in-session `SET PASSWD` (optimistic commit-on-send).

  Distinct from `commit_password/2`, which is the `+r`-gated promotion verb:
  `+r` PROVES the nick is identified, so it may safely promote an anon row
  to permanent (`expires_at = NULL`). A `SET PASSWD` carries NO such proof —
  services reject it unless the nick is already registered/identified — so
  an optimistic commit MUST NOT promote. This function is therefore
  IDENTITY-GATED: it rotates the password only for a row that is ALREADY
  identified (`password_encrypted` set ⟺ permanent), and is a no-op
  (`{:error, :not_identified}`) for an anon row. Without the gate, an anon
  visitor typing `/ns set passwd x` (which services would reject) would be
  silently pinned permanent + un-reapable carrying a junk password — the
  exact promotion the `+r` gate exists to prevent.

  Reuses `commit_password/2`'s underlying write (`commit_password_changeset`
  with `expires_at = nil`, idempotent on an already-permanent row) and the
  same H14 concurrent-delete guard.
  """
  @spec rotate_password(Ecto.UUID.t(), String.t()) ::
          {:ok, Visitor.t()} | {:error, :not_found | :not_identified | Ecto.Changeset.t()}
  def rotate_password(visitor_id, password)
      when is_binary(visitor_id) and is_binary(password) and password != "" do
    case Repo.get(Visitor, visitor_id) do
      nil ->
        {:error, :not_found}

      # Anon row (never +r-identified): SET PASSWD can't apply at the
      # service, and an optimistic commit must not promote → skip.
      %Visitor{password_encrypted: nil} ->
        {:error, :not_identified}

      %Visitor{} = visitor ->
        try do
          visitor
          |> Visitor.commit_password_changeset(password, nil)
          |> Repo.update()
        rescue
          Ecto.StaleEntryError -> {:error, :not_found}
        end
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
          {:ok, Visitor.t()} | {:error, :not_found | :expired}
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
      case visitor |> Visitor.touch_changeset(target) |> Repo.update() do
        {:ok, updated} ->
          {:ok, updated}

        {:error, %Ecto.Changeset{}} ->
          # H13 (REV-D 2026-05-22): the touch_changeset monotonicity
          # guard rejects strictly-backward bumps. A clock-skew event
          # (NTP step or container reboot under wall-clock drift) is
          # an operator-side infrastructure problem the bouncer can't
          # recover from inline. Mirror `Accounts.touch_session/2`'s
          # precedent: log a warning, return the un-bumped row so the
          # caller (auth plug / socket connect) keeps the session
          # alive with stale `expires_at` until the clock resolves.
          Logger.warning(
            "visitor touch backward-clock detected; ignoring " <>
              "(prev=#{DateTime.to_iso8601(visitor.expires_at)} " <>
              "attempted=#{DateTime.to_iso8601(target)})",
            visitor_id: visitor.id,
            reason: :backward_clock
          )

          {:ok, visitor}
      end
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
  fields are NOT wrapped under a `db_state` key (cf. MD2 example). The flatter
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
          |> Visitor.expire_changeset(now)
          |> Repo.update()

        :ok
    end
  end

  @doc """
  Delete a visitor row. The DB-level FK ON DELETE CASCADE on
  `messages`, and `sessions` wipes dependents in the same transaction.

  This is the single reap + admin delete choke point (`Visitors.Reaper`,
  `Operator.delete_visitor`, `AccountDeletion`), so it also evicts the
  subject's `Session.Backoff` ETS entries (S11): the destroyed UUID never
  logs in again, so its per-network failure counters would otherwise
  orphan for the node lifetime.
  """
  @spec delete(Ecto.UUID.t()) :: :ok | {:error, :not_found}
  def delete(visitor_id) when is_binary(visitor_id) do
    case Repo.get(Visitor, visitor_id) do
      nil ->
        {:error, :not_found}

      visitor ->
        {:ok, _} = Repo.delete(visitor)
        :ok = Session.Backoff.forget({:visitor, visitor.id})
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
  Batched lookup: `[visitor_id]` → `%{visitor_id => %Visitor{}}`. One
  query regardless of input size — used by admin endpoints that need
  to resolve N visitor_ids to display labels (nick) without N+1
  round-trips. Mirror of `Grappa.Accounts.get_users_by_ids/1`.

  Empty input returns `%{}` without a query. Missing ids are absent
  from the result map; callers translate to the "DB row missing"
  honesty signal at their boundary.
  """
  @spec get_by_ids([Ecto.UUID.t()]) :: %{Ecto.UUID.t() => Visitor.t()}
  def get_by_ids([]), do: %{}

  def get_by_ids(ids) when is_list(ids) do
    Visitor
    |> where([v], v.id in ^ids)
    |> Repo.all()
    |> Map.new(fn visitor -> {visitor.id, visitor} end)
  end

  @doc """
  Bulk-delete every visitor row pinned to `network_slug`. Returns
  `{:ok, count}` with the deleted-row count. Operator path —
  surfaces through `mix grappa.reap_visitors --network=<slug>` to
  unblock the `Grappa.Bootstrap` W7 hard-error path (Task 20) when
  the operator has intentionally dropped a network from the DB.

  CASCADE: the `visitor_id` FKs on `messages`,
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
  Visitor-side autojoin channel list — the `last_joined_channels`
  snapshot persisted by `Session.Server` on every self-JOIN /
  self-PART / self-KICK. Mirror of
  `Networks.Credential.last_joined_channels` for user subjects (single
  source consumed by `Grappa.Visitors.SessionPlan` for Bootstrap-respawn
  rejoin AND `GrappaWeb.ChannelsController.index/2` for the cicchetto
  sidebar render).

  Visitors have no operator-bound autojoin (mirror of
  `Credential.autojoin_channels`) — the snapshot IS the rejoin list.
  """
  @spec list_autojoin_channels(Visitor.t()) :: [String.t()]
  def list_autojoin_channels(%Visitor{last_joined_channels: channels})
      when is_list(channels),
      do: channels

  @doc """
  Overwrite the per-visitor `last_joined_channels` snapshot. Mirror of
  `Grappa.Networks.Credentials.update_last_joined_channels/3` for
  visitor subjects — called by `Session.Server` on every self-JOIN /
  self-PART / self-KICK so a graceful or crash restart can rehydrate
  the channel list at boot.

  Truncated to `Visitor.last_joined_channels_max/0` entries (200) so a
  pathological session can't grow the JSON column without limit.
  Returns `:ok` on success, `{:error, :not_found}` if the visitor was
  reaped between snapshot write and now (race tolerated — next
  Bootstrap cycle skips the absent visitor naturally).
  """
  @spec update_last_joined_channels(Ecto.UUID.t(), [String.t()]) ::
          :ok | {:error, :not_found | Ecto.Changeset.t()}
  def update_last_joined_channels(visitor_id, channels)
      when is_binary(visitor_id) and is_list(channels) do
    capped = Enum.take(channels, Visitor.last_joined_channels_max())

    case Repo.get(Visitor, visitor_id) do
      nil ->
        {:error, :not_found}

      %Visitor{} = visitor ->
        case visitor |> Visitor.last_joined_channels_changeset(capped) |> Repo.update() do
          {:ok, _} -> :ok
          {:error, changeset} -> {:error, changeset}
        end
    end
  end

  @doc """
  Removes `channel_name` from the visitor's `last_joined_channels` rejoin
  snapshot — the visitor-side mirror of
  `Grappa.Networks.Credentials.remove_autojoin_channel/3`.

  For a visitor the snapshot IS the autojoin source
  (`list_autojoin_channels/1`), so a PART of a channel the visitor is NOT
  currently live-joined to (a stale autojoin entry that 475'd on reconnect,
  with no live membership for `Session.Server` to snapshot away) must drop
  it here — otherwise the `GET /channels` union keeps surfacing it as
  `source: autojoin, joined: false` and the cic tab never dismisses (#87).

  Canonicalises the incoming channel (RFC 2812 casemapping); stored entries
  are already canonical (`Visitor.last_joined_channels_changeset/2` writes
  them so), so the exact-match reject mirrors the user-side helper. Reloads
  the row by id rather than trusting the (possibly stale) caller-held
  struct. `{:error, :not_found}` when the visitor was reaped mid-request.
  """
  @spec remove_autojoin_channel(Visitor.t(), String.t()) ::
          {:ok, Visitor.t()} | {:error, :not_found | Ecto.Changeset.t()}
  def remove_autojoin_channel(%Visitor{id: id}, channel_name) when is_binary(channel_name) do
    canonical = Grappa.IRC.Identifier.canonical_channel(channel_name)

    case Repo.get(Visitor, id) do
      nil ->
        {:error, :not_found}

      %Visitor{} = visitor ->
        kept = Enum.reject(visitor.last_joined_channels, &(&1 == canonical))
        visitor |> Visitor.last_joined_channels_changeset(kept) |> Repo.update()
    end
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
    Repo.one(by_folded_nick(nick, network_slug))
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
    case Repo.one(by_folded_nick(target_nick, network_slug)) do
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
        # H14 (REV-D 2026-05-22): same concurrent-delete race as
        # commit_password/2 — map StaleEntryError to the spec'd
        # `{:error, :not_found}` return.
        try do
          visitor
          |> Visitor.nick_changeset(new_nick)
          |> Repo.update()
        rescue
          Ecto.StaleEntryError -> {:error, :not_found}
        end
    end
  end

  @doc """
  #126 — visitor `disconnect`: drop the upstream IRC connection but KEEP
  the visitor row + scrollback + the web/auth session (the teardown half
  of the disconnect ⇄ reconnect verb pair). Delegates to the SAME shared
  teardown core (`Session.stop_session/3`) that `Networks.disconnect/2`
  uses for users and that #152's reconnect-with-new-ident will reuse for
  its teardown step. Idempotent — returns `:ok` whether or not a live
  session was registered.

  Persistent-identity surface: the caller (`GrappaWeb.SessionController`)
  gates this to registered (NickServ-identified) visitors; an anon
  visitor's only teardown verb is `quit` (= logout, which stops + purges).
  """
  @spec disconnect_session(Visitor.t(), integer()) :: :ok
  def disconnect_session(%Visitor{id: id}, network_id) when is_integer(network_id) do
    Session.stop_session({:visitor, id}, network_id, "disconnected")
  end

  @doc """
  #126 — visitor `reconnect`: respawn the upstream IRC session for a
  visitor whose connection was previously dropped (the `reconnect` half
  of disconnect ⇄ reconnect). Resolves the visitor's `SessionPlan` and
  runs the shared admission → `Backoff.reset` → spawn dance via
  `Grappa.SpawnOrchestrator.spawn/4` — the SAME respawn core
  `NetworksController` drives for a user `:connected` transition, and the
  seam #152's reconnect-with-new-ident reuses (resolve a CHANGED plan,
  then this same spawn).

  `capacity_input` is built by the caller (the `flow: :visitor_reconnect`
  discriminant + `client_id` + `requesting_subject`), mirroring
  `NetworksController.orchestrate_spawn/4`.

  Returns `{:ok, pid}` on a fresh spawn OR an idempotent
  `:already_started` (a concurrent reconnect, or a session that never
  actually dropped). `{:error, :resolve_failed}` when the plan can't be
  built (orphaned network/servers). `{:error, _}` for an admission
  rejection (`:visitor_cap_exceeded` / `{:network_circuit_open, _}`) or a
  `{:start_failed, _}` (upstream connect refused at `init/1`, or
  `:ignore` because the row vanished mid-flight).
  """
  @spec reconnect_session(Visitor.t(), integer(), Admission.capacity_input()) ::
          {:ok, pid()} | {:error, :resolve_failed | term()}
  def reconnect_session(%Visitor{id: id} = visitor, network_id, capacity_input)
      when is_integer(network_id) and is_map(capacity_input) do
    with {:ok, plan} <- resolve_visitor_plan(visitor) do
      case SpawnOrchestrator.spawn({:visitor, id}, network_id, plan, capacity_input) do
        {:ok, :spawned, pid} -> {:ok, pid}
        {:ok, :already_started, pid} -> {:ok, pid}
        {:ok, :ignored} -> {:error, {:start_failed, :ignore}}
        {:error, _} = err -> err
      end
    end
  end

  @spec resolve_visitor_plan(Visitor.t()) ::
          {:ok, Session.start_opts()} | {:error, :resolve_failed}
  defp resolve_visitor_plan(%Visitor{} = visitor) do
    case SessionPlan.resolve(visitor) do
      {:ok, _} = ok ->
        ok

      {:error, reason} ->
        Logger.warning("visitor reconnect: session plan resolve failed",
          visitor_id: visitor.id,
          error: inspect(reason)
        )

        {:error, :resolve_failed}
    end
  end

  @doc """
  #152 — set a visitor's user-settable IRC identity (`ident` +
  `realname`) and LIVE-APPLY it.

  ident/realname are carried only by the USER command, sent once at IRC
  registration; there is no live verb to change them (a second `USER` is
  rejected 462 ERR_ALREADYREGISTRED). So applying to a live session means
  re-registering the upstream connection: this is the visitor half of the
  #126 disconnect ⇄ reconnect seam, reused exactly (per #152 design + vjt
  ruling A — two thin per-subject wrappers over the shared cores).

  Sequence:

    1. Validate + persist via `Visitor.identity_changeset/2` (tilde-strip
       + shape guard on ident, CR/LF/NUL guard on realname). A bad value
       returns `{:error, changeset}` and NOTHING is persisted or bounced.
    2. If a live `Session.Server` is registered for the visitor, reconnect
       it: `Session.stop_session/3` (graceful QUIT) → `SpawnOrchestrator.spawn/4`.
       `Server.init/1`'s `refresh_plan` re-reads the just-persisted row, so
       the new ident/realname land in the fresh USER line for free — no new
       Session.Server state, no new teardown. Scrollback + last_joined
       survive (DB-backed); 001 re-JOINs from autojoin.
    3. If no live session (parked / orphaned network / never connected),
       persist only — the next spawn reads the new values from the row.

  Returns `{:ok, visitor}` (the persisted row) on success — the reconnect
  is a side effect, and its admission/spawn failures are logged, not
  surfaced (the identity IS saved; the bounce is best-effort, mirroring
  how a cap-blocked reconnect leaves the row updated). Returns
  `{:error, changeset}` on validation failure and `{:error, :not_found}`
  if the row was concurrently deleted.
  """
  @spec update_identity(Visitor.t(), map()) ::
          {:ok, Visitor.t()} | {:error, :not_found | Ecto.Changeset.t()}
  def update_identity(%Visitor{} = visitor, attrs) when is_map(attrs) do
    case visitor |> Visitor.identity_changeset(attrs) |> Repo.update() do
      {:ok, updated} ->
        _ = maybe_reconnect_after_identity(updated)
        {:ok, updated}

      {:error, %Ecto.Changeset{} = cs} ->
        {:error, cs}
    end
  rescue
    # A concurrent `delete/1` between the caller's fetch and this update
    # surfaces as a stale-struct error; report it as :not_found (mirrors
    # rotate_password/2's H14 concurrent-delete handling).
    Ecto.StaleEntryError -> {:error, :not_found}
  end

  # Reconnect the live upstream so the new ident/realname re-register.
  # No-op (returns :ok) when the network is orphaned or no session is
  # live — the persist already happened, and the next spawn reads the
  # row. Failures are logged, never surfaced: the identity is saved
  # regardless of whether the bounce succeeded.
  @spec maybe_reconnect_after_identity(Visitor.t()) :: :ok
  defp maybe_reconnect_after_identity(%Visitor{} = visitor) do
    with {:ok, %Networks.Network{id: network_id}} <-
           Networks.get_network_by_slug(visitor.network_slug),
         pid when is_pid(pid) <- Session.whereis({:visitor, visitor.id}, network_id) do
      :ok = Session.stop_session({:visitor, visitor.id}, network_id, "applying identity change")

      case reconnect_session(visitor, network_id, identity_capacity_input(visitor, network_id)) do
        {:ok, _} ->
          :ok

        {:error, reason} ->
          Logger.warning("visitor identity change: reconnect failed (identity persisted)",
            visitor_id: visitor.id,
            error: inspect(reason)
          )

          :ok
      end
    else
      # Orphaned network row or no live session — nothing to reconnect.
      _ -> :ok
    end
  end

  # Mirror of `GrappaWeb.SessionController.capacity_input/3` for the
  # visitor reconnect flow. `requesting_subject` is the visitor itself so
  # the per-IP cap's self-exclusion keeps the visitor's own live browser
  # session from counting against the cap on this reconnect respawn.
  # `source_ip` is the visitor's stored login IP (the same value login
  # writes to accounts_sessions.ip).
  @spec identity_capacity_input(Visitor.t(), integer()) :: Admission.capacity_input()
  defp identity_capacity_input(%Visitor{id: id, ip: ip}, network_id) do
    %{
      network_id: network_id,
      source_ip: ip,
      flow: :visitor_reconnect,
      requesting_subject: {:visitor, id}
    }
  end

  @doc """
  Anon-only co-terminus delete (W11). If the visitor exists and
  `password_encrypted` is nil, delete the row — CASCADE wipes the
  associated accounts_sessions and messages in a single transaction. Registered visitor (`password_encrypted` set):
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
        # S11 — the anon subject is destroyed here (login case-1 failure /
        # preempt); evict its Backoff entries so the retired UUID leaves no
        # orphan. The registered clause below is a no-op: the identity
        # persists, so its backoff history must survive.
        :ok = Session.Backoff.forget({:visitor, visitor.id})
        :ok

      %Visitor{} ->
        :ok
    end
  end
end
