defmodule GrappaWeb.PushSubscriptionController do
  @moduledoc """
  REST surface for `Grappa.Push` subscriptions — push notifications
  cluster B1 (2026-05-14).

  Three endpoints, all behind `[:api, :authn]`:

    * `POST /push/subscriptions` — body
      `{"endpoint": <url>, "keys": {"p256dh": <b64>, "auth": <b64>}}`.
      201 with `%{id, created_at}` on success; 400 if the body shape
      is missing required fields; 422 with `{error:
      "validation_failed", field_errors: ...}` on validation
      (length cap exceeded) OR on the duplicate-endpoint case (re-
      subscription replay — `field_errors.endpoint` carries the
      "has already been taken" token, surfaced via the
      `error_key: :endpoint` override on `Subscription.changeset/2`'s
      unique_constraint).

    * `DELETE /push/subscriptions/:id` — 204 on success;
      404 (uniform body) for cross-user OR missing IDs (probing
      protection — one user cannot enumerate another's
      subscription IDs).

    * `GET /push/subscriptions` — 200 with
      `%{subscriptions: [%{id, user_agent, created_at, last_used_at},
      ...]}`. Powers the cic settings drawer's per-device list (B3).

  ## User-only

  Push subscriptions are tied to PWA-installed sessions; visitors are
  ephemeral and don't install the PWA. Visitors get `:forbidden`
  (403) from `require_user/1` rather than `:unauthorized` (401) — the
  bearer is fine, the verb isn't allowed for this subject. Mirrors
  the visitor-gated branch in `NickController` (Task 30).

  ### Body validation runs BEFORE the visitor gate on POST

  By Phoenix dispatch convention (mirroring `NickController`), the
  POST body's structural-shape match runs before subject branching.
  A visitor sending a malformed body therefore gets `400 :bad_request`
  rather than `403 :forbidden` — they confirm "endpoint exists but
  body is bad," but cannot tell whether their subject would be
  accepted. A visitor with a well-formed body DOES get 403. The
  endpoint's existence is already discoverable from the static route
  table (no probing leak there); the gating still keeps visitors
  from creating rows.

  ## user_agent capture

  Read from the request's `user-agent` header on POST and persisted
  for the device-list UX (B3 settings page shows
  "Firefox 124 on Linux — last used …" rows). Best-effort: header
  may be missing or spoofed; the cic UX displays whatever lands
  verbatim.

  ## View

  Wire shapes live in `GrappaWeb.PushSubscriptionJSON` so the rename
  between server-side field names (`p256dh_key`, `auth_key`) and
  client-side shape conventions stays in one place. Endpoints + keys
  are intentionally NOT echoed back in any list shape — credential-
  grade material per the JSON view's moduledoc.
  """

  use GrappaWeb, :controller

  alias Grappa.Accounts.User
  alias Grappa.Push

  @doc """
  `POST /push/subscriptions` — register a new push subscription for
  the authenticated user.

  Wire shape mirrors the W3C `PushSubscription.toJSON()` output
  (`{endpoint, keys: {p256dh, auth}}`) so the cic SW can pass its
  subscription object straight through with one rename
  (`expirationTime` is dropped at the boundary).
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :forbidden | :bad_request | Ecto.Changeset.t()}
  def create(conn, %{"endpoint" => endpoint, "keys" => %{"p256dh" => p256dh, "auth" => auth}})
      when is_binary(endpoint) and is_binary(p256dh) and is_binary(auth) do
    attrs = %{
      endpoint: endpoint,
      p256dh_key: p256dh,
      auth_key: auth,
      user_agent: get_user_agent(conn)
    }

    with {:ok, user} <- require_user(conn),
         {:ok, sub} <- Push.create({:user, user.id}, attrs) do
      conn
      |> put_status(:created)
      |> render(:show, subscription: sub)
    end
  end

  def create(_, _), do: {:error, :bad_request}

  @doc """
  `DELETE /push/subscriptions/:id` — remove a subscription. Cross-user
  IDs return 404 (uniform body) so a probing user cannot enumerate
  another user's subscription space.
  """
  @spec delete(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :forbidden | :not_found | Ecto.Changeset.t()}
  def delete(conn, %{"id" => id}) when is_binary(id) do
    with {:ok, user} <- require_user(conn),
         {:ok, sub} <- Push.get_for_subject({:user, user.id}, id),
         {:ok, _} <- Push.delete(sub) do
      send_resp(conn, :no_content, "")
    end
  end

  @doc """
  `GET /push/subscriptions` — list the authenticated user's
  subscriptions. Powers the cic settings drawer's per-device list.
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :forbidden}
  def index(conn, _) do
    with {:ok, user} <- require_user(conn) do
      render(conn, :index, subscriptions: Push.list_for_subject({:user, user.id}))
    end
  end

  # Visitor-gating boundary: push subscriptions are user-only by
  # design (visitors are ephemeral). Mirrors the
  # `{:user, _} | {:visitor, _}` dispatch in `NickController` /
  # `MeController`.
  @spec require_user(Plug.Conn.t()) :: {:ok, User.t()} | {:error, :forbidden}
  defp require_user(conn) do
    case conn.assigns[:current_subject] do
      {:user, %User{} = user} -> {:ok, user}
      _ -> {:error, :forbidden}
    end
  end

  @spec get_user_agent(Plug.Conn.t()) :: String.t() | nil
  defp get_user_agent(conn) do
    case Plug.Conn.get_req_header(conn, "user-agent") do
      [ua | _] -> ua
      _ -> nil
    end
  end
end
