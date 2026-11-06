defmodule Grappa.Dcc.TransferTest do
  use ExUnit.Case, async: true

  alias Grappa.Dcc.Transfer
  alias Grappa.DccTestSender
  alias Grappa.IRC.DCC.Offer

  @loopback DccTestSender.loopback()

  setup do
    dir = Path.join(System.tmp_dir!(), "dcc-transfer-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf(dir) end)
    {:ok, dir: dir, path: Path.join(dir, "spooled.bin")}
  end

  # A fake DCC sender: listens on an ephemeral loopback port, hands the
  # caller the port, and runs `serve` against the accepted socket — see
  # `Grappa.DccTestSender` for why it is a real socket and why it drains
  # before closing.
  defp sender(serve) do
    {listen, port} = DccTestSender.listen([])

    task =
      Task.async(fn ->
        {:ok, socket} = :gen_tcp.accept(listen, 5_000)
        result = serve.(socket)
        DccTestSender.drain_until_closed(socket)
        :gen_tcp.close(socket)
        :gen_tcp.close(listen)
        result
      end)

    {port, task}
  end

  # Sends, then HALF-closes. A plain `close/1` can discard whatever is
  # still queued in the send buffer (measured here: 2 of 20 chunks went
  # missing and read as a short transfer), so the flush has to be
  # explicit or the fake sender injects a failure the code never had.
  # `shutdown(:write)` drains the queue and then sends FIN, which is also
  # exactly what a real sender's end-of-file looks like.
  defp send_all(socket, payload) do
    :ok = :gen_tcp.send(socket, payload)
    :ok = :gen_tcp.shutdown(socket, :write)
  end

  defp offer(port, size), do: %Offer{filename: "x.bin", ip: @loopback, port: port, size: size}

  # A floor of 1 B/s gives every transfer here a deadline far past its
  # own runtime, so only the tests ABOUT the deadline ever meet it.
  defp opts, do: [connect_timeout_ms: 2_000, idle_timeout_ms: 2_000, min_rate_bytes_per_second: 1]

  describe "run/3 — the happy path" do
    test "drains the declared byte count to disk and reports it", %{path: path} do
      payload = :crypto.strong_rand_bytes(10_000)
      {port, task} = sender(fn socket -> send_all(socket, payload) end)

      assert {:ok, 10_000} = Transfer.run(offer(port, 10_000), path, opts())
      Task.await(task, 5_000)

      assert File.read!(path) == payload
    end

    test "a zero-byte transfer completes without a single read", %{path: path} do
      {port, task} = sender(fn _ -> :ok end)

      assert {:ok, 0} = Transfer.run(offer(port, 0), path, opts())
      Task.await(task, 5_000)

      assert File.read!(path) == ""
    end

    test "a payload spanning many chunks is reassembled in order", %{path: path} do
      payload = :binary.copy(<<0, 1, 2, 3>>, 5_000)

      {port, task} =
        sender(fn socket ->
          # Deliberately dribbled: the reassembly must not depend on the
          # sender's framing.
          payload
          |> chunk_every_binary(1_000)
          |> Enum.each(fn piece -> :ok = :gen_tcp.send(socket, piece) end)

          :ok = :gen_tcp.shutdown(socket, :write)
        end)

      assert {:ok, 20_000} = Transfer.run(offer(port, 20_000), path, opts())
      Task.await(task, 5_000)

      assert File.read!(path) == payload
    end
  end

  describe "run/3 — the sender lies about size" do
    test "a sender that sends MORE than declared is truncated at the declaration", %{path: path} do
      # The declaration is what the per-transfer cap was checked against
      # before we dialled. Honouring anything beyond it would let a
      # sender outrun the cap by lying low.
      {port, task} = sender(fn socket -> send_all(socket, :binary.copy("A", 50_000)) end)

      assert {:ok, 1_000} = Transfer.run(offer(port, 1_000), path, opts())
      Task.await(task, 5_000)

      assert byte_size(File.read!(path)) == 1_000
    end

    test "a sender that closes EARLY is a reported short transfer, not a silent success", %{
      path: path
    } do
      {port, task} = sender(fn socket -> send_all(socket, :binary.copy("A", 40)) end)

      assert {:error, {:short_transfer, 40, 100}} =
               Transfer.run(offer(port, 100), path, opts())

      Task.await(task, 5_000)
    end

    test "a short transfer leaves no spooled file behind", %{path: path} do
      {port, task} = sender(fn socket -> send_all(socket, :binary.copy("A", 40)) end)

      assert {:error, {:short_transfer, 40, 100}} =
               Transfer.run(offer(port, 100), path, opts())

      Task.await(task, 5_000)

      # Issue 2089: nothing stranger-pushed persists un-reaped. An
      # aborted transfer reaps its own temp file at once rather than
      # waiting out the reaper's orphan grace (issue 2404).
      refute File.exists?(path)
    end
  end

  describe "run/3 — the ack stream" do
    test "acks the cumulative byte count as a 32-bit big-endian word" do
      # Many classic senders block until the receiver acks, so an
      # implementation that never acked would hang against them. Reading
      # the acks back here is the only way to prove we send them.
      payload = :binary.copy("A", 8_000)

      {port, task} =
        sender(fn socket ->
          :ok = :gen_tcp.send(socket, payload)
          read_acks(socket)
        end)

      dir = Path.join(System.tmp_dir!(), "dcc-ack-#{System.unique_integer([:positive])}")
      File.mkdir_p!(dir)
      on_exit(fn -> File.rm_rf(dir) end)

      assert {:ok, 8_000} = Transfer.run(offer(port, 8_000), Path.join(dir, "a.bin"), opts())

      {acks, _} = Task.await(task, 5_000)

      refute acks == [], "expected at least one ack word"
      assert List.last(acks) == 8_000, "the final ack must be the cumulative total"
      assert acks == Enum.sort(acks), "acks must be monotonically non-decreasing"
    end
  end

  describe "run/3 — failure is always typed, never silent" do
    test "a refused connection reports :connect_refused", %{path: path} do
      # Bind and immediately close to get a port nothing is listening on.
      {:ok, listen} = :gen_tcp.listen(0, [:binary, ip: @loopback, active: false])
      {:ok, port} = :inet.port(listen)
      :ok = :gen_tcp.close(listen)

      assert {:error, :connect_refused} = Transfer.run(offer(port, 100), path, opts())
      refute File.exists?(path)
    end

    test "a sender that accepts then goes silent reports :idle_timeout", %{path: path} do
      {port, task} = sender(fn _ -> Process.sleep(1_500) end)

      assert {:error, :idle_timeout} =
               Transfer.run(offer(port, 100), path,
                 connect_timeout_ms: 2_000,
                 idle_timeout_ms: 150,
                 min_rate_bytes_per_second: 1
               )

      Task.await(task, 5_000)
      refute File.exists?(path)
    end

    test "an unspoolable path fails BEFORE the socket is opened", %{dir: dir} do
      # Deliberately BOTH broken: a directory where a file is expected,
      # and a port with nothing listening. Asserting the filesystem
      # reason pins the ordering — we do not dial a stranger we could
      # not have stored the bytes for.
      {:ok, listen} = :gen_tcp.listen(0, [:binary, ip: @loopback, active: false])
      {:ok, dead_port} = :inet.port(listen)
      :ok = :gen_tcp.close(listen)

      unwritable = Path.join(dir, "adir")
      File.mkdir_p!(unwritable)

      assert {:error, {:fs, _}} = Transfer.run(offer(dead_port, 5), unwritable, opts())
    end
  end

  describe "run/3 — the total deadline (issue 2405)" do
    # The idle timeout bounds SILENCE, and each arriving byte starts it
    # again, so before 2405 nothing bounded how LONG a sender could take.
    # The deadline is the declared size at the floor rate plus one idle
    # allowance — here 1_000 ms + 100 B at 1_000 B/s = 1_100 ms.
    test "a sender trickling faster than the idle timeout is stopped at the deadline", %{path: path} do
      # One byte every 500 ms: the 1_000 ms idle timeout never fires, and
      # the 100 bytes would take fifty seconds.
      {port, task} = sender(fn socket -> trickle(socket, 100, 500) end)

      assert {:error, {:too_slow, received, 100, elapsed_ms}} =
               Transfer.run(offer(port, 100), path,
                 connect_timeout_ms: 2_000,
                 idle_timeout_ms: 1_000,
                 min_rate_bytes_per_second: 1_000
               )

      Task.await(task, 10_000)

      # Observed, not assumed: some bytes arrived, not all of them, and
      # the time reported is at least the deadline that stopped it.
      assert received in 1..99
      assert elapsed_ms >= 1_100

      # ...and not much more. The byte at 1_000 ms leaves 100 ms, and the
      # wait after it must be THAT, not another whole idle window: a drain
      # that only checked the clock between chunks would sit until the
      # byte at 1_500 ms.
      assert elapsed_ms < 1_400, "stopped after #{elapsed_ms} ms"

      # The abort arm of "nothing stranger-pushed persists un-reaped".
      refute File.exists?(path)
    end

    test "a sender above the floor rate finishes, past the idle allowance", %{path: path} do
      # 2_000 B/s against a 1_000 B/s floor: the 2_000 bytes take one
      # second, twice the idle allowance, and earn 500 ms + 2 s. A FIXED
      # budget of the idle allowance's size would cut this off halfway;
      # the deadline has to grow with what the sender declared.
      payload = :binary.copy("A", 2_000)

      {port, task} =
        sender(fn socket ->
          payload
          |> chunk_every_binary(100)
          |> Enum.each(fn piece ->
            :ok = :gen_tcp.send(socket, piece)
            Process.sleep(50)
          end)

          :ok = :gen_tcp.shutdown(socket, :write)
        end)

      assert {:ok, 2_000} =
               Transfer.run(offer(port, 2_000), path,
                 connect_timeout_ms: 2_000,
                 idle_timeout_ms: 500,
                 min_rate_bytes_per_second: 1_000
               )

      Task.await(task, 10_000)
      assert File.read!(path) == payload
    end
  end

  describe "run/3 — a sender that never reads its acks (issue 2405)" do
    # A sender that never reads leaves every ack we send in the path
    # between us: its receive window, our socket's send buffer, then the
    # driver's queue. Before 2405 the ack that found the queue past its
    # high watermark BLOCKED, with no timeout, and the transfer with it.
    #
    # The test puts the path in that state before the first byte flows.
    # Our socket's send buffer is shrunk to the kernel floor from outside,
    # and one large write of filler goes out on it, also from outside: the
    # code under test is not told. The sender takes what its receive
    # buffer holds (set to 64 KiB, so the amount is bounded), our kernel
    # holds some more, and the driver queues the rest, far past its high
    # watermark. The transfer's first ack then meets that queue.
    #
    # 🔴 Filled by one large write, not by the acks themselves (issue
    # 2554). The acks used to fill it, against a sender with a 1 KiB
    # receive buffer, and the test failed now and then with
    # `:idle_timeout`: thousands of 4-byte segments sometimes made the
    # SENDER'S kernel drop one its window had admitted, after which it
    # discarded everything we sent, window updates included, and never
    # sent again. No buffer size tried cured it. The filler goes out in
    # full-sized segments instead, and once the window is shut our acks
    # wait in our own queue and never reach the sender at all. The
    # measurements are in DESIGN_NOTES, `entry #2554`.
    #
    # The payload no longer has to fill anything, but it still has to last:
    # the queue is sampled every 5 ms, and at 8 MiB the transfer was over
    # in about 6, so a mutant that kept acking passed. 128 MiB takes about
    # 0.1 s unloaded.
    @unread_ack_payload 128 * 1024 * 1024

    test "the transfer neither hangs nor fails: acking stops, the bytes keep landing", %{path: path} do
      test = self()

      # The zero linger is the sender's, and it is cleanup: a red here
      # leaves both sockets with output queued, and a port in that state
      # does not finish closing (read in the OTP source) — the first CI run
      # of this test measured a VM still alive 13 minutes after its suite
      # ended. Discarding on the sender's side resets the connection, which
      # fails our side's queued write and frees both. `show_econnreset`
      # makes a reset read as one.
      {listen, port} = DccTestSender.listen(recbuf: 65_536, linger: {true, 0}, show_econnreset: true)
      mib = :binary.copy("A", 1024 * 1024)

      sender =
        Task.async(fn ->
          {:ok, socket} = :gen_tcp.accept(listen, 5_000)
          send(test, :accepted)

          receive do
            :go -> :ok
          end

          # An iolist of references to one MiB, so the payload costs one
          # MiB of memory, not 128.
          :ok = :gen_tcp.send(socket, List.duplicate(mib, div(@unread_ack_payload, byte_size(mib))))

          # Not a byte read until the transfer is over. Reading earlier
          # would drain the queue and release the stall this test is about.
          receive do
            :release -> :ok
          end

          {_, ended} = read_acks(socket)
          :gen_tcp.close(socket)
          :gen_tcp.close(listen)
          ended
        end)

      transfer = Task.async(fn -> Transfer.run(offer(port, @unread_ack_payload), path, opts()) end)
      assert_receive :accepted, 5_000
      socket = socket_of(transfer.pid)
      :ok = await_connected(socket)
      :ok = :inet.setopts(socket, sndbuf: 1_024)
      {:ok, [high_watermark: high]} = :inet.getopts(socket, [:high_watermark])

      # A MiB is far more than the sender's buffer and our kernel will take
      # together, so the driver keeps most of it. This write still answers
      # `:ok`: the driver weighs its watermark only against a queue that was
      # already there (`tcp_sendv` in `inet_drv.c`), which is exactly what
      # the transfer's first ack finds.
      :ok = :gen_tcp.send(socket, :binary.copy(<<0>>, 1024 * 1024))
      {:ok, [send_pend: filled]} = :inet.getstat(socket, [:send_pend])
      assert filled >= high, "the filler left #{filled} bytes queued, under #{high}"
      send(sender.pid, :go)

      # It must finish on its own while the sender is STILL holding off —
      # before 2405 the drain parked on an ack and this never returned.
      # Meanwhile, the driver's queue as seen from outside.
      {result, rise} = await_watching_queue(transfer, socket, 15_000)

      assert result == {:ok, {:ok, @unread_ack_payload}},
             "transfer: #{inspect(result)}; spooled: #{inspect(File.stat(path))}"

      # The first ack came back `:timeout` and joined the queue; nothing
      # after it did, so acking STOPPED. An ack per chunk would have added
      # four bytes for each of the thousands of chunks that followed.
      assert rise < 64, "the queue rose #{rise} bytes above its low point"

      # And what was still queued at the end was DISCARDED: our side reset
      # the connection. A graceful close would have waited on the sender to
      # read it and ended with a FIN, which reads as `:closed`.
      send(sender.pid, :release)
      assert Task.await(sender, 10_000) == :econnreset
    end
  end

  defp trickle(_, 0, _), do: :ok

  # One byte per `every_ms`, until the count is spent or the receiver hangs
  # up — whichever comes first, because the deadline is the point.
  defp trickle(socket, n, every_ms) do
    case :gen_tcp.send(socket, "A") do
      :ok ->
        Process.sleep(every_ms)
        trickle(socket, n - 1, every_ms)

      {:error, _} ->
        :ok
    end
  end

  # The transfer's socket, found by owner: `Transfer` opens its spool file
  # `:raw`, which is not a port, so the socket is the only port it holds.
  defp socket_of(pid) do
    [socket] = Enum.filter(Port.list(), &(Port.info(&1, :connected) == {:connected, pid}))
    socket
  end

  # Waits for the transfer's own connect to complete. The sender's accept
  # can come back first, and until the driver has seen the connect finish,
  # a write on the socket answers `:enotconn` (`inet_drv.c`); `peername`
  # turns `{:ok, _}` at the same moment.
  defp await_connected(socket) do
    case :inet.peername(socket) do
      {:ok, _} ->
        :ok

      {:error, :enotconn} ->
        Process.sleep(1)
        await_connected(socket)
    end
  end

  # Yields on `task` in 5 ms steps, sampling the socket's driver queue
  # (`send_pend`) at each; returns the yield and the most the queue ever
  # stood above its lowest earlier sample. A rise rather than a peak,
  # because the queue also DRAINS while the transfer runs: once the sender
  # starts talking, its segments carry a fresh window and our kernel takes
  # more filler — measured, 47 KB of it, against four bytes an ack. A
  # sample after the socket closed is skipped, not an error.
  defp await_watching_queue(task, socket, budget_ms), do: await_watching_queue(task, socket, budget_ms, nil, 0)

  defp await_watching_queue(_, _, budget_ms, _, rise) when budget_ms <= 0, do: {nil, rise}

  defp await_watching_queue(task, socket, budget_ms, low, rise) do
    {low, rise} =
      case :inet.getstat(socket, [:send_pend]) do
        {:ok, [send_pend: queued]} ->
          low = min(low || queued, queued)
          {low, max(rise, queued - low)}

        {:error, _} ->
          {low, rise}
      end

    case Task.yield(task, 5) do
      nil -> await_watching_queue(task, socket, budget_ms - 5, low, rise)
      result -> {result, rise}
    end
  end

  defp chunk_every_binary(<<>>, _), do: []
  defp chunk_every_binary(bin, size) when byte_size(bin) <= size, do: [bin]

  defp chunk_every_binary(bin, size) do
    rest = binary_part(bin, size, byte_size(bin) - size)
    [binary_part(bin, 0, size) | chunk_every_binary(rest, size)]
  end

  # Every ack word until the connection ends, and how it ended.
  defp read_acks(socket), do: read_acks(socket, [])

  defp read_acks(socket, acc) do
    case :gen_tcp.recv(socket, 4, 1_000) do
      {:ok, <<n::unsigned-big-integer-size(32)>>} -> read_acks(socket, [n | acc])
      {:error, reason} -> {Enum.reverse(acc), reason}
    end
  end
end
