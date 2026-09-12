defmodule Grappa.Dcc.Transfer do
  @moduledoc """
  The DCC RECEIVE transport: dial a peer's advertised socket, drain it to
  a spool file, truncate at the declared size, ack (issue 2089).

  This module is deliberately DUMB. It decides nothing about whether the
  transfer *should* happen — not the SSRF class of the address, not the
  per-transfer cap, not the daily quota, not the user's consent. All of
  those are policy on the OFFER and are settled before a caller gets
  here, in one place, so that each refusal maps to its own reported
  reason. Issue 2089's rule is that no outcome is silent, and a
  transport that also judged would have collapsed several distinct
  refusals into one.

  Keeping the gate out also keeps this module honestly testable: its
  tests dial real loopback sockets, which an SSRF gate would refuse.
  That is a consequence of the split, not its reason — but a design whose
  tests need production weakened to pass is the wrong design, and this
  one does not.

  ## Truncation is the whole point of the declared size

  `size` is a CLAIM the sender made before we dialled, and the
  per-transfer cap was checked against that claim. So the drain stops at
  exactly that many bytes no matter how many the peer pushes: a sender
  that declares 1 KiB and streams 50 MiB gets 1 KiB stored and the
  connection dropped. Without this, declaring low would be a general
  bypass of every size policy upstream of here.

  The opposite lie is NOT forgiven. A peer that closes before the
  declared count is a `{:short_transfer, received, declared}` error, and
  the partial spool file is removed on the way out — "nothing
  stranger-pushed persists un-reaped" has to hold on the abort path too,
  and an orphan nobody recorded is precisely what no sweeper can find.

  ## The ack stream

  After every write, the receiver sends the CUMULATIVE byte count as a
  32-bit big-endian word. It is redundant over TCP and the protocol has
  no use for it here — but many classic senders block until they see it,
  so a receiver that never acked would hang against them rather than
  fail cleanly. Sent best-effort: a failed ack does not fail a transfer
  whose bytes are arriving fine.
  """

  # Top-level for now because the `Grappa.Dcc` context it will sit under
  # does not exist yet — where the spooled bytes land is still open
  # (issue 2089). When that context lands this should become a module
  # INSIDE it rather than a sibling, unless a reason to keep it apart
  # appears; it has none today.
  use Boundary, top_level?: true, deps: [Grappa.IRC]

  alias Grappa.IRC.DCC.Offer

  require Logger

  @type opts :: [connect_timeout_ms: pos_integer(), idle_timeout_ms: pos_integer()]

  @typedoc """
  Why a transfer did not complete. Every variant is REPORTABLE — issue
  2089 requires a synthesised status message for each.
  """
  @type failure ::
          {:short_transfer, non_neg_integer(), non_neg_integer()}
          | :connect_refused
          | :connect_timeout
          | :idle_timeout
          | {:tcp, term()}
          | {:fs, term()}

  @doc """
  Drains `offer` into `path`, returning the byte count actually stored.

  Returns `{:ok, offer.size}` on a complete transfer — the count is
  always the declared size, because a longer stream is truncated to it
  and a shorter one is an error rather than a success.

  On ANY failure the spool file is removed before returning, so a
  caller that ignored the error still cannot leak bytes onto disk.
  """
  @spec run(Offer.t(), Path.t(), opts()) :: {:ok, non_neg_integer()} | {:error, failure()}
  def run(%Offer{} = offer, path, opts) when is_binary(path) do
    connect_timeout_ms = Keyword.fetch!(opts, :connect_timeout_ms)
    idle_timeout_ms = Keyword.fetch!(opts, :idle_timeout_ms)

    # The filesystem is checked FIRST: there is no point opening a
    # socket to a stranger when the bytes had nowhere to go.
    case File.open(path, [:write, :binary, :raw]) do
      {:ok, file} -> connect_and_drain(offer, path, file, connect_timeout_ms, idle_timeout_ms)
      {:error, posix} -> {:error, {:fs, posix}}
    end
  end

  defp connect_and_drain(%Offer{} = offer, path, file, connect_timeout_ms, idle_timeout_ms) do
    case :gen_tcp.connect(offer.ip, offer.port, [:binary, active: false], connect_timeout_ms) do
      {:ok, socket} ->
        result = drain(socket, file, offer.size, 0, idle_timeout_ms)
        :ok = :gen_tcp.close(socket)
        finish(result, path, file)

      {:error, reason} ->
        finish({:error, connect_failure(reason)}, path, file)
    end
  end

  defp connect_failure(:econnrefused), do: :connect_refused
  defp connect_failure(:timeout), do: :connect_timeout
  defp connect_failure(reason), do: {:tcp, reason}

  # `received == declared` is the ONLY success. Reaching it with bytes
  # still queued on the socket is fine and intended — we close on the
  # sender mid-push rather than store past the declaration.
  defp drain(_, _, declared, received, _) when received >= declared do
    {:ok, declared}
  end

  defp drain(socket, file, declared, received, idle_timeout_ms) do
    # `recv/3` with length 0 hands back whatever has arrived, bounded by
    # the socket's receive buffer — so the clamp is against the bytes
    # STILL OWED, never a read-size of our own. Clamping to a chunk size
    # instead would silently discard the remainder of an arrived packet.
    case :gen_tcp.recv(socket, 0, idle_timeout_ms) do
      {:ok, data} ->
        keep = clamp(data, declared - received)

        case :file.write(file, keep) do
          :ok ->
            total = received + byte_size(keep)
            :ok = ack(socket, total)
            drain(socket, file, declared, total, idle_timeout_ms)

          {:error, posix} ->
            {:error, {:fs, posix}}
        end

      {:error, :closed} ->
        {:error, {:short_transfer, received, declared}}

      {:error, :timeout} ->
        {:error, :idle_timeout}

      {:error, reason} ->
        {:error, {:tcp, reason}}
    end
  end

  defp clamp(data, want) when byte_size(data) <= want, do: data
  defp clamp(data, want), do: binary_part(data, 0, want)

  # Best-effort by design: the bytes are already on disk, and a sender
  # that has stopped reading its socket must not turn a good transfer
  # into a failure.
  defp ack(socket, total) do
    _ = :gen_tcp.send(socket, <<total::unsigned-big-integer-size(32)>>)
    :ok
  end

  defp finish({:ok, _} = ok, _, file) do
    :ok = :file.close(file)
    ok
  end

  defp finish({:error, _} = error, path, file) do
    :ok = :file.close(file)

    # The abort arm of "nothing stranger-pushed persists un-reaped": a
    # partial spool is removed here rather than left for a sweeper that
    # has no row to find it by.
    case File.rm(path) do
      :ok -> :ok
      {:error, :enoent} -> :ok
      # The path rides in the MESSAGE, not in metadata: the Logger
      # allowlist in `config/config.exs` carries one considered key per
      # reason, and a spool path is not worth widening it for.
      {:error, posix} -> Logger.error("dcc transfer: partial spool left behind at #{path}", error: inspect(posix))
    end

    error
  end
end
