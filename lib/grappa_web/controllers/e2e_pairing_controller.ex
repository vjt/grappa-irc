defmodule GrappaWeb.E2ePairingController do
  @moduledoc """
  The REST door of `Grappa.E2ePairing`, the blind relay two devices of one
  account pair through (grappa-irc#2430, X1).

    * `POST /e2e/pairings` — open a rendezvous; the caller's device is its
      creator. `201 {rendezvous: {id, role, expires_at}}`.
    * `POST /e2e/pairings/:id/join` — join it from a second device of the
      same account. `200 {rendezvous}`; a second joiner gets `409
      pairing_already_joined`, never silence.
    * `POST /e2e/pairings/:id/messages` — body `{payload}`, opaque base64.
      `201 {message: {seq, from, payload}}`.
    * `GET /e2e/pairings/:id/messages?after=<seq>` — what the other side
      posted after `seq`, for a device whose socket missed the push.
    * `DELETE /e2e/pairings/:id` — close it, for both sides. `204`.

  A side is the caller's auth session, so the same bearer is the same
  device. Every message and close is also pushed on the user topic.

  In the `:full_session` block of the router: what a pairing yields is one
  more device for the account's E2E identity, so starting one is
  credential management, as minting a share link is (#1353). An incognito
  visitor is refused for #363's reason: its session is deliberately
  non-portable.
  """
  use GrappaWeb, :controller

  alias Grappa.E2ePairing
  alias Grappa.E2ePairing.Wire
  alias Grappa.Visitors.Visitor
  alias GrappaWeb.Subject, as: WebSubject

  @doc "`POST /e2e/pairings` — open a rendezvous with the caller's device as its creator."
  @spec create(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, term()}
  def create(conn, _) do
    with :ok <- portable(conn),
         {:ok, r} <- E2ePairing.open(subject(conn), label(conn), session(conn)) do
      conn |> put_status(:created) |> json(Wire.rendezvous_response(r, :creator))
    end
  end

  @doc "`POST /e2e/pairings/:id/join` — join it as the second device of the same account."
  @spec join(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, term()}
  def join(conn, %{"id" => id}) do
    with :ok <- portable(conn),
         {:ok, r} <- E2ePairing.join(subject(conn), session(conn), id) do
      json(conn, Wire.rendezvous_response(r, :joiner))
    end
  end

  @doc "`POST /e2e/pairings/:id/messages` — relay one opaque payload to the other side."
  @spec post_message(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, term()}
  def post_message(conn, %{"id" => id} = params) do
    with {:ok, msg} <- E2ePairing.post(subject(conn), session(conn), id, params["payload"]) do
      conn |> put_status(:created) |> json(Wire.message_response(msg))
    end
  end

  @doc "`GET /e2e/pairings/:id/messages?after=<seq>` — what the other side posted after `seq`."
  @spec messages(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, term()}
  def messages(conn, %{"id" => id} = params) do
    with {:ok, after_seq} <- after_seq(params),
         {:ok, msgs} <- E2ePairing.messages(subject(conn), session(conn), id, after_seq) do
      json(conn, Wire.messages_response(msgs))
    end
  end

  @doc "`DELETE /e2e/pairings/:id` — close the rendezvous for both sides."
  @spec delete(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, term()}
  def delete(conn, %{"id" => id}) do
    with :ok <- E2ePairing.close(subject(conn), session(conn), id) do
      send_resp(conn, :no_content, "")
    end
  end

  defp after_seq(params) do
    changeset =
      {%{}, %{after: :integer}}
      |> Ecto.Changeset.cast(Map.take(params, ["after"]), [:after])
      |> Ecto.Changeset.validate_number(:after, greater_than_or_equal_to: 0)

    with {:ok, changes} <- Ecto.Changeset.apply_action(changeset, :validate),
         do: {:ok, Map.get(changes, :after, 0)}
  end

  # #363 — an incognito session must not become portable, and a paired
  # device is exactly that.
  defp portable(%{assigns: %{current_subject: {:visitor, %Visitor{incognito: true}}}}),
    do: {:error, :forbidden}

  defp portable(_), do: :ok

  defp subject(conn), do: WebSubject.to_session(conn.assigns.current_subject)
  defp label(conn), do: WebSubject.topic_label(conn.assigns.current_subject)
  defp session(conn), do: conn.assigns.current_session_id
end
