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
  alias Grappa.Visitors.Visitor

  @network "azzurra"
  @ttl_anon 48 * 3600
  @ttl_registered 7 * 24 * 3600

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
  end

  describe "commit_password/2" do
    test "atomically writes password + bumps expires_at to 7d" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      before_expires = v.expires_at

      assert {:ok, committed} = Visitors.commit_password(v.id, "s3cret")
      # Cloak's EncryptedBinary roundtrips dump/load symmetrically, so the
      # in-memory value after Repo.update is the plaintext "s3cret". The
      # encryption-at-rest property is verified end-to-end by the
      # `Grappa.EncryptedBinary` property test (`dump` produces varying
      # ciphertext that `load` round-trips). We assert here only that the
      # function persisted the value the caller passed in.
      assert committed.password_encrypted == "s3cret"
      assert DateTime.compare(committed.expires_at, before_expires) == :gt

      assert DateTime.diff(committed.expires_at, DateTime.utc_now()) in (@ttl_registered - 5)..(@ttl_registered + 5)
    end

    test "returns {:error, :not_found} for unknown visitor_id" do
      assert {:error, :not_found} =
               Visitors.commit_password(Ecto.UUID.generate(), "s3cret")
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

  describe "delete/1" do
    test "removes visitor row + CASCADE wipes accounts_sessions" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      {:ok, session} = Accounts.create_session({:visitor, v.id}, "1.2.3.4", "ua")

      assert :ok = Visitors.delete(v.id)
      assert is_nil(Repo.get(Visitor, v.id))
      assert is_nil(Repo.get(Session, session.id))
    end

    test "returns {:error, :not_found} for unknown visitor_id" do
      assert {:error, :not_found} = Visitors.delete(Ecto.UUID.generate())
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

  describe "purge_if_anon/1 (W11 co-terminus delete)" do
    test "anon visitor → row deleted + CASCADE wipes accounts_sessions" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      {:ok, session} = Accounts.create_session({:visitor, v.id}, "1.2.3.4", "ua")

      assert is_nil(v.password_encrypted)
      assert :ok = Visitors.purge_if_anon(v.id)

      assert is_nil(Repo.get(Visitor, v.id))
      assert is_nil(Repo.get(Session, session.id))
    end

    test "registered visitor → no-op (row preserved)" do
      {:ok, v} = Visitors.find_or_provision_anon("vjt", @network, "1.2.3.4")
      {:ok, registered} = Visitors.commit_password(v.id, "s3cret")
      {:ok, session} = Accounts.create_session({:visitor, v.id}, "1.2.3.4", "ua")

      refute is_nil(registered.password_encrypted)
      assert :ok = Visitors.purge_if_anon(v.id)

      assert %Visitor{} = Repo.get(Visitor, v.id)
      assert %Session{} = Repo.get(Session, session.id)
    end

    test "missing row → no-op (idempotent)" do
      assert :ok = Visitors.purge_if_anon(Ecto.UUID.generate())
    end
  end
end
