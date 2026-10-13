defmodule Grappa.DccTestSender do
  @moduledoc """
  The SENDER side of a DCC transfer, for tests of the receive path
  (`Grappa.Dcc.TransferTest`, `Grappa.Dcc.ReaperTest`).

  A REAL loopback socket on purpose — the boundary under test IS TCP, and
  mocking `:gen_tcp` would test our own mock's idea of a short read. Only
  the socket verbs live here; each test file builds its own sender out of
  them, because what the sender DOES (stream, dribble, stall, hold) is
  what the test is about.

  Loopback is reachable here and nowhere in production:
  `Grappa.Dcc.Policy` refuses a loopback offer before any socket is
  opened, which is why these tests drive `Grappa.Dcc.Transfer` directly
  rather than through a session.
  """

  @loopback {127, 0, 0, 1}

  @doc "The address every fake sender listens on."
  @spec loopback() :: :inet.ip4_address()
  def loopback, do: @loopback

  @doc "Listens on an ephemeral loopback port; returns the socket and the port."
  @spec listen() :: {:gen_tcp.socket(), :inet.port_number()}
  def listen do
    {:ok, listen} = :gen_tcp.listen(0, [:binary, ip: @loopback, active: false, reuseaddr: true])
    {:ok, port} = :inet.port(listen)
    {listen, port}
  end

  @doc """
  Reads until the RECEIVER closes, discarding what it reads.

  A sender must wait for our side to close rather than close first. The
  receiver acks every chunk, so a sender that closes with those acks still
  unread makes the kernel send RST instead of FIN — and an RST discards
  the payload still in flight. Measured: 2-3 of 20 chunks vanished, read
  by the code under test as a short transfer that never happened.
  """
  @spec drain_until_closed(:gen_tcp.socket()) :: :ok
  def drain_until_closed(socket) do
    case :gen_tcp.recv(socket, 0, 5_000) do
      {:ok, _} -> drain_until_closed(socket)
      {:error, _} -> :ok
    end
  end
end
