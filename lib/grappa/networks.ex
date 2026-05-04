defmodule Grappa.Networks do
  @moduledoc """
  Operator-managed IRC network bindings — slim core: network slug CRUD.

  Networks + servers are shared per-deployment infra (one Azzurra row,
  many users bind it). Credentials are per-(user, network) and carry
  the Cloak-encrypted upstream password. The umbrella context is split
  into four cohesive sub-modules:

    * `Grappa.Networks` (this module) — network slug CRUD:
      `find_or_create_network/1`, `get_network_by_slug/1`,
      `get_network_by_slug!/1`, `get_network!/1`.
    * `Grappa.Networks.Servers` — server-endpoint CRUD + selection
      policy (`add_server/2`, `list_servers/1`, `pick_server!/1`,
      `remove_server/3`).
    * `Grappa.Networks.Credentials` — per-(user, network) credential
      lifecycle including the cascade-on-empty `unbind_credential/2`
      transaction (Session/Scrollback orchestration).
    * `Grappa.Networks.SessionPlan` — pure resolver: credential →
      primitive `t:Grappa.Session.start_opts/0` map.

  Boundary deps + exports remain at this umbrella; sub-modules share
  the same Boundary contract by default.
  """
  use Boundary,
    top_level?: true,
    deps: [
      Grappa.Accounts,
      Grappa.EncryptedBinary,
      Grappa.IRC,
      Grappa.Repo,
      Grappa.Scrollback,
      Grappa.Session,
      Grappa.Vault
    ],
    exports: [Network, NoServerError, Server, Credential, Credentials, Servers, SessionPlan, Wire]

  alias Grappa.Networks.Network
  alias Grappa.Repo

  @doc """
  Idempotently fetches-or-creates a network by slug. Concurrent
  callers race on the unique index — the loser retries the
  `Repo.get_by/2` once and returns the just-inserted row. Genuine
  validation failures (bad slug) still return `{:error, changeset}`.

  The retry lives here, not at every call site, so callers can do the
  one-armed `{:ok, network} = ...` match without each one re-deriving
  the race-handling rule.
  """
  @spec find_or_create_network(%{required(:slug) => String.t()}) ::
          {:ok, Network.t()} | {:error, Ecto.Changeset.t()}
  def find_or_create_network(%{slug: slug} = attrs) when is_binary(slug) do
    case Repo.get_by(Network, slug: slug) do
      %Network{} = net -> {:ok, net}
      nil -> insert_or_recover(attrs, slug)
    end
  end

  # Insert; on changeset error, look once more — if the row is now
  # there, we lost the race and the unique-index violation isn't a
  # validation failure. If it still isn't there, the changeset really
  # is invalid (bad slug, etc.) — surface it.
  defp insert_or_recover(attrs, slug) do
    case %Network{} |> Network.changeset(attrs) |> Repo.insert() do
      {:ok, net} ->
        {:ok, net}

      {:error, %Ecto.Changeset{} = cs} ->
        case Repo.get_by(Network, slug: slug) do
          %Network{} = net -> {:ok, net}
          nil -> {:error, cs}
        end
    end
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
  @spec update_network_caps(Network.t(), %{
          optional(:max_concurrent_sessions) => integer() | nil,
          optional(:max_per_client) => integer() | nil
        }) :: {:ok, Network.t()} | {:error, Ecto.Changeset.t()}
  def update_network_caps(%Network{} = network, attrs) when is_map(attrs) do
    network
    |> Network.changeset(attrs)
    |> Repo.update()
  end
end
