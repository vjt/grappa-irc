defmodule Grappa.UserSettingsCommandCountsTest do
  @moduledoc """
  Issue 2584 — the per-subject command-use counts behind cic's `/` menu
  ("most used first"). One `"command_counts"` key in `user_settings.data`,
  `%{verb => count}`, incremented on send and read by every device of the
  account at its next (re)join.

  The verb is cic's to name (it owns DISPATCH and the user's aliases), so the
  server holds only the SHAPE: the same rule alias names follow, and a
  ceiling on distinct verbs.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.{Repo, UserSettings}
  alias Grappa.UserSettings.Settings

  defp store_raw(subject, data) do
    {:ok, settings} = UserSettings.get_or_init(subject)
    Repo.update!(Settings.changeset(settings, %{data: data}))
  end

  describe "get_command_counts/1" do
    test "returns %{} when no settings row exists" do
      assert UserSettings.get_command_counts({:user, Ecto.UUID.generate()}) == %{}
    end

    test "returns %{} when the row exists without the key" do
      user = user_fixture()
      {:ok, _} = UserSettings.get_or_init({:user, user.id})
      assert UserSettings.get_command_counts({:user, user.id}) == %{}
    end

    test "returns %{} when the stored value is not a map" do
      user = user_fixture()
      store_raw({:user, user.id}, %{"command_counts" => ["whois", 3]})
      assert UserSettings.get_command_counts({:user, user.id}) == %{}
    end

    test "keeps only verb => positive-integer entries" do
      user = user_fixture()

      store_raw({:user, user.id}, %{
        "command_counts" => %{"whois" => 2, "zero" => 0, "neg" => -1, "text" => "3", "float" => 1.5}
      })

      assert UserSettings.get_command_counts({:user, user.id}) == %{"whois" => 2}
    end
  end

  describe "increment_command_count/2" do
    test "the first use counts 1 and is persisted" do
      user = user_fixture()

      assert {:ok, %{"whois" => 1}} = UserSettings.increment_command_count({:user, user.id}, "whois")
      assert UserSettings.get_command_counts({:user, user.id}) == %{"whois" => 1}
    end

    test "every further use adds one" do
      user = user_fixture()
      {:ok, _} = UserSettings.increment_command_count({:user, user.id}, "whois")
      {:ok, _} = UserSettings.increment_command_count({:user, user.id}, "whois")

      assert {:ok, %{"whois" => 3}} = UserSettings.increment_command_count({:user, user.id}, "whois")
    end

    test "answers the WHOLE map, not just the verb it counted" do
      user = user_fixture()
      {:ok, _} = UserSettings.increment_command_count({:user, user.id}, "join")

      assert {:ok, counts} = UserSettings.increment_command_count({:user, user.id}, "whois")
      assert counts == %{"join" => 1, "whois" => 1}
    end

    test "the verb is trimmed and lowercased, so WHOIS and whois are one entry" do
      user = user_fixture()
      {:ok, _} = UserSettings.increment_command_count({:user, user.id}, "WHOIS")

      assert {:ok, counts} = UserSettings.increment_command_count({:user, user.id}, "  whois ")
      assert counts == %{"whois" => 2}
    end

    test "rejects an empty verb on the command_counts field, and stores nothing" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{} = cs} = UserSettings.increment_command_count({:user, user.id}, "   ")
      assert %{command_counts: ["command verb must not be empty"]} = errors_on(cs)
      assert UserSettings.get_command_counts({:user, user.id}) == %{}
    end

    test "rejects a verb containing whitespace" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{} = cs} =
               UserSettings.increment_command_count({:user, user.id}, "who is")

      assert %{command_counts: ["command verb must not contain whitespace"]} = errors_on(cs)
    end

    test "takes a verb of 32 bytes and rejects one of 33" do
      user = user_fixture()
      at_limit = String.duplicate("a", 32)

      assert {:ok, %{^at_limit => 1}} = UserSettings.increment_command_count({:user, user.id}, at_limit)

      assert {:error, %Ecto.Changeset{} = cs} =
               UserSettings.increment_command_count({:user, user.id}, at_limit <> "a")

      assert %{command_counts: ["command verb too long (max 32 bytes)"]} = errors_on(cs)
    end

    test "at 512 distinct verbs a NEW verb is refused, and the counts stay as they were" do
      user = user_fixture()
      full = Map.new(1..512, fn n -> {"v#{n}", 1} end)
      store_raw({:user, user.id}, %{"command_counts" => full})

      assert {:error, %Ecto.Changeset{} = cs} = UserSettings.increment_command_count({:user, user.id}, "whois")
      assert %{command_counts: ["too many distinct command verbs (max 512)"]} = errors_on(cs)
      assert UserSettings.get_command_counts({:user, user.id}) == full
    end

    test "at 512 distinct verbs a verb already counted still counts" do
      user = user_fixture()
      store_raw({:user, user.id}, %{"command_counts" => Map.new(1..512, fn n -> {"v#{n}", 1} end)})

      assert {:ok, %{"v7" => 2}} = UserSettings.increment_command_count({:user, user.id}, "v7")
    end

    test "leaves the other data keys alone" do
      user = user_fixture()
      {:ok, _} = UserSettings.set_aliases({:user, user.id}, %{"wii" => "whois $1 $1"})

      {:ok, _} = UserSettings.increment_command_count({:user, user.id}, "wii")
      assert UserSettings.get_aliases({:user, user.id}) == %{"wii" => "whois $1 $1"}
    end

    test "a visitor has counts of its own, apart from any user's" do
      user = user_fixture()
      visitor = visitor_fixture()
      {:ok, _} = UserSettings.increment_command_count({:user, user.id}, "join")

      assert {:ok, %{"whois" => 1} = counts} = UserSettings.increment_command_count({:visitor, visitor.id}, "whois")
      refute Map.has_key?(counts, "join")
      assert UserSettings.get_command_counts({:user, user.id}) == %{"join" => 1}
    end
  end
end
