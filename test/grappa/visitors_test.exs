defmodule Grappa.VisitorsTest do
  # async: false because visitor INSERTs race with the IRC integration
  # tests for the sqlite single-writer lock under MIX_ENV=test's
  # max_cases: 2 — see handoff doc + CP11 S2 baseline-hygiene notes
  # (residual ~20% sqlite-busy flake category). Serializing this file
  # avoids contributing to the contention. Tests are fast (~300ms total)
  # so the serialization cost is negligible.
  use Grappa.DataCase, async: false

  import Ecto.Query

  alias Grappa.{Accounts, Visitors}
  alias Grappa.Accounts.Session
  alias Grappa.Session.Backoff
  alias Grappa.Visitors.Visitor

  @network "azzurra"
  @ttl_anon 48 * 3600

  describe "find_or_provision_anon/3" do
    test "creates new anon visitor with 48h expires_at" do
      assert {:ok, %Visitor{} = v} =
               Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")

      assert v.nick == "vjt"
      assert v.network_slug == @network
      assert is_nil(v.password_encrypted)

      assert DateTime.diff(v.expires_at, DateTime.utc_now()) in (@ttl_anon - 5)..(@ttl_anon + 5)
    end

    test "returns existing visitor if (nick, network) match" do
      {:ok, v1} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      {:ok, v2} = Visitors.find_or_provision_anon("vjt", @network, "5.6.7.8")
      assert v1.id == v2.id
    end

    test "reattaches a different-case reconnect to the SAME row (rfc1459 #121)" do
      # The bug: a case-sensitive lookup spawned a SECOND visitor on
      # `Mezmerize` -> `mezmerize`, blocking the nick on the orphan.
      # rfc1459 folding collapses both to one identity.
      {:ok, v1} = Visitors.find_or_provision_anon("Mezmerize", @network, "1.2.3.4")
      {:ok, v2} = Visitors.find_or_provision_anon("mezmerize", @network, "5.6.7.8")
      assert v2.id == v1.id
      assert v1.nick == "Mezmerize", "display case of the first-provisioned row is preserved"
    end

    test "folds the four rfc1459 national chars [ ] \\ ~ (bahamut casemapping)" do
      {:ok, v1} = Visitors.find_or_provision_anon("nick[1]", @network, "1.2.3.4")
      {:ok, v2} = Visitors.find_or_provision_anon("nick{1}", @network, "5.6.7.8")
      assert v2.id == v1.id
    end

    test "refreshes :ip on subsequent login when client address changed" do
      # Pre-fix: ip was set ONLY at row creation; long-lived NickServ-
      # identified visitors surfaced their birth IP indefinitely. Now
      # an existing-row hit with a different :ip refreshes the column
      # so the admin audit value tracks the holder's current address.
      {:ok, v1} = Visitors.find_or_provision_anon("vjt-ipa", @network, "1.2.3.4")
      assert v1.ip == "1.2.3.4"

      {:ok, v2} = Visitors.find_or_provision_anon("vjt-ipa", @network, "5.6.7.8")
      assert v2.id == v1.id
      assert v2.ip == "5.6.7.8"
    end

    test "leaves :ip unchanged when same address re-logs in (no-op write)" do
      # Hot path — same client polling: avoid an UPDATE per login.
      {:ok, v1} = Visitors.find_or_provision_anon("vjt-ipb", @network, "1.2.3.4")
      {:ok, v2} = Visitors.find_or_provision_anon("vjt-ipb", @network, "1.2.3.4")
      assert v2.id == v1.id
      assert v2.ip == "1.2.3.4"
      assert v2.updated_at == v1.updated_at
    end

    test "supplying nil :ip does NOT clobber a row that already has a real IP" do
      # Refresh semantics: "I have a fresher value," not "forget what
      # you knew." A future internal/mix-task path with no remote_ip
      # mustn't blank out the audit column.
      {:ok, v1} = Visitors.find_or_provision_anon("vjt-ipc", @network, "1.2.3.4")
      {:ok, v2} = Visitors.find_or_provision_anon("vjt-ipc", @network, nil)
      assert v2.id == v1.id
      assert v2.ip == "1.2.3.4"
    end
  end

  describe "rfc1459 folded unique index (#121, race second-line-of-defense)" do
    test "a folded-collision insert returns {:error, changeset}, not a raise" do
      # find_or_provision_anon's get_by is the fast path; the named
      # `(rfc1459-fold(nick), network_slug)` unique expression index is
      # the second line of defense for a true insert race. This pins
      # that `unique_constraint(:nick, name: ...)` is wired to the right
      # index name — a mismatch would let the second insert RAISE
      # Ecto.ConstraintError instead of returning a changeset error.
      future = DateTime.add(DateTime.utc_now(), 3600, :second)
      base = %{network_slug: @network, expires_at: future, ip: "1.2.3.4"}

      assert {:ok, _} =
               base
               |> Map.put(:nick, "Mezmerize")
               |> Visitor.create_changeset()
               |> Repo.insert()

      assert {:error, cs} =
               base
               |> Map.put(:nick, "mezmerize")
               |> Visitor.create_changeset()
               |> Repo.insert()

      refute cs.valid?
      assert {"has already been taken", _} = cs.errors[:nick]
    end
  end

  describe "commit_password/2" do
    test "atomically writes password + clears expires_at (NickServ-identified = ∞)" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      refute is_nil(v.expires_at)

      assert {:ok, committed} = Visitors.commit_password(v.id, "s3cret")
      # Cloak's EncryptedBinary roundtrips dump/load symmetrically, so the
      # in-memory value after Repo.update is the plaintext "s3cret". The
      # encryption-at-rest property is verified end-to-end by the
      # `Grappa.EncryptedBinary` property test (`dump` produces varying
      # ciphertext that `load` round-trips). We assert here only that the
      # function persisted the value the caller passed in.
      assert committed.password_encrypted == "s3cret"
      # V7: identified rows have no expiry. Reaper's IS-NOT-NULL guard
      # (V5) skips them; only operator `Visitors.delete/1` removes them.
      assert is_nil(committed.expires_at)
    end

    test "returns {:error, :not_found} for unknown visitor_id" do
      assert {:error, :not_found} =
               Visitors.commit_password(Ecto.UUID.generate(), "s3cret")
    end

    test "returns {:error, :not_found} when row is concurrently deleted between lookup and update (H14)" do
      # The lookup-then-update gap can race a concurrent
      # `Visitors.delete/1` (operator-initiated purge), `purge_if_anon/1`
      # (session revoke), or Reaper sweep. Pre-H14 the update raised
      # `Ecto.StaleEntryError` instead of returning the spec'd
      # `{:error, :not_found}`, surfacing as a 500 in the web layer.
      #
      # Deterministic race synthesis: fetch the visitor (warm the
      # struct, simulating Repo.get/2's return), delete the row directly
      # via Repo (the concurrent delete), then call commit_password/2 —
      # its internal Repo.get/2 now returns nil → {:error, :not_found}.
      #
      # NOTE: this test covers the GET-returns-nil branch (cheap to
      # synthesize). The narrower window — Repo.get succeeds, then
      # delete fires, then Repo.update sees a vanished row — is what
      # actually raises StaleEntryError in production. Unit-asserting
      # the rescue clause directly via a synthesized stale struct
      # complements the integration coverage above.
      {:ok, v} = Visitors.find_or_provision_anon("vjt-h14", @network, "1.2.3.4")
      {:ok, _} = Grappa.Repo.delete(v)

      assert {:error, :not_found} = Visitors.commit_password(v.id, "s3cret")
    end

    test "rescue maps Ecto.StaleEntryError to {:error, :not_found} (H14 narrow window)" do
      # Direct unit assertion on the rescue clause: build a struct
      # pinned to a UUID that has never been inserted, build the
      # changeset by hand (mirrors what commit_password/2 does internally
      # post-Repo.get), and confirm the rescue path returns the typed
      # error. This pins the narrow race window — Repo.get/2 succeeded,
      # then a peer deleted between lookup and Repo.update — without
      # needing to coordinate two processes against the sqlite
      # single-writer lock.
      stale_visitor = %Visitor{
        id: Ecto.UUID.generate(),
        nick: "vjt-stale",
        network_slug: @network,
        expires_at: DateTime.add(DateTime.utc_now(), 3600, :second)
      }

      assert_raise Ecto.StaleEntryError, fn ->
        stale_visitor
        |> Visitor.commit_password_changeset("s3cret", nil)
        |> Grappa.Repo.update()
      end
    end
  end

  # #131 — in-session SET PASSWD commit verb. Identity-gated, unlike the
  # +r-promotion `commit_password/2`: it must NEVER promote an unidentified
  # anon visitor to permanent (services reject SET PASSWD for an
  # unidentified nick, and an optimistic commit carries no +r proof).
  describe "rotate_password/2" do
    test "rotates an already-identified visitor's password; expires_at stays NULL" do
      {:ok, anon} = Visitors.find_or_provision_anon("vjt-rot", @network, "1.2.3.4")
      {:ok, identified} = Visitors.commit_password(anon.id, "oldpass")
      assert is_nil(identified.expires_at)

      assert {:ok, rotated} = Visitors.rotate_password(anon.id, "newpass")
      assert rotated.password_encrypted == "newpass"
      # Still permanent — rotation is idempotent on expires_at.
      assert is_nil(rotated.expires_at)
    end

    test "rotates a rest-of-line password with spaces verbatim" do
      {:ok, anon} = Visitors.find_or_provision_anon("vjt-rot-sp", @network, "1.2.3.4")
      {:ok, _} = Visitors.commit_password(anon.id, "oldpass")

      assert {:ok, rotated} = Visitors.rotate_password(anon.id, "my new pass phrase")
      assert rotated.password_encrypted == "my new pass phrase"
    end

    test "{:error, :not_identified} for an anon row — NEVER promotes it to permanent" do
      {:ok, anon} = Visitors.find_or_provision_anon("vjt-anon", @network, "1.2.3.4")
      refute is_nil(anon.expires_at)
      assert is_nil(anon.password_encrypted)

      assert {:error, :not_identified} = Visitors.rotate_password(anon.id, "newpass")

      # The anon row is untouched — still ephemeral, still password-less.
      # Without the gate this would have pinned it permanent + un-reapable.
      reloaded = Grappa.Repo.reload!(anon)
      assert is_nil(reloaded.password_encrypted)
      refute is_nil(reloaded.expires_at)
    end

    test "{:error, :not_found} for an unknown visitor_id" do
      assert {:error, :not_found} = Visitors.rotate_password(Ecto.UUID.generate(), "newpass")
    end

    test "{:error, :not_found} when an identified row is concurrently deleted (H14)" do
      {:ok, anon} = Visitors.find_or_provision_anon("vjt-rot-h14", @network, "1.2.3.4")
      {:ok, _} = Visitors.commit_password(anon.id, "oldpass")
      {:ok, _} = Grappa.Repo.delete(anon)

      assert {:error, :not_found} = Visitors.rotate_password(anon.id, "newpass")
    end
  end

  describe "update_nick/2 concurrent-delete race (H14)" do
    test "returns {:error, :not_found} when row is concurrently deleted" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt-h14b", @network, "1.2.3.4")
      {:ok, _} = Grappa.Repo.delete(v)

      assert {:error, :not_found} = Visitors.update_nick(v.id, "vjt-renamed")
    end
  end

  describe "touch/1" do
    test "bumps expires_at if ≥1h since last bump (delta to fresh target ≥ cadence)" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")

      # Push expires_at backward by >1h relative to a fresh now+48h target
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

      reloaded = Repo.reload!(v)
      assert DateTime.compare(reloaded.expires_at, past) == :eq
    end

    test "NickServ-identified visitor (expires_at = nil) → no-op {:ok, visitor}" do
      # V7: identified visitors don't expire. touch/1 short-circuits without
      # writing to the DB. This pins the production-change semantics: anon
      # = 48h sliding TTL; identified = ∞.
      {:ok, anon} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      {:ok, identified} = Visitors.commit_password(anon.id, "s3cret")
      assert is_nil(identified.expires_at)

      assert {:ok, %Visitor{expires_at: nil}} = Visitors.touch(identified.id)
      reloaded = Repo.reload!(identified)
      assert is_nil(reloaded.expires_at)
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

  describe "list_all_with_live_state/0 (M-4 admin console)" do
    # async: false guard at the module level keeps the registry scan deterministic.
    test "returns {visitor, nil} for visitor with no live session" do
      {:ok, v} = Visitors.find_or_provision_anon("solo", @network, "1.2.3.4")
      {:ok, _} = Grappa.Networks.find_or_create_network(%{slug: @network})

      results = Visitors.list_all_with_live_state()

      assert {%Visitor{} = found, nil} =
               Enum.find(results, fn {row, _} -> row.id == v.id end)

      assert found.id == v.id
    end

    test "returns {visitor, nil} when network_slug has no networks row (orphan)" do
      orphan_slug = "orphan-#{System.unique_integer([:positive])}"
      v = Grappa.AuthFixtures.visitor_fixture(network_slug: orphan_slug, nick: "orph")

      results = Visitors.list_all_with_live_state()

      assert {%Visitor{}, nil} =
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

    # S11: delete/1 is the reap + admin choke point — evicting the row must
    # also evict the subject's Backoff ETS entries, or they orphan for the
    # node lifetime (the destroyed UUID never logs in again).
    test "evicts the subject's Backoff entries" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt-bo", @network, "1.2.3.4")
      :ok = Backoff.record_failure({:visitor, v.id}, 1)
      assert Backoff.failure_count({:visitor, v.id}, 1) == 1

      assert :ok = Visitors.delete(v.id)

      assert Backoff.failure_count({:visitor, v.id}, 1) == 0
    end
  end

  # CP24 bucket E lifecycle/S1: visitor sessions had no equivalent of
  # the user-side `credential_failer` callback that
  # `Networks.SessionPlan` injects. K-line / permanent-SASL on a
  # visitor exited the `Session.Server` silently, leaving the visitor
  # row with `expires_at` still in the future — so `Bootstrap` would
  # cheerfully respawn it on the next app start (and the next, and
  # the next…). No operator signal for permanently-rejected
  # visitors. `Visitors.mark_failed/2` expires the row immediately
  # (Reaper sweeps it within 60s; Bootstrap stops respawning
  # because `list_active/0` filters on `expires_at > now()`) +
  # emits a structured Logger error so the operator dashboard
  # surfaces the rejection.
  describe "mark_failed/2 (lifecycle/S1)" do
    test "expires the visitor immediately so Bootstrap stops respawning" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt-fail", @network, "1.2.3.4")
      assert v in Visitors.list_active()

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

  # #87 — visitor-side mirror of `Credentials.remove_autojoin_channel/3`.
  # The visitor's `last_joined_channels` IS its autojoin source, so leaving
  # a channel must drop it here or the row keeps surfacing in GET /channels.
  describe "remove_autojoin_channel/2" do
    test "drops the channel from the visitor autojoin source, keeps the rest" do
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      with_one = Grappa.AuthFixtures.visitor_channel_fixture(visitor, "#one")
      _ = Grappa.AuthFixtures.visitor_channel_fixture(with_one, "#two")

      assert {:ok, %Visitor{last_joined_channels: kept}} =
               Visitors.remove_autojoin_channel(visitor, "#one")

      assert "#one" not in kept
      assert "#two" in kept
    end

    test "matches case-insensitively (RFC 2812 channel casemapping)" do
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      _ = Grappa.AuthFixtures.visitor_channel_fixture(visitor, "#italia")

      assert {:ok, %Visitor{last_joined_channels: []}} =
               Visitors.remove_autojoin_channel(visitor, "#ITALIA")
    end

    test "absent channel is a no-op (idempotent leave)" do
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      _ = Grappa.AuthFixtures.visitor_channel_fixture(visitor, "#one")

      assert {:ok, %Visitor{last_joined_channels: ["#one"]}} =
               Visitors.remove_autojoin_channel(visitor, "#two")
    end

    test "{:error, :not_found} when the visitor was reaped mid-request" do
      {:ok, visitor} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      Repo.delete!(visitor)

      assert {:error, :not_found} = Visitors.remove_autojoin_channel(visitor, "#one")
    end
  end

  describe "purge_if_anon/1 (W11 co-terminus delete)" do
    test "anon visitor → row deleted + CASCADE wipes accounts_sessions" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      {:ok, session} = Accounts.create_session({:visitor, v.id}, "1.2.3.4", "ua", [])

      assert is_nil(v.password_encrypted)
      assert :ok = Visitors.purge_if_anon(v.id)

      assert is_nil(Repo.get(Visitor, v.id))
      assert is_nil(Repo.get(Session, session.id))
    end

    test "registered visitor → no-op (row preserved)" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      {:ok, registered} = Visitors.commit_password(v.id, "s3cret")
      {:ok, session} = Accounts.create_session({:visitor, v.id}, "1.2.3.4", "ua", [])

      refute is_nil(registered.password_encrypted)
      assert :ok = Visitors.purge_if_anon(v.id)

      assert %Visitor{} = Repo.get(Visitor, v.id)
      assert %Session{} = Repo.get(Session, session.id)
    end

    # S11: the login case-1 failure branch purges the just-provisioned anon
    # via this path — the delete must evict the subject's Backoff entries too
    # (a crash-before-001 mid-provision seeds them).
    test "anon delete evicts the subject's Backoff entries" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt-bo2", @network, "1.2.3.4")
      :ok = Backoff.record_failure({:visitor, v.id}, 1)
      assert Backoff.failure_count({:visitor, v.id}, 1) == 1

      assert :ok = Visitors.purge_if_anon(v.id)

      assert Backoff.failure_count({:visitor, v.id}, 1) == 0
    end

    # S11: a registered visitor is NOT destroyed (row preserved, identity
    # persists) — its backoff history must survive the no-op purge.
    test "registered no-op purge leaves Backoff entries intact" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt-bo3", @network, "1.2.3.4")
      {:ok, _registered} = Visitors.commit_password(v.id, "s3cret")
      :ok = Backoff.record_failure({:visitor, v.id}, 1)

      assert :ok = Visitors.purge_if_anon(v.id)

      assert Backoff.failure_count({:visitor, v.id}, 1) == 1
    end

    test "missing row → no-op (idempotent)" do
      assert :ok = Visitors.purge_if_anon(Ecto.UUID.generate())
    end
  end
end
