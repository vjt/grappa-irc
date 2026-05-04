defmodule Grappa.UserSettingsTest do
  @moduledoc """
  Context tests for `Grappa.UserSettings` — per-user JSON settings store,
  first consumer: `highlight_patterns` (cross-network mention watchlist).

  Property tests cover the core invariants:

    1. Idempotent `get_or_init/1`: repeated calls return the same row id.
    2. Round-trip: any `[String.t()]` written via `set_highlight_patterns/2`
       reads back identical via `get_highlight_patterns/1`.
    3. Key isolation: `set_highlight_patterns/2` preserves other `data` keys
       already in the row (merge semantics, not replace).
    4. Defensive reader: `get_highlight_patterns/1` returns `[]` when the
       row is missing or the key is absent/malformed — never crashes.
    5. String-key invariant: even if atom-keyed data were written (e.g. via
       a test-only backdoor), the reader copes gracefully.
  """
  use Grappa.DataCase, async: true
  use ExUnitProperties

  alias Grappa.{Accounts, Repo, UserSettings}
  alias Grappa.UserSettings.Settings

  # ---------------------------------------------------------------------------
  # Fixtures
  # ---------------------------------------------------------------------------

  defp user_fixture do
    name = "us-user-#{System.unique_integer([:positive])}"
    {:ok, user} = Accounts.create_user(%{name: name, password: "correct horse battery staple"})
    user
  end

  # ---------------------------------------------------------------------------
  # get_or_init/1
  # ---------------------------------------------------------------------------

  describe "get_or_init/1" do
    test "creates a new settings row and returns {:ok, %Settings{}}" do
      user = user_fixture()

      assert {:ok, %Settings{} = settings} = UserSettings.get_or_init(user.id)

      assert settings.user_id == user.id
      assert settings.data == %{}
      assert is_binary(settings.id) or is_integer(settings.id)
    end

    test "returns the existing row on a second call — idempotent" do
      user = user_fixture()

      assert {:ok, %Settings{id: id1}} = UserSettings.get_or_init(user.id)
      assert {:ok, %Settings{id: id2}} = UserSettings.get_or_init(user.id)
      assert id1 == id2
    end

    test "returns {:error, changeset} for a nonexistent user_id (FK violation)" do
      fake_id = Ecto.UUID.generate()
      assert {:error, %Ecto.Changeset{}} = UserSettings.get_or_init(fake_id)
    end

    test "get_or_init for two different users creates two separate rows" do
      u1 = user_fixture()
      u2 = user_fixture()

      assert {:ok, %Settings{id: id1}} = UserSettings.get_or_init(u1.id)
      assert {:ok, %Settings{id: id2}} = UserSettings.get_or_init(u2.id)
      refute id1 == id2
    end
  end

  # ---------------------------------------------------------------------------
  # get_highlight_patterns/1
  # ---------------------------------------------------------------------------

  describe "get_highlight_patterns/1" do
    test "returns [] when no settings row exists for the user" do
      fake_id = Ecto.UUID.generate()
      assert UserSettings.get_highlight_patterns(fake_id) == []
    end

    test "returns [] when a settings row exists but has no highlight_patterns key" do
      user = user_fixture()
      {:ok, _} = UserSettings.get_or_init(user.id)
      assert UserSettings.get_highlight_patterns(user.id) == []
    end

    test "returns the list of patterns after set_highlight_patterns/2" do
      user = user_fixture()
      patterns = ["foo", "bar", "baz"]

      {:ok, _} = UserSettings.set_highlight_patterns(user.id, patterns)
      assert UserSettings.get_highlight_patterns(user.id) == patterns
    end

    test "returns [] when data has a non-list value under 'highlight_patterns'" do
      user = user_fixture()
      {:ok, settings} = UserSettings.get_or_init(user.id)

      # Test-only backdoor: write an unexpected shape directly.
      Repo.update!(Settings.changeset(settings, %{data: %{"highlight_patterns" => "not-a-list"}}))

      assert UserSettings.get_highlight_patterns(user.id) == []
    end

    test "string-key invariant: atom-keyed data doesn't crash the reader" do
      user = user_fixture()
      {:ok, settings} = UserSettings.get_or_init(user.id)

      # Test-only backdoor: write atom-keyed data (simulates miscoded writer).
      # JSON round-trip will turn atom keys into string keys so the reader
      # must use string keys — this test verifies the reader is robust.
      Repo.update!(Settings.changeset(settings, %{data: %{highlight_patterns: ["foo"]}}))

      # After JSON round-trip the key is "highlight_patterns" (string), so
      # the reader SHOULD find it — both string-key and atom-key writes
      # round-trip identically through Jason.
      result = UserSettings.get_highlight_patterns(user.id)
      assert is_list(result)
    end
  end

  # ---------------------------------------------------------------------------
  # set_highlight_patterns/2
  # ---------------------------------------------------------------------------

  describe "set_highlight_patterns/2" do
    test "creates a settings row if none exists and stores the patterns" do
      user = user_fixture()

      assert {:ok, %Settings{} = settings} =
               UserSettings.set_highlight_patterns(user.id, ["one", "two"])

      assert settings.data["highlight_patterns"] == ["one", "two"]
    end

    test "updates the patterns on an existing row" do
      user = user_fixture()
      {:ok, _} = UserSettings.set_highlight_patterns(user.id, ["alpha"])
      {:ok, settings} = UserSettings.set_highlight_patterns(user.id, ["beta", "gamma"])

      assert settings.data["highlight_patterns"] == ["beta", "gamma"]
    end

    test "preserves other keys in data when setting highlight_patterns" do
      user = user_fixture()
      {:ok, settings} = UserSettings.get_or_init(user.id)

      # Write a synthetic non-watchlist key via test-only backdoor.
      Repo.update!(Settings.changeset(settings, %{data: %{"other_key" => "keep-me"}}))

      {:ok, updated} = UserSettings.set_highlight_patterns(user.id, ["foo"])

      assert updated.data["highlight_patterns"] == ["foo"]
      assert updated.data["other_key"] == "keep-me"
    end

    test "accepts an empty list — valid 'explicitly empty' state" do
      user = user_fixture()
      {:ok, _} = UserSettings.set_highlight_patterns(user.id, ["something"])
      assert {:ok, settings} = UserSettings.set_highlight_patterns(user.id, [])
      assert settings.data["highlight_patterns"] == []
    end

    test "rejects a list containing an empty string" do
      user = user_fixture()
      assert {:error, %Ecto.Changeset{}} = UserSettings.set_highlight_patterns(user.id, [""])
    end

    test "rejects a list containing an integer element" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{}} =
               UserSettings.set_highlight_patterns(user.id, [42])
    end

    test "rejects a list containing an atom element" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{}} =
               UserSettings.set_highlight_patterns(user.id, [:foo])
    end

    test "rejects mixed valid + invalid list" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{}} =
               UserSettings.set_highlight_patterns(user.id, ["valid", ""])
    end
  end

  # ---------------------------------------------------------------------------
  # StreamData property tests
  # ---------------------------------------------------------------------------

  describe "property: idempotent get_or_init (same row id on repeated calls)" do
    property "get_or_init N times returns the same id each time" do
      check all(n <- StreamData.integer(2..5)) do
        user = user_fixture()

        ids =
          Enum.map(1..n, fn _ ->
            {:ok, settings} = UserSettings.get_or_init(user.id)
            settings.id
          end)

        assert length(Enum.uniq(ids)) == 1,
               "Expected all #{n} get_or_init calls to return the same id; got #{inspect(ids)}"
      end
    end
  end

  describe "property: set/get round-trip for highlight_patterns" do
    property "patterns written via set_highlight_patterns read back identical" do
      check all(
              patterns <-
                StreamData.list_of(
                  StreamData.string(:alphanumeric, min_length: 1, max_length: 30),
                  max_length: 10
                )
            ) do
        user = user_fixture()

        assert {:ok, _} = UserSettings.set_highlight_patterns(user.id, patterns)
        assert UserSettings.get_highlight_patterns(user.id) == patterns
      end
    end
  end

  describe "property: set_highlight_patterns preserves other data keys" do
    property "synthetic data keys survive a set_highlight_patterns call" do
      check all(
              other_val <- StreamData.string(:alphanumeric, min_length: 1, max_length: 20),
              patterns <-
                StreamData.list_of(
                  StreamData.string(:alphanumeric, min_length: 1, max_length: 20),
                  max_length: 5
                )
            ) do
        user = user_fixture()
        {:ok, settings} = UserSettings.get_or_init(user.id)

        # Test-only backdoor: plant a foreign key in data.
        Repo.update!(Settings.changeset(settings, %{data: %{"synthetic_key" => other_val}}))

        {:ok, updated} = UserSettings.set_highlight_patterns(user.id, patterns)

        assert updated.data["synthetic_key"] == other_val,
               "synthetic_key was dropped after set_highlight_patterns"
      end
    end
  end

  describe "property: concurrent get_or_init does not crash" do
    property "two sequential get_or_init calls for the same user are idempotent" do
      # We simulate concurrency via sequential calls — the on_conflict: :nothing
      # upsert path is exercised by calling get_or_init twice from the same
      # test process. True parallel test-process concurrency would fight the
      # sandbox ownership; sequential simulation is enough to exercise the
      # re-select branch.
      check all(_ <- StreamData.constant(:ok)) do
        user = user_fixture()

        assert {:ok, %Settings{id: id1}} = UserSettings.get_or_init(user.id)
        assert {:ok, %Settings{id: id2}} = UserSettings.get_or_init(user.id)
        assert id1 == id2
      end
    end
  end
end
