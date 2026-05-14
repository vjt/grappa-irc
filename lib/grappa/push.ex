defmodule Grappa.Push do
  @moduledoc """
  Web Push subscription persistence — per-user, per-device PWA push
  endpoints.

  Push notifications cluster B1 (2026-05-14). Stores the opaque
  `(endpoint, p256dh_key, auth_key)` triplet the W3C Push API hands
  out, plus per-device metadata (`user_agent`, `last_used_at`) for
  the cic settings drawer's "see + revoke my devices" UX (B3).

  ## Why it lives here

  Push subscriptions are a sibling concern to Accounts (per-user) but
  are domain-distinct enough to deserve their own context boundary.
  Future B2 will add `Grappa.Push.Sender` (Web Push delivery via
  VAPID-signed POSTs); B4 will add `Grappa.Push.Triggers` (PRIVMSG-
  hot-path eval). Keeping the context standalone means Bootstrap +
  Session.Server only need to depend on `Grappa.Push`, not reach into
  Accounts internals.

  ## API

    * `create/2` — insert (or 409-style replay if `(user_id, endpoint)`
      collides — see `Subscription.changeset/2`'s unique constraint).
    * `list_for_user/1` — every subscription belonging to a user
      (sorted by `inserted_at`, most-recent first).
    * `get_for_user/2` — fetch one by ID, scoped to user (404 if
      cross-user).
    * `delete/1` — by struct.
    * `delete_dead/1` — by endpoint URL. Used by B2's `Push.Sender`
      when a vendor returns 404/410 for a stale subscription.
    * `touch_last_used/1` — bump `last_used_at` after a successful
      Push.Sender delivery (B2 path).

  ## Boundary

    * `Grappa.Repo` — persistence.
    * `Grappa.Accounts` — FK reference to `User`.

  The `Subscription` schema module is internal; callers OUTSIDE this
  context receive `%Subscription{}` structs by type but MUST NOT
  alias the schema directly — go through the context's API. Modules
  inside the `Grappa.Push` namespace itself (`Grappa.Push.Sender`)
  are intra-context and DO alias `Subscription` directly because they
  share the boundary. Same convention as `Grappa.QueryWindows`.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Accounts, Grappa.Repo],
    exports: [Subscription, Sender]

  import Ecto.Query

  alias Grappa.Accounts.User
  alias Grappa.Push.Subscription
  alias Grappa.Repo

  @doc """
  Inserts a new push subscription for the given user.

  `attrs` must be an **atom-keyed** map carrying `:endpoint`,
  `:p256dh_key`, `:auth_key` (all required); `:user_agent` is
  optional. The `user_id` is supplied explicitly via the first
  argument so callers cannot accidentally cross subjects from the
  request body — `Map.put(attrs, :user_id, user_id)` is the only
  authoritative source for the FK. Mixed string/atom keys would
  silently drop the non-matching half during cast; the controller
  (B1's only caller) builds an atom-keyed map from
  `conn.body_params` explicitly.

  Returns `{:ok, %Subscription{}}` on success or
  `{:error, %Ecto.Changeset{}}` on validation / FK / uniqueness
  failure. The unique constraint on `(user_id, endpoint)` surfaces
  as a `:endpoint` field error (via the `error_key: :endpoint`
  override in `Subscription.changeset/2`) when the same browser
  re-subscribes — cic treats the 422 as "already subscribed,
  refresh local cache."
  """
  @spec create(User.t(), map()) :: {:ok, Subscription.t()} | {:error, Ecto.Changeset.t()}
  def create(%User{id: user_id}, attrs) when is_map(attrs) do
    %Subscription{}
    |> Subscription.changeset(Map.put(attrs, :user_id, user_id))
    |> Repo.insert()
  end

  @doc """
  Lists every push subscription belonging to the given user, newest
  first. Empty list when the user has no subscriptions yet.
  """
  @spec list_for_user(User.t()) :: [Subscription.t()]
  def list_for_user(%User{id: user_id}), do: list_for_user_id(user_id)

  @doc """
  Lists every push subscription belonging to the user with the given
  ID, newest first. Empty list when the user has no subscriptions yet.

  Variant of `list_for_user/1` that takes the binary user_id directly
  — used by `Grappa.Push.Sender` (B2) which is called from contexts
  that already have the ID without round-tripping through the User
  struct, and which would otherwise need `Grappa.Accounts` in its
  Boundary dep list just to construct a bare `%User{}`.
  """
  @spec list_for_user_id(Ecto.UUID.t()) :: [Subscription.t()]
  def list_for_user_id(user_id) when is_binary(user_id) do
    query = from(s in Subscription, where: s.user_id == ^user_id, order_by: [desc: s.inserted_at])
    Repo.all(query)
  end

  @doc """
  Fetches a subscription by ID, scoped to the user. Returns
  `{:error, :not_found}` when the row doesn't exist OR when the row
  exists but belongs to a different user — the wire body is uniform
  per the FallbackController convention so a probing user cannot
  distinguish "wrong ID" from "someone else's subscription."
  """
  @spec get_for_user(User.t(), Ecto.UUID.t()) :: {:ok, Subscription.t()} | {:error, :not_found}
  def get_for_user(%User{id: user_id}, id) when is_binary(id) do
    case Repo.get(Subscription, id) do
      %Subscription{user_id: ^user_id} = sub -> {:ok, sub}
      _ -> {:error, :not_found}
    end
  end

  @doc """
  Deletes a subscription. The struct argument is intentional — callers
  must have already loaded + scoped via `get_for_user/2`, which
  prevents a controller from accidentally taking a path-parameter ID
  straight into `Repo.delete_by/2` and bypassing the user check.
  """
  @spec delete(Subscription.t()) :: {:ok, Subscription.t()} | {:error, Ecto.Changeset.t()}
  def delete(%Subscription{} = sub), do: Repo.delete(sub)

  @doc """
  Deletes any subscription matching the given endpoint URL, regardless
  of user. Used by B2's `Push.Sender` when a vendor returns 404 / 410
  for a stale endpoint — the subscription is dead from every user's
  perspective (one user, one endpoint per the unique constraint, but
  the by-endpoint shape avoids loading the row first just to delete
  it).

  Returns `{deleted_count, nil}` per `Repo.delete_all/2` semantics.
  Idempotent — repeated calls with an already-deleted endpoint
  return `{0, nil}`.
  """
  @spec delete_dead(String.t()) :: {non_neg_integer(), nil}
  def delete_dead(endpoint) when is_binary(endpoint) do
    query = from(s in Subscription, where: s.endpoint == ^endpoint)
    Repo.delete_all(query)
  end

  @doc """
  Updates `last_used_at` to `DateTime.utc_now()`. Called by B2's
  `Push.Sender` after a successful delivery. Returns the updated
  struct so callers can chain.

  No changeset wrapper — the field is server-controlled (callers
  cannot supply arbitrary timestamps) and bypassing the cast keeps
  the hot path light. The narrow `Repo.update/1` shape is acceptable
  given the field is set internally, never from user input.
  """
  @spec touch_last_used(Subscription.t()) ::
          {:ok, Subscription.t()} | {:error, Ecto.Changeset.t()}
  def touch_last_used(%Subscription{} = sub) do
    sub
    |> Ecto.Changeset.change(last_used_at: DateTime.utc_now())
    |> Repo.update()
  end
end
