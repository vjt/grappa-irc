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
  @priorities Map.new(Session.e2e_priorities(), &{Atom.to_string(&1), &1})

  @doc """
  `POST /networks/:network_id/e2e/messages` — `{target, verb, payload}`, plus
  an optional `priority`.

  **202, not 201.** Nothing is created and nothing is stored; the lines may
  still be waiting in the pacer when this returns, and IRC never confirms
  delivery. The body carries the `msgid` grappa chose,
  which is what a peer's `NACK` will name.

  `priority` is `control` or `text`, and absent means `text`. A `control`
  message goes ahead of every queued text line; text keeps its order. Set
  `control` on a MSG/PKMSG that carries a CHAL or an ACK: grappa cannot see
  inside it. `keyreq` and `nack` are control whatever it says.

  400 `bad_request` for a target that is not a nick, a verb outside
  `keyreq | pkmsg | msg | nack`, a priority outside `control | text`, or a
  payload that is not base64; 413 `too_large` past 32 KiB or 64 lines; 429
  `rate_limited` when the connection's queue cannot take the whole message.
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :bad_request | :invalid_line | :no_session | :no_socket | :timeout | :too_large | :rate_limited}
  def create(conn, %{"target" => target, "verb" => verb, "payload" => payload} = params)
      when is_binary(target) and is_binary(verb) and is_binary(payload) do
    subject = Subject.to_session(conn.assigns.current_subject)

    with {:ok, verb} <- fetch(@verbs, verb),
         {:ok, priority} <- fetch(@priorities, Map.get(params, "priority", "text")),
         {:ok, msgid} <- Session.send_e2e(subject, conn.assigns.network.id, target, verb, priority, payload) do
      conn |> put_status(:accepted) |> json(%{msgid: msgid})
    end
  end

  def create(_, _), do: {:error, :bad_request}

  # The wire spells closed sets lowercase; anything else is a 400.
  @spec fetch(%{String.t() => atom()}, term()) :: {:ok, atom()} | {:error, :bad_request}
  defp fetch(set, value) do
    case Map.fetch(set, value) do
      {:ok, _} = ok -> ok
      :error -> {:error, :bad_request}
    end
  end
end
