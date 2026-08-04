defmodule Grappa.Accounts.WebAuthnChallengeStore do
  @moduledoc """
  One-shot, process-local WebAuthn ceremony challenge store.

  A ceremony that is never completed is never `take/2`n, so the TTL check
  on the read path alone retained abandoned entries for the life of the
  node — and the endpoint that fills this store sits on the unauthenticated
  login door. The periodic sweep is what bounds it.
  """
  use GenServer

  @ttl_seconds 300
  @sweep_interval_ms :timer.seconds(60)

  @type purpose :: :registration | :authentication | :mode_change | :passwordless | :second_factor
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

  @doc """
  How long a stored ceremony stays claimable, single-sourced so a test
  can position a clock relative to it instead of restating the number.
  """
  # `unquote(@ttl_seconds)` pins the spec to the compile-time singleton,
  # mirroring `ChannelDirectory.ttl_ms/0`. A bare `pos_integer()` is a
  # `:underspecs` supertype of the success typing and fails the gate.
  @spec ttl_seconds() :: unquote(@ttl_seconds)
  def ttl_seconds, do: @ttl_seconds

  @doc "Atomically consumes a live challenge with the expected purpose."
  @spec take(String.t(), purpose()) :: {:ok, Wax.Challenge.t(), metadata()} | {:error, :invalid_challenge}
  def take(id, purpose) when is_binary(id) do
    take(id, purpose, System.monotonic_time(:second))
  end

  @doc """
  Same as `take/2` with an explicit monotonic `now` — the test seam that
  makes the TTL branch reachable without sleeping the real TTL. Sampling
  the clock inside left the expiry guard the one rule here nothing could
  cover, on the store that backs an unauthenticated login door. Mirrors
  `Grappa.RateLimit.FailureWindow.check/4`.
  """
  @spec take(String.t(), purpose(), integer()) ::
          {:ok, Wax.Challenge.t(), metadata()} | {:error, :invalid_challenge}
  def take(id, purpose, now) when is_binary(id) and is_integer(now) do
    GenServer.call(__MODULE__, {:take, id, purpose, now})
  end

  @impl GenServer
  def init(state) do
    schedule_sweep()
    {:ok, state}
  end

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

  @impl GenServer
  def handle_info(:sweep, state) do
    schedule_sweep()
    {:noreply, drop_expired(state, System.monotonic_time(:second))}
  end

  defp schedule_sweep, do: Process.send_after(self(), :sweep, @sweep_interval_ms)

  defp drop_expired(state, now) do
    Map.reject(state, fn {_, {_, _, _, expires_at}} ->
      expires_at <= now
    end)
  end
end
