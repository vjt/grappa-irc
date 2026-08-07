defmodule GrappaWeb.SessionRevocationListener do
  @moduledoc """
  Translates the `Grappa.Accounts.Revocations` domain event into the
  existing socket teardown.

  The whole web-side half of the fix: the contexts announce that a
  subject's bearer sessions are dead, this process turns that into
  `GrappaWeb.UserSocket.disconnect_user_name/1`. It exists so the kill
  sites do not have to reach into the web layer — a context → web
  dependency `Boundary` refuses, and rightly: `Grappa.Accounts` has no
  business knowing that a WebSocket is what dies.

  Stateless and single-subscriber. It holds no socket registry of its
  own: the id-topic broadcast is addressed by label, and Phoenix's
  transport process is already subscribed to it. Nothing to reconcile,
  nothing to leak.

  Only started where the Endpoint is (see `Grappa.Application`): the
  teardown broadcast goes through `GrappaWeb.Endpoint`, and a node
  without one has no sockets to close either.

  No catch-all `handle_info/2`. `Revocations.announce/1` is the sole
  publisher on the topic, so an unrecognised message means a second
  publisher appeared — a crash surfaces it rather than dropping the
  teardown silently.
  """

  use GenServer

  alias Grappa.Accounts.Revocations
  alias Grappa.Subject
  alias GrappaWeb.UserSocket

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts), do: GenServer.start_link(__MODULE__, :ok, opts)

  @impl GenServer
  def init(:ok) do
    :ok = Revocations.subscribe()
    {:ok, :no_state}
  end

  @impl GenServer
  def handle_info({:sessions_revoked, subject}, state) do
    :ok = subject |> Subject.label() |> UserSocket.disconnect_user_name()
    {:noreply, state}
  end
end
