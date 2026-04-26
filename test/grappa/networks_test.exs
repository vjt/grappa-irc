defmodule Grappa.NetworksTest do
  @moduledoc """
  Context tests for `Grappa.Networks` — networks + servers + per-(user, network)
  credentials. The credentials surface carries an at-rest-encrypted password
  column (`password_encrypted`) backed by `Grappa.EncryptedBinary` (Cloak
  AES-GCM); these tests are the end-to-end DB roundtrip exercise that
  `Grappa.EncryptedBinaryTest` (dump/load only) defers to (see that file's
  moduledoc).

  The cascade-on-empty test for `unbind_credential/2` is the one
  domain-specific behavior worth calling out: networks + servers are
  per-deployment shared infra (one Azzurra row, many users bind it), but if
  the LAST binding goes away the network + servers are dead weight and we
  delete them. Until then the FK from credential → network is `:restrict`,
  so an explicit cascade-on-empty in code is the only path that drops the
  parent rows.
  """
  # async: false — every test inserts network + (often) server +
  # credential, and the credential insert pumps through the
  # single-process Cloak.Vault. Under max_cases:2 with the rest of
  # the Phase 2 write-heavy suite, this collides into "Database busy"
  # often enough to be a CI flake source. Serializing this file is
  # cheaper than further bumping busy_timeout (already at 30s).
  use Grappa.DataCase, async: false

  alias Grappa.{Accounts, Networks, Repo}
  alias Grappa.Networks.{Credential, Network, Server}

  defp user_fixture(name \\ nil) do
    name = name || "vjt-#{System.unique_integer([:positive])}"
    {:ok, user} = Accounts.create_user(%{name: name, password: "correct horse battery staple"})
    user
  end

  defp network_fixture(slug \\ nil) do
    slug = slug || "net-#{System.unique_integer([:positive])}"
    {:ok, network} = Networks.find_or_create_network(%{slug: slug})
    network
  end

  describe "find_or_create_network/1" do
    test "creates a network on first call" do
      assert {:ok, %Network{slug: "azzurra"} = net} =
               Networks.find_or_create_network(%{slug: "azzurra"})

      assert is_integer(net.id)
    end

    test "returns the same row on the second call (idempotent)" do
      assert {:ok, %Network{id: id1}} = Networks.find_or_create_network(%{slug: "azzurra"})
      assert {:ok, %Network{id: id2}} = Networks.find_or_create_network(%{slug: "azzurra"})
      assert id1 == id2
    end

    test "rejects an invalid slug" do
      assert {:error, %Ecto.Changeset{} = cs} =
               Networks.find_or_create_network(%{slug: "Bad Slug!"})

      assert errors_on(cs)[:slug] != nil
    end
  end

  describe "add_server/2" do
    test "inserts a server attached to the network" do
      net = network_fixture("azzurra")

      assert {:ok, %Server{} = srv} =
               Networks.add_server(net, %{
                 host: "irc.azzurra.chat",
                 port: 6697,
                 tls: true,
                 priority: 0
               })

      assert srv.network_id == net.id
      assert srv.host == "irc.azzurra.chat"
      assert srv.port == 6697
      assert srv.tls == true
      assert srv.enabled == true
    end

    test "returns {:error, :already_exists} on the same (network, host, port)" do
      net = network_fixture("azzurra")
      attrs = %{host: "irc.azzurra.chat", port: 6697, tls: true}

      assert {:ok, _} = Networks.add_server(net, attrs)
      assert {:error, :already_exists} = Networks.add_server(net, attrs)
    end

    test "rejects a missing host or port" do
      net = network_fixture()

      assert {:error, %Ecto.Changeset{}} =
               Networks.add_server(net, %{port: 6697})

      assert {:error, %Ecto.Changeset{}} =
               Networks.add_server(net, %{host: "x"})
    end
  end

  describe "list_servers/1" do
    test "returns servers ordered by (priority asc, id asc)" do
      net = network_fixture("azzurra")
      {:ok, _} = Networks.add_server(net, %{host: "a", port: 6697, priority: 1})
      {:ok, _} = Networks.add_server(net, %{host: "b", port: 6697, priority: 0})
      {:ok, _} = Networks.add_server(net, %{host: "c", port: 6697, priority: 0})

      assert [%Server{host: "b"}, %Server{host: "c"}, %Server{host: "a"}] =
               Networks.list_servers(net)
    end

    test "returns [] when the network has no servers" do
      net = network_fixture()
      assert Networks.list_servers(net) == []
    end
  end

  describe "bind_credential/3" do
    setup do
      %{user: user_fixture(), network: network_fixture()}
    end

    test "persists a credential row and returns it", %{user: user, network: net} do
      assert {:ok, %Credential{} = cred} =
               Networks.bind_credential(user, net, %{
                 nick: "vjt-grappa",
                 password: "secretpw",
                 auth_method: :auto,
                 autojoin_channels: ["#grappa"]
               })

      assert cred.user_id == user.id
      assert cred.network_id == net.id
      assert cred.nick == "vjt-grappa"
      assert cred.auth_method == :auto
      assert cred.autojoin_channels == ["#grappa"]
    end

    test "encrypts the password in the DB column", %{user: user, network: net} do
      {:ok, _} =
        Networks.bind_credential(user, net, %{
          nick: "vjt",
          password: "PLAIN-PW",
          auth_method: :auto,
          autojoin_channels: []
        })

      # Bypass Cloak by reading the column with a raw SELECT; the only
      # row in this test's sandbox is the one we just inserted.
      {:ok, %{rows: [[blob]]}} =
        Repo.query("SELECT password_encrypted FROM network_credentials")

      assert is_binary(blob)
      refute blob == "PLAIN-PW"
    end

    test "auth_method = :none accepts no password", %{user: user, network: net} do
      assert {:ok, %Credential{auth_method: :none}} =
               Networks.bind_credential(user, net, %{
                 nick: "vjt",
                 auth_method: :none,
                 autojoin_channels: []
               })
    end

    test "auth_method = :sasl without a password fails validation", %{user: user, network: net} do
      assert {:error, %Ecto.Changeset{} = cs} =
               Networks.bind_credential(user, net, %{
                 nick: "vjt",
                 auth_method: :sasl,
                 autojoin_channels: []
               })

      assert errors_on(cs)[:password] != nil
    end

    test "rejects an invalid nick", %{user: user, network: net} do
      assert {:error, %Ecto.Changeset{} = cs} =
               Networks.bind_credential(user, net, %{
                 nick: "bad nick with spaces",
                 auth_method: :none,
                 autojoin_channels: []
               })

      assert errors_on(cs)[:nick] != nil
    end
  end

  describe "update_credential/3" do
    setup do
      user = user_fixture()
      net = network_fixture()

      {:ok, _} =
        Networks.bind_credential(user, net, %{
          nick: "old-nick",
          password: "old-pw",
          auth_method: :auto,
          autojoin_channels: ["#old"]
        })

      %{user: user, network: net}
    end

    test "preserves password_encrypted on a same-auth_method update", %{user: user, network: net} do
      assert {:ok, cred} =
               Networks.update_credential(user, net, %{
                 nick: "renamed",
                 autojoin_channels: ["#new"]
               })

      assert cred.nick == "renamed"
      assert cred.password_encrypted == "old-pw"
      assert cred.autojoin_channels == ["#new"]
    end

    test "rejects auth_method change without a fresh password", %{user: user, network: net} do
      assert {:error, %Ecto.Changeset{} = cs} =
               Networks.update_credential(user, net, %{auth_method: :sasl})

      assert "must be re-supplied when auth_method changes" in errors_on(cs).password
    end

    test "accepts auth_method change with a fresh password", %{user: user, network: net} do
      assert {:ok, cred} =
               Networks.update_credential(user, net, %{
                 auth_method: :sasl,
                 password: "fresh-sasl-pw"
               })

      assert cred.auth_method == :sasl
      assert cred.password_encrypted == "fresh-sasl-pw"
    end

    test "accepts auth_method change to :none without a password", %{user: user, network: net} do
      assert {:ok, cred} =
               Networks.update_credential(user, net, %{auth_method: :none})

      assert cred.auth_method == :none
    end
  end

  describe "list_credentials_for_user/1" do
    test "returns every binding for a user with networks preloaded" do
      user = user_fixture()
      net1 = network_fixture("net-a")
      net2 = network_fixture("net-b")

      {:ok, _} = Networks.bind_credential(user, net1, %{nick: "n", auth_method: :none, autojoin_channels: []})
      {:ok, _} = Networks.bind_credential(user, net2, %{nick: "n", auth_method: :none, autojoin_channels: []})

      creds = Networks.list_credentials_for_user(user)
      assert length(creds) == 2
      assert Enum.all?(creds, &match?(%Network{}, &1.network))
      slugs = creds |> Enum.map(& &1.network.slug) |> Enum.sort()
      assert slugs == ["net-a", "net-b"]
    end

    test "returns [] for a user with no bindings" do
      user = user_fixture()
      assert Networks.list_credentials_for_user(user) == []
    end
  end

  describe "get_credential!/2" do
    test "returns the credential with the password decrypted (Cloak roundtrip)" do
      user = user_fixture()
      net = network_fixture()

      {:ok, _} =
        Networks.bind_credential(user, net, %{
          nick: "vjt",
          password: "ROUND-TRIP",
          auth_method: :auto,
          autojoin_channels: []
        })

      cred = Networks.get_credential!(user, net)
      assert cred.password_encrypted == "ROUND-TRIP"
      assert cred.user_id == user.id
      assert cred.network_id == net.id
    end

    test "raises Ecto.NoResultsError when not bound" do
      user = user_fixture()
      net = network_fixture()

      assert_raise Ecto.NoResultsError, fn -> Networks.get_credential!(user, net) end
    end
  end

  describe "unbind_credential/2" do
    test "deletes the credential row" do
      user = user_fixture()
      net = network_fixture()

      {:ok, _} =
        Networks.bind_credential(user, net, %{
          nick: "vjt",
          auth_method: :none,
          autojoin_channels: []
        })

      assert :ok = Networks.unbind_credential(user, net)
      assert_raise Ecto.NoResultsError, fn -> Networks.get_credential!(user, net) end
    end

    test "cascades the network + servers when no other credentials reference it" do
      user = user_fixture()
      net = network_fixture("azzurra-solo")
      {:ok, _} = Networks.add_server(net, %{host: "irc.azzurra.chat", port: 6697})

      {:ok, _} =
        Networks.bind_credential(user, net, %{
          nick: "vjt",
          auth_method: :none,
          autojoin_channels: []
        })

      assert :ok = Networks.unbind_credential(user, net)
      assert Repo.get(Network, net.id) == nil
      query = from(s in Server, where: s.network_id == ^net.id)
      assert Repo.all(query) == []
    end

    test "keeps the network + servers when another user still has a credential" do
      u1 = user_fixture()
      u2 = user_fixture()
      net = network_fixture("azzurra-shared")
      {:ok, _} = Networks.add_server(net, %{host: "irc.azzurra.chat", port: 6697})

      {:ok, _} =
        Networks.bind_credential(u1, net, %{
          nick: "n1",
          auth_method: :none,
          autojoin_channels: []
        })

      {:ok, _} =
        Networks.bind_credential(u2, net, %{
          nick: "n2",
          auth_method: :none,
          autojoin_channels: []
        })

      assert :ok = Networks.unbind_credential(u1, net)
      assert %Network{} = Repo.get(Network, net.id)
      query = from(s in Server, where: s.network_id == ^net.id)
      assert length(Repo.all(query)) == 1
      assert %Credential{} = Networks.get_credential!(u2, net)
    end

    test "returns :ok when called for a non-existent binding (idempotent)" do
      user = user_fixture()
      net = network_fixture()
      assert :ok = Networks.unbind_credential(user, net)
    end

    # S29 C2: messages.network_id FK is :restrict (NOT :delete_all) so
    # archival messages are NEVER silently nuked when the last user
    # unbinds a network. The cascade-on-empty path detects scrollback
    # presence BEFORE the delete attempt and rolls back with a typed
    # error so the operator can run `mix grappa.delete_scrollback`
    # (Phase 5) explicitly if they want the messages gone.
    test "returns {:error, :scrollback_present} when last user has scrollback on the network" do
      user = user_fixture()
      net = network_fixture("azzurra-archived")
      {:ok, _} = Networks.add_server(net, %{host: "irc.azzurra.chat", port: 6697})

      {:ok, _} =
        Networks.bind_credential(user, net, %{
          nick: "vjt",
          auth_method: :none,
          autojoin_channels: []
        })

      # One scrollback row blocks the cascade.
      {:ok, _} =
        Grappa.Scrollback.insert(%{
          user_id: user.id,
          network_id: net.id,
          channel: "#sniffo",
          server_time: 1,
          kind: :privmsg,
          sender: "vjt",
          body: "msg keep me"
        })

      assert {:error, :scrollback_present} = Networks.unbind_credential(user, net)

      # Transaction rolled back — credential AND network still present.
      assert %Network{} = Repo.get(Network, net.id)
      assert %Credential{} = Networks.get_credential!(user, net)
    end

    test "still cascades when last user has NO scrollback (the happy path remains)" do
      user = user_fixture()
      net = network_fixture("azzurra-cleancascade")
      {:ok, _} = Networks.add_server(net, %{host: "irc.azzurra.chat", port: 6697})

      {:ok, _} =
        Networks.bind_credential(user, net, %{
          nick: "vjt",
          auth_method: :none,
          autojoin_channels: []
        })

      # No messages → cascade proceeds.
      assert :ok = Networks.unbind_credential(user, net)
      assert Repo.get(Network, net.id) == nil
    end
  end
end
