defmodule Grappa.Networks.Credentials do
  @moduledoc """
  Per-(user, network) credential lifecycle.

  CRUD + Cloak-encrypted password handling + the `unbind_credential/2`
  detach path that stops the live session and deletes the user's
  credential row.

  Extracted from `Grappa.Networks` in the D1 god-context split. The
  parent context kept slug CRUD; credential concerns — including the
  `Session.stop_session/2` teardown that drives `unbind_credential/2` —
  live here so the Phase 5 credential REST surface and audit-logging
  hooks land in one cohesive module.

  ## Unbind never deletes the network (GH #105)

  The credential → network FK is `:restrict`. `unbind_credential/2`
  removes ONLY the credential row (and stops the running session); the
  network persists even when its last binding is removed. Networks are
  shared per-deployment infra — an empty binding list is not a delete
  signal. Visitor scrollback follows the visitor lifecycle. Explicit
  operator-initiated teardown is `Grappa.Networks.delete_network/1`,
  which refuses while any credential or archival scrollback still
  references the network.

  ## Encrypted password

  `bind_credential/3` writes the plaintext `password` field through
  `Grappa.Networks.Credential`'s changeset, which copies it into the
  `password_encrypted` Cloak column. `get_credential!/2` returns the
  Credential with the column already decrypted by the Ecto type — the
  plaintext lives only in the `:password_encrypted` field after load
  (the virtual `:password` field is input-only and stays nil).
  """
  import Ecto.Query

  alias Grappa.Accounts.User
  alias Grappa.Ecto.Like
  alias Grappa.IRC.Identifier
  alias Grappa.Networks.{Credential, Network}
  alias Grappa.{Repo, Session}

  # Identifier.nick_fold/1 is a query macro (ASCII fold fragment).
  require Identifier

  @doc """
  Binds `user` to `network` with the given attrs. Validation rules
  live in `Credential.changeset/2`; the plaintext `:password` (when
  given) is encrypted into `:password_encrypted` before insert.
  """
  @spec bind_credential(User.t(), Network.t(), map()) ::
          {:ok, Credential.t()} | {:error, Ecto.Changeset.t()}
  def bind_credential(%User{id: user_id}, %Network{id: network_id}, attrs) when is_map(attrs) do
    attrs =
      attrs
      |> Map.put(:user_id, user_id)
      |> Map.put(:network_id, network_id)

    case %Credential{} |> Credential.changeset(attrs) |> Repo.insert() do
      {:ok, cred} ->
        # Preload `:network` so HTTP callers (M-cluster M-6 admin
        # endpoint, admin-panel bucket 3 strict-create) can render
        # the operator wire shape (which carries `network_slug`)
        # without a Repo dep at the GrappaWeb boundary. Mirrors the
        # post-insert preload on `update_credential/3`.
        {:ok, Repo.preload(cred, :network)}

      {:error, _} = err ->
        err
    end
  end

  @doc """
  Updates the credential bound to `(user, network)`. Same validation
  + encryption pipeline as `bind_credential/3`. Raises
  `Ecto.NoResultsError` if the binding doesn't exist (the `!` suffix)
  — callers should unbind+rebind, not update, when reassigning a
  network. The mix-task callsite is `mix grappa.update_network_credential`,
  which surfaces the raise as a non-zero exit; programmatic callers
  should call `get_credential!/2` themselves first if they need a
  pre-flight existence check.
  """
  @spec update_credential!(User.t(), Network.t(), map()) ::
          {:ok, Credential.t()} | {:error, Ecto.Changeset.t()}
  def update_credential!(%User{} = user, %Network{} = network, attrs) when is_map(attrs) do
    user
    |> get_credential!(network)
    |> Credential.changeset(attrs)
    |> Repo.update()
  end

  @doc """
  Typed-error sibling of `update_credential!/3` for HTTP /
  programmatic callers (M-cluster M-6
  `PATCH /admin/credentials/:user_id/:network_id`). Returns
  `{:error, :not_found}` when the `(user, network)` binding doesn't
  exist instead of raising. Otherwise identical validation pipeline.

  The bang variant stays for `mix grappa.update_network_credential`
  where typo-loudness matters.
  """
  @spec update_credential(User.t(), Network.t(), map()) ::
          {:ok, Credential.t()} | {:error, :not_found | Ecto.Changeset.t()}
  def update_credential(%User{} = user, %Network{} = network, attrs) when is_map(attrs) do
    case get_credential(user, network) do
      {:ok, cred} ->
        case cred |> Credential.changeset(attrs) |> Repo.update() do
          # Preload :network so HTTP callers (M-6 admin endpoint) can
          # render the operator wire shape (which carries
          # network_slug) without a Repo dep at the GrappaWeb
          # boundary. Cost: one extra row fetch on success; cheap
          # next to the changeset round-trip.
          {:ok, updated} -> {:ok, Repo.preload(updated, :network)}
          {:error, _} = err -> err
        end

      {:error, :not_found} ->
        {:error, :not_found}
    end
  end

  @doc """
  Admin-panel bucket 3 (A-2) — wraps `update_credential/3` with a
  side-effect decision: if the change set includes `:password` or
  `:auth_method`, AND a live `Session.Server` exists for
  `{:user, user.id} × network.id`, kill it via `Session.stop_session/2`
  so the next reconnect picks up the new credential bytes. Returns
  the updated credential plus a `session_action:` discriminator the
  caller surfaces to the operator.

  Cosmetic-only attrs (autojoin, realname) leave the live session
  alone — the next outbound JOIN will pick up the new autojoin list
  on next reconnect; mid-flight there's nothing to apply.

  We do NOT auto-respawn the killed session. Operator goes through
  the `POST /networks/:slug/connect` verb (or the cic equivalent)
  to re-spawn under the new creds — same path as a manual `/connect`.
  Keeps this verb single-purpose and avoids smuggling admission +
  spawn machinery into a credentials-edit boundary.
  """
  @spec update_credential_with_session_lifecycle(User.t(), Network.t(), map()) ::
          {:ok, Credential.t(), :left_alone | :stopped}
          | {:error, :not_found | Ecto.Changeset.t()}
  def update_credential_with_session_lifecycle(%User{} = user, %Network{} = network, attrs)
      when is_map(attrs) do
    with {:ok, updated} <- update_credential(user, network, attrs) do
      action = classify_session_action(user, network, attrs)
      maybe_stop_session(user, network, action)
      {:ok, updated, action}
    end
  end

  defp classify_session_action(%User{id: uid}, %Network{id: nid}, attrs) do
    keys = attrs |> Map.keys() |> Enum.map(&to_string/1)
    auth_touching? = "password" in keys or "auth_method" in keys

    cond do
      not auth_touching? -> :left_alone
      Session.whereis({:user, uid}, nid) == nil -> :left_alone
      true -> :stopped
    end
  end

  defp maybe_stop_session(_, _, :left_alone), do: :ok

  defp maybe_stop_session(%User{id: uid}, %Network{id: nid}, :stopped) do
    :ok = Session.stop_session({:user, uid}, nid, "credentials changed")
  end

  @doc """
  #211 phase 4c — remove `channel_name` from a VISITOR credential's
  PER-NETWORK `last_joined_channels` rejoin list (keyed on `(visitor_id,
  network_id)`).

  A visitor has no operator-bound `autojoin_channels` — its rejoin list IS
  `last_joined_channels` — so the cic "dismiss tab" path removes from THAT
  column on the specific network's credential (NOT the single
  `visitors.last_joined_channels` scalar). Canonicalises the channel (RFC
  2812 casemapping); stored entries are already canonical, so an
  exact-match reject mirrors the user helper. Narrow
  `last_joined_channels_changeset` (no wide-changeset validators on this
  path). `{:error, :not_found}` when the credential was unbound.
  """
  @spec remove_visitor_last_joined_channel(Ecto.UUID.t(), pos_integer(), String.t()) ::
          {:ok, Credential.t()} | {:error, :not_found | Ecto.Changeset.t()}
  def remove_visitor_last_joined_channel(visitor_id, network_id, channel_name)
      when is_binary(visitor_id) and is_integer(network_id) and is_binary(channel_name) do
    canonical = Grappa.IRC.Identifier.canonical_target(channel_name)

    case get_visitor_credential(visitor_id, network_id) do
      {:ok, cred} ->
        kept = Enum.reject(cred.last_joined_channels, &(&1 == canonical))

        cred
        |> Credential.last_joined_channels_changeset(kept)
        |> Repo.update()

      {:error, :not_found} ->
        {:error, :not_found}
    end
  end

  @doc """
  Removes `channel_name` from `autojoin_channels` on the `(user, network)`
  credential. Called by `DELETE /networks/:slug/channels/:channel_id` so
  that the next `GET /channels` response omits the closed channel entirely
  (not just as `joined: false`). No-op if `channel_name` is not in the
  autojoin list. Returns `{:ok, credential}` or `{:error, changeset}`.
  """
  @spec remove_autojoin_channel(User.t(), Network.t(), String.t()) ::
          {:ok, Credential.t()} | {:error, Ecto.Changeset.t()} | {:error, :not_found}
  def remove_autojoin_channel(%User{} = user, %Network{} = network, channel_name)
      when is_binary(channel_name) do
    # UX-4 bucket A — canonicalise so a REST DELETE with `#Chan` in the
    # URL path removes the canonical `#chan` row (which is what the
    # Credential.changeset/2 writer normalises to).
    channel_name = Grappa.IRC.Identifier.canonical_target(channel_name)

    case get_credential(user, network) do
      {:ok, cred} ->
        new_autojoin = Enum.reject(cred.autojoin_channels, &(&1 == channel_name))

        cred
        |> Credential.changeset(%{autojoin_channels: new_autojoin})
        |> Repo.update()

      {:error, :not_found} ->
        {:error, :not_found}
    end
  end

  @doc """
  CP22 cluster B (channel-client-polish #14, B-restart) — overwrite the
  per-credential `last_joined_channels` snapshot. Called by
  `Session.Server` on every self-JOIN / self-PART / self-KICK so a
  graceful or crash restart can rehydrate the channel list at boot.

  ID-keyed (not struct-keyed) because the caller has `(user_id,
  network_id)` directly from session state — avoids a Repo round-trip
  to materialize User/Network structs we'd just discard. Returns `:ok`
  on success or `{:error, reason}` (no-op log if the credential row was
  unbound concurrently — restart-rehydrate semantics tolerate the
  missing row, the next session bind would re-establish it).

  ## Cap (CP24 cluster post-cr-review bucket B, persistence/S8)

  Truncated to `Credential.last_joined_channels_max/0` entries (200).
  The natural upper bound is the live join count (typically 5-50;
  RFC 2812 has no absolute ceiling). The cap is a safety belt —
  bounds the JSON column write + boot-time merge cost so a
  pathological session can't grow the snapshot without limit. Tail
  (oldest by sort key in the snapshot Session.Server passes in) is
  dropped on overflow.

  H15 (REV-D 2026-05-22): the cap is also enforced at the schema
  changeset level via `validate_length/3` so any bypassing writer
  (future REST surface, operator mix task, test helper) observes
  the same bound. SoT is `Credential.last_joined_channels_max/0`;
  this helper pre-truncates to keep the changeset validation a
  belt-and-braces guard, not the primary enforcement point.
  """
  @spec update_last_joined_channels(Ecto.UUID.t(), pos_integer(), [String.t()]) ::
          :ok | {:error, :not_found | Ecto.Changeset.t()}
  def update_last_joined_channels(user_id, network_id, channels)
      when is_binary(user_id) and is_integer(network_id) and is_list(channels) do
    capped = Enum.take(channels, Credential.last_joined_channels_max())

    case Repo.get_by(Credential, user_id: user_id, network_id: network_id) do
      nil ->
        {:error, :not_found}

      %Credential{} = cred ->
        # S34: narrow changeset — this fires on every self-JOIN/PART/KICK,
        # so it must not drag the wide `changeset/2`'s unrelated validators
        # (`validate_password_for_auth_method`, `put_encrypted_password`,
        # the `unique_constraint`) onto the hot path. Twin of the visitor
        # side's `Visitor.last_joined_channels_changeset/2`.
        changeset = Credential.last_joined_channels_changeset(cred, capped)

        case Repo.update(changeset) do
          {:ok, _} -> :ok
          {:error, changeset} -> {:error, changeset}
        end
    end
  end

  @doc """
  GH #417 — persist the user's EXPLICIT away snapshot on the
  `(user_id, network_id)` credential so it survives a session crash /
  `:transient` respawn / upstream reconnect. `reason` + `since` set the
  pair (`/away :reason`); both nil clears it (`/back`). Twin of
  `update_last_joined_channels/3`: narrow changeset, keyed by subject +
  network, `{:error, :not_found}` when the credential was unbound between
  the away transition and now (race tolerated — a stopped session's late
  persist is a harmless no-op).

  `Session.Server` calls this fire-and-forget via the injected
  `away_persister` closure (Boundary-clean — Session cannot alias
  Networks), logging but not retrying on `{:error, _}`: the next away
  transition overwrites, and a lost snapshot only forces the next restart
  to boot `:present`.
  """
  @spec update_away(Ecto.UUID.t(), pos_integer(), String.t() | nil, DateTime.t() | nil) ::
          :ok | {:error, :not_found | Ecto.Changeset.t()}
  def update_away(user_id, network_id, reason, since)
      when is_binary(user_id) and is_integer(network_id) do
    case Repo.get_by(Credential, user_id: user_id, network_id: network_id) do
      nil ->
        {:error, :not_found}

      %Credential{} = cred ->
        case Repo.update(Credential.away_changeset(cred, reason, since)) do
          {:ok, _} -> :ok
          {:error, changeset} -> {:error, changeset}
        end
    end
  end

  @doc """
  #211 phase 4c — visitor twin of `update_last_joined_channels/3`, keyed on
  `(visitor_id, network_id)`.

  A visitor's `last_joined_channels` snapshot is now PER-NETWORK on the
  Credential (a multi-network visitor has one credential per network), NOT
  the single `visitors.last_joined_channels` scalar. `Session.Server`'s
  `last_joined_persister` writes here so network A's channel set and
  network B's don't clobber each other (the scalar is a single-network
  field, dropped at phase 7). Same narrow changeset as the user path.
  Returns `:ok`, or `{:error, :not_found}` when the credential was unbound
  between snapshot write and now (race tolerated — restart-rehydrate
  semantics).
  """
  @spec update_visitor_last_joined_channels(Ecto.UUID.t(), pos_integer(), [String.t()]) ::
          :ok | {:error, :not_found | Ecto.Changeset.t()}
  def update_visitor_last_joined_channels(visitor_id, network_id, channels)
      when is_binary(visitor_id) and is_integer(network_id) and is_list(channels) do
    capped = Enum.take(channels, Credential.last_joined_channels_max())

    case Repo.get_by(Credential, visitor_id: visitor_id, network_id: network_id) do
      nil ->
        {:error, :not_found}

      %Credential{} = cred ->
        changeset = Credential.last_joined_channels_changeset(cred, capped)

        case Repo.update(changeset) do
          {:ok, _} -> :ok
          {:error, changeset} -> {:error, changeset}
        end
    end
  end

  @doc """
  #211 phase 7 — commit a NickServ password onto the visitor's
  `(visitor_id, network_id)` Credential (encrypted at rest by Cloak). The
  per-network home for the visitor secret now that the
  `visitors.password_encrypted` scalar is dropped. Shared by both the +r
  observation (`Grappa.Visitors.commit_password/3`) and the #131 optimistic
  `SET PASSWD` (`rotate_password/3`).

  Routes through the narrow `Credential.password_changeset/2` so only
  `password_encrypted` is touched. `{:error, :not_found}` on a missing
  credential OR a concurrent unbind (H14 stale-struct race), mirroring the
  user-side `commit_password/3`.
  """
  @spec commit_visitor_password(Ecto.UUID.t(), pos_integer(), String.t()) ::
          {:ok, Credential.t()} | {:error, :not_found | Ecto.Changeset.t()}
  def commit_visitor_password(visitor_id, network_id, password)
      when is_binary(visitor_id) and is_integer(network_id) and is_binary(password) and
             password != "" do
    case get_visitor_credential(visitor_id, network_id) do
      {:error, :not_found} ->
        {:error, :not_found}

      {:ok, %Credential{} = cred} ->
        try do
          # #211 phase 7 — committing a password IS identifying via NickServ,
          # so flip `auth_method` to `:nickserv_identify` alongside the
          # secret (the pre-phase-7 `credential_attrs` write-through did the
          # same when it saw a non-nil password). An anon credential
          # (`auth_method: :none`) becomes an identifying one; an
          # already-identifying credential is idempotent.
          cred
          |> Credential.password_changeset(password)
          |> Ecto.Changeset.put_change(:auth_method, :nickserv_identify)
          |> Repo.update()
        rescue
          Ecto.StaleEntryError -> {:error, :not_found}
        end
    end
  end

  @doc """
  #211 phase 7 / #561 — rotate the visitor's nick on its `(visitor_id,
  network_id)` Credential from the upstream NICK self-echo (V9), GATED on
  the credential being ANON (`auth_method: :none`).

  #561 — an identified credential's nick is its LOGIN KEY: it is the nick
  the stored NickServ password belongs to. Azzurra's services rename an
  unidentified visitor to `GuestNNNNN`, and that rename echoes here; writing
  the Guest onto an identified credential drifts the stored nick away from
  the password's identity, locking the visitor out on the next reconnect.
  So echo-persist applies ONLY while the credential is anon (there is no
  login identity to protect); an identified credential's nick is bound at
  the proven identify instant (`+r`) via `bind_identified_visitor_nick/3`
  instead, and this returns `{:ok, :held_identified}` (a deliberate no-op).

  Routes through the narrow `Credential.identity_changeset/2` (nick only —
  the folded-nick partial unique index, phase 4b, catches a concurrent
  cross-visitor collision as a changeset error). `{:error, :not_found}` on
  a missing credential OR a concurrent unbind (H14 stale-struct race).
  """
  @spec update_visitor_credential_nick(Ecto.UUID.t(), pos_integer(), String.t()) ::
          {:ok, Credential.t() | :held_identified} | {:error, :not_found | Ecto.Changeset.t()}
  def update_visitor_credential_nick(visitor_id, network_id, new_nick)
      when is_binary(visitor_id) and is_integer(network_id) and is_binary(new_nick) do
    case get_visitor_credential(visitor_id, network_id) do
      {:error, :not_found} ->
        {:error, :not_found}

      # Anon credential — no login identity to protect; echo-persist stays.
      {:ok, %Credential{auth_method: :none} = cred} ->
        write_visitor_nick(cred, new_nick)

      # Identified credential — the nick is the login key; #561 holds it.
      {:ok, %Credential{}} ->
        {:ok, :held_identified}
    end
  end

  @doc """
  #561 — bind the visitor's identified nick onto its `(visitor_id,
  network_id)` Credential at the instant services confirm identification
  (`+r`). UNCONDITIONAL, unlike `update_visitor_credential_nick/3` (which
  the anon gate protects): `+r` is the proof of identity, and bahamut strips
  `+r` on any genuine nick change (`m_nick.c`:
  `mycmp(old, new) != 0 → umode &= ~UMODE_r`), so the nick held at `+r` is
  guaranteed the identified account — never a forced Guest.

  Same narrow `Credential.identity_changeset/2` + H14 stale-struct handling
  as the echo path; `{:error, :not_found}` on a missing credential or a
  concurrent unbind.
  """
  @spec bind_identified_visitor_nick(Ecto.UUID.t(), pos_integer(), String.t()) ::
          {:ok, Credential.t()} | {:error, :not_found | Ecto.Changeset.t()}
  def bind_identified_visitor_nick(visitor_id, network_id, new_nick)
      when is_binary(visitor_id) and is_integer(network_id) and is_binary(new_nick) do
    case get_visitor_credential(visitor_id, network_id) do
      {:error, :not_found} -> {:error, :not_found}
      {:ok, %Credential{} = cred} -> write_visitor_nick(cred, new_nick)
    end
  end

  # Shared narrow nick write: `identity_changeset/2` (nick only) + the H14
  # stale-struct rescue (a concurrent unbind between fetch and update).
  @spec write_visitor_nick(Credential.t(), String.t()) ::
          {:ok, Credential.t()} | {:error, :not_found | Ecto.Changeset.t()}
  defp write_visitor_nick(%Credential{} = cred, new_nick) do
    cred |> Credential.identity_changeset(%{nick: new_nick}) |> Repo.update()
  rescue
    Ecto.StaleEntryError -> {:error, :not_found}
  end

  @doc """
  #211 phase 7 — the visitor's REPRESENTATIVE identity credential: the
  lowest-`network_id` credential the identity holds (the "identity anchor").
  Since the visitor row no longer carries identity scalars, a caller that
  needs the identity's canonical nick/ident/realname without a specific
  network (accretion seed, admin/label display, the slimmed subject wire)
  reads it from this anchor credential.

  Deterministic (min `network_id`) so the anchor is stable across reboots
  and matches the `list_visitor_credentials/1` ordering. `{:error,
  :not_found}` when the identity holds no credential (a fresh row the boot
  reconcile hasn't touched — should not happen post-provision).
  """
  @spec representative_visitor_credential(Ecto.UUID.t()) ::
          {:ok, Credential.t()} | {:error, :not_found}
  def representative_visitor_credential(visitor_id) when is_binary(visitor_id) do
    query =
      from(c in Credential,
        where: c.visitor_id == ^visitor_id,
        order_by: [asc: c.network_id],
        limit: 1
      )

    case Repo.one(query) do
      %Credential{} = c -> {:ok, c}
      nil -> {:error, :not_found}
    end
  end

  @doc """
  #481 — the USER twin of `representative_visitor_credential/1`: the
  identity-anchor credential (lowest `network_id`) a user already holds,
  used to SEED a self-serve network accretion so a new network starts on
  the same nick/ident/realname the user carries elsewhere (identity
  continuity, mirror of `Visitors.accrete_network/3`'s seed). `{:error,
  :not_found}` when the user holds no credential yet — the accretion caller
  falls back to `user.name` (users always have a canonical account name,
  unlike visitors whose identity lives only on credentials).
  """
  @spec representative_user_credential(Ecto.UUID.t()) ::
          {:ok, Credential.t()} | {:error, :not_found}
  def representative_user_credential(user_id) when is_binary(user_id) do
    query =
      from(c in Credential,
        where: c.user_id == ^user_id,
        order_by: [asc: c.network_id],
        limit: 1
      )

    case Repo.one(query) do
      %Credential{} = c -> {:ok, c}
      nil -> {:error, :not_found}
    end
  end

  @doc """
  #211 phase 7 — batched representative-nick lookup:
  `[visitor_id] → %{visitor_id => nick}`. One query regardless of input
  size, for admin listings that resolve N visitor session labels without
  an N+1. The nick is the representative (lowest-`network_id`) credential's
  nick per visitor — the same identity-anchor
  `representative_visitor_credential/1` returns. Visitors with no
  credential are absent from the map (caller maps to the `nil` U-0 honesty
  label). Mirror of `Grappa.Accounts`'s batched id→label lookups.
  """
  @spec representative_nicks_by_visitor_ids([Ecto.UUID.t()]) :: %{Ecto.UUID.t() => String.t()}
  def representative_nicks_by_visitor_ids([]), do: %{}

  def representative_nicks_by_visitor_ids(visitor_ids) when is_list(visitor_ids) do
    # Per visitor, pick the lowest-network_id credential's nick via a
    # correlated MIN subquery — one round-trip, one row per visitor that
    # holds ≥1 credential.
    query =
      from(c in Credential,
        where:
          c.visitor_id in ^visitor_ids and
            c.network_id ==
              fragment(
                "(SELECT MIN(c2.network_id) FROM network_credentials c2 WHERE c2.visitor_id = ?)",
                c.visitor_id
              ),
        select: {c.visitor_id, c.nick}
      )

    query |> Repo.all() |> Map.new()
  end

  @doc """
  #211 phase 7 — is the visitor identity REGISTERED? True iff it holds at
  least one credential carrying a committed NickServ secret
  (`password_encrypted IS NOT NULL`) on ANY network. This is the DERIVED
  permanence flag — the source of truth is the credentials themselves, NOT
  a parallel `visitors.expires_at`-nil flag (which would drift the moment a
  credential is unbound). Identifying on any network makes the identity
  registered; unbinding the last registered credential makes it anon again,
  automatically.
  """
  @spec visitor_registered?(Ecto.UUID.t()) :: boolean()
  def visitor_registered?(visitor_id) when is_binary(visitor_id) do
    query =
      from(c in Credential,
        where: c.visitor_id == ^visitor_id and not is_nil(c.password_encrypted),
        limit: 1
      )

    Repo.exists?(query)
  end

  @doc """
  #211 phase 6 — per-network IDENTITY edit on a `(subject, network)`
  credential (`nick` + `ident` + `realname`). Backs
  `PATCH /networks/:network_id/identity` for BOTH subjects (ruling E).

  Takes the already-resolved `%Credential{}` (the controller fetched it
  subject-scoped via `get_credential/2` / `get_visitor_credential/2`, so
  ownership is asserted) + the identity attrs. Routes through the narrow
  `Credential.identity_changeset/2` (nick/ident/realname only — no
  password/auth/state touch). A folded-nick collision surfaces as a
  changeset error; a concurrent unbind surfaces as `{:error, :not_found}`
  (mirrors `commit_password/3`'s H14 stale-struct handling).
  """
  @spec update_credential_identity(Credential.t(), map()) ::
          {:ok, Credential.t()} | {:error, :not_found | Ecto.Changeset.t()}
  def update_credential_identity(%Credential{} = credential, attrs) when is_map(attrs) do
    case credential |> Credential.identity_changeset(attrs) |> Repo.update() do
      # Preload :network so the HTTP caller can render the credential wire
      # shape (which carries the network slug) without a Repo dep at the
      # GrappaWeb boundary. Mirrors `update_credential/3`.
      {:ok, updated} -> {:ok, Repo.preload(updated, :network)}
      {:error, _} = err -> err
    end
  rescue
    Ecto.StaleEntryError -> {:error, :not_found}
  end

  @doc """
  GH #124 — per-network PASSWORD edit on a `(subject, network)` credential.
  Backs `PUT /networks/:network_id/password` for BOTH subjects: the one field,
  writing the one stored secret.

  This is the cure for the split brain. When grappa's stored secret and
  NickServ's disagree there was previously no way to reconcile them from inside
  the product; now the operator retypes the real password and the credential is
  correct again. For a VISITOR the credential password IS the bouncer login
  credential, so a corrupted secret used to lock them out of grappa itself, not
  merely out of services.

  Write-only by construction — there is no read side. Routes through the narrow
  `Credential.password_changeset/2` (the same one the in-session `SET PASSWD`
  capture uses, so the two doors cannot store different shapes), plus two steps
  that only this door needs:

    * **`:none` is promoted to `:nickserv_identify`.** A password typed into a
      credential configured not to identify would otherwise sit there inert.
      Same promotion, for the same reason, as `commit_visitor_password/3`.
      ONLY `:none`: rewriting `:sasl` or `:server_pass` would change what the
      password is SPENT ON and break a working handshake. Those methods keep
      their password updated by this door — the field edits THE secret for the
      network, whatever the method spends it on.

    * **Azzurra's own guard chain, when the secret is NickServ-bound.** Storing
      a password services will always refuse is a silent identify failure — the
      exact failure mode #124 is about. Shared verbatim with the on-wire door
      via `Session.NSInterceptor.vet_password/2` rather than copied. Applied
      ONLY when the resulting `auth_method` is `:nickserv_identify`: a SASL or
      server password is not spoken to NickServ, and Azzurra's 32-byte cap has
      no business rejecting a legitimately longer one.

  A blank password never reaches here — the caller drops it (leave-blank-to-keep)
  and `password_changeset/2`'s `validate_required/2` would refuse it anyway.
  `{:error, :not_found}` on a concurrent unbind (H14 stale-struct race).
  """
  @spec update_credential_password(Credential.t(), String.t()) ::
          {:ok, Credential.t()} | {:error, :not_found | Ecto.Changeset.t()}
  def update_credential_password(%Credential{} = credential, password)
      when is_binary(password) do
    changeset =
      credential
      |> Credential.password_changeset(password)
      |> promote_none_to_nickserv_identify()
      |> vet_nickserv_password(credential, password)

    case Repo.update(changeset) do
      {:ok, updated} -> {:ok, Repo.preload(updated, :network)}
      {:error, _} = err -> err
    end
  rescue
    Ecto.StaleEntryError -> {:error, :not_found}
  end

  @spec promote_none_to_nickserv_identify(Ecto.Changeset.t()) :: Ecto.Changeset.t()
  defp promote_none_to_nickserv_identify(changeset) do
    if Ecto.Changeset.get_field(changeset, :auth_method) == :none,
      do: Ecto.Changeset.put_change(changeset, :auth_method, :nickserv_identify),
      else: changeset
  end

  # Reads auth_method off the CHANGESET, not the row, so it sees the promotion
  # above: a `:none` credential getting its first password is NickServ-bound
  # from this write onward and must be vetted as such.
  @spec vet_nickserv_password(Ecto.Changeset.t(), Credential.t(), String.t()) ::
          Ecto.Changeset.t()
  defp vet_nickserv_password(changeset, %Credential{nick: nick}, password) do
    if Ecto.Changeset.get_field(changeset, :auth_method) == :nickserv_identify do
      # `nick || ""` — the nick column is nullable (the session plan resolves a
      # fallback at connect time). An empty nick only makes the chain's
      # "password equals your nick" arm inert; every other guard still applies.
      case Session.NSInterceptor.vet_password(password, nick || "") do
        :ok -> changeset
        {:error, reason} -> Ecto.Changeset.add_error(changeset, :password, message(reason))
      end
    else
      changeset
    end
  end

  # The services notice the value would have earned, in words the operator can
  # act on. Same vocabulary as `NSInterceptor`'s reject reasons.
  @spec message(Session.NSInterceptor.vet_reject_reason()) :: String.t()
  defp message(:password_with_spaces), do: "must not contain spaces"
  defp message(:insecure_password), do: "must be at least 5 characters and not equal your nick"
  defp message(:password_max_length), do: "must be at most 32 bytes"
  defp message(:password_with_ccodes), do: "must not contain control characters"

  @doc """
  GH #189 — per-network ON-CONNECT PERFORM LIST edit on a
  `(subject, network)` credential (the raw command list + its `$oper_pass`
  secret). Backs `PUT /networks/:network_id/perform` for BOTH subjects.

  #124 removed the sibling `$nickserv_pass` secret from this door: it now lives
  in the credential password, written by `update_credential_password/2`.

  Takes the already-resolved `%Credential{}` (the controller fetched it
  subject-scoped, so ownership is asserted) + the attrs. Routes through the
  narrow `Credential.perform_changeset/2` (perform_list + oper_pass, both
  encrypted at rest). Unlike identity, there is NO live
  verb: the perform list is read at 001 by `Grappa.Session.Server` and
  re-resolved on every (re)start via `SessionPlan.base_plan/6`, so an edit
  persists only and takes effect on the next (re)connect. No `:network`
  preload — the perform wire shape carries no network fields. A validation
  failure (NUL / over-cap / CRLF in a secret) surfaces as a changeset error; a
  concurrent unbind as `{:error, :not_found}`.
  """
  @spec update_perform_list(Credential.t(), map()) ::
          {:ok, Credential.t()} | {:error, :not_found | Ecto.Changeset.t()}
  def update_perform_list(%Credential{} = credential, attrs) when is_map(attrs) do
    case credential |> Credential.perform_changeset(attrs) |> Repo.update() do
      {:ok, updated} -> {:ok, updated}
      {:error, _} = err -> err
    end
  rescue
    Ecto.StaleEntryError -> {:error, :not_found}
  end

  @doc """
  Rotates the stored upstream NickServ password for `(user_id, network_id)`.

  #131: the id-keyed write `Session.Server`'s `credential_committer`
  callback invokes when it observes a well-formed in-session `SET PASSWD`
  leaving the wire (optimistic commit-on-send — the change emits no `+r`
  rendezvous, and NOTICE-scraping is banned, so there is no positive
  confirmation signal; the user is already identified and it is their own
  deliberate change). #977 moved Azzurra's own guard chain (spaces, under 5 /
  over `PASSMAX` bytes, equal to the nick, control codes) INTO `NSInterceptor`,
  so a value services would refuse never reaches this function. The one
  rejection grappa still cannot foresee is a mistyped OLD password — that one
  stores a password that didn't take. The operator repairs it by retyping it
  into the per-network password field (#124, Settings -> General) — `update_credential_password/2` above.

  User-bound mirror of the visitor-side `Grappa.Visitors.commit_password/2`.
  The `password` is the SECOND token of `SET PASSWD <old> <new>` (#977 — the
  first is the old password services authenticate the rotation against), and
  `NSInterceptor` has already refused anything services would (spaces, under
  5 / over 32 bytes, equal to the nick, control codes). Goes through the narrow
  `Credential.password_changeset/2` so only `password_encrypted` is
  touched — the operator binding is left intact.
  """
  @spec commit_password(Ecto.UUID.t(), pos_integer(), String.t()) ::
          {:ok, Credential.t()} | {:error, :not_found | Ecto.Changeset.t()}
  def commit_password(user_id, network_id, password)
      when is_binary(user_id) and is_integer(network_id) and is_binary(password) and password != "" do
    case Repo.get_by(Credential, user_id: user_id, network_id: network_id) do
      nil ->
        {:error, :not_found}

      %Credential{} = cred ->
        # H14 mirror (visitors.ex `commit_password/2`): a concurrent
        # `unbind_credential/2` landing between the get_by above and the
        # update would raise `Ecto.StaleEntryError`. This runs SYNCHRONOUSLY
        # inside `Session.Server`'s send handler, so the raise would crash
        # the whole session mid-send and drop the IRC connection. Map it to
        # the spec'd `{:error, :not_found}` — same outcome as the get_by miss.
        try do
          case cred |> Credential.password_changeset(password) |> Repo.update() do
            {:ok, updated} -> {:ok, updated}
            {:error, changeset} -> {:error, changeset}
          end
        rescue
          Ecto.StaleEntryError -> {:error, :not_found}
        end
    end
  end

  @doc """
  #349 — commit-on-+r for the registration wizard. Writes the REGISTER
  password AND flips `auth_method` to `:nickserv_identify` on the
  `(user_id, network_id)` credential, atomically, via
  `Credential.registration_changeset/2`.

  `Session.Server`'s `registration_committer` callback invokes this from the
  `+r` observer (`apply_effects/2`) once services confirm a wizard-driven
  REGISTER: the `+r` umode is the cryptographic proof the registration took,
  so unlike SET PASSWD (`commit_password/3`, password only) this promotes the
  bound `--auth none` credential to auto-identify on every future reconnect —
  without it a registered nick gets services-enforced to a Guest nick.

  User-bound mirror of the visitor-side `Grappa.Visitors.commit_password/2`
  `+r` promotion; the `Ecto.StaleEntryError` → `{:error, :not_found}` mapping
  matches `commit_password/3` (a concurrent unbind must not crash the session
  mid-effect).
  """
  @spec commit_registration_password(Ecto.UUID.t(), pos_integer(), String.t()) ::
          {:ok, Credential.t()} | {:error, :not_found | Ecto.Changeset.t()}
  def commit_registration_password(user_id, network_id, password)
      when is_binary(user_id) and is_integer(network_id) and is_binary(password) and password != "" do
    case Repo.get_by(Credential, user_id: user_id, network_id: network_id) do
      nil ->
        {:error, :not_found}

      %Credential{} = cred ->
        try do
          case cred |> Credential.registration_changeset(password) |> Repo.update() do
            {:ok, updated} -> {:ok, updated}
            {:error, changeset} -> {:error, changeset}
          end
        rescue
          Ecto.StaleEntryError -> {:error, :not_found}
        end
    end
  end

  @doc """
  Returns the credential for `(user, network)` with `password_encrypted`
  already decrypted by Cloak. Raises `Ecto.NoResultsError` on miss —
  the operator-side mix tasks expect a missing binding to fail loudly.
  """
  @spec get_credential!(User.t(), Network.t()) :: Credential.t()
  def get_credential!(%User{id: user_id}, %Network{id: network_id}) do
    Repo.one!(credential_query(user_id, network_id))
  end

  @doc """
  Tagged-tuple sibling of `get_credential!/2` for the REST surface.
  Returns `{:error, :not_found}` when the (user, network) binding
  doesn't exist — used by Phase 3 cicchetto endpoints where a missing
  credential is a per-user iso check (the user is asking about a
  network they don't have access to), not an operator typo.
  """
  @spec get_credential(User.t(), Network.t()) ::
          {:ok, Credential.t()} | {:error, :not_found}
  def get_credential(%User{id: user_id}, %Network{id: network_id}) do
    case Repo.one(credential_query(user_id, network_id)) do
      %Credential{} = c -> {:ok, c}
      nil -> {:error, :not_found}
    end
  end

  @doc """
  Id-based sibling of `get_credential/2` for callers that already hold
  the raw `(user_id, network_id)` pair without a preloaded
  `%User{}` + `%Network{}`. M-cluster M-9a's admin Operator verbs
  (`disconnect_session/3`) parse them out of the URL composite id and
  don't need the structs.

  Returns `{:error, :not_found}` on miss (no row, OR either FK
  references a deleted row — the join is implicit in the unique
  index lookup).
  """
  @spec get_credential_by_ids(Ecto.UUID.t(), pos_integer()) ::
          {:ok, Credential.t()} | {:error, :not_found}
  def get_credential_by_ids(user_id, network_id)
      when is_binary(user_id) and is_integer(network_id) do
    case Repo.one(credential_query(user_id, network_id)) do
      %Credential{} = c -> {:ok, c}
      nil -> {:error, :not_found}
    end
  end

  defp credential_query(user_id, network_id) do
    from(c in Credential,
      where: c.user_id == ^user_id and c.network_id == ^network_id
    )
  end

  @doc """
  #211 phase 3 — subject-scoped reader for a VISITOR credential.

  Sibling of `get_credential_by_ids/2` (user-scoped) but keyed on
  `visitor_id` — the visitor read-cutover (`Grappa.Visitors.SessionPlan`)
  resolves a visitor session from its `(visitor_id, network_id)`
  Credential via this reader. Subject-aware BY CONSTRUCTION: it only
  ever matches `visitor_id IS NOT NULL` rows, so a visitor can never be
  routed into the user resolver's `Accounts.get_user!(nil)` crash
  (the phase-1 subject-blind-reader class — the whole reason
  `network_credentials` uses the XOR-FK pattern).

  Returns `{:error, :not_found}` on miss.
  """
  @spec get_visitor_credential(Ecto.UUID.t(), pos_integer()) ::
          {:ok, Credential.t()} | {:error, :not_found}
  def get_visitor_credential(visitor_id, network_id)
      when is_binary(visitor_id) and is_integer(network_id) do
    case Repo.one(visitor_credential_query(visitor_id, network_id)) do
      %Credential{} = c -> {:ok, c}
      nil -> {:error, :not_found}
    end
  end

  defp visitor_credential_query(visitor_id, network_id) do
    from(c in Credential,
      where: c.visitor_id == ^visitor_id and c.network_id == ^network_id
    )
  end

  @doc """
  #211 phase 4c — every credential a VISITOR holds, with `:network`
  preloaded, ordered by `network_id` (deterministic across reboots — the
  Bootstrap per-credential log lines stay diff-friendly).

  A multi-network visitor (post-accretion) has one credential per attached
  network; `Grappa.Bootstrap` respawns ONE `Session.Server` per credential
  so a reboot restores ALL of a visitor's networks, not just the primary
  `network_slug`. Subject-scoped (`WHERE visitor_id ==`) — never surfaces a
  user credential. Empty list when the visitor holds none (a fresh row the
  reconcile hasn't touched — Bootstrap self-heals it via
  `reconcile_credential/1` before this read).
  """
  @spec list_visitor_credentials(Ecto.UUID.t()) :: [Credential.t()]
  def list_visitor_credentials(visitor_id) when is_binary(visitor_id) do
    query =
      from(c in Credential,
        where: c.visitor_id == ^visitor_id,
        order_by: [asc: c.network_id],
        preload: [network: :servers]
      )

    Repo.all(query)
  end

  @doc """
  #211 phase 4c — credential-first VISITOR identity resolution: find the
  visitor credential holding `nick` (ASCII-folded, GH #121/#525) on
  `network_id`.

  This is the phase-7-ready replacement for the `visitors` row lookup
  `Visitors.get_by_nick_and_network/2` (which queries the
  `visitors.network_slug` scalar dropped at phase 7). Login uses the
  returned credential's `visitor_id` to resolve WHICH synthetic identity
  owns `(nick, network)` — else it provisions a new one.

  Folds both the `nick` column and the supplied `nick` through the SAME
  casemapper (`Identifier.nick_fold/1` fragment + `canonical_nick/1`), so
  it matches the phase-4b folded partial unique index
  (`network_credentials_visitor_folded_nick_network_id_index`) and stays
  index-eligible. Visitor-scoped BY CONSTRUCTION (`WHERE visitor_id IS NOT
  NULL`): a USER credential with the same nick never matches — a visitor
  can't be resolved onto a user's identity (the phase-1
  subject-blind-reader class). Returns `{:error, :not_found}` on miss.
  """
  @spec fetch_visitor_credential_by_nick(String.t(), pos_integer()) ::
          {:ok, Credential.t()} | {:error, :not_found}
  def fetch_visitor_credential_by_nick(nick, network_id)
      when is_binary(nick) and is_integer(network_id) do
    folded = Identifier.canonical_target(nick)

    query =
      from(c in Credential,
        where:
          not is_nil(c.visitor_id) and c.network_id == ^network_id and
            Identifier.nick_fold(c.nick) == ^folded
      )

    case Repo.one(query) do
      %Credential{} = c -> {:ok, c}
      nil -> {:error, :not_found}
    end
  end

  @doc """
  #257 — visitor leg of the admin subject-search autocomplete. Returns up
  to `limit` VISITOR credentials (`visitor_id IS NOT NULL`) whose `nick`
  contains `query`, with `:network` preloaded (the caller renders the
  slug), ordered by nick then network.

  The nick match is ASCII-folded (GH #121/#525) on BOTH sides — the query
  via `Identifier.canonical_nick/1`, the column via the
  `Identifier.nick_fold/1` fragment — so a case variant resolves the same
  way login does (a bracket variant like foo[bar]/foo{bar} stays DISTINCT,
  per CASEMAPPING=ascii). The folded query is then LIKE-escaped via
  `Grappa.Ecto.Like` (an underscore is a legal nick char and must match
  literally) with an explicit `ESCAPE '\\'` clause. The ASCII fold leaves
  `\\` UNCHANGED (it is not an `A-Z` byte), so a literal `\\` in the query
  reaches the escape step and is escaped there — no collision with the LIKE
  escape char.

  Visitor-scoped BY CONSTRUCTION (`WHERE visitor_id IS NOT NULL`): a USER
  credential with a matching nick is never returned (the phase-1 subject-
  blind-reader class). A multi-network visitor holding the same nick on N
  networks yields N rows — the "network - nickname" disambiguation. The
  leading-`%` pattern is not index-eligible, but the credential table is
  operator/visitor-scale, so the scan is bounded. A blank/whitespace
  `query` short-circuits to `[]`.
  """
  @spec search_visitor_credentials_by_nick(String.t(), pos_integer()) :: [Credential.t()]
  def search_visitor_credentials_by_nick(query, limit)
      when is_binary(query) and is_integer(limit) and limit > 0 do
    case String.trim(query) do
      "" ->
        []

      trimmed ->
        pattern = Like.contains(Identifier.canonical_target(trimmed))

        query =
          from(c in Credential,
            where:
              not is_nil(c.visitor_id) and
                fragment("? LIKE ? ESCAPE '\\'", Identifier.nick_fold(c.nick), ^pattern),
            order_by: [asc: c.nick, asc: c.network_id],
            limit: ^limit,
            preload: [:network]
          )

        Repo.all(query)
    end
  end

  @doc """
  #211 phase 3 — the single idempotent choke-point that keeps a
  visitor's `(visitor_id, network_id)` Credential current.

  This ONE verb is reused by BOTH:

    * the per-mutation write-through in `Grappa.Visitors` (each visitor
      identity mutation — provision / commit_password / rotate_password
      / update_nick / update_identity / update_last_joined_channels —
      re-applies the visitor's current identity onto the Credential so
      the read path always sees fresh data), AND
    * the bulk reconcile in `Grappa.Bootstrap.run/0` (self-healing:
      refresh every existing visitor Credential + create any missing at
      boot, catching drift from the phase-1-backfill→phase-3-deploy
      window).

  The two callers are the SAME operation ("make the Credential match
  the visitor"), bulk-applied vs single — so they share this verb
  rather than forking two write paths (CLAUDE.md "implement once, reuse
  everywhere").

  Takes PRIMITIVES (`visitor_id`, `network_id`, an identity `attrs`
  map) — never a `%Visitor{}` — so `Grappa.Networks` needs no
  `Grappa.Visitors` dep; the FK stays a `dirty_xref` (a real edge would
  close the `Visitors → Networks` cycle). The caller
  (`Grappa.Visitors`) owns building the attrs from the visitor row.

  `attrs` flows through the wide `Credential.changeset/2` so the virtual
  `:password` re-encrypts under the same Cloak vault (in-memory the
  loaded value is plaintext), the subject XOR + partial-unique guards
  fire, and `auth_method` validation runs. `:user_id` is never set —
  the changeset's `validate_subject_xor/1` accepts the visitor-only
  shape. Idempotent: identical attrs on an existing row are a no-op
  Repo.update; re-running never creates a duplicate (the
  `(visitor_id, network_id)` partial unique index + the get-or-insert
  branch guarantee one row).
  """
  @spec upsert_visitor_credential(Ecto.UUID.t(), pos_integer(), map()) ::
          {:ok, Credential.t()} | {:error, Ecto.Changeset.t()}
  def upsert_visitor_credential(visitor_id, network_id, attrs)
      when is_binary(visitor_id) and is_integer(network_id) and is_map(attrs) do
    attrs =
      attrs
      |> Map.put(:visitor_id, visitor_id)
      |> Map.put(:network_id, network_id)

    case get_visitor_credential(visitor_id, network_id) do
      {:ok, existing} ->
        existing |> Credential.changeset(attrs) |> Repo.update()

      {:error, :not_found} ->
        %Credential{} |> Credential.changeset(attrs) |> Repo.insert()
    end
  end

  @doc """
  Detaches `user` from `network`: deletes the user's credential row and
  stops the running `Session.Server`, if any. Idempotent — a
  non-existent binding still returns `:ok`.

  The network row is NEVER touched (GH #105). A network whose last
  binding is removed simply persists as shared per-deployment infra;
  visitor scrollback continues to follow the visitor lifecycle. Explicit
  network teardown — gated on credential-presence AND scrollback-presence
  — is `Grappa.Networks.delete_network/1`'s job, not unbind's.
  """
  @spec unbind_credential(User.t(), Network.t()) :: :ok
  def unbind_credential(%User{id: user_id}, %Network{id: network_id}) do
    # S29 H5: tear down the running Session.Server BEFORE deleting the
    # credential row. Otherwise the GenServer's cached `state.network_id`
    # outlives the binding; the next outbound PRIVMSG crashes the call
    # handler and the `:transient` restart loops forever (init re-reads
    # the now-absent credential). Idempotent — :ok if no session was
    # running for the key.
    #
    # A2 cycle inversion (Cluster 2): pre-inversion this called an
    # inlined `stop_session_for_unbind/2` that replicated the
    # registry-key tuple to dodge the Networks↔Session Boundary
    # cycle. Now that `Session.Server.init/1` is a pure data
    # consumer, Session no longer deps Networks → the
    # `Networks → Session` edge is legal and we go through the
    # canonical facade.
    :ok = Session.stop_session({:user, user_id}, network_id, "credentials unbound")

    # A single scoped delete_all is atomic on its own — no transaction
    # wrapper needed now that unbind only ever touches the credential row
    # (GH #105 removed the last-binding check + cascade-on-empty network
    # delete that used to share the transaction).
    {_, _} = Repo.delete_all(credential_scope_query(user_id, network_id))
    :ok
  end

  @doc """
  As `unbind_credential/2`, but rides out a transient SQLITE_BUSY on the
  credential delete via `Repo.BusyRetry` and degrades to `{:error,
  :db_unavailable}` on sustained saturation, instead of the raise a naked
  `Repo.delete_all` throws under WAL + `pool_size > 1`.

  The #642 defect-2 accretion rollback
  (`GrappaWeb.SessionController.spawn_or_rollback/4`) calls this: it fires
  PRECISELY on admission refusal — i.e. under exactly the write contention
  where the naked delete is likeliest to raise. Because the accreted
  credential is bound `:parked` until its session is live, a degraded rollback
  safely leaves it `:parked` (a normal, user-recoverable state via PATCH
  /connect), never the `:connected`-with-no-session wedge. A NON-transient
  fault (syntax / corruption) still re-raises — `Repo.BusyRetry`'s contract,
  CLAUDE.md "no silent-swallow". Sibling of
  `Accounts.revoke_session/1` (#630, #636), which had the same "must
  degrade, not crash under peak write load" need. The delete is idempotent, so
  a retried statement is safe.
  """
  @spec unbind_credential_resilient(User.t(), Network.t()) :: :ok | {:error, :db_unavailable}
  def unbind_credential_resilient(%User{id: user_id}, %Network{id: network_id}) do
    :ok =
      Session.stop_session(
        {:user, user_id},
        network_id,
        "credentials unbound (accretion rollback)"
      )

    case Repo.BusyRetry.run(fn ->
           {:ok, Repo.delete_all(credential_scope_query(user_id, network_id))}
         end) do
      {:ok, {_, _}} -> :ok
      {:error, :db_unavailable} = err -> err
    end
  end

  # Scoped credential-row query shared by `unbind_credential/2` and
  # `unbind_credential_resilient/2` — the single (user, network) binding.
  @spec credential_scope_query(Ecto.UUID.t(), pos_integer()) :: Ecto.Query.t()
  defp credential_scope_query(user_id, network_id) do
    from(c in Credential,
      where: c.user_id == ^user_id and c.network_id == ^network_id
    )
  end

  @doc """
  Returns every credential bound to `user`, with networks preloaded
  for display.
  """
  @spec list_credentials_for_user(User.t()) :: [Credential.t()]
  def list_credentials_for_user(%User{id: user_id}) do
    query =
      from(c in Credential,
        where: c.user_id == ^user_id,
        preload: [:network]
      )

    Repo.all(query)
  end

  @doc """
  Returns the `[Network.t()]` bound to a `subject` — user OR visitor —
  with `:network` preloaded. Subject-generic wrapper over the two
  subject-scoped credential readers (`WHERE user_id ==` /
  `WHERE visitor_id ==`), so a caller that only needs the network set
  (e.g. #229's per-session umode cold-snapshot, which fans out one push
  per bound network on the user topic) doesn't branch on subject shape
  itself. Returns `[]` for an unknown/empty subject.
  """
  @spec list_networks_for_subject(Grappa.Session.subject()) :: [Network.t()]
  def list_networks_for_subject({:user, user_id}) when is_binary(user_id) do
    query = from(c in Credential, where: c.user_id == ^user_id, preload: [:network])

    query
    |> Repo.all()
    |> Enum.map(& &1.network)
  end

  def list_networks_for_subject({:visitor, visitor_id}) when is_binary(visitor_id) do
    visitor_id
    |> list_visitor_credentials()
    |> Enum.map(& &1.network)
  end

  @doc """
  Returns every credential whose `connection_state == :connected`,
  with `:network` preloaded.

  Used by `Grappa.Bootstrap` to spawn one `Grappa.Session.Server` per
  bound (user, network) at boot. Sub-task 2j swapped the boot path
  from a TOML-driven config into this DB-driven query so that
  operators using `mix grappa.bind_network` can take effect on the
  next deploy without editing a file.

  T32 (channel-client-polish S1.2): filters on `:connected`. `:parked`
  and `:failed` rows are intentionally skipped — `:parked` is user
  intent ("don't reconnect this on reboot"), `:failed` is a server-set
  terminal flag for hard upstream failures (k-line / permanent SASL).
  Operator brings them back via `Networks.connect/1` (PATCH endpoint
  or future mix task), which flips to `:connected` and the next
  Bootstrap cycle picks them up — though typically the PATCH
  controller spawns the session inline.

  Ordered by `(inserted_at, user_id, network_id)` so the per-credential
  log lines from Bootstrap are deterministic across reboots — handy
  when triaging "this network failed to start, how far did boot get".
  """
  @spec list_credentials_for_all_users() :: [Credential.t()]
  def list_credentials_for_all_users do
    # #211 — `network_credentials` is subject-polymorphic now. This
    # query drives `Bootstrap.spawn_all/1`, whose `SessionPlan.resolve/1`
    # calls `Accounts.get_user!(credential.user_id)`: a visitor
    # credential (`user_id IS NULL`) would make that `Repo.get!(User,
    # nil)` raise `ArgumentError` — NOT the `Ecto.NoResultsError` the
    # resolver rescues — crash-looping Bootstrap into app termination on
    # the boot after the visitor backfill. Visitor sessions are spawned
    # independently by `Bootstrap.spawn_visitors/1` from
    # `Visitors.list_active/0`, so scoping this to user credentials
    # (`user_id IS NOT NULL`) is both correct AND behavior-neutral — the
    # name + the `{:user, user_id}` spawn semantics already meant "user
    # credentials"; the polymorphic table just made the assumption
    # explicit-worthy.
    query =
      from(c in Credential,
        where: c.connection_state == :connected and not is_nil(c.user_id),
        order_by: [asc: c.inserted_at, asc: c.user_id, asc: c.network_id],
        preload: [network: :servers]
      )

    Repo.all(query)
  end

  @doc """
  Returns every USER credential regardless of `connection_state`, with
  `:network` preloaded. Counterpart to `list_credentials_for_all_users/0`
  for surfaces that need to show parked + failed rows alongside
  connected ones — `bin/grappa list-credentials` (T-3) needs ALL
  states for operator triage of a stuck network.

  Same ordering as `list_credentials_for_all_users/0` so the two
  outputs are diff-friendly.

  #211 — scoped to `user_id IS NOT NULL` so the admin `/admin/credentials`
  listing + `bin/grappa list-credentials` operator surface render only
  user credentials. A backfilled visitor credential (`user_id IS NULL`)
  would otherwise appear as a phantom `user_id: nil` row + trigger a
  `LiveIntrospection.lookup_session({:user, nil}, …)` at the admin
  controller. Visitor credentials belong to the (future) visitor
  surface, not the user-credentials door.
  """
  @spec list_all_credentials() :: [Credential.t()]
  def list_all_credentials do
    query =
      from(c in Credential,
        where: not is_nil(c.user_id),
        order_by: [asc: c.inserted_at, asc: c.user_id, asc: c.network_id],
        preload: [network: :servers]
      )

    Repo.all(query)
  end

  @doc """
  #1001 — every credential row, USER-bound and VISITOR-bound alike.

  Deliberately NOT `list_all_credentials/0`, and the two must not be
  unified. That one is scoped `user_id IS NOT NULL` for #211: it backs the
  admin `/admin/credentials` listing and `bin/grappa list-credentials`,
  operator surfaces where a `user_id: nil` row would render as a phantom
  and drive `LiveIntrospection.lookup_session({:user, nil}, …)`. Its narrow
  radius is a feature of a SUBJECT-scoped door.

  This reader answers the opposite question — "what is in the column, for
  anybody" — and it cannot inherit that scope. The secret-rotation path
  reaches BOTH subjects: `Session.Server`'s `rotate_stored_password/2` has a
  `{:visitor, visitor_id}` clause alongside the `{:user, user_id}` one, so a
  visitor credential carries (and corrupts) `password_encrypted` exactly like
  a user one. A repair sweep reading the user-scoped list would print
  "0 candidates" with a corrupted visitor row sitting right there — not a
  coverage gap but a false statement, which is the whole point of a task
  whose only output is a count.

  No `preload: [network: :servers]`: the caller reports on the stored secret,
  never dials one. `:network` alone is preloaded, for the slug in the report.
  """
  @spec list_credentials_every_subject() :: [Credential.t()]
  def list_credentials_every_subject do
    query =
      from(c in Credential,
        order_by: [asc: c.inserted_at, asc: c.id],
        preload: [:network]
      )

    Repo.all(query)
  end

  @doc """
  Returns a map of `connection_state` → USER-credential row count. Used
  by `Grappa.Bootstrap.run/0` to surface honest startup logs when zero
  credentials are `:connected` (e.g. all parked after
  T32 disconnect) — the pre-T-4 "no credentials bound — running
  web-only" message lied when N rows existed but all were parked or
  failed (per `feedback_no_silent_drops_closed` log-honesty class).

  Every value in `Credential.connection_states/0` is represented in the
  result, defaulting to 0 when no row carries that state — operator
  dashboards can pattern-match without `Map.get(_, _, 0)` defensive
  reads. A single SQL `GROUP BY connection_state` round-trip backs the
  count; the per-state zero-fill happens in Elixir.

  #211 — scoped to `user_id IS NOT NULL` so the count matches the set
  `list_credentials_for_all_users/0` actually spawns. Otherwise the
  Bootstrap "N parked, M failed — running web-only" honesty line would
  count backfilled visitor credentials that this path never spawns,
  re-lying in the exact way T-4 fixed.
  """
  @spec count_by_state() :: %{Credential.connection_state() => non_neg_integer()}
  def count_by_state do
    query =
      from(c in Credential,
        where: not is_nil(c.user_id),
        group_by: c.connection_state,
        select: {c.connection_state, count()}
      )

    counts = query |> Repo.all() |> Map.new()

    Map.new(Credential.connection_states(), fn state ->
      {state, Map.get(counts, state, 0)}
    end)
  end
end
