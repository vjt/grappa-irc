defmodule Grappa.Admission do
  @moduledoc """
  Admission-control verbs for new IRC session creation.

  Two verbs:

    * `check_capacity/1` — composes (a) NetworkCircuit gate,
      (b) per-network total cap, (c) per-(client, network) cap.
      Local + cheap (Registry count + one DB query). Consumed by
      `Grappa.Visitors.Login`, `Grappa.Bootstrap`, and any future
      session-spawning surface.

    * `verify_captcha/2` — delegates to the configured Captcha
      behaviour impl. HTTP-bound, only required for `:login_fresh`
      flow.

  Cap dimensions and where they're checked:

  | cap                 | applies to                | source                                         |
  |---------------------|---------------------------|------------------------------------------------|
  | NetworkCircuit      | all flows                 | ETS via `Admission.NetworkCircuit.check/1`     |
  | network total       | all flows                 | `Registry.count_match/3` on SessionRegistry    |
  | client per network  | flows with non-nil client | SQL union over accounts_sessions               |

  Bootstrap flows (`:bootstrap_user`, `:bootstrap_visitor`) carry
  `client_id: nil` because there's no live client at cold-start;
  they bypass the client cap by construction.

  Identity-tier exemptions: NONE. Per Section 1 of the design,
  cap is the operator's knob (raise per-network `max_per_client` to
  allow multi-nick power users); identity tier exempts only CAPTCHA
  (in `verify_captcha/2`), not concurrency.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Accounts, Grappa.Networks, Grappa.Repo, Grappa.Visitors],
    exports: [Captcha, NetworkCircuit]

  import Ecto.Query

  alias Grappa.Accounts.Session, as: AccountSession
  alias Grappa.Admission.NetworkCircuit
  alias Grappa.Networks.{Credential, Network}
  alias Grappa.Repo
  alias Grappa.Visitors.Visitor

  @type subject_kind :: :user | :visitor
  @type flow :: :login_fresh | :login_existing | :bootstrap_user | :bootstrap_visitor

  @type capacity_input :: %{
          subject_kind: subject_kind(),
          subject_id: Ecto.UUID.t() | nil,
          network_id: integer(),
          client_id: String.t() | nil,
          flow: flow()
        }

  @type capacity_error :: :client_cap_exceeded | :network_cap_exceeded | :network_circuit_open

  @default_max_per_client_per_network Application.compile_env(
                                        :grappa,
                                        [:admission, :default_max_per_client_per_network],
                                        1
                                      )

  @doc """
  Compose all capacity checks for a candidate new session.

  Order: NetworkCircuit (cheapest, ETS) → network total
  (Registry count) → client cap (DB query). Bail at first failure.

  `:ok` means the session may be spawned. Any error tag means caller
  must NOT spawn — they should surface the error to the user (Login)
  or skip the row + log (Bootstrap).
  """
  @spec check_capacity(capacity_input()) :: :ok | {:error, capacity_error()}
  def check_capacity(%{network_id: network_id} = input) when is_integer(network_id) do
    with :ok <- check_circuit(network_id),
         :ok <- check_network_total(network_id),
         :ok <- check_client_cap(input) do
      :ok
    end
  end

  defp check_circuit(network_id) do
    case NetworkCircuit.check(network_id) do
      :ok -> :ok
      {:error, :open, _retry_after} -> {:error, :network_circuit_open}
    end
  end

  defp check_network_total(network_id) do
    case Repo.get(Network, network_id) do
      %Network{max_concurrent_sessions: nil} ->
        :ok

      %Network{max_concurrent_sessions: cap} ->
        live = count_live_sessions(network_id)
        if live >= cap, do: {:error, :network_cap_exceeded}, else: :ok

      nil ->
        :ok
    end
  end

  defp count_live_sessions(network_id) do
    Registry.count_match(Grappa.SessionRegistry, {:_, network_id}, :_)
  end

  # Bootstrap flows have nil client — skip client-cap check.
  defp check_client_cap(%{client_id: nil}), do: :ok

  defp check_client_cap(%{client_id: client_id, network_id: network_id} = _input)
       when is_binary(client_id) do
    cap = effective_max_per_client(network_id)
    count = count_subjects_for_client_on_network(client_id, network_id)
    if count >= cap, do: {:error, :client_cap_exceeded}, else: :ok
  end

  defp effective_max_per_client(network_id) do
    case Repo.get(Network, network_id) do
      %Network{max_per_client: nil} -> @default_max_per_client_per_network
      %Network{max_per_client: cap} -> cap
      nil -> @default_max_per_client_per_network
    end
  end

  # Count of distinct subjects (visitor_id ∪ user_id) reachable from
  # accounts_sessions where client_id matches AND the subject is bound
  # to the given network_id (visitor.network_slug = network's slug, OR
  # user has a Credential for network_id). Only non-revoked sessions
  # count.
  defp count_subjects_for_client_on_network(client_id, network_id) do
    %Network{slug: slug} = Repo.get!(Network, network_id)

    visitor_count =
      from(s in AccountSession,
        join: v in Visitor,
        on: v.id == s.visitor_id,
        where:
          s.client_id == ^client_id and
            v.network_slug == ^slug and
            is_nil(s.revoked_at),
        distinct: true,
        select: s.visitor_id
      )
      |> Repo.aggregate(:count, :visitor_id)

    user_count =
      from(s in AccountSession,
        join: c in Credential,
        on: c.user_id == s.user_id and c.network_id == ^network_id,
        where:
          s.client_id == ^client_id and
            is_nil(s.revoked_at),
        distinct: true,
        select: s.user_id
      )
      |> Repo.aggregate(:count, :user_id)

    visitor_count + user_count
  end
end
