defmodule Grappa.VisitorsTest do
  # async: false because visitor INSERTs race with the IRC integration
  # tests for the sqlite single-writer lock under MIX_ENV=test's
  # max_cases: 2 — see handoff doc + CP11 S2 baseline-hygiene notes
  # (residual ~20% sqlite-busy flake category). Serializing this file
  # avoids contributing to the contention. Tests are fast (~300ms total)
  # so the serialization cost is negligible.
  use Grappa.DataCase, async: false

  import Ecto.Query
  import Grappa.AuthFixtures

  alias Grappa.{Accounts, Networks, Themes, Visitors}
  alias Grappa.Accounts.Session
  alias Grappa.Networks.Credentials
  alias Grappa.Session.Backoff
  alias Grappa.Themes.{Theme, TokenModel}
  alias Grappa.Visitors.Visitor

  defp valid_theme_payload do
    %{
      "colors" => Map.new(TokenModel.color_keys(), fn k -> {k, "#123456"} end),
      "font_family" => "mono-default",
      "background" => %{"image_id" => nil, "opacity" => 0.3}
    }
  end

  @network "azzurra"
  @ttl_anon 48 * 3600

  # #211 phase 7 — `find_or_provision_anon/3` resolves the network by slug
  # to bind the anon credential, so the slug MUST have a `networks` row.
  # Every test uses the shared @network slug; create it once per test.
  setup do
    {:ok, network} = Networks.find_or_create_network(%{slug: @network})
    %{network: network}
  end

  # #211 phase 7 — the identity nick lives on the visitor's representative
  # credential now (the row has no nick). Test helper mirroring what the
  # admin/label surfaces read.
  defp nick_of(%Visitor{id: id}) do
    {:ok, cred} = Credentials.representative_visitor_credential(id)
    cred.nick
  end

  defp password_of(%Visitor{id: id}, network_id) do
    {:ok, cred} = Credentials.get_visitor_credential(id, network_id)
    cred.password_encrypted
  end

  describe "find_or_provision_anon/3" do
    test "creates a bare identity row + anon credential with 48h expires_at", %{network: net} do
      assert {:ok, %Visitor{} = v} =
               Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")

      # nick lives on the credential now, not the row
      assert nick_of(v) == "vjt"
      assert is_nil(password_of(v, net.id))
      assert DateTime.diff(v.expires_at, DateTime.utc_now()) in (@ttl_anon - 5)..(@ttl_anon + 5)
    end

    test "returns existing identity if (nick, network) match" do
      {:ok, v1} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      {:ok, v2} = Visitors.find_or_provision_anon("vjt", @network, "5.6.7.8")
      assert v1.id == v2.id
    end

    test "reattaches a different-case reconnect to the SAME identity (rfc1459 #121)" do
      # rfc1459 folding collapses `Mezmerize`/`mezmerize` to one identity —
      # credential-first resolution (phase 4c) keys on the folded credential
      # nick, so the second login resolves the first's visitor.
      {:ok, v1} = Visitors.find_or_provision_anon("Mezmerize", @network, "1.2.3.4")
      {:ok, v2} = Visitors.find_or_provision_anon("mezmerize", @network, "5.6.7.8")
      assert v2.id == v1.id
      assert nick_of(v1) == "Mezmerize", "display case of the first-provisioned credential is preserved"
    end

    test "folds the four rfc1459 national chars [ ] \\ ~ (bahamut casemapping)" do
      {:ok, v1} = Visitors.find_or_provision_anon("nick[1]", @network, "1.2.3.4")
      {:ok, v2} = Visitors.find_or_provision_anon("nick{1}", @network, "5.6.7.8")
      assert v2.id == v1.id
    end

    test "returns {:error, :network_unconfigured} when the slug has no networks row" do
      assert {:error, :network_unconfigured} =
               Visitors.find_or_provision_anon("vjt", "no-such-net", "1.2.3.4")
    end

    test "refreshes :ip on subsequent login when client address changed" do
      {:ok, v1} = Visitors.find_or_provision_anon("vjt-ipa", @network, "1.2.3.4")
      assert v1.ip == "1.2.3.4"

      {:ok, v2} = Visitors.find_or_provision_anon("vjt-ipa", @network, "5.6.7.8")
      assert v2.id == v1.id
      assert v2.ip == "5.6.7.8"
    end

    test "leaves :ip unchanged when same address re-logs in (no-op write)" do
      {:ok, v1} = Visitors.find_or_provision_anon("vjt-ipb", @network, "1.2.3.4")
      {:ok, v2} = Visitors.find_or_provision_anon("vjt-ipb", @network, "1.2.3.4")
      assert v2.id == v1.id
      assert v2.ip == "1.2.3.4"
      assert v2.updated_at == v1.updated_at
    end

    test "supplying nil :ip does NOT clobber a row that already has a real IP" do
      {:ok, v1} = Visitors.find_or_provision_anon("vjt-ipc", @network, "1.2.3.4")
      {:ok, v2} = Visitors.find_or_provision_anon("vjt-ipc", @network, nil)
      assert v2.id == v1.id
      assert v2.ip == "1.2.3.4"
    end
  end

  describe "commit_password/3 (#211 phase 7 — per-network credential)" do
    test "writes the password onto the credential + registers the identity (derived)", %{
      network: net
    } do
      {:ok, v} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      refute Credentials.visitor_registered?(v.id)

      assert {:ok, cred} = Visitors.commit_password(v.id, net.id, "s3cret")
      # Cloak roundtrips symmetrically — the in-memory value is the plaintext.
      assert cred.password_encrypted == "s3cret"

      # #211 phase 7 — registration is DERIVED from the credentials (a
      # committed NickServ secret), NOT a cleared `expires_at`. commit does
      # NOT touch the visitor row's TTL anymore.
      assert Credentials.visitor_registered?(v.id)
    end

    test "returns {:error, :not_found} for an unknown (visitor, network)", %{network: net} do
      assert {:error, :not_found} =
               Visitors.commit_password(Ecto.UUID.generate(), net.id, "s3cret")
    end

    test "returns {:error, :not_found} when the credential is concurrently deleted (H14)", %{
      network: net
    } do
      {:ok, v} = Visitors.find_or_provision_anon("vjt-h14", @network, "1.2.3.4")
      {:ok, _} = Grappa.Repo.delete(v)

      # CASCADE dropped the credential too → not_found.
      assert {:error, :not_found} = Visitors.commit_password(v.id, net.id, "s3cret")
    end
  end

  # #131 — in-session SET PASSWD commit verb. Identity-gated PER-NETWORK:
  # it must NEVER promote an anon credential (services reject SET PASSWD for
  # an unidentified nick, and an optimistic commit carries no +r proof).
  describe "rotate_password/3" do
    test "rotates an already-identified credential's password (stays registered)", %{
      network: net
    } do
      {:ok, anon} = Visitors.find_or_provision_anon("vjt-rot", @network, "1.2.3.4")
      {:ok, _} = Visitors.commit_password(anon.id, net.id, "oldpass")
      assert Credentials.visitor_registered?(anon.id)

      assert {:ok, rotated} = Visitors.rotate_password(anon.id, net.id, "newpass")
      assert rotated.password_encrypted == "newpass"
      assert Credentials.visitor_registered?(anon.id)
    end

    test "rotates a rest-of-line password with spaces verbatim", %{network: net} do
      {:ok, anon} = Visitors.find_or_provision_anon("vjt-rot-sp", @network, "1.2.3.4")
      {:ok, _} = Visitors.commit_password(anon.id, net.id, "oldpass")

      assert {:ok, rotated} = Visitors.rotate_password(anon.id, net.id, "my new pass phrase")
      assert rotated.password_encrypted == "my new pass phrase"
    end

    test "{:error, :not_identified} for an anon credential — NEVER promotes it", %{network: net} do
      {:ok, anon} = Visitors.find_or_provision_anon("vjt-anon", @network, "1.2.3.4")
      refute is_nil(anon.expires_at)
      assert is_nil(password_of(anon, net.id))

      assert {:error, :not_identified} = Visitors.rotate_password(anon.id, net.id, "newpass")

      # Untouched: anon credential + still-ephemeral identity.
      assert is_nil(password_of(anon, net.id))
      refute is_nil(Repo.reload!(anon).expires_at)
    end

    test "{:error, :not_found} for an unknown (visitor, network)", %{network: net} do
      assert {:error, :not_found} =
               Visitors.rotate_password(Ecto.UUID.generate(), net.id, "newpass")
    end

    test "{:error, :not_found} when the credential is concurrently deleted (H14)", %{network: net} do
      {:ok, anon} = Visitors.find_or_provision_anon("vjt-rot-h14", @network, "1.2.3.4")
      {:ok, _} = Visitors.commit_password(anon.id, net.id, "oldpass")
      {:ok, _} = Grappa.Repo.delete(anon)

      assert {:error, :not_found} = Visitors.rotate_password(anon.id, net.id, "newpass")
    end
  end

  describe "update_nick/3 (#211 phase 7 — per-network credential)" do
    test "rotates the credential nick", %{network: net} do
      {:ok, v} = Visitors.find_or_provision_anon("vjt-nick", @network, "1.2.3.4")

      assert {:ok, cred} = Visitors.update_nick(v.id, net.id, "vjt-renamed")
      assert cred.nick == "vjt-renamed"
      assert nick_of(v) == "vjt-renamed"
    end

    test "returns {:error, :not_found} when the credential is gone", %{network: net} do
      {:ok, v} = Visitors.find_or_provision_anon("vjt-h14b", @network, "1.2.3.4")
      {:ok, _} = Grappa.Repo.delete(v)

      assert {:error, :not_found} = Visitors.update_nick(v.id, net.id, "vjt-renamed")
    end
  end

  describe "nick_in_use?/3 (per-network credential folded lookup)" do
    test "true when a DIFFERENT visitor holds the folded nick on the network", %{network: net} do
      {:ok, _} = Visitors.find_or_provision_anon("Taken", @network, "1.2.3.4")
      {:ok, other} = Visitors.find_or_provision_anon("other", @network, "5.6.7.8")

      # rfc1459-folded: `taken` collides with `Taken`.
      assert Visitors.nick_in_use?(other.id, "taken", net.id)
    end

    test "false when only the visitor itself holds the nick (idempotent rename)", %{network: net} do
      {:ok, v} = Visitors.find_or_provision_anon("Self", @network, "1.2.3.4")
      refute Visitors.nick_in_use?(v.id, "self", net.id)
    end

    test "false when the slot is free", %{network: net} do
      {:ok, v} = Visitors.find_or_provision_anon("vjt-free", @network, "1.2.3.4")
      refute Visitors.nick_in_use?(v.id, "nobody-here", net.id)
    end
  end

  describe "touch/1" do
    test "bumps expires_at if ≥1h since last bump (delta to fresh target ≥ cadence)" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")

      one_hour_ago = DateTime.add(DateTime.utc_now(), @ttl_anon - 3601, :second)
      query = from(x in Visitor, where: x.id == ^v.id)
      Repo.update_all(query, set: [expires_at: one_hour_ago])

      assert {:ok, touched} = Visitors.touch(v.id)
      assert DateTime.compare(touched.expires_at, one_hour_ago) == :gt
    end

    test "no-op if <1h since last bump" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      old_expires = v.expires_at

      assert {:ok, touched} = Visitors.touch(v.id)
      assert DateTime.compare(touched.expires_at, old_expires) == :eq
    end

    test "returns {:error, :not_found} for unknown visitor_id" do
      assert {:error, :not_found} = Visitors.touch(Ecto.UUID.generate())
    end

    test "expired visitor → {:error, :expired} (no resurrection)" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      past = DateTime.add(DateTime.utc_now(), -1, :hour)

      query = from(x in Visitor, where: x.id == ^v.id)
      Repo.update_all(query, set: [expires_at: past])

      assert {:error, :expired} = Visitors.touch(v.id)
      assert DateTime.compare(Repo.reload!(v).expires_at, past) == :eq
    end

    test "registered visitor (derived) → no-op {:ok, visitor}, TTL untouched", %{network: net} do
      {:ok, anon} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      {:ok, _} = Visitors.commit_password(anon.id, net.id, "s3cret")
      assert Credentials.visitor_registered?(anon.id)
      # #211 phase 7 — commit does NOT clear expires_at; registration is
      # derived from the credential, so touch no-ops via the derived check.
      before = Repo.reload!(anon).expires_at

      assert {:ok, %Visitor{}} = Visitors.touch(anon.id)
      assert Repo.reload!(anon).expires_at == before
    end
  end

  describe "count_active_for_ip/1" do
    test "counts visitors with expires_at > now() per IP" do
      {:ok, _} = Visitors.find_or_provision_anon("a", @network, "1.2.3.4")
      {:ok, _} = Visitors.find_or_provision_anon("b", @network, "1.2.3.4")
      {:ok, _} = Visitors.find_or_provision_anon("c", @network, "9.9.9.9")

      assert Visitors.count_active_for_ip("1.2.3.4") == 2
      assert Visitors.count_active_for_ip("9.9.9.9") == 1
    end

    test "ignores expired rows" do
      {:ok, dead} = Visitors.find_or_provision_anon("dead", @network, "1.2.3.4")

      query = from(x in Visitor, where: x.id == ^dead.id)
      Repo.update_all(query, set: [expires_at: DateTime.add(DateTime.utc_now(), -1, :hour)])

      assert Visitors.count_active_for_ip("1.2.3.4") == 0
    end
  end

  describe "list_active/0" do
    test "returns only non-expired visitors" do
      {:ok, alive} = Visitors.find_or_provision_anon("alive", @network, "1.2.3.4")
      {:ok, dead} = Visitors.find_or_provision_anon("dead", @network, "1.2.3.4")

      query = from(x in Visitor, where: x.id == ^dead.id)
      Repo.update_all(query, set: [expires_at: DateTime.add(DateTime.utc_now(), -1, :hour)])

      ids = Enum.map(Visitors.list_active(), & &1.id)
      assert alive.id in ids
      refute dead.id in ids
    end
  end

  describe "list_expired/0" do
    test "returns only expired visitors" do
      {:ok, alive} = Visitors.find_or_provision_anon("alive", @network, "1.2.3.4")
      {:ok, dead} = Visitors.find_or_provision_anon("dead", @network, "1.2.3.4")

      query = from(x in Visitor, where: x.id == ^dead.id)
      Repo.update_all(query, set: [expires_at: DateTime.add(DateTime.utc_now(), -1, :hour)])

      ids = Enum.map(Visitors.list_expired(), & &1.id)
      refute alive.id in ids
      assert dead.id in ids
    end

    test "still reaps an expired anon when a USER credential with a password exists (NULL-poisoning regression)",
         %{network: net} do
      # #211 phase 7 CRITICAL regression: `registered_ids_subquery/0` feeds
      # `list_expired/0` via `v.id NOT IN (…)`. If the subquery selected
      # `visitor_id` from ALL credentials with a password — including USER
      # credentials, whose `visitor_id IS NULL` — a single user password
      # would inject a NULL into the set, and SQL `x NOT IN (…, NULL)` is
      # NULL (never TRUE) for every x, zeroing out the Reaper in prod. Seed
      # exactly that shape: a user credential WITH a password alongside an
      # expired anon visitor, and assert the anon is still returned.
      user = user_fixture()
      _ = credential_fixture(user, net, %{password: "hunter2", auth_method: :nickserv_identify})

      {:ok, dead_anon} = Visitors.find_or_provision_anon("deadanon", @network, "1.2.3.4")

      query = from(x in Visitor, where: x.id == ^dead_anon.id)
      Repo.update_all(query, set: [expires_at: DateTime.add(DateTime.utc_now(), -1, :hour)])

      ids = Enum.map(Visitors.list_expired(), & &1.id)
      assert dead_anon.id in ids
    end
  end

  describe "list_all/0 (M-4 admin console)" do
    test "returns active + expired visitors ordered by inserted_at asc" do
      {:ok, alive} = Visitors.find_or_provision_anon("alive", @network, "1.2.3.4")
      {:ok, dead} = Visitors.find_or_provision_anon("dead", @network, "1.2.3.4")

      query = from(x in Visitor, where: x.id == ^dead.id)
      Repo.update_all(query, set: [expires_at: DateTime.add(DateTime.utc_now(), -1, :hour)])

      ids = Enum.map(Visitors.list_all(), & &1.id)
      assert alive.id in ids
      assert dead.id in ids
    end
  end

  describe "list_all_with_live_state/0 (M-4 admin console — per-network)" do
    test "returns {visitor, [{credential, nil}]} for a visitor with no live session" do
      {:ok, v} = Visitors.find_or_provision_anon("solo", @network, "1.2.3.4")

      results = Visitors.list_all_with_live_state()

      assert {%Visitor{} = found, per_network} =
               Enum.find(results, fn {row, _} -> row.id == v.id end)

      assert found.id == v.id
      # one credential (the anon @network one), no live pid → nil live state
      assert [{%Grappa.Networks.Credential{}, nil}] = per_network
    end

    test "returns {visitor, []} for a credential-less identity" do
      # A bare row with no credential (fixture with an unresolved slug).
      orphan_slug = "orphan-#{System.unique_integer([:positive])}"
      v = visitor_fixture(network_slug: orphan_slug, nick: "orph")

      results = Visitors.list_all_with_live_state()

      assert {%Visitor{}, []} =
               Enum.find(results, fn {row, _} -> row.id == v.id end)
    end
  end

  describe "delete/1" do
    test "removes visitor row + CASCADE wipes accounts_sessions" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      {:ok, session} = Accounts.create_session({:visitor, v.id}, "1.2.3.4", "ua", [])

      assert :ok = Visitors.delete(v.id)
      assert is_nil(Repo.get(Visitor, v.id))
      assert is_nil(Repo.get(Session, session.id))
    end

    test "returns {:error, :not_found} for unknown visitor_id" do
      assert {:error, :not_found} = Visitors.delete(Ecto.UUID.generate())
    end

    test "re-homes the visitor's PUBLISHED themes to system, CASCADE-kills private (#299)" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt-themes", @network, "1.2.3.4")
      {:ok, pub} = Themes.create_theme({:visitor, v}, %{name: "Pub", payload: valid_theme_payload()})
      {:ok, _} = Themes.publish_theme({:visitor, v}, pub.id)
      {:ok, priv} = Themes.create_theme({:visitor, v}, %{name: "Priv", payload: valid_theme_payload()})

      assert :ok = Visitors.delete(v.id)

      # Published theme survives, re-homed to the system user.
      survivor = Repo.get(Theme, pub.id)
      assert survivor.user_id == Themes.system_user().id
      assert survivor.visitor_id == nil
      # Private theme died with the visitor via the visitor_id CASCADE.
      assert is_nil(Repo.get(Theme, priv.id))
    end

    test "evicts the subject's Backoff entries" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt-bo", @network, "1.2.3.4")
      :ok = Backoff.record_failure({:visitor, v.id}, 1)
      assert Backoff.failure_count({:visitor, v.id}, 1) == 1

      assert :ok = Visitors.delete(v.id)
      assert Backoff.failure_count({:visitor, v.id}, 1) == 0
    end
  end

  describe "mark_failed/2 (lifecycle/S1)" do
    test "expires the visitor immediately so Bootstrap stops respawning" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt-fail", @network, "1.2.3.4")
      assert Enum.any?(Visitors.list_active(), &(&1.id == v.id))

      assert :ok = Visitors.mark_failed(v.id, "k-lined: 'no spam'")

      refute Enum.any?(Visitors.list_active(), &(&1.id == v.id))
      assert Enum.any?(Visitors.list_expired(), &(&1.id == v.id))
    end

    test "is idempotent on repeat call" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt-fail2", @network, "1.2.3.4")
      assert :ok = Visitors.mark_failed(v.id, "k-lined")
      assert :ok = Visitors.mark_failed(v.id, "k-lined")
    end

    test "returns {:error, :not_found} for unknown visitor_id" do
      assert {:error, :not_found} =
               Visitors.mark_failed(Ecto.UUID.generate(), "k-lined")
    end
  end

  describe "get!/1" do
    test "returns the visitor row by id" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      assert %Visitor{id: id} = Visitors.get!(v.id)
      assert id == v.id
    end

    test "raises Ecto.NoResultsError on miss" do
      assert_raise Ecto.NoResultsError, fn ->
        Visitors.get!(Ecto.UUID.generate())
      end
    end
  end

  # #87 + #211 phase 4c — visitor-side per-network "dismiss channel".
  describe "remove_autojoin_channel/3 (per-network)" do
    test "drops the channel from the visitor's per-network rejoin list, keeps the rest" do
      {_, network} = visitor_with_network(6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt", network.slug, "1.2.3.4")
      :ok = Visitors.update_last_joined_channels(visitor.id, network.id, ["#one", "#two"])

      assert {:ok, _} = Visitors.remove_autojoin_channel(visitor, network.id, "#one")

      kept = Visitors.list_autojoin_channels(visitor, network.id)
      assert "#one" not in kept
      assert "#two" in kept
    end

    test "matches case-insensitively (RFC 2812 channel casemapping)" do
      {_, network} = visitor_with_network(6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt", network.slug, "1.2.3.4")
      :ok = Visitors.update_last_joined_channels(visitor.id, network.id, ["#italia"])

      assert {:ok, _} = Visitors.remove_autojoin_channel(visitor, network.id, "#ITALIA")
      assert Visitors.list_autojoin_channels(visitor, network.id) == []
    end

    test "absent channel is a no-op (idempotent leave)" do
      {_, network} = visitor_with_network(6667)
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt", network.slug, "1.2.3.4")
      :ok = Visitors.update_last_joined_channels(visitor.id, network.id, ["#one"])

      assert {:ok, _} = Visitors.remove_autojoin_channel(visitor, network.id, "#two")
      assert Visitors.list_autojoin_channels(visitor, network.id) == ["#one"]
    end

    test "{:error, :not_found} when the credential is gone" do
      {_, network} = visitor_with_network(6667)
      # A bare visitor with no credential on THIS network.
      other_slug = "other-#{System.unique_integer([:positive])}"
      {:ok, _} = Networks.find_or_create_network(%{slug: other_slug})
      visitor = visitor_fixture(nick: "nocreds", network_slug: other_slug)

      assert {:error, :not_found} =
               Visitors.remove_autojoin_channel(visitor, network.id, "#one")
    end
  end

  describe "purge_if_anon/1 (W11 co-terminus delete)" do
    test "anon visitor → row deleted + CASCADE wipes accounts_sessions" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      {:ok, session} = Accounts.create_session({:visitor, v.id}, "1.2.3.4", "ua", [])

      refute is_nil(v.expires_at)
      assert :ok = Visitors.purge_if_anon(v.id)

      assert is_nil(Repo.get(Visitor, v.id))
      assert is_nil(Repo.get(Session, session.id))
    end

    test "registered visitor → no-op (row preserved)", %{network: net} do
      {:ok, v} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      {:ok, _} = Visitors.commit_password(v.id, net.id, "s3cret")
      {:ok, session} = Accounts.create_session({:visitor, v.id}, "1.2.3.4", "ua", [])

      assert Credentials.visitor_registered?(v.id)
      assert :ok = Visitors.purge_if_anon(v.id)

      assert %Visitor{} = Repo.get(Visitor, v.id)
      assert %Session{} = Repo.get(Session, session.id)
    end

    test "anon purge re-homes PUBLISHED themes to system, CASCADE-kills private (#299)" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt-purge-themes", @network, "1.2.3.4")
      {:ok, pub} = Themes.create_theme({:visitor, v}, %{name: "Pub", payload: valid_theme_payload()})
      {:ok, _} = Themes.publish_theme({:visitor, v}, pub.id)
      {:ok, priv} = Themes.create_theme({:visitor, v}, %{name: "Priv", payload: valid_theme_payload()})

      assert :ok = Visitors.purge_if_anon(v.id)

      survivor = Repo.get(Theme, pub.id)
      assert survivor.user_id == Themes.system_user().id
      assert survivor.visitor_id == nil
      assert is_nil(Repo.get(Theme, priv.id))
    end

    test "anon delete evicts the subject's Backoff entries" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt-bo2", @network, "1.2.3.4")
      :ok = Backoff.record_failure({:visitor, v.id}, 1)
      assert Backoff.failure_count({:visitor, v.id}, 1) == 1

      assert :ok = Visitors.purge_if_anon(v.id)
      assert Backoff.failure_count({:visitor, v.id}, 1) == 0
    end

    test "registered no-op purge leaves Backoff entries intact", %{network: net} do
      {:ok, v} = Visitors.find_or_provision_anon("vjt-bo3", @network, "1.2.3.4")
      {:ok, _} = Visitors.commit_password(v.id, net.id, "s3cret")
      :ok = Backoff.record_failure({:visitor, v.id}, 1)

      assert :ok = Visitors.purge_if_anon(v.id)
      assert Backoff.failure_count({:visitor, v.id}, 1) == 1
    end

    test "missing row → no-op (idempotent)" do
      assert :ok = Visitors.purge_if_anon(Ecto.UUID.generate())
    end
  end
end
