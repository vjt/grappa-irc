defmodule GrappaWeb.PushSubscriptionController do
  @moduledoc """
  REST surface for `Grappa.Push` subscriptions — push notifications
  cluster B1 (2026-05-14) + visitor-parity V3 (2026-05-15).

  Four endpoints, all behind `[:api, :authn]`:

    * `POST /push/subscriptions` — body
      `{"endpoint": <url>, "keys": {"p256dh": <b64>, "auth": <b64>},
      "provider": <"webpush" | "unifiedpush">}`. `"provider"` is
      optional and defaults to `"webpush"` — a UnifiedPush client
      generates a real P-256 keypair + auth secret client-side too
      (the same way a browser's `PushManager.subscribe()` does
      internally for Web Push) and sends it through this SAME shape,
      just tagged `"provider": "unifiedpush"` so the device-list UX
      can tell the two apart; see `Grappa.Push.Subscription`'s
      moduledoc for why delivery itself never branches on it. Also
      accepts an optional `"supersedes": <old-endpoint>` the client
      sends on re-subscribe so the ghost row it is replacing is
      pruned atomically (#181 churn dedup — see `Push.create/2`).
      201 with `%{id, created_at}` on success; 400 if the body shape
      is missing required fields; 422 with `{error:
      "validation_failed", field_errors: ...}` on validation
      (length cap exceeded, unrecognized `provider`) OR on the
      duplicate-endpoint case (re-subscription replay —
      `field_errors.endpoint` carries the "has already been taken"
      token, surfaced via the `error_key: :endpoint` override on
      `Subscription.changeset/2`'s unique_constraint).

    * `DELETE /push/subscriptions/:id` — 204 on success;
      404 (uniform body) for cross-subject OR missing IDs (probing
      protection — one subject cannot enumerate another's
      subscription IDs).

    * `PATCH /push/subscriptions/:id` — body `{"label": <string|null>}`,
      the #964 inline rename. 200 with the updated device summary;
      400 on a missing / non-string `label`; 404 (uniform body) for
      cross-subject or missing IDs; 422 past the length cap.

    * `GET /push/subscriptions` — 200 with
      `%{subscriptions: [%{id, provider, user_agent, label,
      created_at, last_used_at}, ...]}`. Powers the cic settings
      drawer's per-device list (B3); `provider` lets a client tell a
      browser subscription apart from a UnifiedPush-registered device.

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
  (`expirationTime` is dropped at the boundary) — a UnifiedPush
  client sends the identical shape (it generates its own P-256
  keypair + auth secret client-side), plus the optional `"provider"`
  tag. `provider` is passed through as-is when present; when absent,
  `Subscription.changeset/2`'s schema-field default (`"webpush"`)
  applies, so every pre-2026-08-13 caller is unaffected.
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | Ecto.Changeset.t()}
  def create(conn, %{"endpoint" => endpoint, "keys" => %{"p256dh" => p256dh, "auth" => auth}} = params)
      when is_binary(endpoint) and is_binary(p256dh) and is_binary(auth) do
    base_attrs = %{
      endpoint: endpoint,
      p256dh_key: p256dh,
      auth_key: auth,
      user_agent: get_user_agent(conn)
    }

    attrs =
      base_attrs
      |> maybe_put_supersedes(params)
      |> maybe_put_provider(params)

    with {:ok, sub} <- Push.create(Subject.from_assigns(conn.assigns), attrs) do
      conn
      |> put_status(:created)
      |> render(:show, subscription: sub)
    end
  end

  def create(_, _), do: {:error, :bad_request}

  # #181 — optional `supersedes` body field carrying the previous
  # endpoint the client is replacing on re-subscribe. Passed straight to
  # `Push.create/2`, which deletes that subject-scoped row atomically
  # with the insert (churn dedup). Ignored when absent / blank / non-binary.
  # (No @spec: the success typing pins the concrete attrs-map shape, so a
  # `map()` contract is a Dialyzer supertype — the inferred type is exact.)
  defp maybe_put_supersedes(attrs, %{"supersedes" => sup}) when is_binary(sup) and sup != "",
    do: Map.put(attrs, :supersedes, sup)

  defp maybe_put_supersedes(attrs, _), do: attrs

  # `"provider"` (2026-08-13, UnifiedPush) — passed through verbatim when the
  # caller sends a non-empty string; `Subscription`'s `Ecto.Enum` cast
  # rejects anything OUTSIDE the closed set with a 422, same as
  # `validate_inclusion/3` would. `""` is NOT in that "outside the set" case:
  # `Ecto.Changeset.cast/3`'s default `empty_values` already treats `""` as
  # "field not sent" and strips it before validation ever runs, so it
  # 201s and falls back to the schema default (`:webpush`) exactly like an
  # omitted field does — this is intentional (mirrors how a real client with
  # an uninitialised provider setting should behave: safe fallback, not a
  # rejected request). The `provider != ""` guard here mirrors
  # `maybe_put_supersedes/2`'s `sup != ""` above for the same reason: make
  # that fallback an explicit choice in THIS module instead of an unstated
  # side effect of Ecto's `empty_values` default. Absent entirely (or `""`)
  # -> the schema field default applies, matching every pre-2026-08-13
  # caller unchanged.
  defp maybe_put_provider(attrs, %{"provider" => provider}) when is_binary(provider) and provider != "",
    do: Map.put(attrs, :provider, provider)

  defp maybe_put_provider(attrs, _), do: attrs

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
  `PATCH /push/subscriptions/:id` — rename a device (#964). Body
  `{"label": <string|null>}`; `null` or a blank string clears the label
  and the row falls back to its derived name.

  400 when `label` is absent or not a string/null — a type error is the
  client's bug, not a value the 422 envelope should have to describe.
  404 (uniform body) for cross-subject OR missing IDs, same probing
  protection as `delete/2`. 422 when the value exceeds the length cap.
  """
  @spec update(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :not_found | Ecto.Changeset.t()}
  def update(conn, %{"id" => id, "label" => label})
      when is_binary(id) and (is_binary(label) or is_nil(label)) do
    with {:ok, sub} <- Push.get_for_subject(Subject.from_assigns(conn.assigns), id),
         {:ok, renamed} <- Push.update_label(sub, label) do
      render(conn, :device, subscription: renamed)
    end
  end

  def update(_, _), do: {:error, :bad_request}

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
