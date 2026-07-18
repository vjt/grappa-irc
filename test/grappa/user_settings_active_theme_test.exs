defmodule Grappa.UserSettingsActiveThemeTest do
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures, only: [user_fixture: 0, visitor_fixture: 0]

  alias Grappa.UserSettings

  setup do
    user = user_fixture()
    {:ok, subject: {:user, user.id}}
  end

  test "returns nil when no active theme is set", %{subject: subject} do
    assert UserSettings.get_active_theme_id(subject) == nil
  end

  test "round-trips a positive theme id", %{subject: subject} do
    assert {:ok, _} = UserSettings.put_active_theme_id(subject, 42)
    assert UserSettings.get_active_theme_id(subject) == 42
  end

  test "clears the active theme with nil", %{subject: subject} do
    {:ok, _} = UserSettings.put_active_theme_id(subject, 7)
    {:ok, _} = UserSettings.put_active_theme_id(subject, nil)
    assert UserSettings.get_active_theme_id(subject) == nil
  end

  test "rejects a non-positive id", %{subject: subject} do
    assert {:error, %Ecto.Changeset{}} = UserSettings.put_active_theme_id(subject, 0)
    assert {:error, %Ecto.Changeset{}} = UserSettings.put_active_theme_id(subject, -3)
  end

  test "preserves other settings keys on write", %{subject: subject} do
    {:ok, _} = UserSettings.set_highlight_patterns(subject, ["foo"])
    {:ok, _} = UserSettings.put_active_theme_id(subject, 3)

    assert UserSettings.get_highlight_patterns(subject) == ["foo"]
    assert UserSettings.get_active_theme_id(subject) == 3
  end

  describe "active-theme usage counts (#299 item 9)" do
    test "count_active_theme_users counts subjects (users AND visitors) with the theme active" do
      u1 = user_fixture()
      u2 = user_fixture()
      visitor = visitor_fixture()
      other = user_fixture()

      {:ok, _} = UserSettings.put_active_theme_id({:user, u1.id}, 42)
      {:ok, _} = UserSettings.put_active_theme_id({:user, u2.id}, 42)
      {:ok, _} = UserSettings.put_active_theme_id({:visitor, visitor.id}, 42)
      {:ok, _} = UserSettings.put_active_theme_id({:user, other.id}, 99)

      assert UserSettings.count_active_theme_users(42) == 3
      assert UserSettings.count_active_theme_users(99) == 1
      assert UserSettings.count_active_theme_users(7) == 0
    end

    test "count excludes subjects who cleared their active theme" do
      user = user_fixture()
      {:ok, _} = UserSettings.put_active_theme_id({:user, user.id}, 42)
      {:ok, _} = UserSettings.put_active_theme_id({:user, user.id}, nil)
      assert UserSettings.count_active_theme_users(42) == 0
    end

    test "active_theme_counts returns a theme_id => count map, excluding unset rows" do
      u1 = user_fixture()
      u2 = user_fixture()
      u3 = user_fixture()

      {:ok, _} = UserSettings.put_active_theme_id({:user, u1.id}, 42)
      {:ok, _} = UserSettings.put_active_theme_id({:user, u2.id}, 42)
      {:ok, _} = UserSettings.put_active_theme_id({:user, u3.id}, 99)

      counts = UserSettings.active_theme_counts()
      assert counts[42] == 2
      assert counts[99] == 1
      refute Map.has_key?(counts, nil)
    end
  end
end
