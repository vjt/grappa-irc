defmodule Grappa.Themes do
  @moduledoc """
  Themes context — the customizable/shareable theme gallery (#75).

  ## Data model (KISS, vjt)

  Every theme is an INDEPENDENT FULL COPY. Picking a gallery theme copies it
  into your account; editing touches only your copy; publishing pushes your copy
  into the gallery for others to copy. There is no copy-on-write, no shared
  storage, no reference counter that gates lifecycle — deleting a copy can never
  affect anyone else.

  ## Authz (owner-or-admin, in the context — one code path, every door)

    * `admin` may edit/delete ANY theme (moderation).
    * `owner` may edit/delete their own.
    * anyone may browse the gallery + copy.
    * built-ins are read-only: they are owned by the reserved `"system"` user,
      and no logged-in non-admin can be that owner, so the generic
      owner-or-admin check refuses them without a special case.

  The authz-bearing functions take the RICH subject
  `{:user, %User{}} | {:visitor, %Visitor{}}` (the controller's
  `conn.assigns.current_subject`) because the check needs both the caller's id
  and their `is_admin` bit.
  """
  use Boundary,
    top_level?: true,
    deps: [Grappa.Accounts, Grappa.Net.Ssrf, Grappa.RateLimit, Grappa.Repo],
    dirty_xrefs: [Grappa.Visitors.Visitor],
    exports: [Theme, TokenModel]

  import Ecto.Query

  alias Grappa.Accounts.User
  alias Grappa.RateLimit.DailyQuota
  alias Grappa.Repo
  alias Grappa.Themes.Theme
  alias Grappa.Visitors.Visitor

  @system_user_name "system"
  @daily_quota Application.compile_env(:grappa, [:themes, :daily_quota], 5)
  @quota_bucket :theme_create

  @typedoc "Rich subject as carried in `conn.assigns.current_subject`."
  @type subject :: {:user, User.t()} | {:visitor, Visitor.t()}

  @doc "The reserved user name that owns built-in themes."
  @spec system_user_name() :: String.t()
  def system_user_name, do: @system_user_name

  @doc "The seeded system user that owns built-in themes (always present)."
  @spec system_user() :: User.t()
  def system_user, do: Repo.get_by!(User, name: @system_user_name)

  @doc "Gallery listing — published themes (built-ins ship published), most-copied first."
  @spec list_gallery() :: [Theme.t()]
  def list_gallery do
    Theme
    |> where([t], t.published == true)
    |> order_by([t], desc: t.apply_count, asc: t.name)
    |> Repo.all()
    |> Repo.preload(:owner)
  end

  @doc "The caller's own theme library. Visitors own nothing."
  @spec list_owned(subject()) :: [Theme.t()]
  def list_owned({:user, %User{id: user_id}}) do
    Theme
    |> where([t], t.owner_id == ^user_id)
    |> order_by([t], asc: t.name)
    |> Repo.all()
    |> Repo.preload(:owner)
  end

  def list_owned({:visitor, %Visitor{}}), do: []

  @doc "Fetch one theme by id (public read — share-link target), owner preloaded."
  @spec get_theme(integer()) :: {:ok, Theme.t()} | {:error, :not_found}
  def get_theme(id) when is_integer(id) do
    case Repo.get(Theme, id) do
      nil -> {:error, :not_found}
      %Theme{} = theme -> {:ok, Repo.preload(theme, :owner)}
    end
  end

  @doc """
  Save a new theme owned by the calling user (rate-limited, ~5/day). Visitors
  cannot own themes.
  """
  @spec create_theme(subject(), map()) ::
          {:ok, Theme.t()} | {:error, :rate_limited | :forbidden | Ecto.Changeset.t()}
  def create_theme({:user, %User{} = user}, attrs) when is_map(attrs) do
    changeset = Theme.changeset(%Theme{}, Map.put(attrs, :owner_id, user.id))

    # Validate BEFORE consuming quota so a malformed request never burns a slot.
    if changeset.valid? do
      with :ok <- check_quota(user) do
        Repo.insert(changeset)
      end
    else
      {:error, changeset}
    end
  end

  def create_theme({:visitor, %Visitor{}}, _attrs), do: {:error, :forbidden}

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
  independent owned theme (rate-limited). Bumps the SOURCE's `apply_count` — the
  "how many people applied it" usage metric. The copy carries no back-reference
  to its source. Visitors cannot own copies.
  """
  @spec copy_theme(subject(), integer()) ::
          {:ok, Theme.t()} | {:error, :not_found | :forbidden | :rate_limited}
  def copy_theme({:user, %User{} = user}, id) when is_integer(id) do
    with {:ok, source} <- get_theme(id),
         :ok <- check_quota(user) do
      Repo.transaction(fn ->
        name = available_name(user.id, source.name)

        copy =
          %Theme{}
          |> Theme.changeset(%{name: name, owner_id: user.id, payload: source.payload})
          |> Repo.insert!()

        {1, _} =
          Theme
          |> where([t], t.id == ^source.id)
          |> Repo.update_all(inc: [apply_count: 1])

        copy
      end)
    end
  end

  def copy_theme({:visitor, %Visitor{}}, _id), do: {:error, :forbidden}

  ## Internals

  defp set_published(subject, id, value) when is_integer(id) and is_boolean(value) do
    with {:ok, theme} <- get_theme(id),
         :ok <- authorize(subject, theme) do
      theme |> Ecto.Changeset.change(published: value) |> Repo.update()
    end
  end

  # Admin: any. Owner: own. Everyone else (incl. visitors, non-owners, and every
  # non-admin against a system-owned built-in): forbidden.
  defp authorize({:user, %User{is_admin: true}}, %Theme{}), do: :ok
  defp authorize({:user, %User{id: id}}, %Theme{owner_id: id}), do: :ok
  defp authorize(_subject, %Theme{}), do: {:error, :forbidden}

  defp check_quota(%User{id: user_id}) do
    DailyQuota.check_and_record(@quota_bucket, {:user, user_id}, @daily_quota)
  end

  # Find a free name in the caller's library: the base, else "base (2)", …
  # (unique index is (owner_id, name); dedup avoids clashing on re-copy).
  defp available_name(user_id, base) do
    taken =
      Theme
      |> where([t], t.owner_id == ^user_id)
      |> select([t], t.name)
      |> Repo.all()
      |> MapSet.new()

    if MapSet.member?(taken, base) do
      Enum.find_value(2..999, base, fn n ->
        candidate = "#{base} (#{n})"
        if MapSet.member?(taken, candidate), do: nil, else: candidate
      end)
    else
      base
    end
  end
end
