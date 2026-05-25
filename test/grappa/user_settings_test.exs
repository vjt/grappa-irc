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

  import Grappa.AuthFixtures, only: [visitor_fixture: 0]

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

      assert {:ok, %Settings{} = settings} = UserSettings.get_or_init({:user, user.id})

      assert settings.user_id == user.id
      assert settings.data == %{}
      assert is_binary(settings.id) or is_integer(settings.id)
    end

    test "returns the existing row on a second call — idempotent" do
      user = user_fixture()

      assert {:ok, %Settings{id: id1}} = UserSettings.get_or_init({:user, user.id})
      assert {:ok, %Settings{id: id2}} = UserSettings.get_or_init({:user, user.id})
      assert id1 == id2
    end

    test "returns {:error, changeset} for a nonexistent user_id (FK violation)" do
      fake_id = Ecto.UUID.generate()
      assert {:error, %Ecto.Changeset{}} = UserSettings.get_or_init({:user, fake_id})
    end

    test "get_or_init for two different users creates two separate rows" do
      u1 = user_fixture()
      u2 = user_fixture()

      assert {:ok, %Settings{id: id1}} = UserSettings.get_or_init({:user, u1.id})
      assert {:ok, %Settings{id: id2}} = UserSettings.get_or_init({:user, u2.id})
      refute id1 == id2
    end
  end

  # ---------------------------------------------------------------------------
  # get_highlight_patterns/1
  # ---------------------------------------------------------------------------

  describe "get_highlight_patterns/1" do
    test "returns [] when no settings row exists for the user" do
      fake_id = Ecto.UUID.generate()
      assert UserSettings.get_highlight_patterns({:user, fake_id}) == []
    end

    test "returns [] when a settings row exists but has no highlight_patterns key" do
      user = user_fixture()
      {:ok, _} = UserSettings.get_or_init({:user, user.id})
      assert UserSettings.get_highlight_patterns({:user, user.id}) == []
    end

    test "returns the list of patterns after set_highlight_patterns/2" do
      user = user_fixture()
      patterns = ["foo", "bar", "baz"]

      {:ok, _} = UserSettings.set_highlight_patterns({:user, user.id}, patterns)
      assert UserSettings.get_highlight_patterns({:user, user.id}) == patterns
    end

    test "returns [] when data has a non-list value under 'highlight_patterns'" do
      user = user_fixture()
      {:ok, settings} = UserSettings.get_or_init({:user, user.id})

      # Test-only backdoor: write an unexpected shape directly.
      Repo.update!(Settings.changeset(settings, %{data: %{"highlight_patterns" => "not-a-list"}}))

      assert UserSettings.get_highlight_patterns({:user, user.id}) == []
    end

    test "string-key invariant: atom-keyed data doesn't crash the reader" do
      user = user_fixture()
      {:ok, settings} = UserSettings.get_or_init({:user, user.id})

      # Test-only backdoor: write atom-keyed data (simulates miscoded writer).
      # JSON round-trip will turn atom keys into string keys so the reader
      # must use string keys — this test verifies the reader is robust.
      Repo.update!(Settings.changeset(settings, %{data: %{highlight_patterns: ["foo"]}}))

      # After JSON round-trip the key is "highlight_patterns" (string), so
      # the reader SHOULD find it — both string-key and atom-key writes
      # round-trip identically through Jason.
      result = UserSettings.get_highlight_patterns({:user, user.id})
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
               UserSettings.set_highlight_patterns({:user, user.id}, ["one", "two"])

      assert settings.data["highlight_patterns"] == ["one", "two"]
    end

    test "updates the patterns on an existing row" do
      user = user_fixture()
      {:ok, _} = UserSettings.set_highlight_patterns({:user, user.id}, ["alpha"])
      {:ok, settings} = UserSettings.set_highlight_patterns({:user, user.id}, ["beta", "gamma"])

      assert settings.data["highlight_patterns"] == ["beta", "gamma"]
    end

    test "preserves other keys in data when setting highlight_patterns" do
      user = user_fixture()
      {:ok, settings} = UserSettings.get_or_init({:user, user.id})

      # Write a synthetic non-watchlist key via test-only backdoor.
      Repo.update!(Settings.changeset(settings, %{data: %{"other_key" => "keep-me"}}))

      {:ok, updated} = UserSettings.set_highlight_patterns({:user, user.id}, ["foo"])

      assert updated.data["highlight_patterns"] == ["foo"]
      assert updated.data["other_key"] == "keep-me"
    end

    test "accepts an empty list — valid 'explicitly empty' state" do
      user = user_fixture()
      {:ok, _} = UserSettings.set_highlight_patterns({:user, user.id}, ["something"])
      assert {:ok, settings} = UserSettings.set_highlight_patterns({:user, user.id}, [])
      assert settings.data["highlight_patterns"] == []
    end

    test "rejects a list containing an empty string" do
      user = user_fixture()
      assert {:error, %Ecto.Changeset{}} = UserSettings.set_highlight_patterns({:user, user.id}, [""])
    end

    test "rejects a list containing an integer element" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{}} =
               UserSettings.set_highlight_patterns({:user, user.id}, [42])
    end

    test "rejects a list containing an atom element" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{}} =
               UserSettings.set_highlight_patterns({:user, user.id}, [:foo])
    end

    test "rejects mixed valid + invalid list" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{}} =
               UserSettings.set_highlight_patterns({:user, user.id}, ["valid", ""])
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
            {:ok, settings} = UserSettings.get_or_init({:user, user.id})
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

        assert {:ok, _} = UserSettings.set_highlight_patterns({:user, user.id}, patterns)
        assert UserSettings.get_highlight_patterns({:user, user.id}) == patterns
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
        {:ok, settings} = UserSettings.get_or_init({:user, user.id})

        # Test-only backdoor: plant a foreign key in data.
        Repo.update!(Settings.changeset(settings, %{data: %{"synthetic_key" => other_val}}))

        {:ok, updated} = UserSettings.set_highlight_patterns({:user, user.id}, patterns)

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

        assert {:ok, %Settings{id: id1}} = UserSettings.get_or_init({:user, user.id})
        assert {:ok, %Settings{id: id2}} = UserSettings.get_or_init({:user, user.id})
        assert id1 == id2
      end
    end
  end

  # ---------------------------------------------------------------------------
  # notification_prefs accessors (push-notifications cluster B3)
  # ---------------------------------------------------------------------------

  describe "default_notification_prefs/0" do
    test "returns the documented default shape (mentions ON, DMs ON, channels OFF)" do
      defaults = UserSettings.default_notification_prefs()

      assert defaults == %{
               channel_messages_all: false,
               channel_messages_only: [],
               channel_mentions: true,
               private_messages_all: true,
               private_messages_only: []
             }
    end
  end

  describe "get_notification_prefs/1" do
    test "returns defaults when no settings row exists" do
      fake_id = Ecto.UUID.generate()

      assert UserSettings.get_notification_prefs({:user, fake_id}) ==
               UserSettings.default_notification_prefs()
    end

    test "returns defaults when row exists but no notification_prefs key" do
      user = user_fixture()
      {:ok, _} = UserSettings.get_or_init({:user, user.id})

      assert UserSettings.get_notification_prefs({:user, user.id}) ==
               UserSettings.default_notification_prefs()
    end

    test "returns defaults when stored value is malformed (not a map)" do
      user = user_fixture()
      {:ok, settings} = UserSettings.get_or_init({:user, user.id})

      Repo.update!(Settings.changeset(settings, %{data: %{"notification_prefs" => "not-a-map"}}))

      assert UserSettings.get_notification_prefs({:user, user.id}) ==
               UserSettings.default_notification_prefs()
    end

    test "merges partially-populated stored prefs with defaults" do
      user = user_fixture()
      {:ok, settings} = UserSettings.get_or_init({:user, user.id})

      # Persist only a subset of keys (legacy / cross-version row).
      Repo.update!(
        Settings.changeset(settings, %{
          data: %{
            "notification_prefs" => %{
              "channel_messages_all" => true,
              "channel_messages_only" => ["#italia"]
            }
          }
        })
      )

      result = UserSettings.get_notification_prefs({:user, user.id})
      assert result.channel_messages_all == true
      assert result.channel_messages_only == ["#italia"]
      # Missing keys filled from defaults.
      assert result.channel_mentions == true
      assert result.private_messages_all == true
      assert result.private_messages_only == []
    end

    test "drops empty strings from stored whitelist on read (defensive)" do
      user = user_fixture()
      {:ok, settings} = UserSettings.get_or_init({:user, user.id})

      Repo.update!(
        Settings.changeset(settings, %{
          data: %{
            "notification_prefs" => %{
              "channel_mentions" => true,
              "channel_messages_only" => ["#valid", "", "#italia"]
            }
          }
        })
      )

      result = UserSettings.get_notification_prefs({:user, user.id})
      assert result.channel_messages_only == ["#valid", "#italia"]
    end
  end

  describe "put_notification_prefs/2" do
    test "persists a complete prefs map and reads back identically" do
      user = user_fixture()

      prefs = %{
        channel_messages_all: false,
        channel_messages_only: ["#sbiffo"],
        channel_mentions: true,
        private_messages_all: false,
        private_messages_only: ["alice"]
      }

      assert {:ok, %Settings{}} = UserSettings.put_notification_prefs({:user, user.id}, prefs)
      assert UserSettings.get_notification_prefs({:user, user.id}) == prefs
    end

    test "lowercases + trims whitelist members" do
      user = user_fixture()

      prefs = %{
        channel_messages_all: false,
        channel_messages_only: ["  #SBiffo  ", "#Italia"],
        channel_mentions: true,
        private_messages_all: false,
        private_messages_only: ["  Alice ", "BOB"]
      }

      assert {:ok, _} = UserSettings.put_notification_prefs({:user, user.id}, prefs)

      result = UserSettings.get_notification_prefs({:user, user.id})
      assert result.channel_messages_only == ["#sbiffo", "#italia"]
      assert result.private_messages_only == ["alice", "bob"]
    end

    test "deduplicates whitelist members preserving first-occurrence order" do
      user = user_fixture()

      prefs = %{
        channel_messages_all: false,
        channel_messages_only: ["#a", "#b", "#A", "#c", "#B"],
        channel_mentions: true,
        private_messages_all: true,
        private_messages_only: []
      }

      assert {:ok, _} = UserSettings.put_notification_prefs({:user, user.id}, prefs)

      result = UserSettings.get_notification_prefs({:user, user.id})
      assert result.channel_messages_only == ["#a", "#b", "#c"]
    end

    test "stores whitelist even when corresponding _all is true (UI fallback)" do
      user = user_fixture()

      prefs = %{
        channel_messages_all: true,
        channel_messages_only: ["#sbiffo"],
        channel_mentions: true,
        private_messages_all: true,
        private_messages_only: ["alice"]
      }

      assert {:ok, _} = UserSettings.put_notification_prefs({:user, user.id}, prefs)

      result = UserSettings.get_notification_prefs({:user, user.id})
      assert result.channel_messages_only == ["#sbiffo"]
      assert result.private_messages_only == ["alice"]
    end

    test "rejects when no trigger is enabled" do
      user = user_fixture()

      prefs = %{
        channel_messages_all: false,
        channel_messages_only: [],
        channel_mentions: false,
        private_messages_all: false,
        private_messages_only: []
      }

      assert {:error, %Ecto.Changeset{}} = UserSettings.put_notification_prefs({:user, user.id}, prefs)
    end

    test "tolerates string-keyed prefs (post-JSON-decode shape)" do
      user = user_fixture()

      prefs = %{
        "channel_messages_all" => false,
        "channel_messages_only" => ["#italia"],
        "channel_mentions" => true,
        "private_messages_all" => true,
        "private_messages_only" => []
      }

      assert {:ok, _} = UserSettings.put_notification_prefs({:user, user.id}, prefs)

      result = UserSettings.get_notification_prefs({:user, user.id})
      assert result.channel_mentions == true
      assert result.channel_messages_only == ["#italia"]
    end

    test "rejects when a boolean field has a non-boolean value" do
      user = user_fixture()

      prefs = %{
        channel_messages_all: false,
        channel_messages_only: [],
        channel_mentions: "yes",
        private_messages_all: true,
        private_messages_only: []
      }

      assert {:error, %Ecto.Changeset{}} = UserSettings.put_notification_prefs({:user, user.id}, prefs)
    end

    test "rejects when a list field is not a list" do
      user = user_fixture()

      prefs = %{
        channel_messages_all: false,
        channel_messages_only: "#italia",
        channel_mentions: true,
        private_messages_all: true,
        private_messages_only: []
      }

      assert {:error, %Ecto.Changeset{}} = UserSettings.put_notification_prefs({:user, user.id}, prefs)
    end

    test "preserves other data keys (highlight_patterns) when writing prefs" do
      user = user_fixture()
      {:ok, _} = UserSettings.set_highlight_patterns({:user, user.id}, ["foo", "bar"])

      prefs = %{
        channel_messages_all: false,
        channel_messages_only: [],
        channel_mentions: true,
        private_messages_all: true,
        private_messages_only: []
      }

      assert {:ok, _} = UserSettings.put_notification_prefs({:user, user.id}, prefs)
      assert UserSettings.get_highlight_patterns({:user, user.id}) == ["foo", "bar"]
    end
  end

  # ---------------------------------------------------------------------------
  # upload_ttl_seconds accessors (UX-4 bucket M, 2026-05-19)
  # ---------------------------------------------------------------------------

  describe "get_upload_ttl_seconds/1" do
    test "returns nil when no settings row exists" do
      fake_id = Ecto.UUID.generate()
      assert UserSettings.get_upload_ttl_seconds({:user, fake_id}) == nil
    end

    test "returns nil when row exists but no upload_ttl_seconds key" do
      user = user_fixture()
      {:ok, _} = UserSettings.get_or_init({:user, user.id})
      assert UserSettings.get_upload_ttl_seconds({:user, user.id}) == nil
    end

    test "returns nil when stored value is malformed (string instead of integer)" do
      user = user_fixture()
      {:ok, settings} = UserSettings.get_or_init({:user, user.id})

      Repo.update!(Settings.changeset(settings, %{data: %{"upload_ttl_seconds" => "24h"}}))

      assert UserSettings.get_upload_ttl_seconds({:user, user.id}) == nil
    end

    test "returns nil when stored value is zero or negative" do
      user = user_fixture()
      {:ok, settings} = UserSettings.get_or_init({:user, user.id})

      Repo.update!(Settings.changeset(settings, %{data: %{"upload_ttl_seconds" => 0}}))
      assert UserSettings.get_upload_ttl_seconds({:user, user.id}) == nil

      Repo.update!(Settings.changeset(settings, %{data: %{"upload_ttl_seconds" => -1}}))
      assert UserSettings.get_upload_ttl_seconds({:user, user.id}) == nil
    end

    test "returns nil when stored value exceeds upper bound" do
      user = user_fixture()
      {:ok, settings} = UserSettings.get_or_init({:user, user.id})
      Repo.update!(Settings.changeset(settings, %{data: %{"upload_ttl_seconds" => 31_536_001}}))
      assert UserSettings.get_upload_ttl_seconds({:user, user.id}) == nil
    end

    test "returns stored integer when in-range" do
      user = user_fixture()
      {:ok, _} = UserSettings.put_upload_ttl_seconds({:user, user.id}, 3600)
      assert UserSettings.get_upload_ttl_seconds({:user, user.id}) == 3600
    end
  end

  describe "put_upload_ttl_seconds/2" do
    test "persists a positive integer and reads back identically" do
      user = user_fixture()
      assert {:ok, %Settings{}} = UserSettings.put_upload_ttl_seconds({:user, user.id}, 86_400)
      assert UserSettings.get_upload_ttl_seconds({:user, user.id}) == 86_400
    end

    test "persists nil by deleting the key (clears preference)" do
      user = user_fixture()
      {:ok, _} = UserSettings.put_upload_ttl_seconds({:user, user.id}, 3600)
      assert UserSettings.get_upload_ttl_seconds({:user, user.id}) == 3600

      assert {:ok, %Settings{}} = UserSettings.put_upload_ttl_seconds({:user, user.id}, nil)
      assert UserSettings.get_upload_ttl_seconds({:user, user.id}) == nil
    end

    test "rejects zero" do
      user = user_fixture()
      assert {:error, %Ecto.Changeset{}} = UserSettings.put_upload_ttl_seconds({:user, user.id}, 0)
    end

    test "rejects negative" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{}} =
               UserSettings.put_upload_ttl_seconds({:user, user.id}, -3600)
    end

    test "rejects value above upper bound (1 year + 1 second)" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{}} =
               UserSettings.put_upload_ttl_seconds({:user, user.id}, 31_536_001)
    end

    test "accepts the upper bound exactly" do
      user = user_fixture()

      assert {:ok, _} = UserSettings.put_upload_ttl_seconds({:user, user.id}, 31_536_000)
      assert UserSettings.get_upload_ttl_seconds({:user, user.id}) == 31_536_000
    end

    test "rejects non-integer non-nil" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{}} =
               UserSettings.put_upload_ttl_seconds({:user, user.id}, "3600")

      assert {:error, %Ecto.Changeset{}} =
               UserSettings.put_upload_ttl_seconds({:user, user.id}, 3600.5)
    end

    test "preserves other data keys (notification_prefs + highlight_patterns)" do
      user = user_fixture()
      {:ok, _} = UserSettings.set_highlight_patterns({:user, user.id}, ["foo"])

      {:ok, _} =
        UserSettings.put_notification_prefs({:user, user.id}, %{
          channel_messages_all: false,
          channel_messages_only: [],
          channel_mentions: true,
          private_messages_all: true,
          private_messages_only: []
        })

      assert {:ok, _} = UserSettings.put_upload_ttl_seconds({:user, user.id}, 3600)

      assert UserSettings.get_highlight_patterns({:user, user.id}) == ["foo"]
      prefs = UserSettings.get_notification_prefs({:user, user.id})
      assert prefs.channel_mentions == true
    end

    test "works for visitor subjects (visitor-parity)" do
      visitor = visitor_fixture()
      assert {:ok, _} = UserSettings.put_upload_ttl_seconds({:visitor, visitor.id}, 3600)
      assert UserSettings.get_upload_ttl_seconds({:visitor, visitor.id}) == 3600
    end
  end

  # ---------------------------------------------------------------------------
  # reset_for_user/1
  # ---------------------------------------------------------------------------

  describe "reset_for_user/1" do
    test "deletes the settings row so subsequent reads return defaults" do
      user = user_fixture()
      other = user_fixture()
      {:ok, _} = UserSettings.set_highlight_patterns({:user, user.id}, ["foo", "bar"])
      {:ok, _} = UserSettings.set_highlight_patterns({:user, other.id}, ["keep-me"])

      # Pre-condition: both users have custom patterns
      assert UserSettings.get_highlight_patterns({:user, user.id}) == ["foo", "bar"]
      assert UserSettings.get_highlight_patterns({:user, other.id}) == ["keep-me"]

      assert :ok = UserSettings.reset_for_user(user.id)

      # User's settings reset to defaults; other user's preserved.
      assert UserSettings.get_highlight_patterns({:user, user.id}) == []
      assert UserSettings.get_highlight_patterns({:user, other.id}) == ["keep-me"]
    end

    test "is idempotent when user has no settings row" do
      user = user_fixture()
      assert :ok = UserSettings.reset_for_user(user.id)
    end
  end
end
