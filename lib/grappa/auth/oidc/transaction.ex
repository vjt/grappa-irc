defmodule Grappa.Auth.Oidc.Transaction do
  @moduledoc """
  One-shot, process-local store for an in-flight OIDC authorization
  round trip: the PKCE `code_verifier`, the `nonce`, the intent
  (`:login` or `:link`) and, for `:link`, the account the link belongs
  to.

  Modelled line for line on
  `Grappa.Accounts.WebAuthnChallengeStore` — it is the same beast as a
  WebAuthn ceremony: a short-lived, single-use, browser-bound challenge
  standing in front of a credential door, and the same retention trap
  (a ceremony never completed is never `take/1`n, and the door it
  fronts is unauthenticated). Same TTL, same sweep, same
  take-consumes-it semantics.

  ## Why the verifier lives HERE and not in the state token

  The `state` parameter travels through the browser and lands in the
  provider's access log, so it is public material as far as this flow is
  concerned — and `Phoenix.Token` is a SIGNATURE, not an envelope:
  anything inside it is base64url anyone can read. A code verifier that
  rode in it would be handed to the one party PKCE exists to defeat.
  `state` therefore carries only an opaque, unguessable transaction id
  (`GrappaWeb.OidcController.state_token/3`), and the verifier never leaves the
  BEAM. A single-use take also closes the replay the signature alone
  cannot: a captured `state` cannot be spent twice, so a second `code`
  cannot be driven into somebody else's valid round trip.
  """

  @moduledoc since: "1.6.0"

  use GenServer

  @ttl_seconds 300
  @sweep_interval_ms :timer.seconds(60)

  @enforce_keys [:verifier, :nonce, :intent, :user_id]
  defstruct @enforce_keys

  @type intent :: :login | :link

  @type t :: %__MODULE__{
          verifier: String.t(),
          nonce: String.t(),
          intent: intent(),
          user_id: Ecto.UUID.t() | nil
        }

  @doc false
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(_), do: GenServer.start_link(__MODULE__, %{}, name: __MODULE__)

  @doc """
  Stores a transaction and returns its opaque id alongside the
  challenge material the caller needs to build the authorization URL.
  """
  @spec put(intent(), Ecto.UUID.t() | nil) :: %{id: String.t(), transaction: t()}
  def put(intent, user_id) do
    transaction = %__MODULE__{
      verifier: pkce_verifier(),
      nonce: pkce_verifier(),
      intent: intent,
      user_id: user_id
    }

    id = Ecto.UUID.generate()
    expires_at = System.monotonic_time(:second) + @ttl_seconds
    :ok = GenServer.call(__MODULE__, {:put, id, transaction, expires_at})
    %{id: id, transaction: transaction}
  end

  # RFC 7636 §4.1: a 43..128-char base64url string. 64 random bytes →
  # 86 chars, and the same generator makes a fine `nonce`.
  @spec pkce_verifier() :: String.t()
  defp pkce_verifier do
    entropy_bytes = 64
    entropy_bytes |> :crypto.strong_rand_bytes() |> Base.url_encode64(padding: false)
  end

  @doc """
  How long a transaction stays claimable, single-sourced so a test can
  position a clock relative to it instead of restating the number.
  Mirrors `Grappa.Accounts.WebAuthnChallengeStore.ttl_seconds/0`.
  """
  # `unquote(@ttl_seconds)` pins the spec to the compile-time singleton,
  # mirroring `ChannelDirectory.ttl_ms/0`.
  @spec ttl_seconds() :: unquote(@ttl_seconds)
  def ttl_seconds, do: @ttl_seconds

  @doc "Atomically consumes a live transaction. Single-use: a second take refuses."
  @spec take(String.t()) :: {:ok, t()} | {:error, :invalid_transaction}
  def take(id) when is_binary(id) do
    take(id, System.monotonic_time(:second))
  end

  @doc """
  Same as `take/1` with an explicit monotonic `now` — the test seam that
  makes the TTL branch reachable without sleeping the real TTL. Mirrors
  `Grappa.Accounts.WebAuthnChallengeStore.take/3`.
  """
  @spec take(String.t(), integer()) :: {:ok, t()} | {:error, :invalid_transaction}
  def take(id, now) when is_binary(id) and is_integer(now) do
    GenServer.call(__MODULE__, {:take, id, now})
  end

  @impl GenServer
  def init(state) do
    schedule_sweep()
    {:ok, state}
  end

  @impl GenServer
  def handle_call({:put, id, transaction, expires_at}, _, state) do
    {:reply, :ok, Map.put(state, id, {transaction, expires_at})}
  end

  def handle_call({:take, id, now}, _, state) do
    case Map.pop(state, id) do
      {{%__MODULE__{} = transaction, expires_at}, next} when expires_at > now ->
        {:reply, {:ok, transaction}, next}

      {_, next} ->
        {:reply, {:error, :invalid_transaction}, next}
    end
  end

  @impl GenServer
  def handle_info(:sweep, state) do
    schedule_sweep()
    {:noreply, drop_expired(state, System.monotonic_time(:second))}
  end

  defp schedule_sweep, do: Process.send_after(self(), :sweep, @sweep_interval_ms)

  defp drop_expired(state, now) do
    Map.reject(state, fn {_, {_transaction, expires_at}} -> expires_at <= now end)
  end
end
