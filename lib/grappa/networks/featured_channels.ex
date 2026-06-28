defmodule Grappa.Networks.FeaturedChannels do
  @moduledoc """
  CRUD + read helpers for `Grappa.Networks.FeaturedChannel` rows scoped
  to a parent network (GH #85). Mirrors `Grappa.Networks.Servers`.

  Read shapes:

    * `list_channels/1` — all rows (admin listing), position-then-id asc.
    * `list_links/1` — enabled rows as `[%{name, description}]` for the
      public `GET /networks/:id/featured` delivery wire.
    * `featured_name_set/1` — enabled names as a downcased `MapSet` for
      the `/list` directory `featured: boolean` label.

  Delivery is on-display read (not a `/me` snapshot): operator config
  edits reach users on the next HomePane / directory render without a
  login round-trip or PubSub push.
  """
  import Ecto.Query

  alias Grappa.Networks.{FeaturedChannel, Network}
  alias Grappa.Repo

  @doc "Adds a featured channel to `network`; duplicate name → `{:error, :already_exists}`."
  @spec add_channel(Network.t(), map()) ::
          {:ok, FeaturedChannel.t()} | {:error, :already_exists | Ecto.Changeset.t()}
  def add_channel(%Network{id: network_id}, attrs) when is_map(attrs) do
    attrs = Map.put(attrs, :network_id, network_id)

    %FeaturedChannel{}
    |> FeaturedChannel.changeset(attrs)
    |> Repo.insert()
    |> classify()
  end

  @doc "All featured rows for `network` (admin listing), position-then-id asc."
  @spec list_channels(Network.t()) :: [FeaturedChannel.t()]
  def list_channels(%Network{id: network_id}) do
    Repo.all(ordered_query(network_id))
  end

  @doc "Enabled rows as `[%{name, description}]` for the public delivery wire."
  @spec list_links(Network.t()) :: [%{name: String.t(), description: String.t() | nil}]
  def list_links(%Network{id: network_id}) do
    network_id
    |> ordered_query()
    |> where([f], f.enabled == true)
    |> select([f], %{name: f.name, description: f.description})
    |> Repo.all()
  end

  @doc "Enabled channel names as a downcased `MapSet` for the /list directory label."
  @spec featured_name_set(Network.t()) :: MapSet.t(String.t())
  def featured_name_set(%Network{id: network_id}) do
    names =
      network_id
      |> ordered_query()
      |> where([f], f.enabled == true)
      |> select([f], f.name)
      |> Repo.all()

    MapSet.new(names)
  end

  @doc "Fetches a featured row by id, scoped to `network` (cross-network id → `:not_found`)."
  @spec get_channel(Network.t(), integer()) ::
          {:ok, FeaturedChannel.t()} | {:error, :not_found}
  def get_channel(%Network{id: network_id}, id) when is_integer(id) do
    case Repo.get(FeaturedChannel, id) do
      %FeaturedChannel{network_id: ^network_id} = fc -> {:ok, fc}
      _ -> {:error, :not_found}
    end
  end

  @doc "Updates a featured row; duplicate name → `{:error, :already_exists}`."
  @spec update_channel(FeaturedChannel.t(), map()) ::
          {:ok, FeaturedChannel.t()} | {:error, :already_exists | Ecto.Changeset.t()}
  def update_channel(%FeaturedChannel{} = fc, attrs) when is_map(attrs) do
    fc
    |> FeaturedChannel.changeset(attrs)
    |> Repo.update()
    |> classify()
  end

  @doc "Deletes a featured row. Idempotent — a stale (already-gone) row is `:ok`."
  @spec delete_channel(FeaturedChannel.t()) :: :ok
  def delete_channel(%FeaturedChannel{} = fc) do
    case Repo.delete(fc, stale_error_field: :id) do
      {:ok, _} -> :ok
      {:error, %Ecto.Changeset{errors: [{:id, _}]}} -> :ok
    end
  end

  @spec ordered_query(integer()) :: Ecto.Query.t()
  defp ordered_query(network_id) do
    from(f in FeaturedChannel,
      where: f.network_id == ^network_id,
      order_by: [asc: f.position, asc: f.id]
    )
  end

  # Map the (network_id, name) unique-constraint error to :already_exists,
  # mirroring Networks.Servers.classify_server_error/2. Match by constraint
  # NAME (not just `:unique`, and not the field the error attaches to — a
  # composite unique_constraint keys its error on the first listed field):
  # a future second unique constraint should fall through to a normal
  # changeset error rather than silently collapse into :already_exists.
  @name_index "network_featured_channels_network_id_name_index"
  @spec classify({:ok, FeaturedChannel.t()} | {:error, Ecto.Changeset.t()}) ::
          {:ok, FeaturedChannel.t()} | {:error, :already_exists | Ecto.Changeset.t()}
  defp classify({:ok, fc}), do: {:ok, fc}

  defp classify({:error, %Ecto.Changeset{errors: errors} = cs}) do
    if name_collision?(errors), do: {:error, :already_exists}, else: {:error, cs}
  end

  defp name_collision?(errors) do
    Enum.any?(errors, fn {_, {_, opts}} ->
      Keyword.get(opts, :constraint) == :unique and
        Keyword.get(opts, :constraint_name) == @name_index
    end)
  end
end
