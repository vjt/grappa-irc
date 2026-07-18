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
      seed, read-only for non-admins). A visitor-owned theme is never built_in.
    * `mine` — the requesting subject owns this theme (drives the cic
      edit/delete affordances). True for the owning user OR the owning visitor.

  `author` is the owning user's name for a user-owned theme, and a FIXED
  `"guest"` label for a visitor-owned theme — #299 author model B: a visitor's
  nick is NEVER surfaced (no impersonation surface, no anchor-nick).

  `to_wire/2` requires the `:user` association preloaded (every context reader
  preloads it). For a visitor-owned theme `:user` is `nil` (XOR guarantees
  `visitor_id` is set); `author`/`built_in` derive from that.
  """

  alias Grappa.Accounts.User
  alias Grappa.Themes
  alias Grappa.Themes.Theme
  alias Grappa.Visitors.Visitor

  # #299 author model B — the fixed attribution label for a visitor-owned
  # theme. A closed constant, never a nick.
  @guest_author "guest"

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

  @doc "The fixed author label for a visitor-owned theme (author model B)."
  @spec guest_author() :: String.t()
  def guest_author, do: @guest_author

  @doc """
  Render one `%Theme{}` (`:user` preloaded) to the wire shape, from `viewer`'s
  perspective (drives the derived `mine` flag).
  """
  @spec to_wire(Theme.t(), {:user, User.t()} | {:visitor, Visitor.t()} | nil) :: t()
  def to_wire(%Theme{} = theme, viewer) do
    {author, built_in} = attribution(theme)

    %{
      id: theme.id,
      name: theme.name,
      author: author,
      built_in: built_in,
      published: theme.published,
      apply_count: theme.apply_count,
      mine: mine?(theme, viewer),
      payload: theme.payload,
      inserted_at: DateTime.to_iso8601(theme.inserted_at)
    }
  end

  # User-owned: the user's name; built_in iff the system user. Visitor-owned
  # (`:user` is nil — XOR guarantees `visitor_id` set): the fixed guest label,
  # never built_in, NEVER the visitor's nick (author model B).
  defp attribution(%Theme{user: %User{} = user}),
    do: {user.name, user.name == Themes.system_user_name()}

  defp attribution(%Theme{user: nil}), do: {@guest_author, false}

  # A theme is `mine` for the user OR visitor whose subject FK it carries. The
  # `is_binary` guard prevents a nil FK (the other subject branch) from
  # unifying with a nil viewer id in the degenerate case.
  defp mine?(%Theme{user_id: user_id}, {:user, %User{id: user_id}}) when is_binary(user_id),
    do: true

  defp mine?(%Theme{visitor_id: visitor_id}, {:visitor, %Visitor{id: visitor_id}})
       when is_binary(visitor_id),
       do: true

  defp mine?(%Theme{}, _), do: false
end
