defmodule Grappa.Dcc.TransferTest do
  use ExUnit.Case, async: true

  alias Grappa.Dcc.Transfer
  alias Grappa.IRC.DCC.Offer

  @loopback {127, 0, 0, 1}

  setup do
    dir = Path.join(System.tmp_dir!(), "dcc-transfer-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf(dir) end)
    {:ok, dir: dir, path: Path.join(dir, "spooled.bin")}
  end

  # A fake DCC sender: listens on an ephemeral loopback port, hands the
  # caller the port, and runs `serve` against the accepted socket. This
  # is a REAL socket on purpose — the boundary under test IS TCP, and
  # mocking :gen_tcp would test our own mock's idea of a short read.
  defp sender(serve) do
    {:ok, listen} = :gen_tcp.listen(0, [:binary, ip: @loopback, active: false, reuseaddr: true])
    {:ok, port} = :inet.port(listen)

    task =
      Task.async(fn ->
        {:ok, socket} = :gen_tcp.accept(listen, 5_000)
        result = serve.(socket)
        # Wait for OUR side to close rather than closing first. The
        # receiver acks every chunk, so a sender that closes with those
        # acks still unread makes the kernel send RST instead of FIN —
        # and an RST discards the payload still in flight. Measured: 2-3
        # of 20 chunks vanished, read by the code under test as a short
        # transfer that never happened.
        drain_until_closed(socket)
        :gen_tcp.close(socket)
        :gen_tcp.close(listen)
        result
      end)

    {port, task}
  end

  defp drain_until_closed(socket) do
    case :gen_tcp.recv(socket, 0, 5_000) do
      {:ok, _} -> drain_until_closed(socket)
      {:error, _} -> :ok
    end
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

  defp opts, do: [connect_timeout_ms: 2_000, idle_timeout_ms: 2_000]

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
      # aborted transfer reaps its own temp file rather than waiting for
      # a sweeper to notice an orphan nobody recorded.
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
          read_all_acks(socket, [])
        end)

      dir = Path.join(System.tmp_dir!(), "dcc-ack-#{System.unique_integer([:positive])}")
      File.mkdir_p!(dir)
      on_exit(fn -> File.rm_rf(dir) end)

      assert {:ok, 8_000} = Transfer.run(offer(port, 8_000), Path.join(dir, "a.bin"), opts())

      acks = Task.await(task, 5_000)

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
                 idle_timeout_ms: 150
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

  defp chunk_every_binary(<<>>, _), do: []
  defp chunk_every_binary(bin, size) when byte_size(bin) <= size, do: [bin]

  defp chunk_every_binary(bin, size) do
    rest = binary_part(bin, size, byte_size(bin) - size)
    [binary_part(bin, 0, size) | chunk_every_binary(rest, size)]
  end

  defp read_all_acks(socket, acc) do
    case :gen_tcp.recv(socket, 4, 1_000) do
      {:ok, <<n::unsigned-big-integer-size(32)>>} -> read_all_acks(socket, [n | acc])
      {:error, _} -> Enum.reverse(acc)
    end
  end
end
