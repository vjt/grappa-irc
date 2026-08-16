defmodule Grappa.Themes.Wire do
  @moduledoc """
  Single source of truth for the public wire shape of a `Grappa.Themes.Theme`.

  Three doors emit this contract: the gallery + owned listings and the single
  `GET /themes/:id` read (`GrappaWeb.ThemesController`) and the resolved active
  theme (`GrappaWeb.MeThemeController`). Same discipline as
  `Grappa.QueryWindows.Wire` / `Grappa.Scrollback.Wire` — the context owns the
  conversion so controllers stay thin and no raw `%Theme{}` struct crosses the
  wire (its storage shape ≠ its wire shape).

  The wire adds three derived, non-stored fields:

    * `built_in` — the theme is owned by the reserved system user (a curated
      seed, read-only for non-admins). A visitor-owned theme is never built_in.
    * `mine` — the requesting subject owns this theme (drives the cic
      edit/delete affordances). True for the owning user OR the owning visitor.
    * `in_use` — how many subjects currently have this theme active (#299 item
      9 — the real usage metric, distinct from the copy-only `apply_count`).
      The context reader populates it on the `%Theme{}`; 0 if unpopulated.

  `author` (#299 amendment, model A) prefers the theme's stored `author_nick`
  snapshot whenever present — the publishing visitor's representative nick,
  captured at publish time and surviving reap + system re-home (so a re-homed
  row credits the original nick, NOT "system"). With no snapshot it falls back
  to the owning user's name (user themes) or the fixed `"guest"` label (legacy
  / never-published visitor themes). vjt accepted the impersonation caveat: a
  visitor may publish under any nick they hold. `built_in` stays a pure
  ownership predicate (system user) — decoupled from `author`.

  `in_use` (#299 item 9) is a derived, CONTEXT-SUPPLIED count — how many
  subjects currently have this theme active — passed in by the caller rather
  than stored on the struct (a virtual field populated post-query over a list
  doesn't type cleanly, and the count is `Grappa.UserSettings`' domain). List
  callers fetch `Themes.active_theme_counts/0` once; single callers use
  `Themes.count_theme_usage/1`.

  `to_wire/3` requires the `:user` association preloaded (every context reader
  preloads it). For a visitor-owned theme `:user` is `nil` (XOR guarantees
  `visitor_id` is set); `author`/`built_in` derive from that.
  """

  alias Grappa.Accounts.User
  alias Grappa.Themes
  alias Grappa.Themes.Theme
  alias Grappa.Themes.TokenModel
  alias Grappa.Visitors.Visitor

  # #299 author model A — the fallback attribution label, used only when a
  # theme carries no `author_nick` snapshot (legacy / never-published visitor
  # themes). A closed constant.
  @guest_author "guest"

  @typedoc """
  The closed font-family vocabulary, re-exported from
  `Grappa.Themes.TokenModel` so it reaches the codegen (#1406 X-S9).

  `token_model.ex` is not a `*wire.ex` file, so nothing under
  `@wire_glob` used to see the vocabulary and cic transcribed it by hand
  (`themesApi.ts`, four "mirror of …" comments and no gate). Naming the type
  HERE — at the wire boundary that already publishes the payload it belongs to
  — makes `mix grappa.gen_wire_types` emit it as a generated const, and the
  `--check` drift gate then guards a copy nobody has to remember to update.
  """
  @type font_family :: TokenModel.font_family()

  @typedoc "The closed background sizing modes (#294), re-exported per `font_family/0`."
  @type background_size :: TokenModel.size_mode()

  # `Grappa.Themes.BuiltinBackgrounds.t/0` is DELIBERATELY not re-exported here,
  # and `GET /themes/backgrounds` therefore still has no generated counterpart.
  # Measured on #1406: the codegen cannot render it. `t/0` carries
  # `variant: variant()`, a same-module `user_type`, and the EXTERNAL-type path
  # renders one type at a time with no sibling registry — so the types half
  # emits `variant: Variant` (the `camelize` fallback, a name nothing declares:
  # `TS2304`) while the schema half imports `THEMES_BUILTIN_BACKGROUNDS_VARIANT`
  # (`TS2724`), a const neither half emits. The two emitters disagree, and the
  # failure lands on the CLIENT compiler rather than on the generator.
  # `gen_wire_types.ex`'s own comment rules out teaching the external path to
  # resolve refs, so the fix is the emitter's to make (fail loudly first), not
  # a shape restated here — a hand copy of the four fields would reintroduce
  # exactly the twin this issue removes.

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
          in_use: non_neg_integer(),
          mine: boolean(),
          # The sanitized closed-token map (`Grappa.Themes.TokenModel.token_map()`
          # — string-keyed: `"colors"` / `"font_family"` / `"background"`). Typed
          # as an open string-keyed map, NOT a bare `map()`, so the wire codegen
          # emits `Record<string, unknown>` (a bare `map()` would trip the
          # gen_wire_types "defeats codegen" warning for the same output). The
          # VALUE vocabularies are pinned separately, as `font_family/0` and
          # `background_size/0` above (#1406 X-S9); the 27 color KEYS stay
          # cic-owned in `themesApi.ts` and remain UNpinned.
          payload: %{optional(String.t()) => term()},
          inserted_at: String.t()
        }

  @doc "The fallback author label for a snapshot-less visitor theme (author model A)."
  @spec guest_author() :: String.t()
  def guest_author, do: @guest_author

  @doc """
  Render one `%Theme{}` (`:user` preloaded) to the wire shape, from `viewer`'s
  perspective (drives the derived `mine` flag), with the caller-supplied
  `in_use` active-usage count (#299 item 9).
  """
  @spec to_wire(Theme.t(), {:user, User.t()} | {:visitor, Visitor.t()} | nil, non_neg_integer()) ::
          t()
  def to_wire(%Theme{} = theme, viewer, in_use) when is_integer(in_use) do
    {author, built_in} = attribution(theme)

    %{
      id: theme.id,
      name: theme.name,
      author: author,
      built_in: built_in,
      published: theme.published,
      apply_count: theme.apply_count,
      in_use: in_use,
      mine: mine?(theme, viewer),
      payload: theme.payload,
      inserted_at: DateTime.to_iso8601(theme.inserted_at)
    }
  end

  # #299 author model A: author prefers the stored publish-time nick snapshot
  # whenever present (so it survives reap + system re-home — a now-system-owned
  # row still credits the visitor's nick), else the owning user's name, else
  # the fixed guest label. `built_in` is a pure ownership predicate (system
  # user), decoupled from `author` — a re-homed row is built_in AND
  # nick-credited.
  defp attribution(%Theme{} = theme), do: {author_label(theme), built_in?(theme)}

  defp author_label(%Theme{author_nick: nick}) when is_binary(nick) and nick != "", do: nick
  defp author_label(%Theme{user: %User{name: name}}), do: name
  defp author_label(%Theme{user: nil}), do: @guest_author

  defp built_in?(%Theme{user: %User{name: name}}), do: name == Themes.system_user_name()
  defp built_in?(%Theme{user: nil}), do: false

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
