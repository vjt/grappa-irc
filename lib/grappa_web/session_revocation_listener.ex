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

  ## Why the catch-all does not weaken the teardown (#1338 M-S2)

  This module used to have no catch-all `handle_info/2`, on the argument
  that `Revocations.announce/1` is the sole publisher on the topic, so an
  unrecognised message means a second publisher appeared and a crash
  surfaces it. The catch-all keeps that surfacing — it logs at warning
  with the allowlisted `unexpected:` key, the same shape `Grappa.IRC.Client`
  uses — while removing the two ways the crash made teardown WORSE, not
  better:

    * The teardown this process performs is per-MESSAGE and stateless. A
      crash cannot roll back or retry the unrecognised message; it only
      discards the mailbox behind it, so a genuine `{:sessions_revoked, _}`
      queued after an unknown one dies with it. The catch-all drops the
      message it cannot read and serves the next — strictly more teardown,
      never less.
    * A second publisher is a repeating condition, not a one-shot. Crashing
      per message walks the supervisor's restart intensity, and the process
      that turns bearer death into WS teardown is then gone for good — the
      failure mode is silent revocations, precisely what the crash was
      meant to prevent.

  Nothing here recovers from an unknown message: it is logged loudly and
  dropped. What survives is the ability to tear down the NEXT one.
  """

  use GenServer

  alias Grappa.Accounts.Revocations
  alias Grappa.Subject
  alias GrappaWeb.UserSocket

  require Logger

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

  def handle_info(msg, state) do
    Logger.warning("unexpected mailbox message", unexpected: inspect(msg))
    {:noreply, state}
  end
end
