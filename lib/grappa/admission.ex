defmodule Grappa.Admission do
  @moduledoc """
  Admission-control verbs for new IRC session creation.

  Two verbs:

    * `check_capacity/1` — composes (a) NetworkCircuit gate,
      (b) per-network total cap, (c) per-(source-IP, network) cap.
      Local + cheap (Registry count + a DB query). Consumed by
      `Grappa.Visitors.Login`, `Grappa.Bootstrap`, and any future
      session-spawning surface.

    * `verify_captcha/2` — delegates to the configured Captcha
      behaviour impl. HTTP-bound, only required for `:login_fresh`
      flow.

  Cap dimensions and where they're checked:

  | cap                   | applies to                  | source                                       |
  |-----------------------|-----------------------------|----------------------------------------------|
  | NetworkCircuit        | all flows                   | ETS via `Admission.NetworkCircuit.check/1`   |
  | network total         | all flows                   | `Registry.count_select/2` on SessionRegistry |
  | source-IP per network | all flows w/ non-nil src IP | SQL over accounts_sessions.ip                |

  The ONLY per-actor cap is per-(source-IP, network) (#171). It replaced
  a per-(client, network) cap that was bypassable by construction:
  visitor / unauthenticated logins carry `client_id: nil` (no
  `X-Grappa-Client-Id`), so the per-client cap short-circuited to `:ok`
  and a single IP could open arbitrary concurrent visitor sessions
  (clone flood; 7 observed live). Visitors have no stable client
  identity — the source IP is the only durable per-actor handle — so the
  cap collapsed to source IP for ALL flows, authed users included. It
  counts DISTINCT subjects, network-bound, non-revoked, self-excluding
  the requesting subject, subject-kind disjoint, keyed on the persisted
  `accounts_sessions.ip` (the value login writes) against the operator
  knob `Network.max_per_ip` (default `default_max_per_ip_per_network`).

  Bootstrap flows (`:bootstrap_user`, `:bootstrap_visitor`) carry
  `source_ip: nil` (cold-start: no HTTP conn), so they bypass the cap by
  construction — intentional, boot is operator-initiated.

  NAT/CGNAT consequence (deliberate): distinct legit users behind one IP
  share the per-network budget — operators widen it by raising
  `max_per_ip`. That the cap is a tunable knob, not a hardcoded 1, is the
  whole point. See DESIGN_NOTES 2026-07-03.

  Identity-tier exemptions: NONE. Per Section 1 of the design, cap is the
  operator's knob (raise per-network `max_per_ip`); identity tier exempts
  only CAPTCHA (in `verify_captcha/2`), not concurrency.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Accounts, Grappa.Networks, Grappa.RateLimit, Grappa.Repo],
    # Grappa.Visitors.Visitor is referenced only for SQL join predicates
    # (schema-only access). A proper dep would create a
    # Visitors ↔ Admission cycle (Login calls check_capacity). Same
    # pattern as Grappa.Accounts's dirty_xref on Visitors.Visitor.
    dirty_xrefs: [Grappa.Visitors.Visitor],
    exports: [Captcha, Config, NetworkCircuit, NetworkCircuit.AdminWire, Telemetry]

  import Ecto.Query

  alias Grappa.Accounts.Session, as: AccountSession
  alias Grappa.Admission.{Captcha, NetworkCircuit, Telemetry}
  alias Grappa.Networks.{Credential, Network}
  alias Grappa.Repo
  alias Grappa.Visitors.Visitor

  @type flow ::
          :login_fresh
          | :login_existing
          | :bootstrap_user
          | :bootstrap_visitor
          | :patch_network_connect
          | :visitor_reconnect

  @type capacity_input :: %{
          network_id: integer(),
          source_ip: String.t() | nil,
          flow: flow(),
          requesting_subject: Grappa.Session.subject() | nil
        }

  @type capacity_error ::
          :ip_cap_exceeded
          | :visitor_cap_exceeded
          | :user_cap_exceeded
          | {:network_circuit_open, non_neg_integer()}

  @type error :: capacity_error() | Captcha.error()

  # Capacity-error tags exposed for the FC exhaustiveness test
  # (`FallbackControllerTest`'s "every Admission.capacity_error() atom
  # has an FC clause" matrix). The `@type capacity_error()` above is
  # the type-checker contract; this list is the runtime canary. Both
  # MUST move in lockstep — adding a tag to one without the other
  # surfaces as a missing test case or a missing dialyzer pattern.
  # `:network_circuit_open` appears as the bare atom; the test
  # constructs its payload tuple at runtime.
  @capacity_error_atoms [
    :ip_cap_exceeded,
    :visitor_cap_exceeded,
    :user_cap_exceeded,
    :network_circuit_open
  ]

  @doc """
  Canary list mirroring `t:capacity_error/0`. Consumed by the FC
  exhaustiveness test only — production code should pattern-match
  on the typed shape directly.
  """
  @spec capacity_error_atoms() :: [
          :ip_cap_exceeded
          | :visitor_cap_exceeded
          | :user_cap_exceeded
          | :network_circuit_open,
          ...
        ]
  def capacity_error_atoms, do: @capacity_error_atoms

  @typedoc """
  Live-session count projection for a single network, broken out by
  subject_kind. Per U-3 (UD4) the admin Networks listing surfaces these
  alongside the operator-set caps so capacity is visible at a glance.
  """
  @type live_counts :: %{visitors: non_neg_integer(), users: non_neg_integer()}

  @default_max_per_ip_per_network Application.compile_env!(
                                    :grappa,
                                    [:admission, :default_max_per_ip_per_network]
                                  )

  @doc """
  Compose all capacity checks for a candidate new session.

  Order: NetworkCircuit (cheapest, ETS) → network total
  (Registry count) → source-IP cap (DB query). Bail at first failure.

  `:ok` means the session may be spawned. Any error tag means caller
  must NOT spawn — they should surface the error to the user (Login)
  or skip the row + log (Bootstrap).
  """
  @spec check_capacity(capacity_input()) :: :ok | {:error, capacity_error()}
  def check_capacity(
        %{
          network_id: network_id,
          flow: flow,
          source_ip: source_ip,
          requesting_subject: requesting_subject
        } = input
      )
      when is_integer(network_id) do
    subject_kind = subject_kind_for_flow(flow)

    _ = validate_requesting_subject!(requesting_subject, subject_kind, flow)

    result =
      with :ok <- check_circuit(network_id),
           :ok <- check_network_total(network_id, subject_kind),
           :ok <- check_ip_cap(input, subject_kind) do
        :ok
      end

    case result do
      :ok ->
        :ok

      {:error, error} ->
        Telemetry.capacity_reject(flow, error, network_id, source_ip)
        {:error, error}
    end
  end

  # `requesting_subject` is the prior identity (if any) the device is
  # spawning this session AS. The cap excludes its existing
  # accounts_sessions rows so a subject re-establishing its session on
  # the same device cannot be cap-blocked by its own pre-existing rows
  # (UX-5 bucket BC, 2026-05-19). Bootstrap flows + Login Case 1 carry
  # `nil` (no prior subject); user/visitor re-spawns carry the matching
  # tagged-tuple. A mismatch between the flow's subject_kind and the
  # tuple's tag is a caller bug — surface it via a hard FunctionClauseError
  # rather than silently mis-counting (`feedback_silent_swallow`).
  defp validate_requesting_subject!(nil, _, _), do: :ok

  defp validate_requesting_subject!({:visitor, _}, :visitor, _), do: :ok
  defp validate_requesting_subject!({:user, _}, :user, _), do: :ok

  defp validate_requesting_subject!(other, subject_kind, flow) do
    raise ArgumentError,
          "Admission.check_capacity: requesting_subject #{inspect(other)} does not match " <>
            "flow #{inspect(flow)} (subject_kind=#{inspect(subject_kind)})"
  end

  # Flow → subject_kind dispatch. U-2 (UD1): the typed `flow` field
  # already encodes whether the spawn originates from a visitor- or
  # user-bearing surface; subject_kind is derived rather than passed
  # alongside to keep the capacity_input shape stable for callers.
  defp subject_kind_for_flow(:login_fresh), do: :visitor
  defp subject_kind_for_flow(:login_existing), do: :visitor
  defp subject_kind_for_flow(:bootstrap_visitor), do: :visitor
  defp subject_kind_for_flow(:visitor_reconnect), do: :visitor
  defp subject_kind_for_flow(:bootstrap_user), do: :user
  defp subject_kind_for_flow(:patch_network_connect), do: :user

  defp check_circuit(network_id) do
    case NetworkCircuit.check(network_id) do
      :ok ->
        :ok

      {:error, :open, retry_after} when is_integer(retry_after) ->
        # Tuple shape preserves the cooldown payload all the way to the
        # HTTP boundary, where FallbackController emits it as a
        # `Retry-After` response header. Bare-atom would lose the
        # cooldown — clients would have to guess the back-off interval.
        {:error, {:network_circuit_open, retry_after}}
    end
  end

  # U-2 (UD1): subject-aware total cap. The visitor and user caps are
  # operator-tunable per-network knobs that count DIFFERENT live-session
  # populations against DIFFERENT operator-set limits — a network full
  # of anonymous visitors must still admit a registered user, and vice
  # versa. Each clause reads the column matching its subject_kind and
  # filters the SessionRegistry match-spec head to that subject's
  # tagged-tuple shape.
  defp check_network_total(network_id, :visitor) do
    case Repo.get(Network, network_id) do
      %Network{max_concurrent_visitor_sessions: nil} ->
        :ok

      %Network{max_concurrent_visitor_sessions: cap} ->
        live = count_live_sessions(network_id, :visitor)
        if live >= cap, do: {:error, :visitor_cap_exceeded}, else: :ok

      nil ->
        :ok
    end
  end

  defp check_network_total(network_id, :user) do
    case Repo.get(Network, network_id) do
      %Network{max_concurrent_user_sessions: nil} ->
        :ok

      %Network{max_concurrent_user_sessions: cap} ->
        live = count_live_sessions(network_id, :user)
        if live >= cap, do: {:error, :user_cap_exceeded}, else: :ok

      nil ->
        :ok
    end
  end

  defp count_live_sessions(network_id, subject_kind) do
    # Registry keys are `{:session, subject, network_id}` per
    # `Grappa.Session.Server.registry_key/2`. Subject is a 2-tuple
    # `{:visitor, uuid}` or `{:user, uuid}`. Match-spec head literally
    # interpolates network_id + the subject tag at construction time
    # so only sessions of the matching subject_kind on this network
    # count. `:_` matches any uuid inside the subject tuple.
    subject_tag =
      case subject_kind do
        :visitor -> :visitor
        :user -> :user
      end

    Registry.count_select(Grappa.SessionRegistry, [
      {{{:session, {subject_tag, :_}, network_id}, :_, :_}, [], [true]}
    ])
  end

  @doc """
  Per-subject live-session count for a single network. Reuses the
  same Registry match-spec that `check_network_total/2` consults at
  admission time, so the projection cannot drift from the admission
  policy itself (CLAUDE.md "one feature, one code path").

  Returned shape is the U-3 (UD4) admin wire contract — visitors
  + users counted independently against their respective caps.
  `Grappa.Networks.AdminWire` composes this under `live_counts:`
  on each row of `GET /admin/networks`.

  For the bulk admin-list path use `live_counts_by_network/0`
  instead — single Registry scan over all networks rather than
  2N scans (one pair per network).
  """
  @spec live_counts_for_network(integer()) :: live_counts()
  def live_counts_for_network(network_id) when is_integer(network_id) do
    %{
      visitors: count_live_sessions(network_id, :visitor),
      users: count_live_sessions(network_id, :user)
    }
  end

  @doc """
  Bulk projection — `%{network_id => live_counts()}` for every network
  with at least one live session. Single `Registry.select/2` scan
  + `Enum.frequencies/1` in Elixir, replacing the N×2-scan path the
  admin index would otherwise take when iterating per-row.

  Networks with zero live sessions are NOT keyed (the caller must
  default to `%{visitors: 0, users: 0}`). This matches how
  `GET /admin/networks` already shapes the wire — `live_counts` is
  always present per row, defaulting to zeros when the bulk map
  has no entry.
  """
  @spec live_counts_by_network() :: %{integer() => live_counts()}
  def live_counts_by_network do
    # Match-spec head:  `{:session, {subject_tag, _uuid}, network_id}`
    # → return  `{network_id, subject_tag}`.  Reuses the same key shape
    # `count_live_sessions/2` consults — admission policy + projection
    # share the same Registry ground truth.
    pairs =
      Registry.select(Grappa.SessionRegistry, [
        {{{:session, {:"$1", :_}, :"$2"}, :_, :_}, [], [{{:"$2", :"$1"}}]}
      ])

    pairs
    |> Enum.frequencies()
    |> Enum.reduce(%{}, fn {{network_id, subject_tag}, count}, acc ->
      Map.update(
        acc,
        network_id,
        bump(zeros(), subject_tag, count),
        &bump(&1, subject_tag, count)
      )
    end)
  end

  defp zeros, do: %{visitors: 0, users: 0}

  defp bump(%{visitors: v} = m, :visitor, n), do: %{m | visitors: v + n}
  defp bump(%{users: u} = m, :user, n), do: %{m | users: u + n}

  # #171: per-(source-IP, network) cap — the ONLY per-actor cap. Visitor
  # / unauthenticated flows carry no stable client identity, so the
  # source IP is the durable per-actor handle; authed users are capped
  # per-IP too. Counts DISTINCT subjects, network-bound, non-revoked,
  # self-excluding the requesting subject, subject-kind disjoint, keyed
  # on the persisted `accounts_sessions.ip` against `Network.max_per_ip`.
  #
  # `source_ip: nil` skips (cold-start Bootstrap has no HTTP conn). A
  # construction site that omits `source_ip` entirely hits neither clause
  # → FunctionClauseError (loud) — a required-field guard, never a silent
  # nil-skip.
  defp check_ip_cap(%{source_ip: nil}, _), do: :ok

  defp check_ip_cap(
         %{
           source_ip: source_ip,
           network_id: network_id,
           requesting_subject: requesting_subject
         },
         subject_kind
       )
       when is_binary(source_ip) do
    cap = effective_max_per_ip(network_id)

    count =
      count_subjects_for_ip_on_network(
        source_ip,
        network_id,
        subject_kind,
        requesting_subject
      )

    if count >= cap, do: {:error, :ip_cap_exceeded}, else: :ok
  end

  defp effective_max_per_ip(network_id) do
    case Repo.get(Network, network_id) do
      %Network{max_per_ip: nil} -> @default_max_per_ip_per_network
      %Network{max_per_ip: cap} -> cap
      nil -> @default_max_per_ip_per_network
    end
  end

  # Count of distinct subjects (visitor_id ∪ user_id) reachable from
  # accounts_sessions where the SOURCE IP matches AND the subject is
  # bound to the given network_id (visitor.network_slug = network's slug,
  # OR user has a Credential for network_id). Only non-revoked sessions
  # count. Subject-aware (two disjoint clauses: visitor JOINs visitors,
  # user JOINs credentials) so a visitor session on an IP counts against
  # visitor logins and a user session against user logins — an IP running
  # a visitor + a user is two independent budgets, mirroring the
  # per-network total caps' subject split.
  #
  # UX-5 bucket BC (2026-05-19): `requesting_subject` is the prior
  # identity the actor is spawning AS. When non-nil AND its tag matches
  # `subject_kind`, the count EXCLUDES rows attributable to that subject
  # — the cap blocks DIFFERENT subjects from the same IP, never the
  # requesting subject's own pre-existing accounts_sessions. Without
  # self-exclusion the cap counts the operator's own browser session
  # against them, making T32 park → /connect always fail at
  # `max_per_ip = 1` (the default). The two clauses stay disjoint so an
  # exclusion in one cannot leak into the other; see the "cross-clause
  # disjointness" test in `admission_test.exs`.
  defp count_subjects_for_ip_on_network(source_ip, network_id, :visitor, requesting_subject) do
    %Network{slug: slug} = Repo.get!(Network, network_id)

    visitor_count_q =
      from(s in AccountSession,
        join: v in Visitor,
        on: v.id == s.visitor_id,
        where:
          s.ip == ^source_ip and
            v.network_slug == ^slug and
            is_nil(s.revoked_at),
        select: count(s.visitor_id, :distinct)
      )

    Repo.one(exclude_visitor(visitor_count_q, requesting_subject))
  end

  defp count_subjects_for_ip_on_network(source_ip, network_id, :user, requesting_subject) do
    user_count_q =
      from(s in AccountSession,
        join: c in Credential,
        on: c.user_id == s.user_id and c.network_id == ^network_id,
        where:
          s.ip == ^source_ip and
            is_nil(s.revoked_at),
        select: count(s.user_id, :distinct)
      )

    Repo.one(exclude_user(user_count_q, requesting_subject))
  end

  # Self-exclusion narrowing — only applies when the requesting subject's
  # tag matches the clause's subject_kind. `validate_requesting_subject!/3`
  # at the admission entry has already rejected cross-tag combos
  # (`:user` flow with `{:visitor, _}` etc.), so the no-op fallback below
  # only runs for the explicit `nil` case.
  defp exclude_visitor(q, {:visitor, visitor_id}),
    do: from([s, _v] in q, where: s.visitor_id != ^visitor_id)

  defp exclude_visitor(q, _), do: q

  defp exclude_user(q, {:user, user_id}),
    do: from([s, _c] in q, where: s.user_id != ^user_id)

  defp exclude_user(q, _), do: q

  @doc """
  Delegates to the configured Captcha behaviour impl.

  Provider is read from `Grappa.Admission.Config.config/0` —
  `:persistent_term`-backed boot-time snapshot. Tests substitute via
  the test-only `put_test_config/1` helper on `Grappa.Admission.Config`
  (Mix.env-gated), which also lets Mox mocks replace the provider
  per-test.
  """
  @spec verify_captcha(String.t() | nil, String.t() | nil) ::
          :ok | {:error, Captcha.error()}
  def verify_captcha(token, ip) do
    cfg = Grappa.Admission.Config.config()
    cfg.captcha_provider.verify(token, ip)
  end

  @doc """
  Returns the wire-shape provider token for the configured Captcha impl.
  Used by FallbackController in `captcha_required` error envelopes so
  cicchetto knows which widget to mount.
  """
  @spec captcha_provider_wire() :: String.t()
  def captcha_provider_wire do
    Grappa.Admission.Config.config().captcha_provider.wire_name()
  end
end
