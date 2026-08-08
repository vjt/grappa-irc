defmodule Grappa.Migrations.PrefixMutedTargetsWithNetworkTest do
  @moduledoc """
  #1038 — the one-shot mute-key rewrite migration (`20260808120000`).

  Runs the migration's exact UPDATE SQL against hand-written
  `user_settings.data` blobs and asserts vjt's ruling: every stored BARE key
  gains the prefix of the FIRST network found in the DB for that subject,
  optimistically and without trying to reconstruct which network the mute was
  really meant for.

  The SQL is duplicated here (migrations stay self-contained per repo
  convention — see `seed_visitor_enabled_test.exs`) — keep it byte-aligned
  with the migration file.

  Mutes are seeded by writing the column directly rather than through
  `UserSettings.put_notification_prefs/2`: since #1038 that boundary DROPS a
  bare key, so it cannot produce the pre-migration state this migration
  exists to repair.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.UserSettings
  alias Grappa.UserSettings.Settings

  # Keep byte-aligned with priv/repo/migrations/20260808120000_prefix_muted_targets_with_network.exs
  @rewrite_sql """
  UPDATE user_settings
  SET data = json_replace(
    data,
    '$.notification_prefs.muted_targets',
    (SELECT json_group_object(
       CASE
         WHEN instr(entry.key, ' ') > 0 THEN entry.key
         ELSE (SELECT n.slug
                 FROM network_credentials nc
                 JOIN networks n ON n.id = nc.network_id
                WHERE (user_settings.user_id IS NOT NULL AND nc.user_id = user_settings.user_id)
                   OR (user_settings.visitor_id IS NOT NULL AND nc.visitor_id = user_settings.visitor_id)
                ORDER BY nc.id
                LIMIT 1) || ' ' || entry.key
       END,
       json(entry.value))
     FROM json_each(json_extract(user_settings.data, '$.notification_prefs.muted_targets')) entry)
  )
  WHERE json_type(data, '$.notification_prefs.muted_targets') = 'object'
    AND EXISTS (
      SELECT 1
        FROM json_each(json_extract(user_settings.data, '$.notification_prefs.muted_targets')) bare
       WHERE instr(bare.key, ' ') = 0)
    AND EXISTS (
      SELECT 1
        FROM network_credentials nc2
       WHERE (user_settings.user_id IS NOT NULL AND nc2.user_id = user_settings.user_id)
          OR (user_settings.visitor_id IS NOT NULL AND nc2.visitor_id = user_settings.visitor_id))
  """

  defp seed_mutes(subject, muted) do
    {:ok, settings} = UserSettings.get_or_init(subject)

    data = Map.put(settings.data, "notification_prefs", %{"muted_targets" => muted})

    {:ok, _} = settings |> Settings.changeset(%{data: data}) |> Repo.update()
    :ok
  end

  defp stored_mutes(subject) do
    {:ok, settings} = UserSettings.get_or_init(subject)
    settings.data["notification_prefs"]["muted_targets"]
  end

  defp run, do: Repo.query!(@rewrite_sql, [])

  # Returns the SUBJECT only: no test needs the user struct itself, and
  # returning a pair just to discard half of it is what credo's
  # unused-variable consistency check was pointing at.
  defp user_on(slug) do
    user = user_fixture()
    network = network_fixture(slug: slug)
    _ = credential_fixture(user, network, %{nick: "n"})
    {:user, user.id}
  end

  test "a bare key gains the subject's network prefix" do
    subject = user_on("azzurra")
    :ok = seed_mutes(subject, %{"#linux" => %{"until" => nil}})

    run()

    assert stored_mutes(subject) == %{"azzurra #linux" => %{"until" => nil}}
  end

  test "the rewritten key is the one the live reader now matches on" do
    # The migration is only worth anything if what it writes is what
    # `Identifier.channel_key/2` builds. Asserting the literal string above
    # pins the shape; this asserts the two agree, through the real reader.
    subject = user_on("azzurra")
    :ok = seed_mutes(subject, %{"#linux" => %{"until" => nil}})

    run()

    assert Map.has_key?(
             UserSettings.get_notification_prefs(subject).muted_targets,
             Grappa.IRC.Identifier.channel_key("azzurra", "#linux")
           )
  end

  test "a snooze keeps its until across the rewrite" do
    subject = user_on("azzurra")
    until = System.os_time(:second) + 3_600
    :ok = seed_mutes(subject, %{"#linux" => %{"until" => until}})

    run()

    assert stored_mutes(subject) == %{"azzurra #linux" => %{"until" => until}}
  end

  test "every bare key is rewritten, not just the first" do
    subject = user_on("azzurra")

    :ok =
      seed_mutes(subject, %{
        "#linux" => %{"until" => nil},
        "#bofh" => %{"until" => nil},
        "alice" => %{"until" => nil}
      })

    run()

    assert stored_mutes(subject) == %{
             "azzurra #linux" => %{"until" => nil},
             "azzurra #bofh" => %{"until" => nil},
             "azzurra alice" => %{"until" => nil}
           }
  end

  test "an already-composite key is left exactly as it is" do
    subject = user_on("azzurra")

    :ok =
      seed_mutes(subject, %{
        "libera #linux" => %{"until" => nil},
        "#bofh" => %{"until" => nil}
      })

    run()

    # The composite one keeps ITS network — the optimistic prefix is only
    # applied where there is no network to preserve.
    assert stored_mutes(subject) == %{
             "libera #linux" => %{"until" => nil},
             "azzurra #bofh" => %{"until" => nil}
           }
  end

  test "is idempotent — a second run does not double-prefix" do
    subject = user_on("azzurra")
    :ok = seed_mutes(subject, %{"#linux" => %{"until" => nil}})

    run()
    run()

    assert stored_mutes(subject) == %{"azzurra #linux" => %{"until" => nil}}
  end

  test "picks the FIRST credential's network for a multi-network subject" do
    # Optimistic by vjt's ruling: no attempt to reconstruct which network the
    # mute meant. A single-network subject (the common case) lands exactly
    # right; a multi-network one gets one plausible mute it can move by hand.
    user = user_fixture()
    first = network_fixture(slug: "first-net")
    second = network_fixture(slug: "second-net")
    _ = credential_fixture(user, first, %{nick: "n"})
    _ = credential_fixture(user, second, %{nick: "n"})
    subject = {:user, user.id}

    :ok = seed_mutes(subject, %{"#linux" => %{"until" => nil}})

    run()

    assert stored_mutes(subject) == %{"first-net #linux" => %{"until" => nil}}
  end

  test "a subject with NO credential is left alone rather than given a wrong network" do
    # There is nothing to prefix WITH. Leaving the bare key standing means it
    # matches nothing and the conversation notifies — the fail-OPEN direction.
    # Inventing another subject's slug here would silence a room the operator
    # never muted.
    user = user_fixture()
    subject = {:user, user.id}
    :ok = seed_mutes(subject, %{"#linux" => %{"until" => nil}})

    run()

    assert stored_mutes(subject) == %{"#linux" => %{"until" => nil}}
  end

  test "does not reach across subjects — one subject's network never lands on another's mute" do
    subject_a = user_on("net-a")
    subject_b = user_on("net-b")

    :ok = seed_mutes(subject_a, %{"#shared" => %{"until" => nil}})
    :ok = seed_mutes(subject_b, %{"#shared" => %{"until" => nil}})

    run()

    assert stored_mutes(subject_a) == %{"net-a #shared" => %{"until" => nil}}
    assert stored_mutes(subject_b) == %{"net-b #shared" => %{"until" => nil}}
  end

  test "a VISITOR subject is rewritten too, off its own credential" do
    # `user_settings` is subject-polymorphic (XOR FK). A visitor-blind
    # predicate would silently skip every visitor's mutes — the same
    # subject-blind-reader class the XOR-FK audit calls out.
    {visitor, network} = visitor_with_network(6667)
    subject = {:visitor, visitor.id}
    :ok = seed_mutes(subject, %{"#linux" => %{"until" => nil}})

    run()

    assert stored_mutes(subject) == %{"#{network.slug} #linux" => %{"until" => nil}}
  end

  test "an empty mute map is untouched and does not become null" do
    subject = user_on("azzurra")
    :ok = seed_mutes(subject, %{})

    run()

    assert stored_mutes(subject) == %{}
  end

  test "a subject with no notification_prefs at all is untouched" do
    subject = user_on("azzurra")
    {:ok, settings} = UserSettings.get_or_init(subject)
    {:ok, _} = settings |> Settings.changeset(%{data: %{"theme" => "amber"}}) |> Repo.update()

    run()

    {:ok, reloaded} = UserSettings.get_or_init(subject)
    assert reloaded.data == %{"theme" => "amber"}
  end
end
