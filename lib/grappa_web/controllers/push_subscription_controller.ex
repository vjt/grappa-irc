defmodule GrappaWeb.PushSubscriptionController do
  @moduledoc """
  REST surface for `Grappa.Push` subscriptions — push notifications
  cluster B1 (2026-05-14) + visitor-parity V3 (2026-05-15).

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
      404 (uniform body) for cross-subject OR missing IDs (probing
      protection — one subject cannot enumerate another's
      subscription IDs).

    * `GET /push/subscriptions` — 200 with
      `%{subscriptions: [%{id, user_agent, created_at, last_used_at},
      ...]}`. Powers the cic settings drawer's per-device list (B3).

  ## Subject-scoped — V3 (2026-05-15)

  Both registered users and visitors register push subscriptions
  through this controller. The action body delegates to
  `Grappa.Subject.from_assigns/1` for the bare-id tuple and hands it
  straight to `Grappa.Push` context functions; the FK XOR invariant
  is enforced at the schema layer. Anon visitors' subscriptions
  CASCADE-delete on Reaper sweep; identified visitors keep them
  indefinitely (NickServ identity proof = permanent subject).

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

  alias Grappa.{Push, Subject}

  @doc """
  `POST /push/subscriptions` — register a new push subscription for
  the authenticated subject.

  Wire shape mirrors the W3C `PushSubscription.toJSON()` output
  (`{endpoint, keys: {p256dh, auth}}`) so the cic SW can pass its
  subscription object straight through with one rename
  (`expirationTime` is dropped at the boundary).
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | Ecto.Changeset.t()}
  def create(conn, %{"endpoint" => endpoint, "keys" => %{"p256dh" => p256dh, "auth" => auth}})
      when is_binary(endpoint) and is_binary(p256dh) and is_binary(auth) do
    attrs = %{
      endpoint: endpoint,
      p256dh_key: p256dh,
      auth_key: auth,
      user_agent: get_user_agent(conn)
    }

    with {:ok, sub} <- Push.create(Subject.from_assigns(conn.assigns), attrs) do
      conn
      |> put_status(:created)
      |> render(:show, subscription: sub)
    end
  end

  def create(_, _), do: {:error, :bad_request}

  @doc """
  `DELETE /push/subscriptions/:id` — remove a subscription. Cross-
  subject IDs return 404 (uniform body) so a probing subject cannot
  enumerate another subject's subscription space.
  """
  @spec delete(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :not_found | Ecto.Changeset.t()}
  def delete(conn, %{"id" => id}) when is_binary(id) do
    with {:ok, sub} <- Push.get_for_subject(Subject.from_assigns(conn.assigns), id),
         {:ok, _} <- Push.delete(sub) do
      send_resp(conn, :no_content, "")
    end
  end

  @doc """
  `GET /push/subscriptions` — list the authenticated subject's
  subscriptions. Powers the cic settings drawer's per-device list.
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    render(conn, :index, subscriptions: Push.list_for_subject(Subject.from_assigns(conn.assigns)))
  end

  @spec get_user_agent(Plug.Conn.t()) :: String.t() | nil
  defp get_user_agent(conn) do
    case Plug.Conn.get_req_header(conn, "user-agent") do
      [ua | _] -> ua
      _ -> nil
    end
  end
end
