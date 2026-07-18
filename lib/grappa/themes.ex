defmodule Grappa.Themes do
  @moduledoc """
  Themes context — the customizable/shareable theme gallery (#75).

  ## Data model (KISS, vjt)

  Every theme is an INDEPENDENT FULL COPY. Picking a gallery theme copies it
  into your account; editing touches only your copy; publishing pushes your copy
  into the gallery for others to copy. There is no copy-on-write, no shared
  storage, no reference counter that gates lifecycle — deleting a copy can never
  affect anyone else.

  ## Subjects (#299 item 8 — visitors are first-class producers)

  A theme belongs to EITHER a user OR a visitor (`user_id` XOR `visitor_id`,
  the same shape as `user_settings`). Visitors may create / copy / edit /
  publish / keep their own themes exactly like users — with two guards: the
  shared daily quota AND a 50-total owned-theme cap (users have no lifetime
  cap). A reaped visitor's PUBLISHED themes re-home to the system user
  (`rehome_visitor_published_to_system/1`) so gallery contributions survive;
  private ones die with the row. A visitor-owned theme is attributed to a
  FIXED "guest" label on the wire — NEVER a nick (author model B: no
  impersonation surface).

  ## Authz (owner-or-admin, in the context — one code path, every door)

    * `admin` may edit/delete ANY theme (moderation).
    * `owner` (the user OR visitor whose subject FK the theme carries) may
      edit/delete/publish their own.
    * anyone may browse the gallery + copy.
    * built-ins are read-only: they are owned by the reserved `"system"` user,
      and no logged-in non-admin/non-owner can be that owner, so the generic
      owner-or-admin check refuses them without a special case.

  The authz-bearing functions take the RICH subject
  `{:user, %User{}} | {:visitor, %Visitor{}}` (the controller's
  `conn.assigns.current_subject`) because the check needs both the caller's id
  and their `is_admin` bit.
  """
  use Boundary,
    top_level?: true,
    deps: [
      Grappa.Accounts,
      Grappa.Net.Ssrf,
      Grappa.RateLimit,
      Grappa.Repo,
      Grappa.Subject,
      Grappa.Sys.HardenedCmd,
      Grappa.Uploads,
      Grappa.UserSettings
    ],
    dirty_xrefs: [Grappa.Visitors.Visitor],
    exports: [Theme, TokenModel, Wire]

  import Ecto.Query

  alias Grappa.{
    Accounts.User,
    RateLimit.DailyQuota,
    Repo,
    Subject,
    Themes.BackgroundImage,
    Themes.BuiltinBackgrounds,
    Themes.Builtins,
    Themes.Theme,
    UserSettings,
    Visitors.Visitor
  }

  @system_user_name "system"
  @daily_quota Application.compile_env(:grappa, [:themes, :daily_quota], 5)
  @quota_bucket :theme_create

  # #299 item 8 — total owned-theme cap for VISITORS only (users are
  # unchanged: they keep the daily quota, no lifetime cap). The daily quota
  # bounds burst; this bounds the lifetime storage a single anon identity can
  # accumulate. Mirror of the per-IP session cap discipline.
  @visitor_theme_cap 50

  @typedoc "Rich subject as carried in `conn.assigns.current_subject`."
  @type subject :: {:user, User.t()} | {:visitor, Visitor.t()}

  @doc "The reserved user name that owns built-in themes."
  @spec system_user_name() :: String.t()
  def system_user_name, do: @system_user_name

  @doc "The seeded system user that owns built-in themes (always present)."
  @spec system_user() :: User.t()
  def system_user, do: Repo.get_by!(User, name: @system_user_name)

  @doc """
  The curated built-in background catalog (#294) — the picker's server-owned
  vocabulary. Static assets served by nginx at `/backgrounds/<key>.webp`; this
  is the metadata + the closed key set the sanitizer validates against.
  """
  @spec builtin_backgrounds() :: [BuiltinBackgrounds.t()]
  defdelegate builtin_backgrounds(), to: BuiltinBackgrounds, as: :all

  @doc "Gallery listing — published themes (built-ins ship published), most-copied first."
  @spec list_gallery() :: [Theme.t()]
  def list_gallery do
    Theme
    |> where([t], t.published == true)
    |> order_by([t], desc: t.apply_count, asc: t.name)
    |> preload(:user)
    |> Repo.all()
  end

  @doc "The caller's own theme library (users AND visitors, #299 item 8)."
  @spec list_owned(subject()) :: [Theme.t()]
  def list_owned({:user, %User{id: user_id}}), do: owned_query({:user, user_id})
  def list_owned({:visitor, %Visitor{id: visitor_id}}), do: owned_query({:visitor, visitor_id})

  defp owned_query(bare_subject) do
    Theme
    |> Subject.subject_where(bare_subject)
    |> order_by([t], asc: t.name)
    |> preload(:user)
    |> Repo.all()
  end

  @doc """
  Unpublished, system-owned built-ins — visible ONLY to admins (#299). This is
  the moderation surface that un-strands a built-in that was unpublished: a
  stranded built-in has no owner-UI path (the system user has no session),
  unlike a user's own unpublished theme which the owner sees via `list_owned/1`
  and can re-publish from there. Non-admins get `[]` — nothing is stranded from
  their view (their own drafts ride `list_owned/1`). Re-publishing reuses the
  existing owner-or-admin `publish_theme/2` verb; this is just the read.
  """
  @spec list_unpublished_builtins(subject()) :: [Theme.t()]
  def list_unpublished_builtins({:user, %User{is_admin: true}}) do
    system_id = system_user().id

    Theme
    |> where([t], t.user_id == ^system_id and t.published == false)
    |> order_by([t], asc: t.name)
    |> preload(:user)
    |> Repo.all()
  end

  def list_unpublished_builtins(_), do: []

  @doc "Fetch one theme by id (public read — share-link target), :user preloaded."
  @spec get_theme(integer()) :: {:ok, Theme.t()} | {:error, :not_found}
  def get_theme(id) when is_integer(id) do
    case Repo.get(Theme, id) do
      nil -> {:error, :not_found}
      %Theme{} = theme -> {:ok, Repo.preload(theme, :user)}
    end
  end

  @doc """
  Save a new theme owned by the caller (user OR visitor, #299 item 8).
  Rate-limited (~5/day, both subjects); visitors additionally hit the 50-total
  owned-theme cap.
  """
  @spec create_theme(subject(), map()) ::
          {:ok, Theme.t()}
          | {:error, :rate_limited | :theme_cap_reached | Ecto.Changeset.t()}
  def create_theme({:user, %User{id: id}} = subject, attrs) when is_map(attrs),
    do: do_create(subject, {:user, id}, attrs)

  def create_theme({:visitor, %Visitor{id: id}} = subject, attrs) when is_map(attrs),
    do: do_create(subject, {:visitor, id}, attrs)

  defp do_create(subject, bare_subject, attrs) do
    changeset = Theme.changeset(%Theme{}, Subject.put_subject_id(attrs, bare_subject))

    # Validate BEFORE the cap/quota gates so a malformed request never burns a
    # quota slot. Cap first (a pure count), quota last (it RECORDS on success)
    # — hitting the cap must not consume a daily slot.
    if changeset.valid? do
      with :ok <- check_cap(subject),
           :ok <- check_quota(subject) do
        Repo.insert(changeset)
      end
    else
      {:error, changeset}
    end
  end

  @doc "Edit a theme (owner or admin)."
  @spec update_theme(subject(), integer(), map()) ::
          {:ok, Theme.t()} | {:error, :not_found | :forbidden | Ecto.Changeset.t()}
  def update_theme(subject, id, attrs) when is_integer(id) and is_map(attrs) do
    with {:ok, theme} <- get_theme(id),
         :ok <- authorize(subject, theme) do
      theme |> Theme.changeset(attrs) |> Repo.update()
    end
  end

  @doc "Delete a theme (owner or admin)."
  @spec delete_theme(subject(), integer()) :: :ok | {:error, :not_found | :forbidden}
  def delete_theme(subject, id) when is_integer(id) do
    with {:ok, theme} <- get_theme(id),
         :ok <- authorize(subject, theme),
         {:ok, _} <- Repo.delete(theme) do
      :ok
    end
  end

  @doc "Publish a theme into the gallery (owner or admin)."
  @spec publish_theme(subject(), integer()) ::
          {:ok, Theme.t()} | {:error, :not_found | :forbidden}
  def publish_theme(subject, id), do: set_published(subject, id, true)

  @doc "Remove a theme from the gallery listing (owner or admin)."
  @spec unpublish_theme(subject(), integer()) ::
          {:ok, Theme.t()} | {:error, :not_found | :forbidden}
  def unpublish_theme(subject, id), do: set_published(subject, id, false)

  @doc """
  Copy a theme (any readable theme, by id) into the caller's account as a new
  independent owned theme (user OR visitor, #299 item 8; rate-limited, visitor
  cap-gated). Bumps the SOURCE's `apply_count` — the copy-popularity metric.
  The copy carries no back-reference to its source.
  """
  @spec copy_theme(subject(), integer()) ::
          {:ok, Theme.t()}
          | {:error, :not_found | :rate_limited | :theme_cap_reached}
  def copy_theme({:user, %User{id: id}} = subject, theme_id) when is_integer(theme_id),
    do: do_copy(subject, {:user, id}, theme_id)

  def copy_theme({:visitor, %Visitor{id: id}} = subject, theme_id) when is_integer(theme_id),
    do: do_copy(subject, {:visitor, id}, theme_id)

  defp do_copy(subject, bare_subject, theme_id) do
    with {:ok, source} <- get_theme(theme_id),
         :ok <- check_cap(subject),
         :ok <- check_quota(subject) do
      Repo.transaction(fn ->
        name = available_name(bare_subject, source.name)

        attrs = Subject.put_subject_id(%{name: name, payload: source.payload}, bare_subject)

        copy =
          %Theme{}
          |> Theme.changeset(attrs)
          |> Repo.insert!()

        {1, _} =
          Theme
          |> where([t], t.id == ^source.id)
          |> Repo.update_all(inc: [apply_count: 1])

        copy
      end)
    end
  end

  @doc """
  Resolve the subject's active theme (server-persisted per-subject pointer,
  cross-device — #75 fork-1). Returns `nil` when no pointer is set OR the
  pointer dangles (theme deleted / unpublished-and-gone) — the caller (cic)
  falls back to its built-in default look. Takes the bare-id subject tuple
  (`Grappa.UserSettings` scope shape).
  """
  @spec get_active_theme(Subject.t()) :: Theme.t() | nil
  def get_active_theme(subject) do
    case UserSettings.get_active_theme_id(subject) do
      nil ->
        nil

      id ->
        case get_theme(id) do
          {:ok, theme} -> theme
          {:error, :not_found} -> nil
        end
    end
  end

  @doc """
  Point the subject at `id` as their active theme. Any readable theme (every
  theme is public by id — share-link target) is a valid target; the pointer is
  only stored once the theme is confirmed to exist, so a bad id never persists.
  Takes the bare-id subject tuple.
  """
  @spec set_active_theme(Subject.t(), integer()) ::
          {:ok, Theme.t()} | {:error, :not_found | Ecto.Changeset.t()}
  def set_active_theme(subject, id) when is_integer(id) do
    with {:ok, theme} <- get_theme(id),
         {:ok, _} <- UserSettings.put_active_theme_id(subject, id) do
      {:ok, theme}
    end
  end

  @doc """
  Run a background-image source through the re-encode + re-host pipeline and
  return the uploads slug for storing in a theme payload's `background.image_id`.
  The context is the door — controllers call this, never the sub-module. Takes
  the bare-id subject tuple (`Grappa.Uploads` scope shape).
  """
  @spec store_background(Subject.t(), BackgroundImage.source()) ::
          {:ok, String.t()} | {:error, BackgroundImage.error()}
  def store_background(subject, source) do
    BackgroundImage.process_and_store(subject, source)
  end

  @doc """
  Materialise the curated built-in gallery (`Grappa.Themes.Builtins.all/0`) as
  system-owned, published themes. Idempotent: upserts by the partial
  `(user_id, name) WHERE user_id IS NOT NULL` unique index, so a re-run
  refreshes the payload in place rather than duplicating rows (drives the
  re-runnable `mix grappa.seed_themes`). Returns the number of built-ins seeded.
  """
  @spec seed_builtins() :: non_neg_integer()
  def seed_builtins do
    system_id = system_user().id
    builtins = Builtins.all()

    Enum.each(builtins, fn %{name: name, payload: payload} ->
      attrs =
        Subject.put_subject_id(%{name: name, payload: payload, published: true}, {:user, system_id})

      %Theme{}
      |> Theme.changeset(attrs)
      |> Repo.insert!(
        on_conflict: {:replace, [:payload, :published, :updated_at]},
        # Partial index → the conflict target MUST carry the same WHERE
        # predicate, char-identical to the migration index, or SQLite won't
        # match it (see CLAUDE.md: `:unsafe_fragment` conflict target rule).
        conflict_target: {:unsafe_fragment, "(user_id, name) WHERE user_id IS NOT NULL"}
      )
    end)

    length(builtins)
  end

  @doc """
  Re-home a reaped visitor's PUBLISHED themes to the system user so their
  gallery contributions survive the visitor's deletion (#299). The visitor's
  PRIVATE themes are left untouched — they die with the row via the
  `visitor_id ON DELETE CASCADE`. Called from `Grappa.Visitors` at the single
  hard-delete choke point BEFORE `Repo.delete(visitor)` (so re-homed rows no
  longer carry `visitor_id` and escape the CASCADE).

  Author model B (vjt-locked): a re-homed theme becomes system-owned, so the
  wire renders it as a built-in — the visitor's nick is NEVER surfaced (no
  anchor-nick, no impersonation). Each re-homed name is de-duplicated against
  the system user's existing names (a visitor may have published a theme named
  identically to a built-in), reusing the same suffixing as copy. Returns the
  number of themes re-homed.
  """
  @spec rehome_visitor_published_to_system(Ecto.UUID.t()) :: non_neg_integer()
  def rehome_visitor_published_to_system(visitor_id) when is_binary(visitor_id) do
    system_id = system_user().id

    themes =
      Theme
      |> where([t], t.visitor_id == ^visitor_id and t.published == true)
      |> Repo.all()

    Enum.each(themes, fn theme ->
      name = available_name({:user, system_id}, theme.name)

      theme
      |> Ecto.Changeset.change(user_id: system_id, visitor_id: nil, name: name)
      |> Repo.update!()
    end)

    length(themes)
  end

  ## Internals

  defp set_published(subject, id, value) when is_integer(id) and is_boolean(value) do
    with {:ok, theme} <- get_theme(id),
         :ok <- authorize(subject, theme) do
      theme |> Ecto.Changeset.change(published: value) |> Repo.update()
    end
  end

  # Admin: any. Owner: own (user OR visitor, #299 item 8). Everyone else
  # (non-owners, and every non-admin against a system-owned built-in): forbidden.
  defp authorize({:user, %User{is_admin: true}}, %Theme{}), do: :ok
  defp authorize({:user, %User{id: id}}, %Theme{user_id: id}), do: :ok
  defp authorize({:visitor, %Visitor{id: id}}, %Theme{visitor_id: id}), do: :ok
  defp authorize(_, %Theme{}), do: {:error, :forbidden}

  # Daily creation quota — applies to BOTH subjects (~5/day burst bound).
  defp check_quota({:user, %User{id: id}}),
    do: DailyQuota.check_and_record(@quota_bucket, {:user, id}, @daily_quota)

  defp check_quota({:visitor, %Visitor{id: id}}),
    do: DailyQuota.check_and_record(@quota_bucket, {:visitor, id}, @daily_quota)

  # Total owned-theme cap — VISITORS only (users are unchanged: no lifetime
  # cap). Pure count, no side effect — runs before the quota so a capped
  # visitor never burns a daily slot.
  defp check_cap({:user, %User{}}), do: :ok

  defp check_cap({:visitor, %Visitor{id: id}}) do
    count =
      Theme
      |> where([t], t.visitor_id == ^id)
      |> Repo.aggregate(:count, :id)

    if count >= @visitor_theme_cap, do: {:error, :theme_cap_reached}, else: :ok
  end

  # Find a free name in the caller's library: the base, else "base (2)", …
  # (partial unique index is (subject_id, name); dedup avoids clashing on
  # re-copy / re-home). Takes the bare subject tuple.
  defp available_name(bare_subject, base) do
    taken =
      Theme
      |> Subject.subject_where(bare_subject)
      |> select([t], t.name)
      |> Repo.all()
      |> MapSet.new()

    if MapSet.member?(taken, base), do: first_free_suffix(base, taken), else: base
  end

  defp first_free_suffix(base, taken) do
    Enum.find_value(2..999, base, fn n ->
      candidate = "#{base} (#{n})"
      if MapSet.member?(taken, candidate), do: nil, else: candidate
    end)
  end
end
