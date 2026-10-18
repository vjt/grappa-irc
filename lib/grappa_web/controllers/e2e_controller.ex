defmodule GrappaWeb.E2eController do
  @moduledoc """
  The send door for end-to-end encrypted queries (issue 2430).

  The client encrypts; grappa frames, paces and relays. The receive half
  is not a REST resource at all: a peer's message arrives as an
  `e2e_message` event on the user topic and is never stored, so there is
  nothing here to GET.

  Same `:authn` + `ResolveNetwork` pipeline as every other
  `/networks/:network_id/*` route, so ownership is asserted the same way.
  """
  use GrappaWeb, :controller

  alias Grappa.Session
  alias GrappaWeb.Subject

  # The wire spells verbs lowercase, like every other closed set on it; the
  # set itself is the facade's, so the two cannot drift.
  @verbs Map.new(Session.e2e_send_verbs(), &{Atom.to_string(&1), &1})

  @doc """
  `POST /networks/:network_id/e2e/messages` — `{target, verb, payload}`.

  **202, not 201.** Nothing is created and nothing is stored; the lines may
  still be waiting for the recipient's FLUD window when this returns, and
  IRC never confirms delivery. The body carries the `msgid` grappa chose,
  which is what a peer's `NACK` will name.

  400 `bad_request` for a target that is not a nick, a verb outside
  `keyreq | pkmsg | msg | nack`, or a payload that is not base64; 413
  `too_large` past 64 lines; 429 `rate_limited` when the recipient's queue
  cannot take the whole message.
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :bad_request | :invalid_line | :no_session | :no_socket | :timeout | :too_large | :rate_limited}
  def create(conn, %{"target" => target, "verb" => verb, "payload" => payload})
      when is_binary(target) and is_binary(verb) and is_binary(payload) do
    subject = Subject.to_session(conn.assigns.current_subject)

    with {:ok, verb} <- fetch_verb(verb),
         {:ok, msgid} <- Session.send_e2e(subject, conn.assigns.network.id, target, verb, payload) do
      conn |> put_status(:accepted) |> json(%{msgid: msgid})
    end
  end

  def create(_, _), do: {:error, :bad_request}

  @spec fetch_verb(String.t()) :: {:ok, Grappa.IRC.E2e.verb()} | {:error, :bad_request}
  defp fetch_verb(verb) do
    case Map.fetch(@verbs, verb) do
      {:ok, _} = ok -> ok
      :error -> {:error, :bad_request}
    end
  end
end
