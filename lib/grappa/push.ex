defmodule Grappa.Push do
  @moduledoc """
  Web Push subscription persistence — per-subject, per-device PWA push
  endpoints.

  Push notifications cluster B1 (2026-05-14). Stores the opaque
  `(endpoint, p256dh_key, auth_key)` triplet the W3C Push API hands
  out, plus per-device metadata (`user_agent`, `last_used_at`) for
  the cic settings drawer's "see + revoke my devices" UX (B3).

  ## Subject-scoped (visitor-parity V1, 2026-05-15)

  Both registered users and visitors may register push subscriptions;
  storage uses the XOR FK shape (`user_id` XOR `visitor_id`) proven
  by `Grappa.Scrollback.Message` and `Grappa.ReadCursor.Cursor`.
  Visitor reaping CASCADEs the rows on TTL expiry; NickServ-
  identified visitors with infinite TTL keep them indefinitely.

  Every public function takes a `Grappa.Subject.t()` tagged tuple
  rather than a raw `%User{}` — the helper enforces the FK column
  invariant at the call site.

  ## Why it lives here

  Push subscriptions are a sibling concern to Accounts (per-subject)
  but are domain-distinct enough to deserve their own context
  boundary. Future B2 will add `Grappa.Push.Sender` (Web Push delivery
  via VAPID-signed POSTs); B4 will add `Grappa.Push.Triggers`
  (PRIVMSG-hot-path eval). Keeping the context standalone means
  Bootstrap + Session.Server only need to depend on `Grappa.Push`,
  not reach into Accounts internals.

  ## API

    * `create/2` — insert (or 409-style replay if
      `(<subject_id>, endpoint)` collides — see
      `Subscription.changeset/2`'s unique constraint).
    * `list_for_subject/1` — every subscription belonging to a
      subject (sorted by `inserted_at`, most-recent first).
    * `get_for_subject/2` — fetch one by ID, scoped to subject (404
      if cross-subject).
    * `delete/1` — by struct.
    * `delete_dead/1` — by endpoint URL. Used by B2's `Push.Sender`
      when a vendor returns 404/410 for a stale subscription.
    * `touch_last_used/1` — bump `last_used_at` after a successful
      Push.Sender delivery (B2 path).

  ## Boundary

    * `Grappa.Repo` — persistence.
    * `Grappa.Subject` — XOR FK helper.
    * `Grappa.Accounts` — FK reference to `User`.
    * `Grappa.Visitors` — FK reference to `Visitor`.
    * `Grappa.Scrollback` — B4 trigger consumes
      `%Grappa.Scrollback.Message{}` structs.
    * `Grappa.UserSettings` — B4 trigger reads `notification_prefs` +
      `highlight_patterns`.
    * `Grappa.Mentions` — B4 trigger uses `Mentions.mentioned?/3`
      (same word-boundary predicate as the cic mention badge).

  The `Subscription` schema module is internal; callers OUTSIDE this
  context receive `%Subscription{}` structs by type but MUST NOT
  alias the schema directly — go through the context's API. Modules
  inside the `Grappa.Push` namespace itself (`Grappa.Push.Sender`)
  are intra-context and DO alias `Subscription` directly because they
  share the boundary. Same convention as `Grappa.QueryWindows`.
  """

  use Boundary,
    top_level?: true,
    deps: [
      Grappa.Accounts,
      Grappa.IRC,
      Grappa.Mentions,
      Grappa.Repo,
      Grappa.Scrollback,
      Grappa.Subject,
      Grappa.UserSettings,
      Grappa.WSPresence
    ],
    dirty_xrefs: [Grappa.Visitors.Visitor],
    exports: [BadgeSource, Payload, Sender, Subscription, Triggers]

  import Ecto.Query

  alias Grappa.{Push.Subscription, Repo, Subject}

  @vapid_public_key_term {__MODULE__, :vapid_public_key}

  @doc """
  Boot-time stash of the VAPID public key into `:persistent_term`. Read
  once at boot via `Application.fetch_env!/2` (the CLAUDE.md-designated
  boundary site) so the runtime hot path (`PushVapidController.show/2`)
  reads lock-free without re-hitting `Application.get_env/2` per
  request (H16, REV-D 2026-05-22).

  The upstream `:web_push_elixir` library itself reads the key from
  `Application.get_env/2` at delivery time — that's the library's
  concern and out of our control. We mirror the value here so OUR
  callers (the controller) observe the boot-time-pinned constant
  instead of doing their own runtime env read.

  Idempotent; later calls overwrite.
  """
  @spec boot() :: :ok
  def boot do
    key = Application.fetch_env!(:web_push_elixir, :vapid_public_key)
    :persistent_term.put(@vapid_public_key_term, key)
    :ok
  end

  @doc """
  Returns the VAPID public key pinned at boot. Raises if `boot/0`
  hasn't run — any caller reaching this without prior boot is a bug
  (Application.start/2 must call `boot/0` BEFORE the supervised
  Endpoint comes up).
  """
  @spec vapid_public_key() :: String.t()
  def vapid_public_key, do: :persistent_term.get(@vapid_public_key_term)

  @doc """
  Inserts a new push subscription for the given subject.

  `attrs` must be an **atom-keyed** map carrying `:endpoint`,
  `:p256dh_key`, `:auth_key` (all required); `:user_agent` is
  optional. The subject FK column is supplied via the first argument
  through `Subject.put_subject_id/2` so callers cannot accidentally
  cross subjects from the request body. Mixed string/atom keys would
  silently drop the non-matching half during cast; the controller
  builds an atom-keyed map from `conn.body_params` explicitly.

  Returns `{:ok, %Subscription{}}` on success or
  `{:error, %Ecto.Changeset{}}` on validation / FK / uniqueness
  failure. The unique constraint on `(<subject_id>, endpoint)`
  surfaces as a `:endpoint` field error (via the `error_key:
  :endpoint` override in `Subscription.changeset/2`) when the same
  browser re-subscribes — cic treats the 422 as "already subscribed,
  refresh local cache."

  ## `:supersedes` — churn dedup (#181, 2026-07-04)

  `attrs` MAY carry an optional `:supersedes` key holding a previous
  endpoint URL the client is replacing. When present (and different
  from the new `:endpoint`), the create runs in a transaction that
  first deletes THAT subject-scoped endpoint, then inserts the new
  row — so a re-subscribe after a silent client-side drop does not
  leave a ghost row behind. The reconciliation is deliberately
  **client-authoritative**: the client names the exact endpoint it is
  superseding, and the delete is scoped to the requesting subject, so
  it can never touch another subject's identically-named endpoint nor
  a legitimate second device (a subject may own two devices with an
  identical `user_agent` — proven in prod). `:supersedes == :endpoint`
  (endpoint did not rotate) is a no-op delete so the same-endpoint
  re-subscribe still surfaces as the unique-constraint replay.
  """
  @spec create(Subject.t(), map()) ::
          {:ok, Subscription.t()} | {:error, Ecto.Changeset.t()}
  def create({_, _} = subject, attrs) when is_map(attrs) do
    case Map.pop(attrs, :supersedes) do
      {supersedes, rest} when is_binary(supersedes) ->
        insert_superseding(subject, rest, supersedes)

      {_, rest} ->
        do_insert(subject, rest)
    end
  end

  defp do_insert(subject, attrs) do
    %Subscription{}
    |> Subscription.changeset(Subject.put_subject_id(attrs, subject))
    |> Repo.insert()
  end

  defp insert_superseding(subject, attrs, supersedes) do
    Repo.transaction(fn ->
      # Subject-scoped delete of the exact endpoint the client says it is
      # replacing — but never the endpoint we are about to (re)insert, so
      # a non-rotated re-subscribe still surfaces as the unique-constraint
      # replay (#181). `subject_where/2` scopes to the requesting subject,
      # so a shared endpoint string can never cross subjects.
      if supersedes != Map.get(attrs, :endpoint) do
        Subscription
        |> Subject.subject_where(subject)
        |> where([s], s.endpoint == ^supersedes)
        |> Repo.delete_all()
      end

      case do_insert(subject, attrs) do
        {:ok, sub} -> sub
        {:error, changeset} -> Repo.rollback(changeset)
      end
    end)
  end

  @doc """
  Lists every push subscription belonging to the given subject,
  newest first. Empty list when the subject has no subscriptions yet.
  """
  @spec list_for_subject(Subject.t()) :: [Subscription.t()]
  def list_for_subject({_, _} = subject) do
    Subscription
    |> Subject.subject_where(subject)
    |> order_by([s], desc: s.inserted_at)
    |> Repo.all()
  end

  @doc """
  Fetches a subscription by ID, scoped to the subject. Returns
  `{:error, :not_found}` when the row doesn't exist OR when the row
  exists but belongs to a different subject — the wire body is
  uniform per the FallbackController convention so a probing operator
  cannot distinguish "wrong ID" from "someone else's subscription."
  """
  @spec get_for_subject(Subject.t(), Ecto.UUID.t()) ::
          {:ok, Subscription.t()} | {:error, :not_found}
  def get_for_subject({:user, user_id}, id) when is_binary(id) do
    case Repo.get(Subscription, id) do
      %Subscription{user_id: ^user_id} = sub -> {:ok, sub}
      _ -> {:error, :not_found}
    end
  end

  def get_for_subject({:visitor, visitor_id}, id) when is_binary(id) do
    case Repo.get(Subscription, id) do
      %Subscription{visitor_id: ^visitor_id} = sub -> {:ok, sub}
      _ -> {:error, :not_found}
    end
  end

  @doc """
  Deletes a subscription. The struct argument is intentional —
  callers must have already loaded + scoped via `get_for_subject/2`,
  which prevents a controller from accidentally taking a path-
  parameter ID straight into `Repo.delete_by/2` and bypassing the
  subject check.
  """
  @spec delete(Subscription.t()) :: {:ok, Subscription.t()} | {:error, Ecto.Changeset.t()}
  def delete(%Subscription{} = sub), do: Repo.delete(sub)

  @doc """
  Deletes any subscription matching the given endpoint URL,
  regardless of subject. Used by B2's `Push.Sender` when a vendor
  returns 404 / 410 for a stale endpoint — the subscription is dead
  from every subject's perspective (one subject, one endpoint per the
  unique constraint, but the by-endpoint shape avoids loading the row
  first just to delete it).

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
  Test-support: drains every `push_subscriptions` row for `user_id` in
  a single DELETE. Intended for `Grappa.TestSupport.SubjectReset` only —
  production lifecycle uses `create/2` + `delete/1` + `delete_dead/1`.
  """
  @spec subscription_clear_all_for_user(Ecto.UUID.t()) :: :ok
  def subscription_clear_all_for_user(user_id) when is_binary(user_id) do
    query = from(s in Subscription, where: s.user_id == ^user_id)
    Repo.delete_all(query)
    :ok
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
