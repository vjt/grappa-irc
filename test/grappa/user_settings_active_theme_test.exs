defmodule Grappa.UserSettingsActiveThemeTest do
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures, only: [user_fixture: 0]

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
end
