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
  alias Grappa.PubSub.Topic
  alias Grappa.UserSettings.Settings

  # ---------------------------------------------------------------------------
  # Fixtures
  # ---------------------------------------------------------------------------

  defp user_fixture do
    name = "us-user-#{System.unique_integer([:positive])}"
    {:ok, user} = Accounts.create_user(%{name: name, password: "correct horse battery staple"})
    user
  end

  # The PubSub topic root a settings write broadcasts on, built by the
  # same production function the web edge uses — never spelled out here.
  defp label(%Grappa.Accounts.User{name: name}), do: Grappa.Subject.label({:user, name})

  defp label(%Grappa.Visitors.Visitor{id: id}), do: Grappa.Subject.label({:visitor, id})

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
               presence_online: false,
               presence_offline: false,
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

    test "a legacy row written before #378 inherits both presence prefs OFF" do
      # The rollout contract: `notification_prefs` is string-keyed JSON in the
      # existing `:map` column, so there is no migration — every row written
      # before the two keys existed flows through `merge_with_defaults/1` and
      # inherits `false`/`false`. Presence push is therefore opt-IN: nobody
      # who never opened Settings starts receiving lockscreen banners.
      user = user_fixture()
      {:ok, settings} = UserSettings.get_or_init({:user, user.id})

      Repo.update!(
        Settings.changeset(settings, %{
          data: %{
            "notification_prefs" => %{
              "channel_messages_all" => false,
              "channel_messages_only" => [],
              "channel_mentions" => true,
              "private_messages_all" => true,
              "private_messages_only" => []
            }
          }
        })
      )

      result = UserSettings.get_notification_prefs({:user, user.id})

      assert result.presence_online == false
      assert result.presence_offline == false
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
        presence_online: false,
        presence_offline: false,
        muted_targets: %{"azzurra #noisy" => %{"until" => nil}}
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
        private_messages_only: ["  Alice ", "BOB"],
        presence_online: false,
        presence_offline: false
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
        private_messages_only: ["Foo[Bar]", "quux~"],
        presence_online: false,
        presence_offline: false
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
        private_messages_only: [],
        presence_online: false,
        presence_offline: false
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
        private_messages_only: ["alice"],
        presence_online: false,
        presence_offline: false
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
        private_messages_only: [],
        presence_online: false,
        presence_offline: false
      }

      assert {:error, %Ecto.Changeset{}} = UserSettings.put_notification_prefs({:user, user.id}, prefs)
    end

    test "rejects a PUT that omits the presence keys (deploy-skew 422, stated)" do
      # `cast_bools/2` requires EVERY `@prefs_bool_keys` member present, which
      # is the contract the three original booleans already had. A cic bundle
      # older than #378 therefore 422s until it reloads — accepted: server and
      # bundle ship together, so the window is already-open tabs. Making the
      # two new booleans optional would create two classes of boolean in one
      # map, which is worse than the window.
      user = user_fixture()

      prefs = %{
        channel_messages_all: false,
        channel_messages_only: [],
        channel_mentions: true,
        private_messages_all: true,
        private_messages_only: []
      }

      assert {:error, %Ecto.Changeset{}} = UserSettings.put_notification_prefs({:user, user.id}, prefs)
    end

    test "presence prefs are NOT triggers — all message triggers off still rejects" do
      # The `@prefs_trigger_keys` exclusion, pinned behaviourally. That
      # validator exists to reject a map that silently mutes all MESSAGE push.
      # If the presence keys joined the list, this map would pass validation
      # because `presence_online` is true — muting messages, which is exactly
      # what the guard prevents. Consequence, accepted for v1: a
      # presence-only-push configuration is unrepresentable.
      user = user_fixture()

      prefs = %{
        channel_messages_all: false,
        channel_messages_only: [],
        channel_mentions: false,
        private_messages_all: false,
        private_messages_only: [],
        presence_online: true,
        presence_offline: true
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
        "private_messages_only" => [],
        "presence_online" => false,
        "presence_offline" => false
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
        private_messages_only: [],
        presence_online: false,
        presence_offline: false
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
        private_messages_only: [],
        presence_online: false,
        presence_offline: false
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
        private_messages_only: [],
        presence_online: false,
        presence_offline: false
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
      presence_online: false,
      presence_offline: false,
      muted_targets: muted
    }
  end

  defp put_muted(user, muted),
    do: UserSettings.put_notification_prefs({:user, user.id}, base_prefs(muted))

  defp read_muted(user),
    do: UserSettings.get_notification_prefs({:user, user.id}).muted_targets

  describe "notification_prefs muted_targets (#866, network-keyed since #1038)" do
    test "folds the TARGET and keeps the slug, so the stored key is the one a row matches" do
      user = user_fixture()

      assert {:ok, _} =
               put_muted(user, %{
                 "  azzurra #SBiffo " => %{"until" => nil},
                 "azzurra Alice" => %{"until" => nil}
               })

      # A-Z only on the target half, and the whole key trimmed. The slug rides
      # through VERBATIM — cic's `channelKey` does not fold it either, and a
      # server that did would store a key no lookup can rebuild. The same
      # `Identifier.channel_key/2` that `Triggers.muted?/4` builds from the
      # incoming row is what composes this.
      assert read_muted(user) == %{
               "azzurra #sbiffo" => %{"until" => nil},
               "azzurra alice" => %{"until" => nil}
             }
    end

    test "the SAME channel on two networks is two independent mutes (the #1038 point)" do
      user = user_fixture()

      assert {:ok, _} =
               put_muted(user, %{
                 "azzurra #linux" => %{"until" => nil},
                 "libera #linux" => %{"until" => nil}
               })

      assert map_size(read_muted(user)) == 2
    end

    test "unmuting on one network leaves the other network's mute standing" do
      user = user_fixture()

      assert {:ok, _} =
               put_muted(user, %{
                 "azzurra #linux" => %{"until" => nil},
                 "libera #linux" => %{"until" => nil}
               })

      # What the client does to unmute: PUT back the map without that key.
      assert {:ok, _} = put_muted(user, %{"libera #linux" => %{"until" => nil}})

      assert read_muted(user) == %{"libera #linux" => %{"until" => nil}}
    end

    # -------------------------------------------------------------------
    # The bare (pre-#1038) key shape — what an OLD cic bundle still sends
    # -------------------------------------------------------------------

    test "a BARE key is dropped at the boundary instead of stored network-blind" do
      user = user_fixture()

      # A key with no separator is not a ChannelKey. Storing it verbatim would
      # recreate exactly the defect #1038 exists to remove: a row that reads as
      # muted in settings and silences nothing, because no lookup ever builds
      # that string. `PresenceFilter.Resolver` has dropped separator-less pins
      # since they shipped; this is the same posture, not a new one.
      assert {:ok, _} = put_muted(user, %{"#noisy" => %{"until" => nil}})

      assert read_muted(user) == %{}
    end

    test "a bare key does NOT fail the whole PUT — the rest of the map survives" do
      user = user_fixture()

      # The constraint #1038 states outright: an old bundle that still sends
      # bare keys must not be able to corrupt or wipe a migrated map. Erroring
      # the request would land the noise on the wrong person (the old bundle
      # could then save NO notification setting at all) and would break the
      # tolerant contract `cast_muted_targets/2` already keeps for an absent
      # key. Unknown-is-never-fatal, in both directions (#447).
      assert {:ok, _} =
               put_muted(user, %{
                 "#noisy" => %{"until" => nil},
                 "azzurra #keepme" => %{"until" => nil}
               })

      assert read_muted(user) == %{"azzurra #keepme" => %{"until" => nil}}
    end

    test "an old bundle's read-modify-write cannot wipe a migrated mute" do
      user = user_fixture()
      assert {:ok, _} = put_muted(user, %{"azzurra #migrated" => %{"until" => nil}})

      # The old bundle GETs the prefs, spreads the map it does not understand,
      # and adds its own bare key. The composite entries are opaque strings to
      # it, so they ride back out untouched.
      old_bundle_body = Map.put(read_muted(user), "#freshly-muted-by-old-cic", %{"until" => nil})

      assert {:ok, _} = put_muted(user, old_bundle_body)

      assert read_muted(user) == %{"azzurra #migrated" => %{"until" => nil}}
    end

    test "does not over-fold non-ASCII, so #CAFÉ and #café stay two mutes (#525)" do
      user = user_fixture()

      assert {:ok, _} =
               put_muted(user, %{
                 "azzurra #CAFÉ" => %{"until" => nil},
                 "azzurra #café" => %{"until" => nil}
               })

      assert map_size(read_muted(user)) == 2
    end

    test "keeps a snooze whose until is still ahead" do
      user = user_fixture()
      until = System.os_time(:second) + 3_600

      assert {:ok, _} = put_muted(user, %{"azzurra #noisy" => %{"until" => until}})
      assert read_muted(user) == %{"azzurra #noisy" => %{"until" => until}}
    end

    test "drops a snooze whose until has elapsed, on READ (Q3)" do
      user = user_fixture()
      elapsed = System.os_time(:second) - 1

      assert {:ok, _} = put_muted(user, %{"azzurra #noisy" => %{"until" => elapsed}})

      assert read_muted(user) == %{}
    end

    test "expiry is a read projection — the elapsed row is still in the column" do
      user = user_fixture()
      elapsed = System.os_time(:second) - 1

      assert {:ok, _} = put_muted(user, %{"azzurra #noisy" => %{"until" => elapsed}})
      assert read_muted(user) == %{}

      # The point of Q3 being "on read": no sweeper, and the GET does not turn
      # into a write. `Push.BadgeCount` calls the reader per recount, so a
      # pruning read would issue a write per badge refresh.
      settings = Repo.get_by!(Settings, user_id: user.id)

      assert %{"muted_targets" => %{"azzurra #noisy" => %{"until" => ^elapsed}}} =
               settings.data["notification_prefs"]
    end

    test "an elapsed entry disappears from storage on the next write, without a sweeper" do
      user = user_fixture()
      elapsed = System.os_time(:second) - 1

      assert {:ok, _} = put_muted(user, %{"azzurra #noisy" => %{"until" => elapsed}})
      # A client PUTs back what it read, and what it read had the entry gone.
      assert {:ok, _} = put_muted(user, read_muted(user))

      settings = Repo.get_by!(Settings, user_id: user.id)
      assert settings.data["notification_prefs"]["muted_targets"] == %{}
    end

    test "an ABSENT muted_targets key leaves the stored mutes alone" do
      user = user_fixture()
      assert {:ok, _} = put_muted(user, %{"azzurra #noisy" => %{"until" => nil}})

      # A cic bundle predating #866 saves an unrelated checkbox. It is saying
      # nothing about mutes, not asserting there are none — clearing them here
      # would be silent data loss for the whole rollout window.
      legacy = Map.delete(base_prefs(%{}), :muted_targets)
      assert {:ok, _} = UserSettings.put_notification_prefs({:user, user.id}, legacy)

      assert read_muted(user) == %{"azzurra #noisy" => %{"until" => nil}}
    end

    test "an EXPLICIT empty map does clear them — that is how the client unmutes" do
      user = user_fixture()
      assert {:ok, _} = put_muted(user, %{"azzurra #noisy" => %{"until" => nil}})

      assert {:ok, _} = put_muted(user, %{})

      assert read_muted(user) == %{}
    end

    test "rejects a non-integer until rather than storing a mute nobody can expire" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{} = cs} =
               put_muted(user, %{"azzurra #noisy" => %{"until" => "tomorrow"}})

      assert errors_on(cs)[:notification_prefs] != nil
    end

    test "a bare key is dropped WITHOUT judging its value" do
      user = user_fixture()

      # A dropped key stores no entry, so it has no value to validate. Failing
      # here would make an old bundle's ability to save its settings depend on
      # a field that was never going to be stored — undoing the whole reason
      # the bare key is dropped rather than rejected. A CURRENT bundle always
      # sends a composite key, so its `until` is still validated (the test
      # above); nothing is weakened for the path that can actually store.
      assert {:ok, _} = put_muted(user, %{"#noisy" => %{"until" => "tomorrow"}})
      assert read_muted(user) == %{}
    end

    test "rejects a non-positive until" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{}} = put_muted(user, %{"azzurra #noisy" => %{"until" => 0}})
    end

    test "rejects a value that is not a map" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{}} = put_muted(user, %{"azzurra #noisy" => true})
    end

    test "rejects a muted_targets that is not a map" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{}} =
               UserSettings.put_notification_prefs(
                 {:user, user.id},
                 %{base_prefs(%{}) | muted_targets: ["#noisy"]}
               )
    end

    test "drops a key that trims down to a bare slug with no target" do
      user = user_fixture()

      assert {:ok, _} = put_muted(user, %{"azzurra    " => %{"until" => nil}})
      assert read_muted(user) == %{}
    end

    test "drops a key that is only whitespace" do
      user = user_fixture()

      assert {:ok, _} = put_muted(user, %{"   " => %{"until" => nil}})
      assert read_muted(user) == %{}
    end

    test "bounds the entry count, because the column is a user-writable blob" do
      user = user_fixture()

      too_many =
        Map.new(1..2_001, fn n -> {"#chan#{n}", %{"until" => nil}} end)

      assert {:error, %Ecto.Changeset{}} = put_muted(user, too_many)
    end

    test "drops a sibling key the writer invented rather than persisting an unmodelled shape" do
      user = user_fixture()

      assert {:ok, _} =
               put_muted(user, %{"azzurra #noisy" => %{"until" => nil, "reason" => "loud"}})

      assert read_muted(user) == %{"azzurra #noisy" => %{"until" => nil}}
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

  describe "rename_muted_target/4 (#1340 K-S2 — the mute joins the #373 set)" do
    test "moves the mute from the old nick to the new one, on that network only" do
      user = user_fixture()

      assert {:ok, _} =
               put_muted(user, %{
                 "azzurra guest" => %{"until" => nil},
                 "libera guest" => %{"until" => nil},
                 "azzurra #linux" => %{"until" => nil}
               })

      assert {:ok, :renamed} =
               UserSettings.rename_muted_target({:user, user.id}, "azzurra", "guest", "Guest2")

      # The renamed peer is still silenced, under the identity they now
      # carry; the same nick on another network and the channel mute beside
      # it are untouched — the rename is one conversation moving, not a sweep.
      assert read_muted(user) == %{
               "azzurra guest2" => %{"until" => nil},
               "libera guest" => %{"until" => nil},
               "azzurra #linux" => %{"until" => nil}
             }
    end

    test "carries the snooze expiry across, rather than promoting it to permanent" do
      user = user_fixture()
      until = System.system_time(:second) + 3_600

      assert {:ok, _} = put_muted(user, %{"azzurra guest" => %{"until" => until}})

      assert {:ok, :renamed} =
               UserSettings.rename_muted_target({:user, user.id}, "azzurra", "guest", "Guest2")

      assert read_muted(user) == %{"azzurra guest2" => %{"until" => until}}
    end

    test "folds BOTH sides, so the stored key and the wire casing need not agree" do
      user = user_fixture()

      # Stored folded (every writer folds), renamed from the RAW casing the
      # NICK line carries — the #121/#372 key/display split.
      assert {:ok, _} = put_muted(user, %{"azzurra guest87449" => %{"until" => nil}})

      assert {:ok, :renamed} =
               UserSettings.rename_muted_target(
                 {:user, user.id},
                 "azzurra",
                 "Guest87449",
                 "NickTemporaneo"
               )

      assert read_muted(user) == %{"azzurra nicktemporaneo" => %{"until" => nil}}
    end

    test "a case-only NICK is a no-op, not a self-destructive re-key" do
      user = user_fixture()

      assert {:ok, _} = put_muted(user, %{"azzurra guest" => %{"until" => nil}})

      assert {:ok, :noop} =
               UserSettings.rename_muted_target({:user, user.id}, "azzurra", "guest", "GUEST")

      assert read_muted(user) == %{"azzurra guest" => %{"until" => nil}}
    end

    test "on a fold-collision the DESTINATION's own entry survives" do
      user = user_fixture()
      until = System.system_time(:second) + 3_600

      # Both identities muted: `guest` permanently, `guest2` snoozed. The
      # operator's choice about the identity that SURVIVES is the one that
      # means something after the rename.
      assert {:ok, _} =
               put_muted(user, %{
                 "azzurra guest" => %{"until" => nil},
                 "azzurra guest2" => %{"until" => until}
               })

      assert {:ok, :renamed} =
               UserSettings.rename_muted_target({:user, user.id}, "azzurra", "guest", "guest2")

      assert read_muted(user) == %{"azzurra guest2" => %{"until" => until}}
    end

    test "an unmuted peer renaming changes nothing" do
      user = user_fixture()

      assert {:ok, _} = put_muted(user, %{"azzurra #linux" => %{"until" => nil}})

      assert {:ok, :noop} =
               UserSettings.rename_muted_target({:user, user.id}, "azzurra", "guest", "Guest2")

      assert read_muted(user) == %{"azzurra #linux" => %{"until" => nil}}
    end

    test "a subject with no settings row at all is a no-op, not a crash" do
      user = user_fixture()

      assert {:ok, :noop} =
               UserSettings.rename_muted_target({:user, user.id}, "azzurra", "guest", "Guest2")
    end

    test "leaves every OTHER notification pref exactly as it was" do
      user = user_fixture()

      assert {:ok, _} =
               UserSettings.put_notification_prefs(
                 {:user, user.id},
                 %{
                   base_prefs(%{"azzurra guest" => %{"until" => nil}})
                   | channel_messages_only: ["#linux"],
                     private_messages_all: false,
                     private_messages_only: ["bob"]
                 }
               )

      before = UserSettings.get_notification_prefs({:user, user.id})

      assert {:ok, :renamed} =
               UserSettings.rename_muted_target({:user, user.id}, "azzurra", "guest", "Guest2")

      after_rename = UserSettings.get_notification_prefs({:user, user.id})

      # A rename migrates what the operator already chose; it is not a new
      # choice, so nothing but the mute key may move.
      assert Map.delete(before, :muted_targets) == Map.delete(after_rename, :muted_targets)
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
          private_messages_only: [],
          presence_online: false,
          presence_offline: false
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

  # ---------------------------------------------------------------------------
  # auto_away_debounce_seconds accessors (#348)
  # ---------------------------------------------------------------------------
  #
  # THREE states, one scalar — the setting is one control per vjt's ruling
  # (a delay AND an off switch), so it is one key and never a value plus a
  # sibling boolean:
  #
  #   nil         no preference — the session keeps the server-wide default
  #   :disabled   auto-away OFF for this subject: no timer is ever armed
  #   n           seconds to wait after the last visible device hides
  #
  # `:disabled` is an ATOM in the context API (CLAUDE.md: atoms for closed
  # sets) and the integer `0` on the JSON side of the boundary. The integer
  # `0` is therefore NOT a valid seconds value here — passing it in is a
  # 422, exactly like -1.

  describe "get_auto_away_debounce_seconds/1" do
    test "returns nil when no settings row exists" do
      fake_id = Ecto.UUID.generate()
      assert UserSettings.get_auto_away_debounce_seconds({:user, fake_id}) == nil
    end

    test "returns nil when the row exists but has no auto_away_debounce_seconds key" do
      user = user_fixture()
      {:ok, _} = UserSettings.get_or_init({:user, user.id})
      assert UserSettings.get_auto_away_debounce_seconds({:user, user.id}) == nil
    end

    test "decodes the stored 0 sentinel as :disabled" do
      user = user_fixture()
      {:ok, settings} = UserSettings.get_or_init({:user, user.id})
      Repo.update!(Settings.changeset(settings, %{data: %{"auto_away_debounce_seconds" => 0}}))

      assert UserSettings.get_auto_away_debounce_seconds({:user, user.id}) == :disabled
    end

    test "returns nil for malformed stored values (never crashes, falls back to default)" do
      user = user_fixture()
      {:ok, settings} = UserSettings.get_or_init({:user, user.id})

      for bogus <- ["600", -1, 1.5, %{"seconds" => 600}] do
        Repo.update!(Settings.changeset(settings, %{data: %{"auto_away_debounce_seconds" => bogus}}))

        assert UserSettings.get_auto_away_debounce_seconds({:user, user.id}) == nil
      end
    end

    test "returns nil for a stored value above the accepted range" do
      user = user_fixture()
      {:ok, settings} = UserSettings.get_or_init({:user, user.id})

      Repo.update!(
        Settings.changeset(settings, %{
          data: %{"auto_away_debounce_seconds" => UserSettings.auto_away_debounce_seconds_max() + 1}
        })
      )

      assert UserSettings.get_auto_away_debounce_seconds({:user, user.id}) == nil
    end
  end

  describe "put_auto_away_debounce_seconds/2" do
    test "persists a positive integer and reads back identically" do
      user = user_fixture()

      assert {:ok, %Settings{}} =
               UserSettings.put_auto_away_debounce_seconds({:user, user.id}, 120, label(user))

      assert UserSettings.get_auto_away_debounce_seconds({:user, user.id}) == 120
    end

    test "persists :disabled and reads it back as :disabled" do
      user = user_fixture()

      assert {:ok, %Settings{}} =
               UserSettings.put_auto_away_debounce_seconds({:user, user.id}, :disabled, label(user))

      assert UserSettings.get_auto_away_debounce_seconds({:user, user.id}) == :disabled
    end

    test "nil clears the preference (back to the server default)" do
      user = user_fixture()
      {:ok, _} = UserSettings.put_auto_away_debounce_seconds({:user, user.id}, 120, label(user))

      assert {:ok, %Settings{}} =
               UserSettings.put_auto_away_debounce_seconds({:user, user.id}, nil, label(user))

      assert UserSettings.get_auto_away_debounce_seconds({:user, user.id}) == nil
    end

    test "accepts both ends of the range exactly" do
      user = user_fixture()
      min = UserSettings.auto_away_debounce_seconds_min()
      max = UserSettings.auto_away_debounce_seconds_max()

      assert {:ok, _} = UserSettings.put_auto_away_debounce_seconds({:user, user.id}, min, label(user))
      assert UserSettings.get_auto_away_debounce_seconds({:user, user.id}) == min

      assert {:ok, _} = UserSettings.put_auto_away_debounce_seconds({:user, user.id}, max, label(user))
      assert UserSettings.get_auto_away_debounce_seconds({:user, user.id}) == max
    end

    test "rejects out-of-range, zero and non-integer values at the boundary" do
      user = user_fixture()
      min = UserSettings.auto_away_debounce_seconds_min()
      max = UserSettings.auto_away_debounce_seconds_max()

      for bogus <- [0, -1, min - 1, max + 1, "120", 1.5, :off] do
        assert {:error, %Ecto.Changeset{} = cs} =
                 UserSettings.put_auto_away_debounce_seconds({:user, user.id}, bogus, label(user))

        assert Keyword.has_key?(cs.errors, :auto_away_debounce_seconds)
      end
    end

    test "preserves other data keys (merge semantics, not replace)" do
      user = user_fixture()
      {:ok, _} = UserSettings.set_highlight_patterns({:user, user.id}, ["foo", "bar"])

      {:ok, _} = UserSettings.put_auto_away_debounce_seconds({:user, user.id}, 300, label(user))

      assert UserSettings.get_highlight_patterns({:user, user.id}) == ["foo", "bar"]
      assert UserSettings.get_auto_away_debounce_seconds({:user, user.id}) == 300
    end

    test "works for visitor subjects (visitor-parity at the store layer)" do
      visitor = visitor_fixture()

      assert {:ok, _} = UserSettings.put_auto_away_debounce_seconds({:visitor, visitor.id}, 60, label(visitor))
      assert UserSettings.get_auto_away_debounce_seconds({:visitor, visitor.id}) == 60
    end
  end

  # ---------------------------------------------------------------------------
  # put_auto_away_debounce_seconds/3 — the two announcements (#348)
  # ---------------------------------------------------------------------------
  #
  # A write has two audiences and they need different shapes: live
  # `Session.Server` processes, which want a raw term on a bridge topic no
  # WS client can join, and the subject's other devices, which want the
  # JSON-encodable wire event on the public user topic. Both leave from
  # the context, so no door can persist the value without announcing it.

  describe "put_auto_away_debounce_seconds/3 broadcasts" do
    setup do
      user = user_fixture()
      label = label(user)

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user(label))
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user_settings(label))

      {:ok, user: user, label: label}
    end

    test "a delay reaches sessions as a term and devices as a wire event", %{
      user: user,
      label: label
    } do
      {:ok, _} = UserSettings.put_auto_away_debounce_seconds({:user, user.id}, 120, label)

      assert_receive {:auto_away_debounce_changed, 120}

      assert_receive %Phoenix.Socket.Broadcast{
        payload: %{kind: :auto_away_debounce_changed, auto_away_debounce_seconds: 120}
      }
    end

    test "OFF stays an atom for sessions and becomes 0 for devices", %{user: user, label: label} do
      {:ok, _} = UserSettings.put_auto_away_debounce_seconds({:user, user.id}, :disabled, label)

      assert_receive {:auto_away_debounce_changed, :disabled}

      assert_receive %Phoenix.Socket.Broadcast{
        payload: %{kind: :auto_away_debounce_changed, auto_away_debounce_seconds: 0}
      }
    end

    test "clearing the preference is announced too, as nil/null", %{user: user, label: label} do
      {:ok, _} = UserSettings.put_auto_away_debounce_seconds({:user, user.id}, 120, label)
      assert_receive {:auto_away_debounce_changed, 120}

      {:ok, _} = UserSettings.put_auto_away_debounce_seconds({:user, user.id}, nil, label)

      assert_receive {:auto_away_debounce_changed, nil}

      assert_receive %Phoenix.Socket.Broadcast{
        payload: %{kind: :auto_away_debounce_changed, auto_away_debounce_seconds: nil}
      }
    end

    test "a rejected value announces nothing", %{user: user, label: label} do
      over = UserSettings.auto_away_debounce_seconds_max() + 1

      assert {:error, %Ecto.Changeset{}} =
               UserSettings.put_auto_away_debounce_seconds({:user, user.id}, over, label)

      refute_receive {:auto_away_debounce_changed, _}, 100
      refute_receive %Phoenix.Socket.Broadcast{payload: %{kind: :auto_away_debounce_changed}}, 100
    end

    test "another subject's topics stay silent", %{user: user, label: label} do
      other = user_fixture()
      other_label = label(other)

      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user_settings(other_label))

      {:ok, _} = UserSettings.put_auto_away_debounce_seconds({:user, user.id}, 120, label)

      assert_receive {:auto_away_debounce_changed, 120}
      refute_receive {:auto_away_debounce_changed, _}, 100
    end
  end
end
