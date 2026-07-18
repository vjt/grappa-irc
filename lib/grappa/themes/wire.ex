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

  `to_wire/2` requires the `:user` association preloaded (every context reader
  preloads it); `author` and `built_in` both derive from it.
  """

  alias Grappa.Accounts.User
  alias Grappa.Themes
  alias Grappa.Themes.Theme
  alias Grappa.Visitors.Visitor

  # The rich viewer subject (as carried in `conn.assigns.current_subject`) is
  # inlined into `to_wire/2`'s spec rather than exposed as a public `@type` — a
  # named type would make `grappa.gen_wire_types` emit a `ThemesWireViewer` TS
  # type that drags the full `User`/`Visitor` structs (password_hash included)
  # into the client wire-types file. Only `t/0` — the actual wire shape — is a
  # public type.
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
  @spec to_wire(Theme.t(), {:user, User.t()} | {:visitor, Visitor.t()} | nil) :: t()
  def to_wire(%Theme{user: %User{} = user} = theme, viewer) do
    %{
      id: theme.id,
      name: theme.name,
      author: user.name,
      built_in: user.name == Themes.system_user_name(),
      published: theme.published,
      apply_count: theme.apply_count,
      mine: mine?(theme, viewer),
      payload: theme.payload,
      inserted_at: DateTime.to_iso8601(theme.inserted_at)
    }
  end

  # A theme is `mine` only for the user who owns it — visitors own nothing (yet).
  defp mine?(%Theme{user_id: user_id}, {:user, %User{id: user_id}}), do: true
  defp mine?(%Theme{}, _), do: false
end
