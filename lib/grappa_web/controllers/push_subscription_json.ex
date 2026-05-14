defmodule GrappaWeb.PushSubscriptionJSON do
  @moduledoc """
  Phoenix view layer for `GrappaWeb.PushSubscriptionController` —
  push notifications cluster B1 (2026-05-14).

  Centralizes the wire shapes for the three actions so the rename
  between server-side field names (`p256dh_key`, `auth_key`) and
  client-side keys (kept in sync with the W3C `PushSubscription.toJSON()`
  output where applicable) lives in one place. B2's Push.Sender will
  consume `Subscription.t()` directly from the context — only the
  REST surface uses the wire shapes here.

  ## Action shapes

    * `:show` (POST 201 response) — `%{id, created_at}`. Endpoint and
      keys are NOT echoed back; cic already has them locally (it just
      sent them).
    * `:index` (GET 200) — `%{subscriptions: [%{id, user_agent,
      created_at, last_used_at}, ...]}`. Powers cic settings drawer
      device list (B3). `last_used_at` is `nil` until B2's
      `Push.Sender` writes the first delivery.

  ## Why no endpoint/keys in any list shape

  The endpoint URL + keys are credential-grade material — exposing
  them in a GET surface would let an XSS vector exfiltrate every
  device's push capability. cic doesn't need them after the initial
  POST (the SW holds the live `PushSubscription` object). Only
  `Push.Sender` server-side needs the keys, and it reads them from
  the schema directly via the context, never via this view.
  """

  alias Grappa.Push.Subscription

  @type subscription_summary :: %{
          id: Ecto.UUID.t(),
          user_agent: String.t() | nil,
          created_at: DateTime.t(),
          last_used_at: DateTime.t() | nil
        }

  @type create_response :: %{id: Ecto.UUID.t(), created_at: DateTime.t()}
  @type index_response :: %{subscriptions: [subscription_summary()]}

  @doc "Renders the `:show` action — POST 201 response shape."
  @spec show(%{subscription: Subscription.t()}) :: create_response()
  def show(%{subscription: %Subscription{} = sub}) do
    %{id: sub.id, created_at: sub.inserted_at}
  end

  @doc "Renders the `:index` action — GET 200 response shape."
  @spec index(%{subscriptions: [Subscription.t()]}) :: index_response()
  def index(%{subscriptions: subs}) do
    %{subscriptions: Enum.map(subs, &summary/1)}
  end

  @spec summary(Subscription.t()) :: subscription_summary()
  defp summary(%Subscription{} = sub) do
    %{
      id: sub.id,
      user_agent: sub.user_agent,
      created_at: sub.inserted_at,
      last_used_at: sub.last_used_at
    }
  end
end
