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
  alias Grappa.Networks.{Credential, Credentials, Network, Server, Servers, SessionPlan}
  alias Grappa.PubSub.Topic

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

    # B5.4 M-pers-6: the race-recovery path was "on ANY changeset error,
    # fall through to Repo.get_by; if the row is now there, return it as
    # `{:ok, _}`." That contract loses validation errors whenever an
    # out-of-band insert (raw SQL, concurrent process, manual Repo
    # poke) plants a row with the same slug between the failing
    # validate-changeset insert and the recovery get_by — the operator-
    # side "where did my validation error go?" failure mode. Fix: only
    # fall through on a uniqueness violation on `:slug`; other
    # validation failures surface the changeset directly.
    #
    # This test pins the contract by planting a bad-slug row in the DB
    # and then calling find_or_create_network with the same bad slug.
    # The pre-B5.4 code path went: top-level get_by → finds the
    # planted row → returns `{:ok, _}`, masking the slug-validation
    # error that Network.changeset would have surfaced. Post-B5.4:
    # find_or_create_network ALSO validates the slug at the entry
    # point so the get_by fast-path can't mask a validation failure.
    test "surfaces validation failure even when a bad-slug row exists in the DB" do
      bad_slug = "Bad Slug!"
      refute Identifier.valid_network_slug?(bad_slug)

      # Plant a row with the bad slug via schemaless insert (bypasses
      # Network.changeset). This mimics a raw-SQL state of the table.
      {:ok, _} =
        Repo.insert(%Network{
          slug: bad_slug,
          inserted_at: DateTime.utc_now(),
          updated_at: DateTime.utc_now()
        })

      assert {:error, %Ecto.Changeset{} = cs} =
               Networks.find_or_create_network(%{slug: bad_slug})

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
               Servers.add_server(net, %{
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

      assert {:ok, _} = Servers.add_server(net, attrs)
      assert {:error, :already_exists} = Servers.add_server(net, attrs)
    end

    test "rejects a missing host or port" do
      net = network_fixture()

      assert {:error, %Ecto.Changeset{}} =
               Servers.add_server(net, %{port: 6697})

      assert {:error, %Ecto.Changeset{}} =
               Servers.add_server(net, %{host: "x"})
    end
  end

  describe "list_servers/1" do
    test "returns servers ordered by (priority asc, id asc)" do
      net = network_fixture("azzurra")
      {:ok, _} = Servers.add_server(net, %{host: "a", port: 6697, priority: 1})
      {:ok, _} = Servers.add_server(net, %{host: "b", port: 6697, priority: 0})
      {:ok, _} = Servers.add_server(net, %{host: "c", port: 6697, priority: 0})

      assert [%Server{host: "b"}, %Server{host: "c"}, %Server{host: "a"}] =
               Servers.list_servers(net)
    end

    test "returns [] when the network has no servers" do
      net = network_fixture()
      assert Servers.list_servers(net) == []
    end
  end

  describe "bind_credential/3" do
    setup do
      %{user: user_fixture(), network: network_fixture()}
    end

    test "persists a credential row and returns it", %{user: user, network: net} do
      assert {:ok, %Credential{} = cred} =
               Credentials.bind_credential(user, net, %{
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
        Credentials.bind_credential(user, net, %{
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
               Credentials.bind_credential(user, net, %{
                 nick: "vjt",
                 auth_method: :none,
                 autojoin_channels: []
               })
    end

    test "auth_method = :sasl without a password fails validation", %{user: user, network: net} do
      assert {:error, %Ecto.Changeset{} = cs} =
               Credentials.bind_credential(user, net, %{
                 nick: "vjt",
                 auth_method: :sasl,
                 autojoin_channels: []
               })

      assert errors_on(cs)[:password] != nil
    end

    test "rejects an invalid nick", %{user: user, network: net} do
      assert {:error, %Ecto.Changeset{} = cs} =
               Credentials.bind_credential(user, net, %{
                 nick: "bad nick with spaces",
                 auth_method: :none,
                 autojoin_channels: []
               })

      assert errors_on(cs)[:nick] != nil
    end

    # A8: nick validation is sourced from `Identifier.valid_nick?/1`.
    # These two parity tests lock the Credential ↔ Identifier contract
    # — if Credential's nick rule and Identifier.valid_nick? ever
    # diverge again, one of these fires. Asserted at the changeset
    # layer (no DB round-trip) since the contract is pure validation;
    # Repo.insert is exercised by the surrounding tests.
    test "accepts every nick Identifier.valid_nick?/1 accepts", %{user: user, network: net} do
      # Sample of edge cases Identifier explicitly permits:
      # leading bracket, full 30-char length, embedded IRC special
      # chars. RFC 2812 §2.3.1 forbids leading dash (tail-only) — see
      # the rejection test below.
      for nick <- ["[bot]", "v|t", "v_jt", "v-jt", String.duplicate("a", 30)] do
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
      # leading digit, control byte, over 30 chars. Empty string is
      # tested separately via `validate_required` below — here we want
      # nicks that pass `validate_required` but fail the syntax rule.
      for nick <- ["has space", "9leading", "-leading-dash", "ctl\x01char", String.duplicate("a", 31)] do
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
               Credentials.bind_credential(user, net, %{
                 nick: "vjt",
                 realname: "real\r\nQUIT :pwn",
                 auth_method: :none,
                 autojoin_channels: []
               })

      assert errors_on(cs)[:realname] != nil
    end

    test "rejects sasl_user with embedded LF", %{user: user, network: net} do
      assert {:error, %Ecto.Changeset{} = cs} =
               Credentials.bind_credential(user, net, %{
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
               Credentials.bind_credential(user, net, %{
                 nick: "vjt",
                 auth_method: :server_pass,
                 password: "secret\x00pwn",
                 autojoin_channels: []
               })

      assert errors_on(cs)[:password] != nil
    end

    test "rejects autojoin_channels with invalid channel name", %{user: user, network: net} do
      assert {:error, %Ecto.Changeset{} = cs} =
               Credentials.bind_credential(user, net, %{
                 nick: "vjt",
                 auth_method: :none,
                 autojoin_channels: ["#good", "#bad\r\nQUIT"]
               })

      assert errors_on(cs)[:autojoin_channels] != nil
    end

    test "rejects autojoin_channels missing prefix", %{user: user, network: net} do
      assert {:error, %Ecto.Changeset{} = cs} =
               Credentials.bind_credential(user, net, %{
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
               Credentials.bind_credential(user, net, %{
                 nick: "vjt",
                 autojoin_channels: []
               })

      assert errors_on(cs)[:auth_method] != nil
    end
  end

  describe "update_credential!/3" do
    setup do
      user = user_fixture()
      net = network_fixture()

      {:ok, _} =
        Credentials.bind_credential(user, net, %{
          nick: "old-nick",
          password: "old-pw",
          auth_method: :auto,
          autojoin_channels: ["#old"]
        })

      %{user: user, network: net}
    end

    test "preserves password_encrypted on a same-auth_method update", %{user: user, network: net} do
      assert {:ok, cred} =
               Credentials.update_credential!(user, net, %{
                 nick: "renamed",
                 autojoin_channels: ["#new"]
               })

      assert cred.nick == "renamed"
      assert cred.password_encrypted == "old-pw"
      assert cred.autojoin_channels == ["#new"]
    end

    test "rejects auth_method change without a fresh password", %{user: user, network: net} do
      assert {:error, %Ecto.Changeset{} = cs} =
               Credentials.update_credential!(user, net, %{auth_method: :sasl})

      assert "must be re-supplied when auth_method changes" in errors_on(cs).password
    end

    test "accepts auth_method change with a fresh password", %{user: user, network: net} do
      assert {:ok, cred} =
               Credentials.update_credential!(user, net, %{
                 auth_method: :sasl,
                 password: "fresh-sasl-pw"
               })

      assert cred.auth_method == :sasl
      assert cred.password_encrypted == "fresh-sasl-pw"
    end

    test "accepts auth_method change to :none without a password", %{user: user, network: net} do
      assert {:ok, cred} =
               Credentials.update_credential!(user, net, %{auth_method: :none})

      assert cred.auth_method == :none
    end

    test "raises Ecto.NoResultsError when the binding doesn't exist (the `!` suffix)" do
      # F4: the spec is `{:ok, _} | {:error, Ecto.Changeset.t()}` —
      # the Ecto.NoResultsError raise from the inner `get_credential!`
      # is admitted by the function name. This test pins the contract
      # so a future "soft return" rewrite has to break the test.
      orphan_user = user_fixture()
      orphan_net = network_fixture()

      assert_raise Ecto.NoResultsError, fn ->
        Credentials.update_credential!(orphan_user, orphan_net, %{nick: "x"})
      end
    end
  end

  describe "update_credential/3 (M-6 typed sibling)" do
    setup do
      user = user_fixture()
      net = network_fixture()

      {:ok, _} =
        Credentials.bind_credential(user, net, %{
          nick: "old-nick",
          password: "old-pw",
          auth_method: :auto,
          autojoin_channels: ["#old"]
        })

      %{user: user, network: net}
    end

    test "returns {:ok, cred} on valid attrs", %{user: user, network: net} do
      assert {:ok, cred} = Credentials.update_credential(user, net, %{nick: "renamed"})
      assert cred.nick == "renamed"
    end

    test "returns {:error, %Ecto.Changeset{}} on invalid attrs", %{user: user, network: net} do
      assert {:error, %Ecto.Changeset{}} =
               Credentials.update_credential(user, net, %{auth_method: :sasl})
    end

    test "returns {:error, :not_found} when the binding doesn't exist" do
      # HTTP-path sibling — operator gets a typed 404, not a stack
      # trace. Distinct from the bang variant which is bin/grappa-only.
      orphan_user = user_fixture()
      orphan_net = network_fixture()

      assert Credentials.update_credential(orphan_user, orphan_net, %{nick: "x"}) ==
               {:error, :not_found}
    end
  end

  describe "list_credentials_for_user/1" do
    test "returns every binding for a user with networks preloaded" do
      user = user_fixture()
      net1 = network_fixture("net-a")
      net2 = network_fixture("net-b")

      {:ok, _} = Credentials.bind_credential(user, net1, %{nick: "n", auth_method: :none, autojoin_channels: []})
      {:ok, _} = Credentials.bind_credential(user, net2, %{nick: "n", auth_method: :none, autojoin_channels: []})

      creds = Credentials.list_credentials_for_user(user)
      assert length(creds) == 2
      assert Enum.all?(creds, &match?(%Network{}, &1.network))
      slugs = creds |> Enum.map(& &1.network.slug) |> Enum.sort()
      assert slugs == ["net-a", "net-b"]
    end

    test "returns [] for a user with no bindings" do
      user = user_fixture()
      assert Credentials.list_credentials_for_user(user) == []
    end
  end

  describe "list_credentials_for_all_users/0" do
    test "returns [] when no credentials exist" do
      assert Credentials.list_credentials_for_all_users() == []
    end

    test "returns every credential across users + networks with :network preloaded" do
      u1 = user_fixture("alice-#{System.unique_integer([:positive])}")
      u2 = user_fixture("bob-#{System.unique_integer([:positive])}")
      net_a = network_fixture("net-a-#{System.unique_integer([:positive])}")
      net_b = network_fixture("net-b-#{System.unique_integer([:positive])}")

      {:ok, _} =
        Credentials.bind_credential(u1, net_a, %{nick: "a", auth_method: :none, autojoin_channels: []})

      {:ok, _} =
        Credentials.bind_credential(u1, net_b, %{nick: "a", auth_method: :none, autojoin_channels: []})

      {:ok, _} =
        Credentials.bind_credential(u2, net_a, %{nick: "b", auth_method: :none, autojoin_channels: []})

      creds = Credentials.list_credentials_for_all_users()
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
        Credentials.bind_credential(u1, net_a, %{nick: "a", auth_method: :none, autojoin_channels: []})

      {:ok, c2} =
        Credentials.bind_credential(u2, net_a, %{nick: "b", auth_method: :none, autojoin_channels: []})

      {:ok, c3} =
        Credentials.bind_credential(u1, net_b, %{nick: "a", auth_method: :none, autojoin_channels: []})

      ts =
        Enum.map(Credentials.list_credentials_for_all_users(), &{&1.user_id, &1.network_id, &1.inserted_at})

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
        Credentials.bind_credential(user, net, %{
          nick: "vjt",
          password: "ROUND-TRIP",
          auth_method: :auto,
          autojoin_channels: []
        })

      cred = Credentials.get_credential!(user, net)
      assert cred.password_encrypted == "ROUND-TRIP"
      assert cred.user_id == user.id
      assert cred.network_id == net.id
    end

    test "raises Ecto.NoResultsError when not bound" do
      user = user_fixture()
      net = network_fixture()

      assert_raise Ecto.NoResultsError, fn -> Credentials.get_credential!(user, net) end
    end
  end

  # Codebase review 2026-05-08 cross-infra H1 (HIGH).
  # Pre-fix: `Networks.broadcast_state_change/4` emitted
  # `{:connection_state_changed, %{...}}` via raw
  # `Phoenix.PubSub.broadcast/3`. GrappaChannel uses ONLY the framework
  # fastlane subscription (no manual `subscribe`), and fastlane fans out
  # `%Phoenix.Socket.Broadcast{}` envelopes — the raw 2-tuple was a
  # no-op for WS subscribers. Cic JOINED `grappa:network:slug` but never
  # received `connection_state_changed`; T32 disconnect/connect state
  # was invisible to the live UI (cic worked around by REST refetch
  # post-PATCH).
  #
  # Fix: route through `Grappa.PubSub.broadcast_event/2` with payload
  # `%{kind: "connection_state_changed", ...}` — the existing wire-event
  # contract every other CP15 typed event uses. Fastlane delivers the
  # payload as `phx_msg{event: "event"}` exactly once per WS, AND plain
  # `Phoenix.PubSub.subscribe/2` subscribers (test processes) receive a
  # `%Phoenix.Socket.Broadcast{event: "event", payload: ...}` envelope.
  describe "broadcast_state_change — wire-event contract (H1)" do
    test "connect/1 from :parked emits %Phoenix.Socket.Broadcast{} on the network topic" do
      user = user_fixture()
      net = network_fixture()

      {:ok, cred} =
        Credentials.bind_credential(user, net, %{
          nick: "vjt",
          password: "secretpw",
          auth_method: :auto
        })

      # Park first so connect/1 has work to do.
      {:ok, parked} = Networks.disconnect(cred, "manual")
      assert parked.connection_state == :parked

      topic = Topic.user(user.name)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      {:ok, reconnected} = Networks.connect(parked)
      assert reconnected.connection_state == :connected

      # Assert the wire-event contract: phoenix Channel envelope, kind:
      # string literal, payload carries from/to/network_slug. The pre-fix
      # tuple shape `{:connection_state_changed, %{...}}` would never
      # arrive in this shape because raw PubSub.broadcast skips the
      # channel-server fastlane wrapping.
      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{
                         kind: "connection_state_changed",
                         from: :parked,
                         to: :connected,
                         network_slug: slug
                       }
                     },
                     1_000

      assert slug == net.slug
    end

    test "disconnect/2 from :connected emits %Phoenix.Socket.Broadcast{} on the user topic" do
      user = user_fixture()
      net = network_fixture()

      {:ok, cred} =
        Credentials.bind_credential(user, net, %{
          nick: "vjt",
          password: "secretpw",
          auth_method: :auto
        })

      topic = Topic.user(user.name)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      reason = "testing parked state"
      {:ok, parked} = Networks.disconnect(cred, reason)
      assert parked.connection_state == :parked

      # Symmetric to the connect/1 case: cic's parked-window derivation
      # (`networkBySlug[slug].connection_state == :parked` ⇒ greyed
      # cascade) is driven entirely by this user-topic event. If this
      # broadcast regresses to a raw 2-tuple or stops firing, the
      # cic-side derivation has nothing to read and /disconnect leaves
      # the UI looking fully connected (the original CP15 B6 gap).
      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{
                         kind: "connection_state_changed",
                         from: :connected,
                         to: :parked,
                         network_slug: slug,
                         reason: ^reason
                       }
                     },
                     1_000

      assert slug == net.slug
    end
  end

  # UX-4 bucket B (2026-05-18). Every credential `connection_state`
  # transition co-emits a narrow `home_network_state_changed` payload on
  # the SAME user-topic alongside the wider `connection_state_changed`
  # event. HomePane patches `home_data.networks` in-place from this; the
  # Sidebar greyed-cascade + query-window store keep reading the wider
  # event. Two events, one transition, zero parallel state.
  describe "broadcast_state_change — UX-4 B home co-emit" do
    test "connect/1 from :parked also emits home_network_state_changed" do
      user = user_fixture()
      net = network_fixture()

      {:ok, cred} =
        Credentials.bind_credential(user, net, %{
          nick: "vjt",
          password: "secretpw",
          auth_method: :auto
        })

      {:ok, parked} = Networks.disconnect(cred, "manual")
      assert parked.connection_state == :parked

      topic = Topic.user(user.name)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      {:ok, _} = Networks.connect(parked)

      slug = net.slug

      # Drain both co-emitted broadcasts. Order is connection_state_changed
      # first, home_network_state_changed second — pinned by
      # `broadcast_state_change/4` so cic's discriminated dispatch
      # consumes them in the order they fire.
      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{kind: "connection_state_changed"}
                     },
                     1_000

      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{
                         kind: "home_network_state_changed",
                         network: %{slug: ^slug, connection_state: :connected, nick: "vjt"}
                       }
                     },
                     1_000
    end

    test "disconnect/2 from :connected also emits home_network_state_changed" do
      user = user_fixture()
      net = network_fixture()

      {:ok, cred} =
        Credentials.bind_credential(user, net, %{
          nick: "vjt",
          password: "secretpw",
          auth_method: :auto
        })

      topic = Topic.user(user.name)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      reason = "operator paused"
      {:ok, _} = Networks.disconnect(cred, reason)

      slug = net.slug

      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{kind: "connection_state_changed"}
                     },
                     1_000

      assert_receive %Phoenix.Socket.Broadcast{
                       event: "event",
                       payload: %{
                         kind: "home_network_state_changed",
                         network: %{
                           slug: ^slug,
                           connection_state: :parked,
                           connection_state_reason: ^reason
                         }
                       }
                     },
                     1_000
    end

    # Idempotency carry: `connect/1` on a row already at `:connected`
    # is a no-op (no DB write, no broadcast). The home co-emit MUST
    # follow the same contract — otherwise a duplicate PATCH /connect
    # under U-0's concurrent-safety semantics would fan out a phantom
    # `home_network_state_changed` event and cic would render a
    # spurious "row patched" log line.
    test "idempotent connect/1 (already :connected) emits NEITHER event" do
      user = user_fixture()
      net = network_fixture()

      {:ok, cred} =
        Credentials.bind_credential(user, net, %{
          nick: "vjt",
          password: "secretpw",
          auth_method: :auto
        })

      assert cred.connection_state == :connected

      topic = Topic.user(user.name)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      {:ok, _} = Networks.connect(cred)

      refute_receive %Phoenix.Socket.Broadcast{payload: %{kind: "connection_state_changed"}}, 100
      refute_receive %Phoenix.Socket.Broadcast{payload: %{kind: "home_network_state_changed"}}, 100
    end
  end

  describe "home_data_for_user/1 (UX-4 B)" do
    test "renders %{networks: []} for a user with zero credentials" do
      user = user_fixture()
      assert Networks.home_data_for_user(user) == %{networks: []}
    end

    test "renders one row per credential, alpha by slug (matches list_credentials_for_user)" do
      user = user_fixture()
      net_a = network_fixture("net-a-#{System.unique_integer([:positive])}")
      net_b = network_fixture("net-b-#{System.unique_integer([:positive])}")

      {:ok, _} =
        Credentials.bind_credential(user, net_a, %{
          nick: "vjt-a",
          auth_method: :none,
          autojoin_channels: []
        })

      {:ok, _} =
        Credentials.bind_credential(user, net_b, %{
          nick: "vjt-b",
          auth_method: :none,
          autojoin_channels: []
        })

      assert %{networks: rows} = Networks.home_data_for_user(user)
      assert length(rows) == 2

      # Each row carries the credential's configured nick (no Session.Server
      # running in this test → resolve_network_nick falls back to cred.nick).
      by_slug = Map.new(rows, &{&1.slug, &1})

      assert by_slug[net_a.slug].nick == "vjt-a"
      assert by_slug[net_a.slug].connection_state == :connected
      assert by_slug[net_b.slug].nick == "vjt-b"
      assert by_slug[net_b.slug].connection_state == :connected
    end

    test "surfaces parked credentials too (NOT filtered to :connected)" do
      user = user_fixture()
      net = network_fixture()

      {:ok, cred} =
        Credentials.bind_credential(user, net, %{
          nick: "vjt",
          password: "x",
          auth_method: :auto
        })

      {:ok, _} = Networks.disconnect(cred, "manual")

      assert %{networks: [row]} = Networks.home_data_for_user(user)
      assert row.slug == net.slug
      assert row.connection_state == :parked
      assert row.connection_state_reason == "manual"
    end
  end

  describe "resolve_network_nick/2 (UX-4 B promotion from controller)" do
    test "falls back to cred.nick when there's no live Session.Server" do
      user = user_fixture()
      net = network_fixture()

      {:ok, _} =
        Credentials.bind_credential(user, net, %{
          nick: "vjt-cred",
          auth_method: :none,
          autojoin_channels: []
        })

      cred =
        user
        |> Credentials.list_credentials_for_user()
        |> hd()

      assert Networks.resolve_network_nick(user.id, cred) == "vjt-cred"
    end
  end

  describe "unbind_credential/2" do
    test "deletes the credential row" do
      user = user_fixture()
      net = network_fixture()

      {:ok, _} =
        Credentials.bind_credential(user, net, %{
          nick: "vjt",
          auth_method: :none,
          autojoin_channels: []
        })

      assert :ok = Credentials.unbind_credential(user, net)
      assert_raise Ecto.NoResultsError, fn -> Credentials.get_credential!(user, net) end
    end

    test "cascades the network + servers when no other credentials reference it" do
      user = user_fixture()
      net = network_fixture("azzurra-solo")
      {:ok, _} = Servers.add_server(net, %{host: "irc.azzurra.chat", port: 6697})

      {:ok, _} =
        Credentials.bind_credential(user, net, %{
          nick: "vjt",
          auth_method: :none,
          autojoin_channels: []
        })

      assert :ok = Credentials.unbind_credential(user, net)
      assert Repo.get(Network, net.id) == nil
      query = from(s in Server, where: s.network_id == ^net.id)
      assert Repo.all(query) == []
    end

    test "keeps the network + servers when another user still has a credential" do
      u1 = user_fixture()
      u2 = user_fixture()
      net = network_fixture("azzurra-shared")
      {:ok, _} = Servers.add_server(net, %{host: "irc.azzurra.chat", port: 6697})

      {:ok, _} =
        Credentials.bind_credential(u1, net, %{
          nick: "n1",
          auth_method: :none,
          autojoin_channels: []
        })

      {:ok, _} =
        Credentials.bind_credential(u2, net, %{
          nick: "n2",
          auth_method: :none,
          autojoin_channels: []
        })

      assert :ok = Credentials.unbind_credential(u1, net)
      assert %Network{} = Repo.get(Network, net.id)
      query = from(s in Server, where: s.network_id == ^net.id)
      assert length(Repo.all(query)) == 1
      assert %Credential{} = Credentials.get_credential!(u2, net)
    end

    test "returns :ok when called for a non-existent binding (idempotent)" do
      user = user_fixture()
      net = network_fixture()
      assert :ok = Credentials.unbind_credential(user, net)
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
      {:ok, _} = Servers.add_server(net, %{host: "irc.azzurra.chat", port: 6697})

      {:ok, _} =
        Credentials.bind_credential(user, net, %{
          nick: "vjt",
          auth_method: :none,
          autojoin_channels: []
        })

      # One scrollback row blocks the cascade.
      {:ok, _} =
        Grappa.ScrollbackHelpers.insert(%{
          user_id: user.id,
          network_id: net.id,
          channel: "#sniffo",
          server_time: 1,
          kind: :privmsg,
          sender: "vjt",
          body: "msg keep me"
        })

      assert {:error, :scrollback_present} = Credentials.unbind_credential(user, net)

      # Transaction rolled back — credential AND network still present.
      assert %Network{} = Repo.get(Network, net.id)
      assert %Credential{} = Credentials.get_credential!(user, net)
    end

    # S29 H5: see Grappa.Session.ServerTest "unbind_credential tears
    # down a running session" for the integration test that proves
    # `Credentials.unbind_credential/2` calls `Grappa.Session.stop_session/2`
    # before deleting the row. Lives there because that file already
    # carries the IRCServer + sandbox-shared scaffolding for live
    # sessions.

    test "still cascades when last user has NO scrollback (the happy path remains)" do
      user = user_fixture()
      net = network_fixture("azzurra-cleancascade")
      {:ok, _} = Servers.add_server(net, %{host: "irc.azzurra.chat", port: 6697})

      {:ok, _} =
        Credentials.bind_credential(user, net, %{
          nick: "vjt",
          auth_method: :none,
          autojoin_channels: []
        })

      # No messages → cascade proceeds.
      assert :ok = Credentials.unbind_credential(user, net)
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

  describe "network_id_by_slug_index/0 (M-4 admin console)" do
    test "returns %{slug => id} for every networks row" do
      net_a = network_fixture("idx-a-#{System.unique_integer([:positive])}")
      net_b = network_fixture("idx-b-#{System.unique_integer([:positive])}")

      index = Networks.network_id_by_slug_index()

      assert Map.get(index, net_a.slug) == net_a.id
      assert Map.get(index, net_b.slug) == net_b.id
    end
  end

  describe "list_all/0 (M-5 admin console)" do
    test "returns every networks row ordered by slug ascending" do
      # Insert in reverse-slug order to prove the ordering isn't accidental.
      net_z = network_fixture("z-#{System.unique_integer([:positive])}")
      net_a = network_fixture("a-#{System.unique_integer([:positive])}")
      net_m = network_fixture("m-#{System.unique_integer([:positive])}")

      slugs = Enum.map(Networks.list_all(), & &1.slug)

      # All three present, in ascending slug order. Other tests may also
      # have planted rows; assert relative order rather than exact set.
      idx_a = Enum.find_index(slugs, &(&1 == net_a.slug))
      idx_m = Enum.find_index(slugs, &(&1 == net_m.slug))
      idx_z = Enum.find_index(slugs, &(&1 == net_z.slug))
      assert idx_a < idx_m
      assert idx_m < idx_z
    end
  end

  describe "update_network_caps/2" do
    test "sets all three caps (visitor + user + per_client)" do
      net = network_fixture()
      assert is_nil(net.max_concurrent_visitor_sessions)
      assert net.max_concurrent_user_sessions == 3
      assert is_nil(net.max_per_client)

      assert {:ok, %Network{} = updated} =
               Networks.update_network_caps(net, %{
                 max_concurrent_visitor_sessions: 3,
                 max_concurrent_user_sessions: 5,
                 max_per_client: 1
               })

      assert updated.max_concurrent_visitor_sessions == 3
      assert updated.max_concurrent_user_sessions == 5
      assert updated.max_per_client == 1
      assert updated.slug == net.slug
    end

    test "updates only the cap fields supplied; preserves the others" do
      net = network_fixture()

      {:ok, with_both} =
        Networks.update_network_caps(net, %{
          max_concurrent_visitor_sessions: 5,
          max_per_client: 2
        })

      assert {:ok, %Network{} = updated} =
               Networks.update_network_caps(with_both, %{max_concurrent_visitor_sessions: 10})

      assert updated.max_concurrent_visitor_sessions == 10
      assert updated.max_per_client == 2
    end

    test "rejects negative caps via changeset" do
      net = network_fixture()

      assert {:error, %Ecto.Changeset{} = cs} =
               Networks.update_network_caps(net, %{max_per_client: -1})

      assert errors_on(cs)[:max_per_client] != nil

      assert {:error, %Ecto.Changeset{} = cs2} =
               Networks.update_network_caps(net, %{max_concurrent_user_sessions: -1})

      assert errors_on(cs2)[:max_concurrent_user_sessions] != nil
    end

    test "accepts zero (degenerate lock-down — explicit 'allow none')" do
      net = network_fixture()

      assert {:ok, %Network{} = updated} =
               Networks.update_network_caps(net, %{max_concurrent_visitor_sessions: 0})

      assert updated.max_concurrent_visitor_sessions == 0
    end

    test "with nil clears the cap (explicit 'unlimited')" do
      net = network_fixture()

      {:ok, with_caps} =
        Networks.update_network_caps(net, %{
          max_concurrent_visitor_sessions: 5,
          max_per_client: 3
        })

      assert {:ok, %Network{} = cleared} =
               Networks.update_network_caps(with_caps, %{max_concurrent_visitor_sessions: nil})

      assert is_nil(cleared.max_concurrent_visitor_sessions)
      # the unsupplied other cap is preserved
      assert cleared.max_per_client == 3
    end

    test "with nil clears max_per_client too (symmetry)" do
      net = network_fixture()

      {:ok, with_caps} =
        Networks.update_network_caps(net, %{
          max_concurrent_visitor_sessions: 5,
          max_per_client: 3
        })

      assert {:ok, %Network{} = cleared} =
               Networks.update_network_caps(with_caps, %{max_per_client: nil})

      assert is_nil(cleared.max_per_client)
      assert cleared.max_concurrent_visitor_sessions == 5
    end

    test "with nil clears max_concurrent_user_sessions (no DB default override)" do
      net = network_fixture()
      # DB default = 3.
      assert net.max_concurrent_user_sessions == 3

      assert {:ok, %Network{} = cleared} =
               Networks.update_network_caps(net, %{max_concurrent_user_sessions: nil})

      assert is_nil(cleared.max_concurrent_user_sessions)
    end

    test "ignores unknown attrs (cast allowlist)" do
      net = network_fixture()

      assert {:ok, %Network{} = updated} =
               Networks.update_network_caps(net, %{
                 max_concurrent_visitor_sessions: 4,
                 garbage: "ignored"
               })

      assert updated.max_concurrent_visitor_sessions == 4
    end
  end

  describe "pick_server!/1 (A2/A10 — lifted from Session.Server)" do
    test "returns the lowest-priority enabled server, ties broken by id" do
      net = network_fixture()
      {:ok, _} = Servers.add_server(net, %{host: "h1", port: 6667, priority: 5})
      {:ok, _} = Servers.add_server(net, %{host: "h2", port: 6667, priority: 1})
      {:ok, _} = Servers.add_server(net, %{host: "h3", port: 6667, priority: 1})

      preloaded = Repo.preload(net, :servers)
      assert %Server{host: "h2"} = Servers.pick_server!(preloaded)
    end

    test "skips disabled servers even when priority would prefer them" do
      net = network_fixture()
      {:ok, _} = Servers.add_server(net, %{host: "disabled", port: 6667, priority: 0, enabled: false})
      {:ok, _} = Servers.add_server(net, %{host: "enabled", port: 6667, priority: 5})

      preloaded = Repo.preload(net, :servers)
      assert %Server{host: "enabled"} = Servers.pick_server!(preloaded)
    end

    test "raises NoServerError when every server is disabled" do
      net = network_fixture()
      {:ok, _} = Servers.add_server(net, %{host: "off", port: 6667, enabled: false})
      preloaded = Repo.preload(net, :servers)

      assert_raise Networks.NoServerError, fn -> Servers.pick_server!(preloaded) end
    end

    test "raises NoServerError when the network has zero servers" do
      net = network_fixture()
      preloaded = Repo.preload(net, :servers)
      assert_raise Networks.NoServerError, fn -> Servers.pick_server!(preloaded) end
    end
  end

  # Cluster 2 (A2): the data resolver that flattens a Credential +
  # picked Server + User into the primitive `Session.start_opts/0`
  # plan. Session.Server.init/1 is now a pure consumer of this map;
  # the failure-mode tests previously lived on server_test.exs and
  # moved here when the resolution moved into Networks.
  describe "SessionPlan.resolve/1" do
    test "returns the resolved primitive opts for a bound credential" do
      user = user_fixture()
      net = network_fixture()
      {:ok, _} = Servers.add_server(net, %{host: "irc.example", port: 6697, tls: true, priority: 0})

      {:ok, _} =
        Credentials.bind_credential(user, net, %{
          nick: "vjt-grappa",
          auth_method: :sasl,
          password: "loadbearing",
          autojoin_channels: ["#sniffo"]
        })

      cred = Credentials.get_credential!(user, net)
      assert {:ok, plan} = SessionPlan.resolve(cred)

      assert plan.subject == {:user, user.id}
      assert plan.subject_label == user.name
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
      {:ok, _} = Servers.add_server(net, %{host: "off", port: 6667, enabled: false})

      {:ok, _} =
        Credentials.bind_credential(user, net, %{
          nick: "vjt",
          auth_method: :none,
          autojoin_channels: []
        })

      cred = Credentials.get_credential!(user, net)
      assert {:error, :no_server} = SessionPlan.resolve(cred)
    end

    test "returns {:error, :no_server} when the network has no servers at all" do
      user = user_fixture()
      net = network_fixture()

      {:ok, _} =
        Credentials.bind_credential(user, net, %{
          nick: "vjt",
          auth_method: :none,
          autojoin_channels: []
        })

      cred = Credentials.get_credential!(user, net)
      assert {:error, :no_server} = SessionPlan.resolve(cred)
    end

    test "is a no-op preload when the credential already has :network preloaded (Bootstrap path)" do
      user = user_fixture()
      net = network_fixture()
      {:ok, _} = Servers.add_server(net, %{host: "h", port: 6667})

      {:ok, _} =
        Credentials.bind_credential(user, net, %{
          nick: "vjt",
          auth_method: :none,
          autojoin_channels: []
        })

      # `list_credentials_for_all_users/0` is the canonical
      # preloaded-:network producer.
      [cred] = Credentials.list_credentials_for_all_users()
      assert {:ok, plan} = SessionPlan.resolve(cred)
      assert plan.host == "h"
    end
  end
end
