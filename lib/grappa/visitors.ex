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
      in-session `SET PASSWD` (no +r fires for a password change). #211
      phase 7 — does NOT clear `expires_at`: registration permanence is
      DERIVED from the credentials (`Credentials.visitor_registered?/1`),
      which short-circuits `touch/1` to a no-op, so a registered visitor
      simply stops sliding its TTL (operator-driven deletion is the only
      removal path).
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
  ≥1h cadence per W9). REGISTERED visitors (holding ≥1 NickServ credential
  — `Credentials.visitor_registered?/1`) have no expiry: `touch/1`
  short-circuits to a no-op for them, so their `expires_at` stops sliding
  and the Reaper never sweeps the row. #211 phase 7 — permanence is DERIVED
  from the credentials, NOT a `visitors.expires_at`-nil flag:
  `commit_password/3` no longer clears it, and a legacy pre-phase-7
  permanent row (`expires_at IS NULL`) short-circuits first. Inbound-IRC
  events and idle WebSocket heartbeats do NOT bump the TTL.
  """

  use Boundary,
    top_level?: true,
    deps: [
      Grappa.Accounts,
      # `destroy_visitor/1` announces the bearer death the visitor-row
      # CASCADE causes; nothing in Accounts runs on that path.
      Grappa.Accounts.Revocations,
      Grappa.Admission,
      Grappa.Auth.IdentifierClassifier,
      Grappa.IRC,
      Grappa.LiveIntrospection,
      Grappa.Networks,
      Grappa.Repo,
      Grappa.Session,
      Grappa.SpawnOrchestrator,
      Grappa.Subject,
      Grappa.Themes,
      Grappa.UserSettings,
      # #645 — Login records the client source prefix before it spawns, so a
      # first-time visitor is not held by mode-2 addressing.
      Grappa.Vhosts,
      Grappa.Visitors.Visitor
    ],
    exports: [AdminWire, Login, SessionPlan, Wire]

  import Ecto.Query

  alias Grappa.{Admission, Networks, Repo, Session, SpawnOrchestrator, Themes, UserSettings}
  alias Grappa.Accounts.Revocations
  alias Grappa.Networks.{Credential, Credentials}
  alias Grappa.Visitors.{SessionPlan, Visitor}

  require Logger

  @anon_ttl_seconds 48 * 3600
  @touch_cadence_seconds 3600
  # #363 incognito — the linger window. A fresh incognito visitor is born
  # with this short TTL instead of the 48h anon TTL; `slide_incognito_lingers/1`
  # (driven by the Reaper reconcile) refreshes it to `now + @incognito_linger_seconds`
  # ONLY while a browser socket is connected. Once the last socket drops the TTL
  # is no longer refreshed and elapses ~1h later, and the ordinary `list_expired/0`
  # sweep collects the row with the full CASCADE wipe — reconnect within the
  # window resumes the slide and cancels the deletion.
  @incognito_linger_seconds 3600

  # #363 incognito — the GENTLE upload-expiry default seeded onto a fresh
  # incognito session's own upload-TTL preference (see `create_anon/4`). 3600
  # is the shortest rung of the upload ladder (`@allowed_ttl_seconds` in
  # `GrappaWeb.UploadsController`, self-verified), so an attachment defaults to
  # a 1h life instead of the standard 24h anon default. It is a DEFAULT, not a
  # clamp: the holder can raise it to the 72h ladder cap from the settings
  # drawer and the server does NOT re-limit them (vjt 2026-07-26). Distinct
  # attr from `@incognito_linger_seconds` even though both are 3600 today —
  # session linger and upload expiry are unrelated clocks that must be free to
  # diverge.
  @incognito_upload_ttl_seconds 3600

  @doc """
  Find an existing visitor identity by `(nick, network)`, or provision
  a fresh anon one. The fresh identity is a BARE `%Visitor{}` row
  (`expires_at = now + 48h`, `ip`) plus an anon `(visitor_id, network)`
  Credential carrying the identity (`nick`, `auth_method: :none`).

  #211 phase 7 — the visitor row no longer carries `nick`/`network_slug`;
  identity lives ONLY on the credential. So provision resolves the network
  by slug (needed for the credential FK), resolves an EXISTING identity
  credential-first (`resolve_identity_by_nick/2`, the phase-4c reader), and
  on a miss creates the bare row + anon credential atomically (a credential
  folded-nick collision rolls back the bare row so no orphan identity is
  left behind).

  `ip` is recorded on creation for the per-IP cap (W3) and for operator
  audit. `nil` is acceptable when the caller has no IP (mix-task driven
  provisioning, future internal flows).

  When an existing identity is found and the supplied `ip` differs from
  what's persisted, the row's `:ip` is refreshed via `ip_changeset/2` so
  the admin audit value tracks the holder's current address. `nil`
  supplied with a row carrying a real IP does NOT overwrite — refresh is
  "I have a fresher value," not "forget what you knew."

  `{:error, :network_unconfigured}` when the slug has no `Networks.Network`
  row (a credential can't be bound); `{:error, Ecto.Changeset.t()}` when
  the bare-row insert or anon-credential insert is rejected (e.g. a raced
  folded-nick collision).
  """
  @spec find_or_provision_anon(String.t(), String.t(), String.t() | nil) ::
          {:ok, Visitor.t()} | {:error, :network_unconfigured | Ecto.Changeset.t() | :db_unavailable}
  def find_or_provision_anon(nick, network_slug, ip)
      when is_binary(nick) and is_binary(network_slug) do
    find_or_provision_anon(nick, network_slug, ip, false)
  end

  @doc """
  #363 incognito variant. The `incognito` flag is applied ONLY on FRESH
  provision: a returning identity keeps its existing persistence semantics —
  incognito is a fresh-session choice, not a retroactive conversion that
  would delete data the holder never opted to lose. A fresh incognito row is
  born with the short linger TTL (`@incognito_linger_seconds`) rather than
  the 48h anon TTL; the Reaper reconcile (`slide_incognito_lingers/1`) owns
  it from there. `find_or_provision_anon/3` delegates here with `false`.
  """
  @spec find_or_provision_anon(String.t(), String.t(), String.t() | nil, boolean()) ::
          {:ok, Visitor.t()} | {:error, :network_unconfigured | Ecto.Changeset.t() | :db_unavailable}
  def find_or_provision_anon(nick, network_slug, ip, incognito)
      when is_binary(nick) and is_binary(network_slug) and is_boolean(incognito) do
    case Networks.get_network_by_slug(network_slug) do
      {:ok, %Networks.Network{id: network_id}} ->
        case resolve_identity_by_nick(nick, network_id) do
          %Visitor{} = existing -> maybe_refresh_ip(existing, ip)
          nil -> create_anon(nick, network_id, ip, incognito)
        end

      {:error, :not_found} ->
        {:error, :network_unconfigured}
    end
  end

  defp maybe_refresh_ip(%Visitor{ip: same} = visitor, same), do: {:ok, visitor}
  defp maybe_refresh_ip(%Visitor{} = visitor, nil), do: {:ok, visitor}

  defp maybe_refresh_ip(%Visitor{} = visitor, new_ip) when is_binary(new_ip) do
    # #523 — the returning-visitor login branch (same POST /auth/login door as
    # `create_anon`) rides out a transient SQLITE_BUSY on the IP refresh;
    # sustained saturation degrades to `{:error, :db_unavailable}` → a clean 503
    # (#518). A single UPDATE, so the retry re-runs one idempotent statement.
    Repo.BusyRetry.run(fn ->
      visitor
      |> Visitor.ip_changeset(new_ip)
      |> Repo.update()
    end)
  end

  # #211 phase 7 — a fresh visitor identity is a BARE row (TTL + audit ip)
  # plus an anon `(visitor_id, network)` Credential that OWNS the identity
  # (nick / ident / realname / auth_method). Wrapped in a transaction so a
  # credential folded-nick collision (a concurrent provision of the same
  # nick winning the race after our `resolve_identity_by_nick/2` saw none)
  # rolls back the bare row — no orphan identity-less visitor is left
  # behind. The `(visitor_id, network_id)` + folded-nick partial unique
  # indexes (phase 4b) are the collision guards.
  @spec create_anon(String.t(), pos_integer(), String.t() | nil, boolean()) ::
          {:ok, Visitor.t()} | {:error, Ecto.Changeset.t() | :db_unavailable}
  defp create_anon(nick, network_id, ip, incognito) do
    ttl_seconds = if incognito, do: @incognito_linger_seconds, else: @anon_ttl_seconds
    expires_at = DateTime.add(DateTime.utc_now(), ttl_seconds, :second)

    # #523 — ride out a transient SQLITE_BUSY at the transaction's `BEGIN
    # IMMEDIATE` (where the write-lock is acquired under contention); sustained
    # saturation degrades to `{:error, :db_unavailable}` → a clean 503 (#518) at
    # POST /auth/login provisioning instead of a 500 raise. The retry wraps the
    # WHOLE transaction from OUTSIDE (mirror of `Themes.copy_theme/2`): a busy
    # at BEGIN runs before the closure body, and the connection is only free to
    # retry once the failed transaction has rolled back. The closure is
    # ALL-DB (Visitor insert + credential upsert + settings seed) with NO
    # PubSub/ETS/token side-effect, so a retried transaction is safe to re-run.
    Repo.BusyRetry.run(fn ->
      Repo.immediate_transaction(fn ->
        provision_anon_row(nick, network_id, expires_at, ip, incognito)
      end)
    end)
  end

  # The provisioning transaction body, extracted so `create_anon/4`'s
  # `BusyRetry.run → immediate_transaction` wrapper stays within credo's
  # max-nesting depth. Returns the visitor on success; a folded-nick
  # collision rolls the whole transaction back (throws, never returns).
  defp provision_anon_row(nick, network_id, expires_at, ip, incognito) do
    with {:ok, visitor} <-
           %{expires_at: expires_at, ip: ip, incognito: incognito}
           |> Visitor.create_changeset()
           |> Repo.insert(),
         {:ok, _} <-
           Credentials.upsert_visitor_credential(visitor.id, network_id, %{
             nick: nick,
             sasl_user: nick,
             auth_method: :none
           }),
         {:ok, _} <- seed_incognito_upload_ttl(visitor, incognito) do
      visitor
    else
      {:error, changeset} -> Repo.rollback(changeset)
    end
  end

  # #363 — a fresh incognito session seeds its OWN upload-TTL preference to a
  # gentle 1h default so an attachment does not silently outlive the ephemeral
  # session by the full 24h anon default. Seeded here — the single
  # fresh-provision door, inside the same transaction so it rolls back with the
  # row — and NEVER on an existing-row re-login (incognito is a fresh-session
  # choice, mirroring the `incognito` flag itself). It is a default, not a cap:
  # the holder raises it up to the 72h ladder from the drawer and the server
  # leaves them be (vjt 2026-07-26). Non-incognito provisions leave the pref
  # unset and fall through to the standard 24h upload default.
  @spec seed_incognito_upload_ttl(Visitor.t(), boolean()) ::
          {:ok, term()} | {:error, Ecto.Changeset.t() | :db_unavailable}
  defp seed_incognito_upload_ttl(_, false), do: {:ok, :not_incognito}

  defp seed_incognito_upload_ttl(%Visitor{id: id}, true),
    do: UserSettings.put_upload_ttl_seconds({:visitor, id}, @incognito_upload_ttl_seconds)

  @doc """
  #211 phase 7 — resolve the visitor's `(visitor_id, network_id)`
  Credential. The credential IS the identity source of truth (the visitor
  row is a pure identity/TTL row now), so there is nothing to self-heal
  from — a missing credential is a genuine `{:error, :not_found}` (the
  caller maps it to `:network_unconfigured`-class handling). Provision
  (`find_or_provision_anon/3`) + accretion (`accrete_network/3`) are the
  only credential creators.
  """
  @spec resolve_credential(Visitor.t(), pos_integer()) ::
          {:ok, Credential.t()} | {:error, :not_found}
  def resolve_credential(%Visitor{id: id}, network_id) when is_integer(network_id) do
    Credentials.get_visitor_credential(id, network_id)
  end

  @doc """
  #211 phase 6 — reconcile a visitor's `(visitor_id, network_id)`
  credential to `:connected` after login synchronously spawned its
  session. Login spawns the ANCHOR network via the raw
  `Session.start_session` path (identity proof), which does NOT touch
  `connection_state` — so a visitor who previously PARKED the anchor and
  then re-logs in would land a LIVE session while the DB row stayed
  `:parked` (a DB/live desync, and the next reboot's Bootstrap
  parked-skip would silently drop the just-established session). Logging
  in via the anchor IS a deliberate "bring me back on" — so flip it
  `:connected`. Idempotent (`Networks.connect/1` no-ops on an
  already-`:connected` row); `:parked | :failed → :connected` transitions
  + broadcasts. Best-effort — a missing credential (should not happen
  post-provision) is a no-op.
  """
  @spec mark_anchor_connected(Visitor.t(), pos_integer()) :: :ok
  def mark_anchor_connected(%Visitor{id: id}, network_id) when is_integer(network_id) do
    case Credentials.get_visitor_credential(id, network_id) do
      {:ok, cred} ->
        {:ok, _} = Networks.connect(cred)
        :ok

      {:error, :not_found} ->
        :ok
    end
  end

  @doc """
  Atomically write a NickServ password onto the visitor's
  `(visitor_id, network_id)` Credential (encrypted at rest by Cloak).
  Called from `Grappa.Session.Server` on either trigger: the +r MODE
  observation that confirmed the visitor's nick is identified
  (IDENTIFY/REGISTER rendezvous), or the #131 optimistic on-send commit of
  an in-session `SET PASSWD`.

  #211 phase 7 — the password lives PER-NETWORK on the credential now (the
  `visitors.password_encrypted` scalar is dropped). The `Session.Server`
  callback captures its network in the `Grappa.Visitors.SessionPlan`
  closure, so this is network-explicit. Registration is DERIVED from the
  credentials (`Credentials.visitor_registered?/1` — ≥1 credential with a
  committed secret), NOT a parallel `visitors.expires_at`-nil flag: so
  committing a password does NOT touch the visitor row at all. The Reaper's
  `list_expired/0` excludes registered identities directly (see there);
  identifying on ANY network makes the identity permanent, and unbinding
  the last registered credential makes it anon again — automatically, with
  no flag to drift.
  """
  @spec commit_password(Ecto.UUID.t(), pos_integer(), String.t()) ::
          {:ok, Credential.t()} | {:error, :not_found | Ecto.Changeset.t()}
  def commit_password(visitor_id, network_id, password)
      when is_binary(visitor_id) and is_integer(network_id) and is_binary(password) and
             password != "" do
    Credentials.commit_visitor_password(visitor_id, network_id, password)
  end

  @doc """
  #561 — the `+r`-observed identity commit: writes the confirmed NickServ
  password AND binds the nick held at the identify instant onto the
  `(visitor_id, network_id)` Credential. Called from
  `Grappa.Session.Server`'s `apply_effects/2` on `:visitor_r_observed` (the
  visitor branch) via the injected `visitor_committer` closure.

  Both bindings matter. The password promotes the credential to
  `:nickserv_identify` (see `commit_password/3`). The nick is bound because
  a later VOLUNTARY rename is NOT persisted (#561's echo gate on
  `update_nick/3`), so the credential must carry the nick the visitor last
  IDENTIFIED with — you come back as the nick you authed as. bahamut strips
  `+r` on any genuine nick change, so `nick` is guaranteed the identified
  account, never a forced Guest.

  The password commit is PRIMARY (it is the login secret): a cross-visitor
  folded-nick collision on the SECONDARY nick bind is logged but MUST NOT
  undo the committed password. Returns the password-commit result;
  `{:error, :not_found}` if the credential is gone.
  """
  @spec commit_identity(Ecto.UUID.t(), pos_integer(), String.t(), String.t()) ::
          {:ok, Credential.t()} | {:error, :not_found | Ecto.Changeset.t()}
  def commit_identity(visitor_id, network_id, password, nick)
      when is_binary(visitor_id) and is_integer(network_id) and is_binary(password) and
             password != "" and is_binary(nick) do
    with {:ok, _} = committed <- commit_password(visitor_id, network_id, password) do
      case Credentials.bind_identified_visitor_nick(visitor_id, network_id, nick) do
        {:ok, _} ->
          Logger.info("visitor +r → identified nick bound (#561)",
            visitor_id: visitor_id,
            nick: nick
          )

        {:error, reason} ->
          Logger.warning(
            "visitor +r: password committed but identified-nick bind failed (#561)",
            visitor_id: visitor_id,
            nick: nick,
            reason: inspect(reason)
          )
      end

      committed
    end
  end

  @doc """
  #131 — rotate an ALREADY-identified visitor's NickServ password on the
  `(visitor_id, network_id)` Credential from an in-session `SET PASSWD`
  (optimistic commit-on-send).

  Distinct from `commit_password/3`, which is the `+r`-gated promotion
  verb: `+r` PROVES the nick is identified, so it may safely promote the
  identity to permanent (#211 phase 7 — permanence is DERIVED from the
  credential via `Credentials.visitor_registered?/1`; `expires_at` is
  untouched, NOT cleared to NULL). A `SET PASSWD` carries NO
  such proof — services reject it unless the nick is already
  registered/identified — so an optimistic commit MUST NOT promote. This
  function is therefore IDENTITY-GATED PER-NETWORK: it rotates the password
  only for a credential that is ALREADY identified on this network
  (`password_encrypted` set), and is a no-op (`{:error, :not_identified}`)
  for an anon credential. Without the gate, an anon visitor typing
  `/ns set passwd x` (which services would reject) would silently pin a
  junk password onto the credential.

  #211 phase 7 — password + identify-state are per-network on the
  credential now, so the gate reads the credential (not the retired
  `visitors.password_encrypted` scalar). Does NOT touch `expires_at` (an
  already-identified visitor is already permanent).
  """
  @spec rotate_password(Ecto.UUID.t(), pos_integer(), String.t()) ::
          {:ok, Credential.t()} | {:error, :not_found | :not_identified | Ecto.Changeset.t()}
  def rotate_password(visitor_id, network_id, password)
      when is_binary(visitor_id) and is_integer(network_id) and is_binary(password) and
             password != "" do
    case Credentials.get_visitor_credential(visitor_id, network_id) do
      {:error, :not_found} ->
        {:error, :not_found}

      # Anon credential (never identified on this network): SET PASSWD can't
      # apply at the service, and an optimistic commit must not promote.
      {:ok, %Credential{password_encrypted: nil}} ->
        {:error, :not_identified}

      {:ok, %Credential{}} ->
        Credentials.commit_visitor_password(visitor_id, network_id, password)
    end
  end

  @doc """
  Slide `expires_at` forward on user-initiated REST/WS verbs. Anon
  visitors slide to now + 48h; REGISTERED visitors (hold ≥1 NickServ
  credential) are no-ops — they don't expire. No-op if the resulting bump
  on an anon row would extend by less than 1h (`@touch_cadence_seconds`) —
  keeps the per-request DB-write cost negligible under sustained traffic.

  #211 phase 7 — registration is DERIVED from the credentials
  (`Credentials.visitor_registered?/1`), not a `visitors.expires_at`-nil
  flag. `commit_password/3` no longer clears `expires_at`, so a
  post-phase-7 registered visitor still carries an anon-shaped TTL value —
  the registered check (not the nil check) is what makes touch a no-op for
  it. A legacy pre-phase-7 permanent row (`expires_at IS NULL`) short-
  circuits first.
  """
  @spec touch(Ecto.UUID.t()) ::
          {:ok, Visitor.t()} | {:error, :not_found | :expired}
  def touch(visitor_id) when is_binary(visitor_id) do
    case Repo.get(Visitor, visitor_id) do
      nil ->
        {:error, :not_found}

      %Visitor{expires_at: nil} = visitor ->
        # Legacy pre-phase-7 permanent row — no expiry, no-op.
        {:ok, visitor}

      %Visitor{expires_at: exp} = visitor ->
        cond do
          # Registered (derived) — never expires; no TTL bump.
          Credentials.visitor_registered?(visitor.id) ->
            {:ok, visitor}

          # #363 incognito — the Reaper reconcile (`slide_incognito_lingers/1`)
          # owns the linger TTL while a browser socket is connected; touch must
          # NOT slide it to +48h or the 1h linger is defeated. Still gate reads
          # once the window has elapsed (mirrors the anon `:expired` semantics).
          # Extracted to keep this cond ≤2 levels deep (Credo Refactor.Nesting).
          visitor.incognito ->
            incognito_read_gate(visitor)

          # Anon + still-live — slide the TTL (cadence-gated).
          DateTime.compare(exp, DateTime.utc_now()) == :gt ->
            maybe_bump(visitor)

          # Anon + already elapsed — gate read access; the Reaper deletes.
          # Without this gate `maybe_bump/1` would resurrect an expired row
          # 48h into the future on the next REST/WS verb.
          true ->
            {:error, :expired}
        end
    end
  end

  # #363 — an incognito visitor's TTL is owned by the Reaper reconcile
  # (`slide_incognito_lingers/1`) while a browser socket is connected; touch
  # never slides it. It still gates reads once the linger has elapsed (mirrors
  # the anon `:expired` semantic — an elapsed row is dead to reads until the
  # Reaper collects it). Extracted from `touch/1`'s cond so the nesting stays
  # ≤2 deep.
  @spec incognito_read_gate(Visitor.t()) :: {:ok, Visitor.t()} | {:error, :expired}
  defp incognito_read_gate(%Visitor{expires_at: exp} = visitor) do
    if DateTime.compare(exp, DateTime.utc_now()) == :gt,
      do: {:ok, visitor},
      else: {:error, :expired}
  end

  # #211 phase 7 — reached only from `touch/1` AFTER the `expires_at: nil`
  # (permanent/registered) branch, so the row here is always anon
  # (non-nil `expires_at`). The prior `password_encrypted: nil` guard was
  # a redundant second check on the same "is this anon" question — the TTL
  # axis is the single discriminator now.
  defp maybe_bump(%Visitor{} = visitor) do
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
  Count visitors active for the given `ip`. A visitor is "active" if it is
  REGISTERED (holds ≥1 NickServ credential — derived, never expires) OR
  anon-but-not-yet-elapsed (`expires_at > now()`). Legacy pre-phase-7
  registered rows carry `expires_at IS NULL` and are also active. Per-IP
  cap (W3) enforcement primitive — composed by the Login orchestrator
  before `find_or_provision_anon/3`.
  """
  @spec count_active_for_ip(String.t()) :: non_neg_integer()
  def count_active_for_ip(ip) when is_binary(ip) do
    now = DateTime.utc_now()

    query =
      from(v in Visitor,
        where:
          v.ip == ^ip and
            (is_nil(v.expires_at) or v.expires_at > ^now or
               v.id in subquery(registered_ids_subquery()))
      )

    Repo.aggregate(query, :count, :id)
  end

  @doc """
  All active visitors — REGISTERED (holds ≥1 NickServ credential; derived,
  never expires) OR anon-but-not-yet-elapsed (`expires_at > now()`) OR
  legacy-permanent (`expires_at IS NULL`, pre-phase-7 rows). Used by
  `Grappa.Bootstrap` to enumerate sessions to respawn at app start.
  Registered identities must always respawn; otherwise an operator bounce
  silently destroys their session presence.

  #211 phase 7 — registration is DERIVED from the credentials (the
  `registered_ids_subquery/0` EXISTS), not a `visitors.expires_at`-nil flag
  (which would drift on credential unbind). `commit_password/3` no longer
  clears `expires_at`, so a post-phase-7 registered visitor keeps its anon
  TTL value — but the registered-subquery keeps it active regardless.
  """
  @spec list_active() :: [Visitor.t()]
  def list_active do
    now = DateTime.utc_now()

    query =
      from(v in Visitor,
        where:
          is_nil(v.expires_at) or v.expires_at > ^now or
            v.id in subquery(registered_ids_subquery())
      )

    Repo.all(query)
  end

  # #211 phase 7 — the DERIVED registration predicate: visitor_ids holding
  # ≥1 credential with a committed NickServ secret. The single source of
  # truth for "is this identity permanent", replacing the retired
  # `visitors.expires_at`-nil flag. Composed into `list_active/0`,
  # `list_expired/0`, and `count_active_for_ip/1` so all three axes agree
  # by construction (no parallel flag to drift).
  #
  # CRITICAL — the `not is_nil(c.visitor_id)` guard is load-bearing, NOT
  # redundant with the visitor-side XOR. The subject-XOR `network_credentials`
  # table holds USER credentials too (`visitor_id IS NULL`), and a user with
  # a stored password (the steady state — nickserv_identify / sasl /
  # server_pass all set `password_encrypted`) would otherwise contribute a
  # NULL into this set. `list_expired/0` consumes it as `v.id NOT IN (…)`,
  # and SQL `x NOT IN (…, NULL)` evaluates to NULL (never TRUE) for EVERY
  # `x` — so a single user password would silently zero out the Reaper,
  # leaking every expired anon visitor row forever. Scoping to visitor
  # credentials (mirrors the phase-4b partial index
  # `WHERE visitor_id IS NOT NULL`) removes the NULLs at the source, keeping
  # both the positive-`IN` callers (list_active/count_active_for_ip) and the
  # `NOT IN` caller (list_expired) correct.
  @spec registered_ids_subquery() :: Ecto.Query.t()
  defp registered_ids_subquery do
    from(c in Credential,
      where: not is_nil(c.visitor_id) and not is_nil(c.password_encrypted),
      select: c.visitor_id
    )
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
  Every visitor row joined to its per-network credentials + live
  `Grappa.Session.Server` introspection.

  #211 phase 7 — a visitor is MULTI-network (accretion), and identity
  (nick) lives per-network on the credential, not on the row. So this
  returns one entry per visitor carrying its credential list, each
  credential paired with its live introspection (or `nil` when no pid is
  registered for `{:visitor, v.id} × credential.network_id`). The `nil` IS
  the U-0 honesty signal — admin console renders it prominently so the
  operator sees "DB intent exists, BEAM doesn't" rather than a quietly
  empty row.

  A visitor with NO credentials (a fresh row the boot reconcile hasn't
  touched) yields an empty per-network list — surfaced so the operator
  sees the credential-less identity rather than it vanishing.

  One DB roundtrip for the visitor list + one per visitor for its
  credentials; N registry lookups (one per credential) at O(1) each. Each
  lookup also fetches `joined_channels` via a `GenServer.call` with a
  250ms-per-pid timeout — worst-case latency is `O(N × 250ms)` when every
  pid is stuck, gracefully degraded.
  """
  @spec list_all_with_live_state() ::
          [
            {Visitor.t(), [{Credential.t(), Grappa.LiveIntrospection.SessionEntry.t() | nil}]}
          ]
  def list_all_with_live_state do
    for v <- list_all() do
      per_network =
        for cred <- Credentials.list_visitor_credentials(v.id) do
          live = Grappa.LiveIntrospection.lookup_session({:visitor, v.id}, cred.network_id)
          {cred, live}
        end

      {v, per_network}
    end
  end

  @doc """
  All ANON visitors past their TTL — `expires_at <= now()` AND NOT
  registered. Used by `Grappa.Visitors.Reaper` to enumerate rows due for
  deletion.

  #211 phase 7 — registration is DERIVED from the credentials, so the
  reap-exclusion is `v.id NOT IN (visitor_ids holding a NickServ
  credential)` rather than the retired `expires_at IS NULL` flag. A visitor
  who identified on any network is excluded from expiry regardless of its
  `expires_at` value (which `commit_password/3` no longer clears). The
  `expires_at IS NOT NULL` guard is retained: a legacy pre-phase-7
  permanent row carries `expires_at = NULL` and must never be swept.
  """
  @spec list_expired() :: [Visitor.t()]
  def list_expired do
    now = DateTime.utc_now()

    query =
      from(v in Visitor,
        where:
          not is_nil(v.expires_at) and v.expires_at <= ^now and
            v.id not in subquery(registered_ids_subquery())
      )

    Repo.all(query)
  end

  @doc """
  #363 — the Reaper reconcile primitive. Slides the linger TTL of every
  incognito visitor in `connected_visitor_ids` (the set holding a live
  browser socket, computed by `Grappa.Visitors.Reaper` from
  `Grappa.WSPresence`) forward to `now + @incognito_linger_seconds`.

  Disconnected incognito visitors are deliberately NOT refreshed: their TTL
  winds down and `list_expired/0` collects them ~1h after the last socket
  dropped, with the full FK ON DELETE CASCADE wipe. A reconnect re-populates
  the connected set, so the next reconcile slides the TTL back out — the
  deletion is cancelled with no explicit "reconnected" event.

  Set-based `update_all`, filtered to `incognito == true` so a non-incognito
  id in the list is a no-op. This deliberately BYPASSES the
  `touch_changeset/2` monotonicity guard (it is a plain UPDATE, not a
  changeset): correct here, because a while-connected reconcile only ever
  moves the TTL forward. Returns the number of rows slid. An empty
  connected set slides nothing.
  """
  @spec slide_incognito_lingers([Ecto.UUID.t()]) :: non_neg_integer()
  def slide_incognito_lingers(connected_visitor_ids) when is_list(connected_visitor_ids) do
    now = DateTime.utc_now()
    target = DateTime.add(now, @incognito_linger_seconds, :second)

    query =
      from(v in Visitor,
        where: v.incognito == true and v.id in ^connected_visitor_ids
      )

    {count, _} = Repo.update_all(query, set: [expires_at: target, updated_at: now])

    count
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
          user: Grappa.Subject.label({:visitor, visitor.id}),
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
  Delete a visitor row. Before the hard delete, the visitor's PUBLISHED themes
  re-home to the system user (#299) so gallery contributions survive; the
  DB-level FK ON DELETE CASCADE on `themes` (the private ones), `messages`,
  `network_credentials` and `sessions` wipes the rest in the same transaction.

  This is the single reap + admin delete choke point (`Visitors.Reaper`,
  `Operator.delete_visitor`, `AccountDeletion`), so it also evicts the
  subject's `Session.Backoff` ETS entries (S11): the destroyed UUID never
  logs in again, so its per-network failure counters would otherwise
  orphan for the node lifetime.
  """
  @spec delete(Ecto.UUID.t()) :: :ok | {:error, :not_found | :db_unavailable}
  def delete(visitor_id) when is_binary(visitor_id) do
    case Repo.get(Visitor, visitor_id) do
      nil -> {:error, :not_found}
      # #590 — `destroy_visitor/1` degrades a sustained SQLITE_BUSY to
      # `{:error, :db_unavailable}`; propagate it so each caller maps its
      # terminal (reaper DROP, operator/admin 503, account-deletion 503).
      visitor -> destroy_visitor(visitor)
    end
  end

  # The single hard-delete mechanic shared by delete/1 (reap + operator) and
  # purge_if_anon/1 (anon co-terminus). Re-homes the visitor's PUBLISHED themes
  # to the system user (survive as gallery contributions, #299) BEFORE the
  # delete, so the visitor_id ON DELETE CASCADE then wipes only the private
  # themes + credentials + messages + sessions.
  #
  # Deliberately NOT wrapped in a Repo.transaction: re-home's leading SELECT
  # would start a DEFERRED (read) sqlite transaction that then upgrades to a
  # write on the DELETE — and that read→write upgrade throws SQLITE_BUSY under
  # concurrent writers (integration CI hit exactly this: "Database busy" on
  # DELETE FROM visitors). Sequential single-statement writes each take the
  # write lock immediately (busy_timeout waits, never upgrade-fails) — the same
  # shape as the pre-#299 lone `Repo.delete`. Atomicity isn't needed: re-home
  # is idempotent (it only matches `visitor_id = ? AND published`, and re-homed
  # rows have `visitor_id = NULL`), so a crash between the two steps self-heals
  # on the next reap/retry (re-home finds nothing, delete proceeds). Backoff
  # eviction is ETS, after the DB writes.
  #
  # #590 — the whole (re-home + delete) is a BACKGROUND write (reap / operator
  # / account-deletion / anon-cleanup, no HTTP client waiting mid-write). Ride
  # out a transient SQLITE_BUSY via the shared engine and degrade sustained
  # saturation to `{:error, :db_unavailable}` rather than letting the raise
  # escape and crash the reaper GenServer. `BusyRetry.run/1` is NOT a
  # transaction — it re-runs the (idempotent) op on a raise — so the "sequential
  # single-statement writes, self-heals" property above is preserved: a retry
  # re-homes (no-op the second time) then re-deletes. The atom is returned; each
  # public verb maps its own terminal (`delete/1` propagates → reaper DROP /
  # operator + account 503; `purge_if_anon/1` absorbs → best-effort cleanup).
  @spec destroy_visitor(Visitor.t()) :: :ok | {:error, :db_unavailable}
  defp destroy_visitor(%Visitor{} = visitor) do
    outcome =
      Repo.BusyRetry.run(fn ->
        Themes.rehome_visitor_published_to_system(visitor.id)
        {:ok, _} = Repo.delete(visitor)
        {:ok, :deleted}
      end)

    case outcome do
      {:ok, :deleted} ->
        :ok = Session.Backoff.forget({:visitor, visitor.id})
        # The `sessions.visitor_id ON DELETE CASCADE` FK kills every bearer
        # of this visitor without any Accounts codepath running, so the
        # socket teardown is announced from the deleting side. This one call
        # covers the admin DELETE, `bin/grappa delete-visitor`, the 60s
        # Reaper sweep, self-delete and the anon co-terminus purge: they all
        # funnel through here.
        :ok = Revocations.announce({:visitor, visitor.id})

      {:error, :db_unavailable} = err ->
        err
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
  #211 phase 7 — the `Retry-After` hint on an `:anon_collision`: resolve
  the visitor identity that currently holds `nick` on `network_id`
  (credential-first, the same reader login uses) and return its
  `expires_at`, or `nil` when no identity holds the nick (no hint to give).

  Replaces the pre-phase-7 `get_by_nick_and_network/2` row lookup (which
  queried the dropped `visitors.network_slug` scalar). Used by
  `GrappaWeb.AuthController` without exposing `Repo` to the web boundary.
  """
  @spec collision_expires_at(String.t(), pos_integer()) :: DateTime.t() | nil
  def collision_expires_at(nick, network_id)
      when is_binary(nick) and is_integer(network_id) do
    case resolve_identity_by_nick(nick, network_id) do
      %Visitor{expires_at: expires_at} -> expires_at
      nil -> nil
    end
  end

  @doc """
  #211 phase 4c — PER-NETWORK visitor rejoin list, read from the
  `(visitor_id, network_id)` Credential.

  A multi-network visitor has a distinct channel set per network; the
  `GET /channels` sidebar (network-scoped by the request) reads THIS
  network's set from its credential — NOT the single
  `visitors.last_joined_channels` scalar (which is write-dead as of phase
  4c and dropped at phase 7). No credential on this network (the visitor
  hasn't attached / joined there) → empty list.
  """
  @spec list_autojoin_channels(Visitor.t(), pos_integer()) :: [String.t()]
  def list_autojoin_channels(%Visitor{id: id}, network_id) when is_integer(network_id) do
    case Credentials.get_visitor_credential(id, network_id) do
      {:ok, %Credential{last_joined_channels: channels}} when is_list(channels) -> channels
      {:error, :not_found} -> []
    end
  end

  @doc """
  #211 phase 4c — PER-NETWORK visitor `last_joined_channels` write, keyed
  on `(visitor_id, network_id)`.

  A multi-network visitor (post-accretion) has one credential per network;
  each live `Session.Server` must persist ITS network's channel snapshot
  to ITS credential — NOT the single `visitors.last_joined_channels`
  scalar, which two concurrent sessions (network A + network B) would
  clobber. `Session.Server`'s visitor `last_joined_persister` calls here
  with the network it was spawned for. Delegates to the shared
  `Credentials.update_visitor_last_joined_channels/3` (the per-network
  credential writer — mirror of the user path). The `visitors`-scalar
  column is write-dead as of phase 4c and drops entirely at phase 7.
  Returns `:ok` or `{:error, :not_found}` (the credential was unbound
  mid-flight — race tolerated).
  """
  @spec update_last_joined_channels(Ecto.UUID.t(), pos_integer(), [String.t()]) ::
          :ok | {:error, :not_found | Ecto.Changeset.t()}
  def update_last_joined_channels(visitor_id, network_id, channels)
      when is_binary(visitor_id) and is_integer(network_id) and is_list(channels) do
    Credentials.update_visitor_last_joined_channels(visitor_id, network_id, channels)
  end

  @doc """
  #211 phase 4c — PER-NETWORK visitor "dismiss channel": remove
  `channel_name` from the `(visitor_id, network_id)` Credential's
  `last_joined_channels` rejoin list.

  A multi-network visitor's rejoin list is per-network on the credential,
  so the cic dismiss path (network-scoped by the request) removes from
  THIS network's credential — NOT the single `visitors.last_joined_channels`
  scalar (write-dead as of phase 4c, dropped at phase 7). Delegates to the
  shared `Credentials.remove_visitor_last_joined_channel/3`.
  `{:ok, credential}` or `{:error, :not_found}` (no credential on this
  network).
  """
  @spec remove_autojoin_channel(Visitor.t(), pos_integer(), String.t()) ::
          {:ok, Credential.t()} | {:error, :not_found | Ecto.Changeset.t()}
  def remove_autojoin_channel(%Visitor{id: id}, network_id, channel_name)
      when is_integer(network_id) and is_binary(channel_name) do
    Credentials.remove_visitor_last_joined_channel(id, network_id, channel_name)
  end

  @doc """
  #211 phase 4c — credential-first VISITOR identity resolution: which
  synthetic visitor identity owns `nick` (ASCII-folded, #121/#525) on `network_id`?

  Resolves via the visitor's `(fold(nick), network_id)` **Credential**
  (`Credentials.fetch_visitor_credential_by_nick/2`) → its `visitor_id` →
  the `%Visitor{}` row. #211 phase 7 — this is now the ONLY visitor
  identity reader (the `visitors.nick`/`network_slug` scalar row lookup is
  gone): identity is keyed on the Credential, so a visitor whose
  credentials span multiple networks resolves to ONE identity from any of
  them. Returns the `%Visitor{}` or `nil` (no credential holds the nick on
  the network → the caller provisions).

  A credential whose `visitor_id` FK is dangling (the visitor row was
  reaped between the credential read and the visitor load — should not
  happen, the FK is `:restrict`) surfaces as `nil` so login provisions
  cleanly rather than crashing.
  """
  @spec resolve_identity_by_nick(String.t(), pos_integer()) :: Visitor.t() | nil
  def resolve_identity_by_nick(nick, network_id)
      when is_binary(nick) and is_integer(network_id) do
    case Credentials.fetch_visitor_credential_by_nick(nick, network_id) do
      {:ok, %Credential{visitor_id: visitor_id}} when is_binary(visitor_id) ->
        Repo.get(Visitor, visitor_id)

      {:error, :not_found} ->
        nil
    end
  end

  @doc """
  Visitor-side NICK rename pre-check (V9, narrowed by #828). Returns
  `true` if a DIFFERENT visitor identity holds `target_nick` on
  `network_id` under an IDENTIFIED credential; the caller surfaces that
  as 409 nick_in_use BEFORE sending NICK upstream. False if the slot is
  free, if the only occupant IS the visitor itself (idempotent rename to
  current nick), or if the occupant is ANON.

  #828 — the ANON exemption is the whole point. This is a query over the
  local credential registry: it answers "is this nick recorded against
  some visitor row", NOT "is this nick in use on the network right now".
  A visitor who connected once and left keeps its ANON row until the
  reaper collects it, and pre-#828 that dead row refused the nick to
  everyone else forever — observed in production on Azzurra
  (2026-08-04), a nick free upstream that grappa would not hand out. The
  only authority on wire availability is the ircd, which already answers
  with `433` (classified `:nick_in_use` in `Visitors.Login`, routed to
  `$server` post-registration), so the ANON pre-check bought nothing on
  the taken case and lied on the free one.

  An IDENTIFIED credential is a different question and keeps its
  refusal: there the nick is the LOGIN KEY (#561 — bound at the proven
  `+r`, held against a services-forced Guest), so letting another
  visitor take it is an identity problem, not a wire-availability one.

  #211 phase 7 — folded lookup on the `(fold(nick), network_id)`
  credential (the same reader login uses), NOT the retired
  `visitors.(nick, network_slug)` row index.
  """
  @spec nick_held_by_identified?(Ecto.UUID.t(), String.t(), pos_integer()) :: boolean()
  def nick_held_by_identified?(visitor_id, target_nick, network_id)
      when is_binary(visitor_id) and is_binary(target_nick) and is_integer(network_id) do
    case Credentials.fetch_visitor_credential_by_nick(target_nick, network_id) do
      {:error, :not_found} -> false
      {:ok, %Credential{visitor_id: ^visitor_id}} -> false
      {:ok, %Credential{auth_method: :none}} -> false
      {:ok, %Credential{}} -> true
    end
  end

  @doc """
  Rotate a visitor's nick on its `(visitor_id, network_id)` Credential
  after upstream confirmed the rename via NICK self-echo (V9,
  visitor-parity cluster, 2026-05-15). Called from
  `Grappa.Session.Server`'s `apply_effects/2` (private) on the
  `{:visitor_nick_changed, new_nick}` effect emitted by EventRouter
  when `state.subject == {:visitor, _}` and `old_nick == state.nick`.

  #211 phase 7 — the nick lives PER-NETWORK on the credential now (the
  `visitors.nick` scalar is dropped). The `Session.Server` callback
  captures its network in the `Grappa.Visitors.SessionPlan` closure, so
  this is network-explicit. The credential-side folded-nick UNIQUE index
  (phase 4b) catches concurrent collisions (two visitors racing for the
  same nick on the same network) — the controller-boundary
  `nick_held_by_identified?/3` pre-check is the fast path for an
  identified holder (#828 — an ANON holder no longer refuses, so this
  constraint is what a collision with a stale ANON row hits); this is the
  second line of defense.

  #561 — the echo persist is GATED downstream: it rotates the nick only
  while the credential is ANON (`auth_method: :none`). An IDENTIFIED
  credential's nick is its login key and returns `{:ok, :held_identified}`
  (no write) — see
  `Grappa.Networks.Credentials.update_visitor_credential_nick/3`. The
  identified nick is bound at the proven identify (`+r`) via
  `commit_identity/4`, not on the wire echo.

  `{:error, :not_found}` on a reaped row (terminal — Reaper got the
  credential between `send_nick` and the upstream echo). Logged + dropped
  at the call site.
  """
  @spec update_nick(Ecto.UUID.t(), pos_integer(), String.t()) ::
          {:ok, Credential.t() | :held_identified} | {:error, :not_found | Ecto.Changeset.t()}
  def update_nick(visitor_id, network_id, new_nick)
      when is_binary(visitor_id) and is_integer(network_id) and is_binary(new_nick) do
    Credentials.update_visitor_credential_nick(visitor_id, network_id, new_nick)
  end

  # #211 phase 6 — the #126 `disconnect_session/2` + `reconnect_session/3`
  # public verbs were REMOVED with the retired `POST
  # /session/{disconnect,reconnect}` routes. Visitors now park/reconnect
  # each network via the subject-agnostic `PATCH /networks/:network_id`
  # (`Networks.disconnect/2` / `connect/1` + the controller's
  # #211 phase 6 — the #126 `disconnect_session/2` + `reconnect_session/3`
  # public verbs were REMOVED with the retired `POST
  # /session/{disconnect,reconnect}` routes. Visitors now park/reconnect
  # each network via the subject-agnostic `PATCH /networks/:network_id`
  # (`Networks.disconnect/2` / `connect/1` +
  # `GrappaWeb.NetworkSpawn.orchestrate/4`), exactly as users do — teardown is
  # `Session.stop_session/3` (the shared core those verbs already wrapped).
  # #211 phase 7 — the visitor-only `PATCH /me/identity` live-apply
  # (`update_identity/2` + `maybe_reconnect_after_identity/1` +
  # `resolve_visitor_plan/1`) was RETIRED: visitor identity editing moved
  # onto the per-network door `PATCH /networks/:id/identity`
  # (`NetworksController.identity`, subject-agnostic), which owns its own
  # live-apply bounce via the web-layer `SpawnOrchestrator.reconnect/5`
  # wrapper. `SessionPlan.resolve/2` (network-explicit) is the only
  # resolver now.

  @doc """
  #211 phase 4c — ACCRETION: attach an ADDITIONAL network to an
  already-authenticated visitor identity, then spawn its upstream session.

  The genuinely-new multi-network capability (F7). A registered visitor
  authenticated on network A adds network B **while authenticated**: this
  attaches a NEW `(visitor_id, network_B)` Credential to the EXISTING
  synthetic identity (NOT a new visitor row) and spawns B via the SAME
  `SpawnOrchestrator.spawn/4` core that reconnect drives. The identity is
  ONE `%Visitor{}` spanning both networks; B carries the identity's nick
  (F4 per-network nick — B starts on the identity's canonical nick; a
  later per-network rename is `update_nick` scoped to B's credential).

  Gates, in order:

    1. `slug` must be `visitor_enabled` (the runtime allowlist — you cannot
       accrete a non-enabled network) → `{:error, :network_not_visitor_enabled}`
       / `{:error, :network_unconfigured}`.
    2. The visitor must not ALREADY hold a credential on that network
       (idempotent guard) → `{:error, :already_attached}` so a
       double-accrete is a clean 409, not a silent re-spawn.

  B starts ANON on its NickServ (`auth_method: :none`) — the visitor may
  not be registered on B; if they identify, B's `+r` observer commits B's
  secret exactly as initial registration does (the credential is the proof,
  per-network). `source_ip` is the caller's client IP (for the per-IP cap +
  audit); the capacity_input is assembled internally once the target
  network is resolved (unlike `reconnect_session/3`, the caller can't
  pre-build it — the network slug is arbitrary request input, not the
  visitor's pinned network).

  Returns `{:ok, pid}` on spawn (or idempotent `:already_started`),
  `{:error, :network_not_visitor_enabled | :network_unconfigured |
  :already_attached | :resolve_failed}`, or an admission/`{:start_failed,
  _}` error from the shared spawn.
  """
  @spec accrete_network(Visitor.t(), String.t(), String.t() | nil) ::
          {:ok, pid()}
          | {:error,
             :network_not_visitor_enabled
             | :network_unconfigured
             | :already_attached
             | :resolve_failed
             | term()}
  def accrete_network(%Visitor{} = visitor, slug, source_ip)
      when is_binary(slug) and (is_binary(source_ip) or is_nil(source_ip)) do
    with {:ok, network} <- Networks.fetch_accretable_network(slug),
         :ok <- ensure_not_attached(visitor, network),
         {:ok, _} <- attach_credential(visitor, network),
         {:ok, plan} <- resolve_accreted_plan(visitor, network) do
      capacity_input = accretion_capacity_input(visitor, network.id, source_ip)

      case SpawnOrchestrator.spawn({:visitor, visitor.id}, network.id, plan, capacity_input) do
        {:ok, :spawned, pid} -> {:ok, pid}
        {:ok, :already_started, pid} -> {:ok, pid}
        {:ok, :ignored} -> {:error, {:start_failed, :ignore}}
        {:error, _} = err -> err
      end
    end
  end

  @doc """
  #211 phase 6 (ruling C) — AUTO-CONNECT the visitor's `visitor_autoconnect`
  set. Called ASYNC after a successful login (the sync anchor network is
  already live); attaches + spawns each autoconnect network the identity
  isn't already on. Zero-friction multi-network from first login, no
  picker, no extra login step.

  Reuses `accrete_network/3` per network, so the semantics fall out for
  free:

    * network with NO credential → attach + spawn (new autoconnect net);
    * network with a LIVE credential (the anchor, or a re-login
      reconnect) → `:already_attached` → skipped (idempotent);
    * network with a PARKED credential → `:already_attached` → skipped →
      **parked networks stay parked** across a re-login (ruling D
      persistence — autoconnect never un-parks a deliberate disconnect).

  Best-effort per network: a single network's failure (cap, circuit,
  upstream) is logged + skipped, never aborting the rest — a partial
  autoconnect is better than none. The `:already_attached` skip is a
  normal outcome, not logged as an error. Returns `:ok` unconditionally
  (fire-and-forget; the caller runs it in a supervised Task).

  `source_ip` threads the login IP for the per-IP cap (each spawn is a
  fresh `:login_fresh` dial). `anchor_id` is the network login already
  connected synchronously — excluded so it isn't redundantly re-accreted
  (it would `:already_attached` anyway, but skipping is cheaper + quieter).
  """
  @spec autoconnect(Visitor.t(), pos_integer(), String.t() | nil) :: :ok
  def autoconnect(%Visitor{} = visitor, anchor_id, source_ip)
      when is_integer(anchor_id) and (is_binary(source_ip) or is_nil(source_ip)) do
    Networks.list_visitor_autoconnect()
    |> Enum.reject(fn net -> net.id == anchor_id or not net.visitor_enabled end)
    |> Enum.each(fn net -> autoconnect_one(visitor, net, source_ip) end)
  end

  @spec autoconnect_one(Visitor.t(), Networks.Network.t(), String.t() | nil) :: :ok
  defp autoconnect_one(%Visitor{} = visitor, %Networks.Network{slug: slug}, source_ip) do
    case accrete_network(visitor, slug, source_ip) do
      {:ok, _} ->
        :ok

      {:error, :already_attached} ->
        # Normal: the anchor, a re-login reconnect, or a PARKED network
        # the visitor deliberately disconnected — autoconnect leaves it be.
        :ok

      {:error, reason} ->
        Logger.warning("visitor autoconnect: network skipped",
          visitor_id: visitor.id,
          network: slug,
          error: inspect(reason)
        )

        :ok
    end
  end

  # Accretion dials a NEW upstream, so it uses the `:login_fresh` flow (a
  # genuinely new connection, gated by the network-total + circuit caps) —
  # NOT `:visitor_reconnect` (which is for restoring a dropped session).
  # `requesting_subject` is the visitor itself so the per-IP cap's
  # self-exclusion keeps the visitor's own live browser session from
  # counting against the cap on this spawn.
  @spec accretion_capacity_input(Visitor.t(), pos_integer(), String.t() | nil) ::
          Admission.capacity_input()
  defp accretion_capacity_input(%Visitor{id: id}, network_id, source_ip) do
    %{
      network_id: network_id,
      source_ip: source_ip,
      flow: :login_fresh,
      requesting_subject: {:visitor, id}
    }
  end

  # Idempotency guard: refuse a second accrete of a network the identity
  # already holds a credential for, so a double-attach is a clean
  # `:already_attached` rather than a silent re-spawn.
  @spec ensure_not_attached(Visitor.t(), Networks.Network.t()) ::
          :ok | {:error, :already_attached}
  defp ensure_not_attached(%Visitor{id: id}, %Networks.Network{id: network_id}) do
    case Credentials.get_visitor_credential(id, network_id) do
      {:error, :not_found} -> :ok
      {:ok, %Credential{}} -> {:error, :already_attached}
    end
  end

  # Attach the accreted credential: the identity's nick/ident/realname on
  # the new network, ANON (`auth_method: :none`) — B is a fresh upstream
  # the visitor has not yet identified on. Goes through the SAME shared
  # `upsert_visitor_credential/3` choke point as provision + reconcile (one
  # write path). The credential-side folded-nick unique index (phase 4b)
  # guards a cross-visitor nick collision on B → surfaces as a changeset
  # error, mapped to `:already_attached`-class handling by the caller's
  # `{:error, _}` propagation.
  #
  # #211 phase 7 — the identity's nick/ident/realname live on the
  # credential now (the `visitors.nick` scalar is dropped), so seed B from
  # a REPRESENTATIVE existing credential (the visitor is authenticated on
  # ≥1 network to reach accretion, so one always exists). No representative
  # → `:no_identity` (should not happen post-auth) surfaces as a
  # `:resolve_failed`-class abort via the caller's `with`.
  @spec attach_credential(Visitor.t(), Networks.Network.t()) ::
          {:ok, Credential.t()} | {:error, :no_identity | :db_unavailable | Ecto.Changeset.t()}
  defp attach_credential(%Visitor{id: id}, %Networks.Network{id: network_id}) do
    case Credentials.representative_visitor_credential(id) do
      {:ok, %Credential{nick: nick, ident: ident, realname: realname}} ->
        # #523 — ride out a transient SQLITE_BUSY on the accretion write;
        # sustained saturation degrades to `{:error, :db_unavailable}` → a clean
        # 503 (#518) at POST /session accretion instead of a 500 raise.
        Repo.BusyRetry.run(fn ->
          Credentials.upsert_visitor_credential(id, network_id, %{
            nick: nick,
            ident: ident,
            realname: realname,
            sasl_user: nick,
            auth_method: :none,
            last_joined_channels: []
          })
        end)

      {:error, :not_found} ->
        {:error, :no_identity}
    end
  end

  @spec resolve_accreted_plan(Visitor.t(), Networks.Network.t()) ::
          {:ok, Session.start_opts()} | {:error, :resolve_failed}
  defp resolve_accreted_plan(%Visitor{} = visitor, %Networks.Network{} = network) do
    case SessionPlan.resolve(visitor, network) do
      {:ok, _} = ok ->
        ok

      {:error, reason} ->
        Logger.warning("visitor accretion: session plan resolve failed",
          visitor_id: visitor.id,
          network: network.slug,
          error: inspect(reason)
        )

        {:error, :resolve_failed}
    end
  end

  @doc """
  Anon-only co-terminus delete (W11). If the visitor exists and is anon
  (holds NO NickServ credential), delete the row — CASCADE wipes the
  associated accounts_sessions, network_credentials and messages in a
  single transaction. Registered visitor (≥1 NickServ credential): no-op,
  the identity persists across logouts. Missing row: no-op (idempotent
  under concurrent deletion).

  #211 phase 7 — the anon-vs-registered discriminator is DERIVED from the
  credentials (`Credentials.visitor_registered?/1`), NOT the retired
  `visitors.password_encrypted` scalar NOR a `visitors.expires_at`-nil flag.
  `commit_password/3` no longer clears `expires_at` (registration is
  derived, not stored), so a post-phase-7 registered visitor still carries
  an anon-shaped TTL value — the credential check, not the `expires_at`
  shape, is what protects it from the anon co-terminus delete. A legacy
  pre-phase-7 permanent row (`expires_at IS NULL`) also has ≥1 NickServ
  credential (phase-1 backfill), so it too is protected.

  Called from every accounts_sessions deletion site. Anon visitors' data
  dies with their session row; registered visitors' data persists past
  session death and is gated on the next login by the `Visitors.Login`
  per-network credential password match.
  """
  @spec purge_if_anon(Ecto.UUID.t()) :: :ok
  def purge_if_anon(visitor_id) when is_binary(visitor_id) do
    case Repo.get(Visitor, visitor_id) do
      nil ->
        :ok

      %Visitor{} = visitor ->
        if Credentials.visitor_registered?(visitor.id) do
          # Registered — identity persists; its backoff history must survive.
          :ok
        else
          purge_anon_visitor(visitor)
        end
    end
  end

  # S11 — the anon subject is destroyed here (login case-1 failure /
  # preempt). destroy_visitor re-homes published themes (#299), hard-
  # deletes the row (CASCADE), and evicts its Backoff entries so the
  # retired UUID leaves no orphan.
  #
  # #590 — this is a co-terminus BEST-EFFORT cleanup (a failed/preempted
  # login has no HTTP client waiting on the purge), and every caller
  # matches `:ok =`. A sustained SQLITE_BUSY therefore ABSORBS to `:ok`
  # + a log rather than propagating: the anon row is simply left for
  # `Visitors.Reaper` to collect once its TTL elapses. Distinct from
  # `delete/1`, whose operator/admin callers want the 503.
  @spec purge_anon_visitor(Visitor.t()) :: :ok
  defp purge_anon_visitor(%Visitor{} = visitor) do
    case destroy_visitor(visitor) do
      :ok ->
        :ok

      {:error, :db_unavailable} ->
        Logger.warning(
          "purge_if_anon: db unavailable — anon purge deferred to reaper",
          visitor_id: visitor.id
        )

        :ok
    end
  end
end
