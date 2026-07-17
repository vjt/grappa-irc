defmodule Grappa.Themes.Wire do
  @moduledoc """
  Single source of truth for the public wire shape of a `Grappa.Themes.Theme`.

  Three doors emit this contract: the gallery + owned listings and the single
  `GET /themes/:id` read (`GrappaWeb.ThemesController`) and the resolved active
  theme (`GrappaWeb.MeThemeController`). Same discipline as
  `Grappa.QueryWindows.Wire` / `Grappa.Scrollback.Wire` — the context owns the
  conversion so controllers stay thin and no raw `%Theme{}` struct crosses the
  wire (its storage shape ≠ its wire shape).

  The wire adds two viewer-derived, non-stored fields:

    * `built_in` — the theme is owned by the reserved system user (a curated
      seed, read-only for non-admins).
    * `mine` — the requesting subject owns this theme (drives the cic
      edit/delete affordances).

  `to_wire/2` requires the `:owner` association preloaded (every context reader
  preloads it); `author` and `built_in` both derive from it.
  """

  alias Grappa.Accounts.User
  alias Grappa.Themes
  alias Grappa.Themes.Theme
  alias Grappa.Visitors.Visitor

  @typedoc "The rich viewer subject (as carried in `conn.assigns.current_subject`)."
  @type viewer :: {:user, User.t()} | {:visitor, Visitor.t()} | nil

  @type t :: %{
          id: integer(),
          name: String.t(),
          author: String.t(),
          built_in: boolean(),
          published: boolean(),
          apply_count: integer(),
          mine: boolean(),
          payload: map(),
          inserted_at: String.t()
        }

  @doc """
  Render one `%Theme{}` (owner preloaded) to the wire shape, from `viewer`'s
  perspective (drives the derived `mine` flag).
  """
  @spec to_wire(Theme.t(), viewer()) :: t()
  def to_wire(%Theme{owner: %User{} = owner} = theme, viewer) do
    %{
      id: theme.id,
      name: theme.name,
      author: owner.name,
      built_in: owner.name == Themes.system_user_name(),
      published: theme.published,
      apply_count: theme.apply_count,
      mine: mine?(theme, viewer),
      payload: theme.payload,
      inserted_at: DateTime.to_iso8601(theme.inserted_at)
    }
  end

  # A theme is `mine` only for the user who owns it — visitors own nothing.
  defp mine?(%Theme{owner_id: owner_id}, {:user, %User{id: owner_id}}), do: true
  defp mine?(%Theme{}, _viewer), do: false
end
