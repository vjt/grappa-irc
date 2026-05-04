defmodule Grappa.Accounts.SessionsTest do
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures, only: [visitor_fixture: 0]

  alias Grappa.Accounts
  alias Grappa.Accounts.{Session, User}

  setup do
    # Bypass Accounts.create_user/1 — Argon2's ~100ms hash compounded
    # across the whole suite + sqlite's single-writer lock causes
    # `Exqlite.Error: Database busy` storms. Sessions tests don't
    # exercise password verification; a hashless fixture is faithful
    # enough to the schema for the session lifecycle under test.
    {:ok, user} = Repo.insert(%User{name: "vjt-#{System.unique_integer([:positive])}", password_hash: "x"})
    %{user: user}
  end

  describe "create_session/3" do
    test "persists a session bound to the user with last_seen_at = created_at = now",
         %{user: user} do
      before = DateTime.utc_now()

      assert {:ok, %Session{} = s} =
               Accounts.create_session({:user, user.id}, "127.0.0.1", "test-ua")

      assert s.user_id == user.id
      assert s.ip == "127.0.0.1"
      assert s.user_agent == "test-ua"
      assert s.revoked_at == nil

      # created_at == last_seen_at on a fresh session
      assert s.created_at == s.last_seen_at

      # both are within a few seconds of `before`
      assert DateTime.diff(s.created_at, before, :second) >= 0
      assert DateTime.diff(s.created_at, before, :second) < 5
    end

    test "accepts nil ip / user_agent (mix-task-driven session has no conn)",
         %{user: user} do
      assert {:ok, %Session{ip: nil, user_agent: nil}} =
               Accounts.create_session({:user, user.id}, nil, nil)
    end

    # S29 H4: Session was the only schema in the project without a
    # changeset. create_session/3 used `Ecto.Changeset.change/2` (no
    # validation), so a stale user_id (deleted user, never-existed
    # UUID) raised a raw `Ecto.ConstraintError` instead of the
    # `{:error, %Ecto.Changeset{}}` the @spec promised. The
    # `assoc_constraint(:user)` clause in the new
    # `Session.changeset/2` translates the FK violation into a
    # standard validation error so callers can pattern-match.
    test "returns {:error, %Ecto.Changeset{}} for a stale user_id (FK miss)" do
      stale_uuid = Ecto.UUID.generate()

      assert {:error, %Ecto.Changeset{} = cs} =
               Accounts.create_session({:user, stale_uuid}, "127.0.0.1", "test-ua")

      refute cs.valid?
      assert {"does not exist", _} = cs.errors[:user]
    end
  end

  describe "create_session/3 with visitor subject" do
    test "creates session bound to visitor (no user_id)" do
      visitor = visitor_fixture()

      assert {:ok, %Session{} = s} =
               Accounts.create_session({:visitor, visitor.id}, "1.2.3.4", "ua")

      assert s.visitor_id == visitor.id
      assert is_nil(s.user_id)
      assert s.ip == "1.2.3.4"
      assert s.user_agent == "ua"
    end

    test "returns {:error, %Ecto.Changeset{}} for a stale visitor_id (FK miss)" do
      stale_uuid = Ecto.UUID.generate()

      assert {:error, %Ecto.Changeset{} = cs} =
               Accounts.create_session({:visitor, stale_uuid}, nil, nil)

      refute cs.valid?
      assert {"does not exist", _} = cs.errors[:visitor]
    end
  end

  describe "Session.changeset/2 XOR enforcement" do
    test "rejects neither user_id nor visitor_id set" do
      now = DateTime.utc_now()

      cs =
        Session.changeset(%Session{}, %{
          created_at: now,
          last_seen_at: now
        })

      refute cs.valid?
      # B5.4 M-pers-2: synthetic :subject key — neither user_id nor visitor_id
      # is "wrong"; the error is about the absence of EITHER. A single key
      # keeps client-side error rendering uniform across both XOR violations.
      assert "must set user_id or visitor_id" in errors_on(cs).subject
      refute Map.has_key?(errors_on(cs), :user_id)
      refute Map.has_key?(errors_on(cs), :visitor_id)
    end

    test "rejects both user_id and visitor_id set", %{user: user} do
      visitor = visitor_fixture()
      now = DateTime.utc_now()

      cs =
        Session.changeset(%Session{}, %{
          user_id: user.id,
          visitor_id: visitor.id,
          created_at: now,
          last_seen_at: now
        })

      refute cs.valid?
      # B5.4 M-pers-2: synthetic :subject key (was always :user_id, masking
      # which side was the unexpected addition). Both fields are valid in
      # isolation; the conflict is across the pair, not on one specific field.
      assert "user_id and visitor_id are mutually exclusive" in errors_on(cs).subject
      refute Map.has_key?(errors_on(cs), :user_id)
      refute Map.has_key?(errors_on(cs), :visitor_id)
    end

    test "accepts and round-trips client_id (UUID v4)" do
      user = Grappa.AuthFixtures.user_fixture()
      now = DateTime.utc_now()
      client_id = "44c2ab8a-cb38-4960-b92a-a7aefb190386"

      attrs = %{
        user_id: user.id,
        created_at: now,
        last_seen_at: now,
        client_id: client_id
      }

      changeset = Session.changeset(%Session{}, attrs)
      assert changeset.valid?
      assert {:ok, session} = Grappa.Repo.insert(changeset)
      assert session.client_id == client_id
    end

    test "rejects client_id that is not a UUID v4 (decision E cast)" do
      user = Grappa.AuthFixtures.user_fixture()
      now = DateTime.utc_now()

      attrs = %{
        user_id: user.id,
        created_at: now,
        last_seen_at: now,
        client_id: "not-a-uuid"
      }

      changeset = Session.changeset(%Session{}, attrs)
      refute changeset.valid?
      assert "is invalid" in errors_on(changeset).client_id
    end

    test "client_id is optional (nil for mix-task / legacy rows)" do
      user = Grappa.AuthFixtures.user_fixture()
      now = DateTime.utc_now()

      attrs = %{user_id: user.id, created_at: now, last_seen_at: now}
      changeset = Session.changeset(%Session{}, attrs)

      assert changeset.valid?
      assert {:ok, session} = Grappa.Repo.insert(changeset)
      assert session.client_id == nil
    end
  end

  describe "Session.touch_changeset/2 monotonic last_seen_at (B5.4 L-pers-3)" do
    setup %{user: user} do
      {:ok, session} = Accounts.create_session({:user, user.id}, nil, nil)
      %{session: session}
    end

    test "accepts a forward bump (now > prev)", %{session: session} do
      forward = DateTime.add(session.last_seen_at, 60, :second)
      cs = Session.touch_changeset(session, forward)
      assert cs.valid?
      assert Ecto.Changeset.get_change(cs, :last_seen_at) == forward
    end

    test "accepts the same instant (no-op write — not strictly forward but not backward)",
         %{session: session} do
      # equal-to-prev is a degenerate-but-not-skewed case: a tight
      # touch loop under high load can reasonably observe `now ==
      # prev` at usec resolution. Reject only the strictly-backward
      # case so legitimate same-tick touches pass through.
      cs = Session.touch_changeset(session, session.last_seen_at)
      assert cs.valid?
    end

    test "rejects a backward jump (system-clock skew)", %{session: session} do
      backward = DateTime.add(session.last_seen_at, -60, :second)
      cs = Session.touch_changeset(session, backward)

      refute cs.valid?
      assert "must not move backward (system-clock skew?)" in errors_on(cs).last_seen_at
    end
  end

  describe "authenticate/1" do
    setup %{user: user} do
      {:ok, session} = Accounts.create_session({:user, user.id}, "127.0.0.1", "test-ua")
      %{session: session}
    end

    test "returns {:ok, session} for a valid token", %{session: session, user: user} do
      assert {:ok, %Session{user_id: uid, id: sid}} = Accounts.authenticate(session.id)
      assert uid == user.id
      assert sid == session.id
    end

    test "returns {:error, :invalid_token} for a non-UUID string" do
      assert {:error, :invalid_token} = Accounts.authenticate("not-a-uuid")
    end

    test "returns {:error, :not_found} for a well-formed but unknown UUID" do
      assert {:error, :not_found} = Accounts.authenticate(Ecto.UUID.generate())
    end

    test "returns {:error, :revoked} after revoke_session/1", %{session: session} do
      :ok = Accounts.revoke_session(session.id)
      assert {:error, :revoked} = Accounts.authenticate(session.id)
    end

    test "returns {:error, :expired} when last_seen_at is older than the 7-day idle window",
         %{session: session} do
      # Time-travel the row directly — bypassing the public API is the
      # cheapest way to assert the expiry policy without sleeping.
      eight_days_ago = DateTime.add(DateTime.utc_now(), -8 * 24 * 3600, :second)
      stale_row(session.id, eight_days_ago)

      assert {:error, :expired} = Accounts.authenticate(session.id)
    end

    test "does NOT bump last_seen_at when called within the 60s throttle window",
         %{session: session} do
      original = session.last_seen_at

      assert {:ok, _} = Accounts.authenticate(session.id)

      reloaded = Repo.get!(Session, session.id)
      assert reloaded.last_seen_at == original
    end

    test "DOES bump last_seen_at when prior last_seen_at is older than 60s",
         %{session: session} do
      # Push last_seen_at to 5 minutes ago — outside the throttle window
      # but well within the 7-day idle window. authenticate/1 should
      # bump and return the refreshed session.
      five_minutes_ago = DateTime.add(DateTime.utc_now(), -5 * 60, :second)
      stale_row(session.id, five_minutes_ago)

      assert {:ok, %Session{last_seen_at: new_last_seen}} =
               Accounts.authenticate(session.id)

      assert DateTime.compare(new_last_seen, five_minutes_ago) == :gt

      reloaded = Repo.get!(Session, session.id)
      assert reloaded.last_seen_at == new_last_seen
    end
  end

  describe "authenticate/1 visitor-bound sessions" do
    test "returns visitor-bound session with visitor_id, no user_id" do
      visitor = visitor_fixture()
      {:ok, session} = Accounts.create_session({:visitor, visitor.id}, nil, nil)

      assert {:ok, %Session{visitor_id: vid, user_id: nil}} =
               Accounts.authenticate(session.id)

      assert vid == visitor.id
    end
  end

  describe "revoke_session/1" do
    test "is idempotent — revoking twice is :ok and the row stays revoked",
         %{user: user} do
      {:ok, session} = Accounts.create_session({:user, user.id}, nil, nil)

      assert :ok = Accounts.revoke_session(session.id)
      assert :ok = Accounts.revoke_session(session.id)

      reloaded = Repo.get!(Session, session.id)
      assert reloaded.revoked_at != nil
    end

    test "is :ok even for an unknown id (no-op, does not raise)" do
      assert :ok = Accounts.revoke_session(Ecto.UUID.generate())
    end
  end

  describe "Boundary export" do
    test "Grappa.Accounts.User stays the user-facing schema; Session is a sibling export" do
      assert function_exported?(User, :__schema__, 1)
      assert function_exported?(Session, :__schema__, 1)
    end
  end

  defp stale_row(id, ts) do
    import Ecto.Query
    query = from(s in Session, where: s.id == ^id)
    {1, _} = Repo.update_all(query, set: [last_seen_at: ts])
  end
end
