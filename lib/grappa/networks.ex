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
      policy (`add_server/2`, `list_servers/1`, `pick_server!/1`,
      `remove_server/3`).
    * `Grappa.Networks.Credentials` — per-(user, network) credential
      lifecycle including the cascade-on-empty `unbind_credential/2`
      transaction (Session/Scrollback orchestration).
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
      Grappa.EncryptedBinary,
      Grappa.IRC,
      Grappa.PubSub,
      Grappa.Repo,
      Grappa.Scrollback,
      Grappa.Session,
      Grappa.Vault
    ],
    exports: [Network, NoServerError, Server, Credential, Credentials, Servers, SessionPlan, Wire]

  alias Grappa.{Accounts, Repo, Session}
  alias Grappa.Accounts.User
  alias Grappa.Networks.{Credential, Network}
  alias Grappa.PubSub.Topic

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
  @spec find_or_create_network(%{required(:slug) => String.t()}) ::
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
  Updates the admission caps (`max_concurrent_sessions`,
  `max_per_client`) on a network row. Operator-side entry point used by
  `mix grappa.set_network_caps` (dev DB) and `bin/grappa rpc` against
  the same fn (prod DB) — single source for the validation +
  Repo.update round-trip.

  Three-valued contract per cap (decision F, B5.3):

    * `nil` — explicitly clears the cap (means "unlimited"). The
      `--clear-max-sessions` / `--clear-max-per-client` mix flags
      surface this from the operator side.
    * `0` — degenerate lock-down (means "allow none"). Explicit
      operator intent, distinct from "unlimited".
    * `N > 0` — the cap itself.

  Negative integers and non-integers are rejected by
  `Network.changeset/2`'s `validate_non_negative_or_nil/2` rule.
  Unsupplied keys keep their current value (changeset only casts the
  allowlist `[:slug, :max_concurrent_sessions, :max_per_client]`).
  """
  # B5.3 review-fix: tightened from `integer() | nil` to
  # `non_neg_integer() | nil` so the typespec matches the changeset's
  # `validate_non_negative_or_nil/2` rule + the schema's
  # `non_neg_integer() | nil` field type. Drift between the spec
  # (loose) and the runtime contract (strict) misled callers into
  # thinking negative values were a runtime concern; they're rejected
  # at the changeset boundary unconditionally.
  @spec update_network_caps(Network.t(), %{
          optional(:max_concurrent_sessions) => non_neg_integer() | nil,
          optional(:max_per_client) => non_neg_integer() | nil
        }) :: {:ok, Network.t()} | {:error, Ecto.Changeset.t()}
  def update_network_caps(%Network{} = network, attrs) when is_map(attrs) do
    network
    |> Network.changeset(attrs)
    |> Repo.update()
  end

  @typedoc """
  PubSub event payload broadcast on every successful (non-idempotent)
  `connection_state` transition. Topic shape is
  `Grappa.PubSub.Topic.network(user_name, network_slug)`. Subscribers
  (cicchetto via Phoenix Channels, future Phase 6 listener) consume
  this to render the user-visible state badge + the
  server-messages-window lifecycle line.
  """
  @type connection_state_changed_event :: %{
          user_id: Ecto.UUID.t(),
          network_id: integer(),
          network_slug: String.t(),
          from: Credential.connection_state(),
          to: Credential.connection_state(),
          reason: String.t() | nil,
          at: DateTime.t()
        }

  @doc """
  Transitions a credential to `:connected`. Idempotent if already
  `:connected` (no DB write, no broadcast).

  Does NOT spawn the `Session.Server` — see the moduledoc T32 boundary
  note. The caller (`NetworkController` for `/connect`, `Bootstrap` at
  boot) handles admission + `Session.start_session/3`.

  `:parked | :failed → :connected`. Clears the prior `reason` (the
  user reconnecting overrides the prior parked/failed cause). Emits
  `{:connection_state_changed, event}` on
  `Topic.network(user_name, network_slug)`.
  """
  @spec connect(Credential.t()) :: {:ok, Credential.t()}
  def connect(%Credential{connection_state: :connected} = cred) do
    {:ok, preload_user_and_network(cred)}
  end

  def connect(%Credential{connection_state: from} = cred) when from in [:parked, :failed] do
    cred = preload_user_and_network(cred)
    updated = transition!(cred, :connected, nil)
    broadcast_state_change(updated, from, :connected, nil)
    {:ok, updated}
  end

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
    cred = preload_user_and_network(cred)
    subject = {:user, cred.user_id}

    _ = best_effort_quit(subject, cred.network_id, reason)
    :ok = Session.stop_session(subject, cred.network_id)

    updated = transition!(cred, :parked, reason)
    broadcast_state_change(updated, :connected, :parked, reason)
    {:ok, updated}
  end

  def disconnect(%Credential{connection_state: state}, _)
      when state in [:parked, :failed],
      do: {:error, :not_connected}

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
    cred = preload_user_and_network(cred)
    subject = {:user, cred.user_id}

    :ok = Session.stop_session(subject, cred.network_id)

    updated = transition!(cred, :failed, reason)
    broadcast_state_change(updated, :connected, :failed, reason)
    {:ok, updated}
  end

  def mark_failed(%Credential{connection_state: :parked}, _),
    do: {:error, :user_parked}

  # Direct-write changeset for connection-state transitions only.
  # `Credential.changeset/2` runs the full validate_required + password
  # + safe-line-token gauntlet, which is wrong for in-place state
  # writes — we already have a row that passed those rules at bind
  # time. `Ecto.Changeset.change/2` skips them; the closed-set
  # Ecto.Enum cast at the schema field still rejects bogus atoms.
  @spec transition!(Credential.t(), Credential.connection_state(), String.t() | nil) ::
          Credential.t()
  defp transition!(%Credential{} = cred, new_state, reason) do
    now = DateTime.truncate(DateTime.utc_now(), :second)

    cred
    |> Ecto.Changeset.change(%{
      connection_state: new_state,
      connection_state_reason: reason,
      connection_state_changed_at: now
    })
    |> Repo.update!()
  end

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

  @spec preload_user_and_network(Credential.t()) :: Credential.t()
  defp preload_user_and_network(%Credential{} = cred) do
    cred
    |> maybe_preload_user()
    |> maybe_preload_network()
  end

  defp maybe_preload_user(%Credential{user: %User{}} = cred), do: cred

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
  @spec broadcast_state_change(
          Credential.t(),
          Credential.connection_state(),
          Credential.connection_state(),
          String.t() | nil
        ) :: :ok
  defp broadcast_state_change(
         %Credential{user: %User{name: user_name}, network: %Network{slug: slug}} = cred,
         from,
         to,
         reason
       ) do
    event =
      {:connection_state_changed,
       %{
         user_id: cred.user_id,
         network_id: cred.network_id,
         network_slug: slug,
         from: from,
         to: to,
         reason: reason,
         at: cred.connection_state_changed_at
       }}

    _ = Phoenix.PubSub.broadcast(Grappa.PubSub, Topic.network(user_name, slug), event)
    :ok
  end
end
