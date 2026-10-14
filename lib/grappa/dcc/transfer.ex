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
  stranger-pushed persists un-reaped" has to hold on the abort path too.
  `Grappa.Dcc.Reaper`'s orphan pass would find the bytes as well, but
  only after its grace (issue 2404); removing them here frees the disk
  the moment the transfer is known dead. That pass is the backstop for
  when this arm never runs at all — the task killed mid-drain.

  ## The deadline (issue 2405)

  The idle timeout bounds SILENCE, and every arriving byte starts it
  again, so on its own it never bounded how LONG a sender could take: one
  byte every 29 seconds held a socket, a file handle and this task for as
  long as the sender liked. So the drain also runs against a deadline
  fixed when the connection opens — one idle allowance plus the DECLARED
  size at the floor rate the caller passes — and every wait is the
  shorter of the idle timeout and the time left. Past it the transfer
  fails `{:too_slow, received, declared, elapsed_ms}`, with what was
  observed rather than a bare atom, and the partial goes like any other.

  Proportional to the claim, not a constant: a fixed budget large enough
  for the biggest file the ceiling admits would hand a stranger the same
  hours on a one-kilobyte offer. And the claim is safe to trust here
  because it is already capped by `Grappa.Dcc.Policy` and the stream is
  truncated at it — declaring big buys a sender time only up to a file
  the operator agreed to take.

  ## The ack stream

  After every write, the receiver sends the CUMULATIVE byte count as a
  32-bit big-endian word. It is redundant over TCP and the protocol has
  no use for it here — but many classic senders block until they see it,
  so a receiver that never acked would hang against them rather than
  fail cleanly. Sent best-effort: a failed ack does not fail a transfer
  whose bytes are arriving fine.

  🔴 **And it can never block (issue 2405).** It used to be a plain
  synchronous send: against a sender that never reads, the acks filled
  its receive window, our send buffer and the driver queue, and the next
  one parked this task with no timeout — no deadline could fire, because
  the clock is only read between waits. The socket now sends with
  `send_timeout: 0`, which the inet driver answers `{:error, :timeout}` at
  once when its queue is past the high watermark (`tcp_sendv` in
  `inet_drv.c`) instead of suspending the caller. That answer means the
  sender is not reading, so acking STOPS for the rest of the transfer and
  the drain carries on — further acks would only queue behind the ones
  it ignored, and a sender that ignores them does not need them. The acks
  already queued are then DISCARDED at close (`close/1`): kept, they hold
  the socket open until a peer that has stopped reading reads them.
  """

  # Top-level for now because the `Grappa.Dcc` context it will sit under
  # does not exist yet — where the spooled bytes land is still open
  # (issue 2089). When that context lands this should become a module
  # INSIDE it rather than a sibling, unless a reason to keep it apart
  # appears; it has none today.
  use Boundary, top_level?: true, deps: [Grappa.IRC]

  alias Grappa.IRC.DCC.Offer

  require Logger

  @type opts :: [
          connect_timeout_ms: pos_integer(),
          idle_timeout_ms: pos_integer(),
          min_rate_bytes_per_second: pos_integer()
        ]

  @typedoc """
  Why a transfer did not complete. Every variant is REPORTABLE — issue
  2089 requires a synthesised status message for each.
  """
  @type failure ::
          {:short_transfer, non_neg_integer(), non_neg_integer()}
          | {:too_slow, non_neg_integer(), non_neg_integer(), non_neg_integer()}
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
    idle_ms = Keyword.fetch!(opts, :idle_timeout_ms)
    min_rate = Keyword.fetch!(opts, :min_rate_bytes_per_second)
    budget = %{idle_ms: idle_ms, deadline_ms: deadline_ms(offer.size, idle_ms, min_rate)}

    # The filesystem is checked FIRST: there is no point opening a
    # socket to a stranger when the bytes had nowhere to go.
    case File.open(path, [:write, :binary, :raw]) do
      {:ok, file} -> connect_and_drain(offer, path, file, connect_timeout_ms, budget)
      {:error, posix} -> {:error, {:fs, posix}}
    end
  end

  # One idle allowance — what a single stall is already granted — plus the
  # declared size at the floor rate. See the moduledoc.
  defp deadline_ms(declared, idle_ms, min_rate), do: idle_ms + div(declared * 1_000, min_rate)

  defp connect_and_drain(%Offer{} = offer, path, file, connect_timeout_ms, budget) do
    # `send_timeout: 0` is what keeps the ack from ever blocking — see the
    # moduledoc. It is the only send this socket makes.
    case :gen_tcp.connect(offer.ip, offer.port, [:binary, active: false, send_timeout: 0], connect_timeout_ms) do
      {:ok, socket} ->
        # The clock starts once the connection is up: the dial has its own
        # budget, and the deadline is for the bytes.
        started_at = now_ms()

        xfer = %{
          socket: socket,
          file: file,
          declared: offer.size,
          idle_ms: budget.idle_ms,
          started_at: started_at,
          deadline_at: started_at + budget.deadline_ms,
          acking: true
        }

        result = drain(xfer, 0)
        :ok = close(socket)
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
  defp drain(%{declared: declared}, received) when received >= declared do
    {:ok, declared}
  end

  defp drain(xfer, received) do
    now = now_ms()

    if now >= xfer.deadline_at,
      do: {:error, {:too_slow, received, xfer.declared, now - xfer.started_at}},
      else: receive_chunk(xfer, received, min(xfer.idle_ms, xfer.deadline_at - now))
  end

  defp receive_chunk(xfer, received, wait_ms) do
    # `recv/3` with length 0 hands back whatever has arrived, bounded by
    # the socket's receive buffer — so the clamp is against the bytes
    # STILL OWED, never a read-size of our own. Clamping to a chunk size
    # instead would silently discard the remainder of an arrived packet.
    case :gen_tcp.recv(xfer.socket, 0, wait_ms) do
      {:ok, data} ->
        keep = clamp(data, xfer.declared - received)

        case :file.write(xfer.file, keep) do
          :ok ->
            total = received + byte_size(keep)
            drain(ack(xfer, total), total)

          {:error, posix} ->
            {:error, {:fs, posix}}
        end

      {:error, :closed} ->
        {:error, {:short_transfer, received, xfer.declared}}

      # The wait was what was LEFT of the deadline, not a whole idle
      # window, so this is the deadline: go round once more and let the
      # clock in `drain/2` report it with what it observed.
      {:error, :timeout} when wait_ms < xfer.idle_ms ->
        drain(xfer, received)

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
  # into a failure. `:timeout` is the one answer that changes anything —
  # it is how `send_timeout: 0` says the sender is not reading, and the
  # moduledoc says why acking stops there for good.
  defp ack(%{acking: false} = xfer, _), do: xfer

  defp ack(xfer, total) do
    case :gen_tcp.send(xfer.socket, <<total::unsigned-big-integer-size(32)>>) do
      {:error, :timeout} -> %{xfer | acking: false}
      _ -> xfer
    end
  end

  defp now_ms, do: System.monotonic_time(:millisecond)

  # Output still in the driver's queue at the end means the peer stopped
  # reading what we send, and a plain close would wait for it twice over:
  # in `prim_inet:close/1` (five seconds without progress, three minutes at
  # most), then in the driver, which keeps a closing port with queued
  # output open until it drains (`tcp_inet_flush`, OTP-7615) — for as long
  # as the peer likes. One socket held per such transfer; and ports stuck
  # that way are what kept the VM of issue 2405's first CI run alive 13
  # minutes after its suite ended. A zero linger makes the driver discard
  # the queue and the kernel reset the connection: nothing in that queue
  # was going to be read. An empty queue closes gracefully as before, so a
  # sender waiting for its final ack still gets it.
  defp close(socket) do
    case :inet.getstat(socket, [:send_pend]) do
      {:ok, [send_pend: 0]} -> :ok
      # Bytes queued, or a socket too broken to say: either way, no wait.
      _ -> _ = :inet.setopts(socket, linger: {true, 0})
    end

    :gen_tcp.close(socket)
  end

  defp finish({:ok, _} = ok, _, file) do
    :ok = :file.close(file)
    ok
  end

  defp finish({:error, _} = error, path, file) do
    :ok = :file.close(file)

    # The abort arm of "nothing stranger-pushed persists un-reaped": a
    # partial spool is removed here, at once, rather than left an hour for
    # the reaper's orphan pass to notice.
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
