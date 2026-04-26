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
  alias Grappa.IRC.Identifier
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

    # A18: slug validation is sourced from
    # `Identifier.valid_network_slug?/1`. The Network
    # changeset previously carried its own `@slug_format` regex +
    # `validate_length(min: 1, max: 64)` pair that drifted from
    # Identifier (cap 32). These two parity tests lock the contract
    # — if Network's slug rule and Identifier.valid_network_slug? ever
    # diverge again, one of these fires. Asserted at the changeset
    # layer (no DB round-trip) since the contract is pure validation.
    test "accepts every slug Identifier.valid_network_slug?/1 accepts" do
      for slug <- ["azzurra", "net_1", "foo-bar", "a", String.duplicate("a", 32)] do
        assert Identifier.valid_network_slug?(slug),
               "test fixture invariant: Identifier should accept #{inspect(slug)}"

        cs = Network.changeset(%Network{}, %{slug: slug})

        refute Map.has_key?(errors_on(cs), :slug),
               "Network rejected #{inspect(slug)} that Identifier accepts"
      end
    end

    test "rejects every slug Identifier.valid_network_slug?/1 rejects" do
      # Empty string is tested via `validate_required` — here we want
      # slugs that pass `validate_required` but fail the syntax rule.
      for slug <- ["Azzurra", "foo/bar", "foo bar", "foo.bar", String.duplicate("a", 33)] do
        refute Identifier.valid_network_slug?(slug),
               "test fixture invariant: Identifier should reject #{inspect(slug)}"

        cs = Network.changeset(%Network{}, %{slug: slug})

        assert errors_on(cs)[:slug] != nil,
               "Network accepted #{inspect(slug)} that Identifier rejects"
      end
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

    # A8: nick validation is sourced from `Identifier.valid_nick?/1`.
    # The Credential changeset previously carried its own regex + length
    # rule that drifted slightly (the local regex disallowed leading
    # hyphens; Identifier permits them per RFC 2812 §2.3.1 + the
    # modern-IRC permissiveness documented in Identifier's moduledoc).
    # These two parity tests lock the contract — if Credential's nick
    # rule and Identifier.valid_nick? ever diverge again, one of these
    # fires. Asserted at the changeset layer (no DB round-trip) since
    # the contract is pure validation; Repo.insert is exercised by the
    # surrounding tests.
    test "accepts every nick Identifier.valid_nick?/1 accepts", %{user: user, network: net} do
      # Sample of edge cases Identifier explicitly permits:
      # leading hyphen, leading bracket, full 31-char length, embedded
      # IRC special chars. All of these used to be rejected by the
      # local Credential regex.
      for nick <- ["-vjt", "[bot]", "v|t", "v_jt", String.duplicate("a", 31)] do
        assert Identifier.valid_nick?(nick),
               "test fixture invariant: Identifier should accept #{inspect(nick)}"

        cs =
          Credential.changeset(%Credential{}, %{
            user_id: user.id,
            network_id: net.id,
            nick: nick,
            auth_method: :none,
            autojoin_channels: []
          })

        refute Map.has_key?(errors_on(cs), :nick),
               "Credential rejected #{inspect(nick)} that Identifier accepts"
      end
    end

    test "rejects every nick Identifier.valid_nick?/1 rejects", %{user: user, network: net} do
      # Sample of inputs Identifier explicitly rejects: contains space,
      # leading digit, control byte, over 31 chars. Empty string is
      # tested separately via `validate_required` below — here we want
      # nicks that pass `validate_required` but fail the syntax rule.
      for nick <- ["has space", "9leading", "ctl\x01char", String.duplicate("a", 32)] do
        refute Identifier.valid_nick?(nick),
               "test fixture invariant: Identifier should reject #{inspect(nick)}"

        cs =
          Credential.changeset(%Credential{}, %{
            user_id: user.id,
            network_id: net.id,
            nick: nick,
            auth_method: :none,
            autojoin_channels: []
          })

        assert errors_on(cs)[:nick] != nil,
               "Credential accepted #{inspect(nick)} that Identifier rejects"
      end
    end

    # S29 C1 review-fix #1: every text field that ends up interpolated
    # into a wire line at handshake time (PASS, NICK, USER, PRIVMSG
    # NickServ) must be CRLF/NUL-free at the changeset boundary. The
    # operator-input path is the OTHER door into IRC.Client besides the
    # REST surface; without these checks an operator typo planted CRLF
    # at bind time would inject an arbitrary IRC command at handshake.
    test "rejects realname with embedded CRLF", %{user: user, network: net} do
      assert {:error, %Ecto.Changeset{} = cs} =
               Networks.bind_credential(user, net, %{
                 nick: "vjt",
                 realname: "real\r\nQUIT :pwn",
                 auth_method: :none,
                 autojoin_channels: []
               })

      assert errors_on(cs)[:realname] != nil
    end

    test "rejects sasl_user with embedded LF", %{user: user, network: net} do
      assert {:error, %Ecto.Changeset{} = cs} =
               Networks.bind_credential(user, net, %{
                 nick: "vjt",
                 sasl_user: "user\nQUIT",
                 auth_method: :sasl,
                 password: "x",
                 autojoin_channels: []
               })

      assert errors_on(cs)[:sasl_user] != nil
    end

    test "rejects password with NUL byte", %{user: user, network: net} do
      assert {:error, %Ecto.Changeset{} = cs} =
               Networks.bind_credential(user, net, %{
                 nick: "vjt",
                 auth_method: :server_pass,
                 password: "secret\x00pwn",
                 autojoin_channels: []
               })

      assert errors_on(cs)[:password] != nil
    end

    test "rejects autojoin_channels with invalid channel name", %{user: user, network: net} do
      assert {:error, %Ecto.Changeset{} = cs} =
               Networks.bind_credential(user, net, %{
                 nick: "vjt",
                 auth_method: :none,
                 autojoin_channels: ["#good", "#bad\r\nQUIT"]
               })

      assert errors_on(cs)[:autojoin_channels] != nil
    end

    test "rejects autojoin_channels missing prefix", %{user: user, network: net} do
      assert {:error, %Ecto.Changeset{} = cs} =
               Networks.bind_credential(user, net, %{
                 nick: "vjt",
                 auth_method: :none,
                 autojoin_channels: ["no-prefix"]
               })

      assert errors_on(cs)[:autojoin_channels] != nil
    end

    # S29 H10: dropping the `default: :auto` on Credential.auth_method.
    # Operators must pick the auth method explicitly — :auto is still
    # a valid choice (modern + legacy ircd combo) but it should not
    # be the silent default. Half-built attrs (test, REPL, future
    # REST attrs) defaulting to :auto without a password used to pass
    # the schema enum check, then crash mid-handshake in
    # IRC.Client.sasl_plain_payload with `<< nil :: binary >>` :badarg.
    # With no default + validate_required([:auth_method]), the
    # missing-method case fails loudly at the changeset boundary.
    test "rejects bind_credential when auth_method is missing", %{user: user, network: net} do
      assert {:error, %Ecto.Changeset{} = cs} =
               Networks.bind_credential(user, net, %{
                 nick: "vjt",
                 autojoin_channels: []
               })

      assert errors_on(cs)[:auth_method] != nil
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

  describe "list_credentials_for_all_users/0" do
    test "returns [] when no credentials exist" do
      assert Networks.list_credentials_for_all_users() == []
    end

    test "returns every credential across users + networks with :network preloaded" do
      u1 = user_fixture("alice-#{System.unique_integer([:positive])}")
      u2 = user_fixture("bob-#{System.unique_integer([:positive])}")
      net_a = network_fixture("net-a-#{System.unique_integer([:positive])}")
      net_b = network_fixture("net-b-#{System.unique_integer([:positive])}")

      {:ok, _} =
        Networks.bind_credential(u1, net_a, %{nick: "a", auth_method: :none, autojoin_channels: []})

      {:ok, _} =
        Networks.bind_credential(u1, net_b, %{nick: "a", auth_method: :none, autojoin_channels: []})

      {:ok, _} =
        Networks.bind_credential(u2, net_a, %{nick: "b", auth_method: :none, autojoin_channels: []})

      creds = Networks.list_credentials_for_all_users()
      assert length(creds) == 3
      assert Enum.all?(creds, &match?(%Credential{}, &1))
      assert Enum.all?(creds, &match?(%Network{}, &1.network))

      pairs = Enum.map(creds, &{&1.user_id, &1.network_id})
      assert {u1.id, net_a.id} in pairs
      assert {u1.id, net_b.id} in pairs
      assert {u2.id, net_a.id} in pairs
    end

    test "orders by inserted_at ascending so Bootstrap output is deterministic" do
      u1 = user_fixture("alice-#{System.unique_integer([:positive])}")
      u2 = user_fixture("bob-#{System.unique_integer([:positive])}")
      net_a = network_fixture("net-a-#{System.unique_integer([:positive])}")
      net_b = network_fixture("net-b-#{System.unique_integer([:positive])}")

      {:ok, c1} =
        Networks.bind_credential(u1, net_a, %{nick: "a", auth_method: :none, autojoin_channels: []})

      {:ok, c2} =
        Networks.bind_credential(u2, net_a, %{nick: "b", auth_method: :none, autojoin_channels: []})

      {:ok, c3} =
        Networks.bind_credential(u1, net_b, %{nick: "a", auth_method: :none, autojoin_channels: []})

      ts =
        Enum.map(Networks.list_credentials_for_all_users(), &{&1.user_id, &1.network_id, &1.inserted_at})

      # Strictly non-decreasing inserted_at — ties broken by composite key.
      assert ts == Enum.sort_by(ts, fn {u, n, t} -> {t, u, n} end)
      assert {c1.user_id, c1.network_id, c1.inserted_at} in ts
      assert {c2.user_id, c2.network_id, c2.inserted_at} in ts
      assert {c3.user_id, c3.network_id, c3.inserted_at} in ts
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

    # S29 H5: see Grappa.Session.ServerTest "unbind_credential tears
    # down a running session" for the integration test that proves
    # `Networks.unbind_credential/2` calls `Grappa.Session.stop_session/2`
    # before deleting the row. Lives there because that file already
    # carries the IRCServer + sandbox-shared scaffolding for live
    # sessions.

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

  describe "get_network_by_slug!/1" do
    test "returns the row on a known slug" do
      net = network_fixture("known-slug-#{System.unique_integer([:positive])}")
      assert %Network{id: id} = Networks.get_network_by_slug!(net.slug)
      assert id == net.id
    end

    test "raises Ecto.NoResultsError on an unknown slug — operator typo is loud" do
      assert_raise Ecto.NoResultsError, fn ->
        Networks.get_network_by_slug!("definitely-not-a-network-#{System.unique_integer([:positive])}")
      end
    end
  end

  describe "pick_server!/1 (A2/A10 — lifted from Session.Server)" do
    test "returns the lowest-priority enabled server, ties broken by id" do
      net = network_fixture()
      {:ok, _} = Networks.add_server(net, %{host: "h1", port: 6667, priority: 5})
      {:ok, _} = Networks.add_server(net, %{host: "h2", port: 6667, priority: 1})
      {:ok, _} = Networks.add_server(net, %{host: "h3", port: 6667, priority: 1})

      preloaded = Repo.preload(net, :servers)
      assert %Server{host: "h2"} = Networks.pick_server!(preloaded)
    end

    test "skips disabled servers even when priority would prefer them" do
      net = network_fixture()
      {:ok, _} = Networks.add_server(net, %{host: "disabled", port: 6667, priority: 0, enabled: false})
      {:ok, _} = Networks.add_server(net, %{host: "enabled", port: 6667, priority: 5})

      preloaded = Repo.preload(net, :servers)
      assert %Server{host: "enabled"} = Networks.pick_server!(preloaded)
    end

    test "raises NoServerError when every server is disabled" do
      net = network_fixture()
      {:ok, _} = Networks.add_server(net, %{host: "off", port: 6667, enabled: false})
      preloaded = Repo.preload(net, :servers)

      assert_raise Networks.NoServerError, fn -> Networks.pick_server!(preloaded) end
    end

    test "raises NoServerError when the network has zero servers" do
      net = network_fixture()
      preloaded = Repo.preload(net, :servers)
      assert_raise Networks.NoServerError, fn -> Networks.pick_server!(preloaded) end
    end
  end

  # Cluster 2 (A2): the data resolver that flattens a Credential +
  # picked Server + User into the primitive `Session.start_opts/0`
  # plan. Session.Server.init/1 is now a pure consumer of this map;
  # the failure-mode tests previously lived on server_test.exs and
  # moved here when the resolution moved into Networks.
  describe "session_plan/1" do
    test "returns the resolved primitive opts for a bound credential" do
      user = user_fixture()
      net = network_fixture()
      {:ok, _} = Networks.add_server(net, %{host: "irc.example", port: 6697, tls: true, priority: 0})

      {:ok, _} =
        Networks.bind_credential(user, net, %{
          nick: "vjt-grappa",
          auth_method: :sasl,
          password: "loadbearing",
          autojoin_channels: ["#sniffo"]
        })

      cred = Networks.get_credential!(user, net)
      assert {:ok, plan} = Networks.session_plan(cred)

      assert plan.user_name == user.name
      assert plan.network_slug == net.slug
      assert plan.nick == "vjt-grappa"
      # effective_realname / effective_sasl_user fall back to nick
      # — the build_plan helper in Networks owns the fallback.
      assert plan.realname == "vjt-grappa"
      assert plan.sasl_user == "vjt-grappa"
      assert plan.auth_method == :sasl
      assert plan.password == "loadbearing"
      assert plan.autojoin_channels == ["#sniffo"]
      assert plan.host == "irc.example"
      assert plan.port == 6697
      assert plan.tls == true
    end

    test "returns {:error, :no_server} when the network has zero enabled servers" do
      user = user_fixture()
      net = network_fixture()
      {:ok, _} = Networks.add_server(net, %{host: "off", port: 6667, enabled: false})

      {:ok, _} =
        Networks.bind_credential(user, net, %{
          nick: "vjt",
          auth_method: :none,
          autojoin_channels: []
        })

      cred = Networks.get_credential!(user, net)
      assert {:error, :no_server} = Networks.session_plan(cred)
    end

    test "returns {:error, :no_server} when the network has no servers at all" do
      user = user_fixture()
      net = network_fixture()

      {:ok, _} =
        Networks.bind_credential(user, net, %{
          nick: "vjt",
          auth_method: :none,
          autojoin_channels: []
        })

      cred = Networks.get_credential!(user, net)
      assert {:error, :no_server} = Networks.session_plan(cred)
    end

    test "is a no-op preload when the credential already has :network preloaded (Bootstrap path)" do
      user = user_fixture()
      net = network_fixture()
      {:ok, _} = Networks.add_server(net, %{host: "h", port: 6667})

      {:ok, _} =
        Networks.bind_credential(user, net, %{
          nick: "vjt",
          auth_method: :none,
          autojoin_channels: []
        })

      # `list_credentials_for_all_users/0` is the canonical
      # preloaded-:network producer.
      [cred] = Networks.list_credentials_for_all_users()
      assert {:ok, plan} = Networks.session_plan(cred)
      assert plan.host == "h"
    end
  end
end
