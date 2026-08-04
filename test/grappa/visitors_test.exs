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

  alias Grappa.{Accounts, Networks, Themes, UserSettings, Visitors}
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
  # #363 incognito — the linger window: an incognito visitor born with a
  # short TTL that the Reaper reconcile slides forward only while a browser
  # socket is connected, so it elapses ~1h after the last disconnect.
  @ttl_incognito 3600
  # #363 incognito — the gentle upload-expiry default seeded onto a fresh
  # incognito session's OWN upload-TTL pref (shortest ladder rung, 1h). A
  # separate clock from the linger even though both are 3600 today.
  @seeded_incognito_upload_ttl 3600

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

    test "reattaches a different-case reconnect to the SAME identity (ASCII, #121/#525)" do
      # ASCII folding collapses `Mezmerize`/`mezmerize` to one identity —
      # credential-first resolution (phase 4c) keys on the folded credential
      # nick, so the second login resolves the first's visitor.
      {:ok, v1} = Visitors.find_or_provision_anon("Mezmerize", @network, "1.2.3.4")
      {:ok, v2} = Visitors.find_or_provision_anon("mezmerize", @network, "5.6.7.8")
      assert v2.id == v1.id
      assert nick_of(v1) == "Mezmerize", "display case of the first-provisioned credential is preserved"
    end

    test "does NOT fold the bracket chars [ ] \\ ~ — CASEMAPPING=ascii (#525)" do
      # bahamut folds A-Z only; `nick[1]` and `nick{1}` are DISTINCT nicks,
      # so they provision SEPARATE visitor identities (reverses the #121
      # over-fold). A case-only variant still collapses (below).
      {:ok, v1} = Visitors.find_or_provision_anon("nick[1]", @network, "1.2.3.4")
      {:ok, v2} = Visitors.find_or_provision_anon("nick{1}", @network, "5.6.7.8")
      assert v2.id != v1.id

      {:ok, v3} = Visitors.find_or_provision_anon("NICK[1]", @network, "9.9.9.9")
      assert v3.id == v1.id
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

    test "arity/3 provisions a non-incognito session" do
      assert {:ok, %Visitor{incognito: false}} =
               Visitors.find_or_provision_anon("plain", @network, "1.2.3.4")
    end
  end

  describe "find_or_provision_anon/4 (#363 incognito)" do
    test "incognito: true sets the flag + a ~1h linger TTL (not the 48h anon TTL)", %{
      network: net
    } do
      assert {:ok, %Visitor{} = v} =
               Visitors.find_or_provision_anon("ghost", @network, "1.2.3.4", true)

      assert v.incognito == true
      # identity still lives on the anon credential (no password)
      assert nick_of(v) == "ghost"
      assert is_nil(password_of(v, net.id))
      # born with the SHORT linger window, deliberately not the 48h anon TTL
      assert DateTime.diff(v.expires_at, DateTime.utc_now()) in (@ttl_incognito - 5)..(@ttl_incognito + 5)
    end

    test "incognito: false is byte-identical to the ordinary 48h anon session" do
      assert {:ok, %Visitor{} = v} =
               Visitors.find_or_provision_anon("normal", @network, "1.2.3.4", false)

      assert v.incognito == false
      assert DateTime.diff(v.expires_at, DateTime.utc_now()) in (@ttl_anon - 5)..(@ttl_anon + 5)
    end

    test "the incognito flag is only set on FRESH provision, never flipped on an existing row" do
      # A returning nick whose row already exists keeps its persistence
      # semantics — incognito is a fresh-session choice, not a retroactive
      # conversion (which would delete data the holder never opted to lose).
      {:ok, first} = Visitors.find_or_provision_anon("returning", @network, "1.2.3.4", false)
      {:ok, second} = Visitors.find_or_provision_anon("returning", @network, "1.2.3.4", true)

      assert second.id == first.id
      assert second.incognito == false
    end

    test "incognito: true seeds a gentle 1h upload-TTL preference on the fresh session" do
      # #363 — an incognito session's attachments default to the shortest
      # ladder rung (1h) instead of the 24h anon default, seeded as the
      # visitor's OWN pref so cic bootstraps it into `expire=`. It is a
      # default, not a cap: the holder can still raise it (no server clamp).
      {:ok, v} = Visitors.find_or_provision_anon("ghost-ul", @network, "1.2.3.4", true)

      assert UserSettings.get_upload_ttl_seconds({:visitor, v.id}) ==
               @seeded_incognito_upload_ttl
    end

    test "incognito: false leaves the upload-TTL preference unset (standard default applies)" do
      {:ok, v} = Visitors.find_or_provision_anon("normal-ul", @network, "1.2.3.4", false)

      assert UserSettings.get_upload_ttl_seconds({:visitor, v.id}) == nil
    end

    test "the upload-TTL seed does NOT fire on an existing-row re-login as incognito" do
      # Mirror of the flag's fresh-only rule: a returning row keeps whatever
      # pref it had; re-login with incognito: true must not retro-seed it.
      {:ok, first} = Visitors.find_or_provision_anon("returning-ul", @network, "1.2.3.4", false)
      {:ok, second} = Visitors.find_or_provision_anon("returning-ul", @network, "1.2.3.4", true)

      assert second.id == first.id
      assert UserSettings.get_upload_ttl_seconds({:visitor, second.id}) == nil
    end

    test "an existing incognito row keeps its seeded 3600 pref when re-logged-in as non-incognito" do
      # #426, the flip's OTHER direction (mirror of the test above): a fresh
      # incognito session seeds 3600, then the SAME nick re-logs-in with
      # incognito: false. The existing-row branch (`maybe_refresh_ip`) never
      # re-seeds NOR clears the pref, exactly as it never flips the flag — so
      # the gentle upload TTL the holder was given survives the re-login. The
      # existing-row branch touching the pref (either direction) is the
      # regression this locks.
      {:ok, first} = Visitors.find_or_provision_anon("flip-ul", @network, "1.2.3.4", true)

      assert UserSettings.get_upload_ttl_seconds({:visitor, first.id}) ==
               @seeded_incognito_upload_ttl

      {:ok, second} = Visitors.find_or_provision_anon("flip-ul", @network, "1.2.3.4", false)

      # Same row, and the flag is not flipped either (fresh-only), so the
      # incognito clock and its seeded pref both persist untouched.
      assert second.id == first.id
      assert second.incognito == true

      assert UserSettings.get_upload_ttl_seconds({:visitor, second.id}) ==
               @seeded_incognito_upload_ttl
    end

    # #426 point 2 (rollback-on-seed-failure) is DELIBERATELY not covered here,
    # and that is a motivated choice, not an omission — see the issue comment.
    # The seed cannot be driven to `{:error, changeset}` with real data: it is
    # called with a valid constant (@incognito_upload_ttl_seconds ≤ max) on a
    # visitor already inserted in the same transaction, so `get_or_init`'s
    # `validate_subject_exists` is always `:ok`, the settings insert uses
    # `on_conflict: :nothing`, and the update is of a valid changeset. The
    # transaction's all-or-nothing rollback can only be driven by the clause-2
    # credential collision, which is NOT fixture-reachable: the guard
    # `resolve_identity_by_nick`/`fetch_visitor_credential_by_nick` shares the
    # exact partial scope (`WHERE visitor_id IS NOT NULL`) and ASCII fold of
    # the `network_credentials_visitor_folded_nick_network_id_index` it guards,
    # so it is a genuine concurrency race, not a single-threaded scenario.
    # Forcing it would need a production seam (design-discipline #4: the
    # mechanism heavier than the problem) for a P2 regression test.
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
    test "rotates an ANON credential nick (no login identity to protect)", %{network: net} do
      {:ok, v} = Visitors.find_or_provision_anon("vjt-nick", @network, "1.2.3.4")

      assert {:ok, cred} = Visitors.update_nick(v.id, net.id, "vjt-renamed")
      assert cred.nick == "vjt-renamed"
      assert nick_of(v) == "vjt-renamed"
    end

    # #561 — the NICK self-echo path must NOT rotate an IDENTIFIED
    # credential's nick. Azzurra's services rename an unidentified visitor
    # to `GuestNNNNN`; persisting that Guest onto the credential drifts the
    # stored nick away from the identity its NickServ password belongs to,
    # locking the visitor out on the next reconnect. The identified
    # credential's nick is its login key — echo-immutable; it is bound only
    # on a proven identify (+r) via `commit_identity/4`.
    test "does NOT rotate an IDENTIFIED credential nick — protects the login key (#561)", %{
      network: net
    } do
      {:ok, v} = Visitors.find_or_provision_anon("vjt-id", @network, "1.2.3.4")
      {:ok, _} = Visitors.commit_password(v.id, net.id, "s3cret")
      assert Credentials.visitor_registered?(v.id)

      assert {:ok, :held_identified} = Visitors.update_nick(v.id, net.id, "Guest15769")
      assert nick_of(v) == "vjt-id"
    end

    test "returns {:error, :not_found} when the credential is gone", %{network: net} do
      {:ok, v} = Visitors.find_or_provision_anon("vjt-h14b", @network, "1.2.3.4")
      {:ok, _} = Grappa.Repo.delete(v)

      assert {:error, :not_found} = Visitors.update_nick(v.id, net.id, "vjt-renamed")
    end
  end

  # #561 — the `+r`-observed commit binds BOTH the NickServ password AND the
  # nick held at the identify instant. bahamut strips `+r` on any genuine
  # nick change (`m_nick.c`: `mycmp(old, new) != 0` → `umode &= ~UMODE_r`),
  # so `+r` on the wire ⟺ the current nick IS the identified account — the
  # bound nick can never be a forced Guest.
  describe "commit_identity/4 (#561 — +r binds the identified nick)" do
    test "commits the password AND binds the identified nick", %{network: net} do
      {:ok, v} = Visitors.find_or_provision_anon("vjt-ci", @network, "1.2.3.4")

      # +r fires while wearing a grouped/registered nick the visitor
      # identified with — distinct from the provisioned nick to prove the
      # bind is a real write, not a no-op.
      assert {:ok, _} = Visitors.commit_identity(v.id, net.id, "s3cret", "vjt-grouped")

      assert password_of(v, net.id) == "s3cret"
      assert Credentials.visitor_registered?(v.id)
      assert nick_of(v) == "vjt-grouped"
    end

    test "returns {:error, :not_found} for an unknown (visitor, network)", %{network: net} do
      assert {:error, :not_found} =
               Visitors.commit_identity(Ecto.UUID.generate(), net.id, "s3cret", "vjt")
    end

    # The password commit is PRIMARY (the login secret); the nick bind is
    # SECONDARY. A cross-visitor folded-nick collision on the bind must NOT
    # undo the password — else a rare stale-row collision would drop a
    # visitor's committed identity on the floor.
    test "a folded-nick collision on the bind does NOT undo the committed password", %{
      network: net
    } do
      # Another visitor already holds "Taken" (folded "taken") on this network.
      {:ok, _} = Visitors.find_or_provision_anon("Taken", @network, "9.9.9.9")
      {:ok, v} = Visitors.find_or_provision_anon("vjt-coll", @network, "1.2.3.4")

      # commit tries to bind the colliding folded nick — the secondary bind
      # fails on the folded-nick unique index; the PRIMARY password survives.
      assert {:ok, _} = Visitors.commit_identity(v.id, net.id, "s3cret", "taken")

      assert password_of(v, net.id) == "s3cret"
      assert Credentials.visitor_registered?(v.id)
      # Nick unchanged — the collision was rejected, not applied.
      assert nick_of(v) == "vjt-coll"
    end
  end

  describe "nick_held_by_identified?/3 (per-network credential folded lookup)" do
    test "true when a DIFFERENT visitor's IDENTIFIED credential holds the folded nick",
         %{network: net} do
      {:ok, holder} = Visitors.find_or_provision_anon("Taken", @network, "1.2.3.4")
      {:ok, _} = Visitors.commit_password(holder.id, net.id, "s3cret")
      {:ok, other} = Visitors.find_or_provision_anon("other", @network, "5.6.7.8")

      # ASCII-folded: `taken` collides with `Taken`.
      assert Visitors.nick_held_by_identified?(other.id, "taken", net.id)
    end

    # #828 — the ANON row answers "was recorded here once", not "is on the
    # network now". Refusing off it stranded nicks that were free upstream.
    test "false when the holder credential is ANON", %{network: net} do
      {:ok, _} = Visitors.find_or_provision_anon("Taken", @network, "1.2.3.4")
      {:ok, other} = Visitors.find_or_provision_anon("other", @network, "5.6.7.8")

      refute Visitors.nick_held_by_identified?(other.id, "taken", net.id)
    end

    test "false when only the visitor itself holds the nick, even identified (idempotent rename)",
         %{network: net} do
      {:ok, v} = Visitors.find_or_provision_anon("Self", @network, "1.2.3.4")
      {:ok, _} = Visitors.commit_password(v.id, net.id, "s3cret")

      refute Visitors.nick_held_by_identified?(v.id, "self", net.id)
    end

    test "false when the slot is free", %{network: net} do
      {:ok, v} = Visitors.find_or_provision_anon("vjt-free", @network, "1.2.3.4")
      refute Visitors.nick_held_by_identified?(v.id, "nobody-here", net.id)
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

    test "#363 incognito visitor → no-op {:ok, visitor}, TTL NOT slid to 48h" do
      # touch must not push an incognito TTL out to +48h — that would defeat
      # the 1h linger. The Reaper reconcile owns the incognito clock while a
      # browser socket is connected; touch just leaves it alone.
      {:ok, v} = Visitors.find_or_provision_anon("ghost", @network, "1.2.3.4", true)
      before = v.expires_at

      assert {:ok, %Visitor{}} = Visitors.touch(v.id)
      assert DateTime.compare(Repo.reload!(v).expires_at, before) == :eq
    end

    test "#363 incognito visitor past its linger → {:error, :expired} (no resurrection)" do
      {:ok, v} = Visitors.find_or_provision_anon("ghost2", @network, "1.2.3.4", true)
      past = DateTime.add(DateTime.utc_now(), -1, :minute)
      query = from(x in Visitor, where: x.id == ^v.id)
      Repo.update_all(query, set: [expires_at: past])

      assert {:error, :expired} = Visitors.touch(v.id)
    end
  end

  describe "slide_incognito_lingers/1 (#363 reconcile)" do
    test "slides a connected incognito visitor's TTL forward to ~now+1h" do
      {:ok, v} = Visitors.find_or_provision_anon("conn-ghost", @network, "1.2.3.4", true)
      # wind the linger down close to expiry, as if it had been disconnected
      near = DateTime.add(DateTime.utc_now(), 5, :minute)
      query = from(x in Visitor, where: x.id == ^v.id)
      Repo.update_all(query, set: [expires_at: near])

      assert 1 == Visitors.slide_incognito_lingers([v.id])

      assert DateTime.diff(Repo.reload!(v).expires_at, DateTime.utc_now()) in (@ttl_incognito - 5)..(@ttl_incognito + 5)
    end

    test "leaves a connected NON-incognito visitor untouched" do
      {:ok, v} = Visitors.find_or_provision_anon("conn-normal", @network, "1.2.3.4", false)
      before = v.expires_at

      assert 0 == Visitors.slide_incognito_lingers([v.id])
      assert DateTime.compare(Repo.reload!(v).expires_at, before) == :eq
    end

    test "leaves a DISCONNECTED incognito visitor untouched (absent from the connected set)" do
      {:ok, v} = Visitors.find_or_provision_anon("gone-ghost", @network, "1.2.3.4", true)
      before = v.expires_at

      assert 0 == Visitors.slide_incognito_lingers([])
      assert DateTime.compare(Repo.reload!(v).expires_at, before) == :eq
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
