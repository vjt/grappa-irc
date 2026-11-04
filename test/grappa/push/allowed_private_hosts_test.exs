defmodule Grappa.Push.AllowedPrivateHostsTest do
  @moduledoc """
  The operator's exemption from the push endpoint address policy (#2401):
  a host in `PUSH_ALLOWED_PRIVATE_HOSTS` may be private and plain `http`,
  at both doors — `Subscription.changeset/2` when a client registers, and
  `Grappa.Push.Sender` when it delivers.

  Every exempted case has its twin with the list empty, in the same
  describe: without it, a green would not say whether the exemption or
  some other path admitted the endpoint.

  `async: false` — the list lives in `:persistent_term`, global to the VM.
  """
  use Grappa.DataCase, async: false

  import ExUnit.CaptureLog
  import Grappa.AuthFixtures, only: [user_fixture: 0]
  import Grappa.PushFixtures, only: [stored_subscription!: 2]

  alias Grappa.Push
  alias Grappa.Push.Sender

  # Real P-256 client key + auth secret: the sender encrypts before it
  # dials, and random bytes fail there (same pair as `SenderTest`).
  @client_p256dh "BCfaYE5dGabdzef68MI0SN24b4Gsf1t_N3ftUlWaFGzkuudjHLor0CRjosM3c7SLZ7PfFufpsFUh8vsO1t8wCHs"
  @client_auth "3aw2ceVFv0OIBXxAvkAlSA"

  @payload %{
    title: "vjt",
    body: "ping in #sbiffo",
    tag: "libera:#sbiffo",
    url: "/?network=libera&channel=%23sbiffo"
  }

  setup do
    # Back to what boot stashed, from the same config it read.
    booted = Application.fetch_env!(:grappa, :push_allowed_private_hosts)
    on_exit(fn -> Push.boot_allowed_private_hosts(booted) end)
  end

  defp register(endpoint) do
    user = user_fixture()

    Push.create({:user, user.id}, %{
      endpoint: endpoint,
      p256dh_key: @client_p256dh,
      auth_key: @client_auth,
      user_agent: "Mozilla/5.0 allowed-private-hosts-test"
    })
  end

  defp refused?({:error, %Ecto.Changeset{errors: errors}}),
    do: match?({"must be an https URL on a public host", _}, errors[:endpoint])

  defp refused?({:ok, _}), do: false

  describe "registration" do
    @exempted ["http://push-catcher:3000/p/abc", "https://192.168.1.20/wp", "http://[fd00::20]:8080/wp"]

    test "an exempted host registers over plain http or on a private address" do
      Push.boot_allowed_private_hosts(["push-catcher", "192.168.1.20", "fd00::20"])

      for endpoint <- @exempted do
        assert {:ok, %Push.Subscription{endpoint: ^endpoint}} = register(endpoint)
      end
    end

    test "the same endpoints are refused while the list is empty" do
      Push.boot_allowed_private_hosts([])

      for endpoint <- @exempted do
        assert refused?(register(endpoint)), "#{endpoint} was admitted with nothing exempted"
      end
    end

    test "the match folds ASCII case and a trailing root dot, both ways round" do
      Push.boot_allowed_private_hosts(["Push-Catcher."])

      assert {:ok, _} = register("http://PUSH-CATCHER:3000/p/abc")
      assert {:ok, _} = register("http://push-catcher.:3000/p/abc")
    end

    test "an IP literal matches in its canonical form, however either side spells it" do
      Push.boot_allowed_private_hosts(["fd00:0::20"])

      assert {:ok, _} = register("http://[fd00::20]:8080/wp")
      assert {:ok, _} = register("http://[FD00:0:0::20]:8080/wp")
    end

    @neighbours [
      "http://evil.push-catcher:3000/p",
      "http://push-catcher.evil:3000/p",
      "http://10.0.0.1/p",
      "ftp://push-catcher/p"
    ]

    test "the exemption names a host, never its neighbours or another scheme" do
      Push.boot_allowed_private_hosts(["push-catcher"])

      for endpoint <- @neighbours do
        assert refused?(register(endpoint)), "#{endpoint} rode the push-catcher exemption"
      end
    end
  end

  describe "boot" do
    @impossible ["ntfy.lan:8080", "http://ntfy.lan", "[fd00::20]", "ntfy.lan/up"]

    test "an entry that could never equal a host is refused by name, and nothing is installed" do
      Push.boot_allowed_private_hosts(["push-catcher"])

      for entry <- @impossible do
        error = assert_raise ArgumentError, fn -> Push.boot_allowed_private_hosts(["ntfy.lan", entry]) end
        assert error.message =~ inspect(entry)
      end

      assert Push.allowed_private_host?("push-catcher")
      refute Push.allowed_private_host?("ntfy.lan")
    end
  end

  describe "delivery" do
    setup do
      # 127.0.0.2 is loopback: the real guard refuses it, and the test
      # resolver waves only 127.0.0.1 / localhost through, so a request that
      # reaches this listener can only have come through the exemption.
      {:ok, listener} = :gen_tcp.listen(0, [:binary, active: false, ip: {127, 0, 0, 2}])
      {:ok, port} = :inet.port(listener)
      user = user_fixture()

      sub =
        stored_subscription!({:user, user.id}, %{
          endpoint: "http://127.0.0.2:#{port}/wp",
          p256dh_key: @client_p256dh,
          auth_key: @client_auth,
          user_agent: "Mozilla/5.0 allowed-private-hosts-test"
        })

      {:ok, listener: listener, sub: sub}
    end

    test "an exempted private host is dialled and delivered to", %{listener: listener, sub: sub} do
      Push.boot_allowed_private_hosts(["127.0.0.2"])

      server =
        Task.async(fn ->
          {:ok, socket} = :gen_tcp.accept(listener, 5_000)
          {:ok, request} = :gen_tcp.recv(socket, 0, 5_000)
          :ok = :gen_tcp.send(socket, "HTTP/1.1 201 Created\r\ncontent-length: 0\r\n\r\n")
          # Read until the sender hangs up: closing with its body still
          # unread would answer with a RST that can race the 201.
          drain(socket)
          request
        end)

      assert :ok = Sender.send_to_subscription(sub, @payload)
      assert "POST /wp HTTP/1.1\r\n" <> _ = Task.await(server)
    end

    test "the same host is refused before any connection while the list is empty", %{listener: listener, sub: sub} do
      Push.boot_allowed_private_hosts([])

      capture_log(fn ->
        assert {:error, :ssrf_blocked} = Sender.send_to_subscription(sub, @payload)
      end)

      assert {:error, :timeout} = :gen_tcp.accept(listener, 100)
    end
  end

  defp drain(socket) do
    case :gen_tcp.recv(socket, 0, 5_000) do
      {:ok, _} -> drain(socket)
      {:error, _} -> :ok
    end
  end
end
