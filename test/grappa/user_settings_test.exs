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
               private_messages_only: [],
               # #866 — nothing muted by default. This map is also mirrored
               # byte-for-byte by cic's DEFAULT_NOTIFICATION_PREFS, so an
               # un-hydrated client behaves like a subject who configured
               # nothing rather than one who muted everything.
               muted_targets: %{}
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
        private_messages_only: ["alice"],
        muted_targets: %{"#noisy" => %{"until" => nil}}
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

    test "folds BOTH nick and channel whitelists under ASCII casemapping (#525)" do
      user = user_fixture()

      prefs = %{
        channel_messages_all: false,
        # #525: channels fold via canonical_channel under CASEMAPPING=ascii
        # (A-Z only, brackets preserved), so `#Foo[X]` → `#foo[x]` (was the
        # #364 rfc1459 `#foo{x}` over-fold).
        channel_messages_only: ["#Foo[X]"],
        channel_mentions: true,
        private_messages_all: false,
        # Nicks fold via canonical_nick (ASCII): case only; `[ ~` are kept.
        private_messages_only: ["Foo[Bar]", "quux~"]
      }

      assert {:ok, _} = UserSettings.put_notification_prefs({:user, user.id}, prefs)

      result = UserSettings.get_notification_prefs({:user, user.id})
      assert result.channel_messages_only == ["#foo[x]"]
      assert result.private_messages_only == ["foo[bar]", "quux~"]
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
  # muted_targets — per-conversation mute (#866)
  # ---------------------------------------------------------------------------

  defp base_prefs(muted) do
    %{
      channel_messages_all: false,
      channel_messages_only: [],
      channel_mentions: true,
      private_messages_all: true,
      private_messages_only: [],
      muted_targets: muted
    }
  end

  defp put_muted(user, muted),
    do: UserSettings.put_notification_prefs({:user, user.id}, base_prefs(muted))

  defp read_muted(user),
    do: UserSettings.get_notification_prefs({:user, user.id}).muted_targets

  describe "notification_prefs muted_targets (#866)" do
    test "folds keys with canonical_target/1, so the stored key is the one a row matches" do
      user = user_fixture()

      assert {:ok, _} =
               put_muted(user, %{
                 "  #SBiffo " => %{"until" => nil},
                 "Alice" => %{"until" => nil}
               })

      # A-Z only, and trimmed. The same fold `Triggers.muted?/3` applies to the
      # incoming channel/sender — a write that folded differently would store a
      # key no message can ever match.
      assert read_muted(user) == %{
               "#sbiffo" => %{"until" => nil},
               "alice" => %{"until" => nil}
             }
    end

    test "does not over-fold non-ASCII, so #CAFÉ and #café stay two mutes (#525)" do
      user = user_fixture()

      assert {:ok, _} =
               put_muted(user, %{
                 "#CAFÉ" => %{"until" => nil},
                 "#café" => %{"until" => nil}
               })

      assert map_size(read_muted(user)) == 2
    end

    test "keeps a snooze whose until is still ahead" do
      user = user_fixture()
      until = System.os_time(:second) + 3_600

      assert {:ok, _} = put_muted(user, %{"#noisy" => %{"until" => until}})
      assert read_muted(user) == %{"#noisy" => %{"until" => until}}
    end

    test "drops a snooze whose until has elapsed, on READ (Q3)" do
      user = user_fixture()
      elapsed = System.os_time(:second) - 1

      assert {:ok, _} = put_muted(user, %{"#noisy" => %{"until" => elapsed}})

      assert read_muted(user) == %{}
    end

    test "expiry is a read projection — the elapsed row is still in the column" do
      user = user_fixture()
      elapsed = System.os_time(:second) - 1

      assert {:ok, _} = put_muted(user, %{"#noisy" => %{"until" => elapsed}})
      assert read_muted(user) == %{}

      # The point of Q3 being "on read": no sweeper, and the GET does not turn
      # into a write. `Push.BadgeCount` calls the reader per recount, so a
      # pruning read would issue a write per badge refresh.
      settings = Repo.get_by!(Settings, user_id: user.id)

      assert %{"muted_targets" => %{"#noisy" => %{"until" => ^elapsed}}} =
               settings.data["notification_prefs"]
    end

    test "an elapsed entry disappears from storage on the next write, without a sweeper" do
      user = user_fixture()
      elapsed = System.os_time(:second) - 1

      assert {:ok, _} = put_muted(user, %{"#noisy" => %{"until" => elapsed}})
      # A client PUTs back what it read, and what it read had the entry gone.
      assert {:ok, _} = put_muted(user, read_muted(user))

      settings = Repo.get_by!(Settings, user_id: user.id)
      assert settings.data["notification_prefs"]["muted_targets"] == %{}
    end

    test "an ABSENT muted_targets key leaves the stored mutes alone" do
      user = user_fixture()
      assert {:ok, _} = put_muted(user, %{"#noisy" => %{"until" => nil}})

      # A cic bundle predating #866 saves an unrelated checkbox. It is saying
      # nothing about mutes, not asserting there are none — clearing them here
      # would be silent data loss for the whole rollout window.
      legacy = Map.delete(base_prefs(%{}), :muted_targets)
      assert {:ok, _} = UserSettings.put_notification_prefs({:user, user.id}, legacy)

      assert read_muted(user) == %{"#noisy" => %{"until" => nil}}
    end

    test "an EXPLICIT empty map does clear them — that is how the client unmutes" do
      user = user_fixture()
      assert {:ok, _} = put_muted(user, %{"#noisy" => %{"until" => nil}})

      assert {:ok, _} = put_muted(user, %{})

      assert read_muted(user) == %{}
    end

    test "rejects a non-integer until rather than storing a mute nobody can expire" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{} = cs} =
               put_muted(user, %{"#noisy" => %{"until" => "tomorrow"}})

      assert errors_on(cs)[:notification_prefs] != nil
    end

    test "rejects a non-positive until" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{}} = put_muted(user, %{"#noisy" => %{"until" => 0}})
    end

    test "rejects a value that is not a map" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{}} = put_muted(user, %{"#noisy" => true})
    end

    test "rejects a muted_targets that is not a map" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{}} =
               UserSettings.put_notification_prefs(
                 {:user, user.id},
                 %{base_prefs(%{}) | muted_targets: ["#noisy"]}
               )
    end

    test "rejects a key that folds to empty" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{}} = put_muted(user, %{"   " => %{"until" => nil}})
    end

    test "bounds the entry count, because the column is a user-writable blob" do
      user = user_fixture()

      too_many =
        Map.new(1..2_001, fn n -> {"#chan#{n}", %{"until" => nil}} end)

      assert {:error, %Ecto.Changeset{}} = put_muted(user, too_many)
    end

    test "drops a sibling key the writer invented rather than persisting an unmodelled shape" do
      user = user_fixture()

      assert {:ok, _} = put_muted(user, %{"#noisy" => %{"until" => nil, "reason" => "loud"}})

      assert read_muted(user) == %{"#noisy" => %{"until" => nil}}
    end

    test "the reader survives a malformed stored map, failing OPEN" do
      user = user_fixture()
      {:ok, settings} = UserSettings.get_or_init({:user, user.id})

      # Hand-written column, the shape a future/miscoded writer could leave.
      data = %{
        "notification_prefs" => %{
          "channel_mentions" => true,
          "muted_targets" => %{
            "#good" => %{"until" => nil},
            "#bad-until" => %{"until" => "soon"},
            "#not-a-map" => 42,
            "" => %{"until" => nil}
          }
        }
      }

      {:ok, _} = settings |> Settings.changeset(%{data: data}) |> Repo.update()

      # Only the intelligible entry survives. The unreadable ones NOTIFY rather
      # than silence forever — a mute nobody can interpret must not be a mute.
      assert read_muted(user) == %{"#good" => %{"until" => nil}}
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

  # ---------------------------------------------------------------------------
  # aliases accessors (#385 user-defined command aliases)
  # ---------------------------------------------------------------------------

  describe "get_aliases/1" do
    test "returns %{} when no settings row exists" do
      fake_id = Ecto.UUID.generate()
      assert UserSettings.get_aliases({:user, fake_id}) == %{}
    end

    test "returns %{} when row exists but no aliases key" do
      user = user_fixture()
      {:ok, _} = UserSettings.get_or_init({:user, user.id})
      assert UserSettings.get_aliases({:user, user.id}) == %{}
    end

    test "returns %{} when stored value is malformed (list instead of map)" do
      user = user_fixture()
      {:ok, settings} = UserSettings.get_or_init({:user, user.id})
      Repo.update!(Settings.changeset(settings, %{data: %{"aliases" => ["not", "a", "map"]}}))
      assert UserSettings.get_aliases({:user, user.id}) == %{}
    end

    test "filters non-string entries defensively (string => string only)" do
      user = user_fixture()
      {:ok, settings} = UserSettings.get_or_init({:user, user.id})

      Repo.update!(
        Settings.changeset(settings, %{
          data: %{"aliases" => %{"wii" => "whois $1 $1", "bad" => 42}}
        })
      )

      assert UserSettings.get_aliases({:user, user.id}) == %{"wii" => "whois $1 $1"}
    end

    test "returns the stored map when present" do
      user = user_fixture()
      {:ok, _} = UserSettings.set_aliases({:user, user.id}, %{"wii" => "whois $1 $1"})
      assert UserSettings.get_aliases({:user, user.id}) == %{"wii" => "whois $1 $1"}
    end
  end

  describe "set_aliases/2" do
    test "persists a map and reads back identically" do
      user = user_fixture()

      aliases = %{"wii" => "whois $1 $1", "j" => "join $*"}

      assert {:ok, %Settings{}} = UserSettings.set_aliases({:user, user.id}, aliases)
      assert UserSettings.get_aliases({:user, user.id}) == aliases
    end

    test "lowercases alias names (case-insensitive keys)" do
      user = user_fixture()
      assert {:ok, _} = UserSettings.set_aliases({:user, user.id}, %{"WII" => "whois $1 $1"})
      assert UserSettings.get_aliases({:user, user.id}) == %{"wii" => "whois $1 $1"}
    end

    test "trims surrounding whitespace from name and expansion" do
      user = user_fixture()
      assert {:ok, _} = UserSettings.set_aliases({:user, user.id}, %{"  wii  " => "  whois $1  "})
      assert UserSettings.get_aliases({:user, user.id}) == %{"wii" => "whois $1"}
    end

    test "accepts an empty map (clears all aliases)" do
      user = user_fixture()
      {:ok, _} = UserSettings.set_aliases({:user, user.id}, %{"wii" => "whois $1 $1"})
      assert {:ok, _} = UserSettings.set_aliases({:user, user.id}, %{})
      assert UserSettings.get_aliases({:user, user.id}) == %{}
    end

    test "rejects an empty alias name" do
      user = user_fixture()
      assert {:error, %Ecto.Changeset{}} = UserSettings.set_aliases({:user, user.id}, %{"" => "whois"})
    end

    test "rejects an alias name containing whitespace" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{}} =
               UserSettings.set_aliases({:user, user.id}, %{"wi i" => "whois"})
    end

    test "rejects an empty expansion" do
      user = user_fixture()
      assert {:error, %Ecto.Changeset{}} = UserSettings.set_aliases({:user, user.id}, %{"wii" => "   "})
    end

    test "rejects non-string values" do
      user = user_fixture()
      assert {:error, %Ecto.Changeset{}} = UserSettings.set_aliases({:user, user.id}, %{"wii" => 42})
    end

    test "rejects a name longer than 32 bytes" do
      user = user_fixture()
      long = String.duplicate("a", 33)
      assert {:error, %Ecto.Changeset{}} = UserSettings.set_aliases({:user, user.id}, %{long => "whois"})
    end

    test "rejects an expansion longer than 512 bytes" do
      user = user_fixture()
      long = String.duplicate("x", 513)
      assert {:error, %Ecto.Changeset{}} = UserSettings.set_aliases({:user, user.id}, %{"big" => long})
    end

    test "rejects more than 200 aliases" do
      user = user_fixture()
      too_many = Map.new(1..201, fn n -> {"a#{n}", "whois"} end)
      assert {:error, %Ecto.Changeset{}} = UserSettings.set_aliases({:user, user.id}, too_many)
    end

    test "preserves other data keys (highlight_patterns)" do
      user = user_fixture()
      {:ok, _} = UserSettings.set_highlight_patterns({:user, user.id}, ["foo", "bar"])

      assert {:ok, _} = UserSettings.set_aliases({:user, user.id}, %{"wii" => "whois $1 $1"})
      assert UserSettings.get_highlight_patterns({:user, user.id}) == ["foo", "bar"]
    end

    test "works for visitor subjects (visitor-parity)" do
      visitor = visitor_fixture()
      assert {:ok, _} = UserSettings.set_aliases({:visitor, visitor.id}, %{"wii" => "whois $1 $1"})
      assert UserSettings.get_aliases({:visitor, visitor.id}) == %{"wii" => "whois $1 $1"}
    end
  end

  # ---------------------------------------------------------------------------
  # last_client_prefix64 accessors (#543 INC-3 — dumb base16 string store)
  # ---------------------------------------------------------------------------

  describe "get/put_last_client_prefix64 — opaque base16 string store" do
    test "round-trips a base16 string" do
      user = user_fixture()
      hex = Base.encode16(<<0x20, 0x01, 0x0D, 0xB8, 0, 1, 0, 2>>)

      assert {:ok, _} = UserSettings.put_last_client_prefix64({:user, user.id}, hex)
      assert UserSettings.get_last_client_prefix64({:user, user.id}) == hex
    end

    test "last write wins (roam) — the putter replaces, not appends" do
      user = user_fixture()
      first = Base.encode16(<<1, 2, 3, 4>>)
      second = Base.encode16(<<5, 6, 7, 8>>)

      {:ok, _} = UserSettings.put_last_client_prefix64({:user, user.id}, first)
      {:ok, _} = UserSettings.put_last_client_prefix64({:user, user.id}, second)
      assert UserSettings.get_last_client_prefix64({:user, user.id}) == second
    end

    test "get returns nil when no settings row exists" do
      user = user_fixture()
      assert UserSettings.get_last_client_prefix64({:user, user.id}) == nil
    end

    test "get returns nil when the row exists but the key is absent" do
      user = user_fixture()
      {:ok, _} = UserSettings.get_or_init({:user, user.id})
      assert UserSettings.get_last_client_prefix64({:user, user.id}) == nil
    end

    test "get returns nil for a malformed (non-string) stored value" do
      user = user_fixture()
      {:ok, settings} = UserSettings.get_or_init({:user, user.id})
      # Bypass the typed putter to inject a bad shape (a miscoded writer).
      {:ok, _} =
        Repo.update(Settings.changeset(settings, %{data: %{"last_client_prefix64" => 123}}))

      assert UserSettings.get_last_client_prefix64({:user, user.id}) == nil
    end

    test "put rejects an empty string" do
      user = user_fixture()
      assert {:error, %Ecto.Changeset{}} = UserSettings.put_last_client_prefix64({:user, user.id}, "")
    end

    test "put rejects a non-base16 string" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{}} =
               UserSettings.put_last_client_prefix64({:user, user.id}, "not-hex-zz")
    end

    test "put preserves other data keys (highlight_patterns)" do
      user = user_fixture()
      {:ok, _} = UserSettings.set_highlight_patterns({:user, user.id}, ["foo", "bar"])

      {:ok, _} = UserSettings.put_last_client_prefix64({:user, user.id}, Base.encode16(<<9, 9>>))
      assert UserSettings.get_highlight_patterns({:user, user.id}) == ["foo", "bar"]
    end

    test "works for visitor subjects (visitor-parity)" do
      visitor = visitor_fixture()
      hex = Base.encode16(<<0xCA, 0xFE>>)

      assert {:ok, _} = UserSettings.put_last_client_prefix64({:visitor, visitor.id}, hex)
      assert UserSettings.get_last_client_prefix64({:visitor, visitor.id}) == hex
    end
  end
end
