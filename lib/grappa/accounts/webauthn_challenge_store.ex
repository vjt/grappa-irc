defmodule Grappa.Accounts.WebAuthnChallengeStore do
  @moduledoc "One-shot, process-local WebAuthn ceremony challenge store."
  use GenServer

  @ttl_seconds 300

  @type purpose :: :registration | :authentication | :mode_change
  @type metadata :: map()

  @doc false
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(_), do: GenServer.start_link(__MODULE__, %{}, name: __MODULE__)

  @doc "Stores a challenge once and returns its opaque ceremony ID."
  @spec put(Wax.Challenge.t(), purpose(), metadata()) :: String.t()
  def put(challenge, purpose, metadata) do
    id = Ecto.UUID.generate()
    expires_at = System.monotonic_time(:second) + @ttl_seconds
    :ok = GenServer.call(__MODULE__, {:put, id, challenge, purpose, metadata, expires_at})
    id
  end

  @doc "Atomically consumes a live challenge with the expected purpose."
  @spec take(String.t(), purpose()) :: {:ok, Wax.Challenge.t(), metadata()} | {:error, :invalid_challenge}
  def take(id, purpose) when is_binary(id) do
    GenServer.call(__MODULE__, {:take, id, purpose, System.monotonic_time(:second)})
  end

  @impl GenServer
  def init(state), do: {:ok, state}

  @impl GenServer
  def handle_call({:put, id, challenge, purpose, metadata, expires_at}, _, state) do
    {:reply, :ok, Map.put(state, id, {challenge, purpose, metadata, expires_at})}
  end

  def handle_call({:take, id, purpose, now}, _, state) do
    case Map.pop(state, id) do
      {{challenge, ^purpose, metadata, expires_at}, next} when expires_at > now ->
        {:reply, {:ok, challenge, metadata}, next}

      {_, next} ->
        {:reply, {:error, :invalid_challenge}, next}
    end
  end
end
