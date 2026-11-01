defmodule Grappa.E2eRequests.Wire do
  @moduledoc """
  The wire shape of `Grappa.E2eRequests` (issue 2486): the REST bodies of
  the `/e2e/requests` routes and the two user-topic events. One request
  shape for all of them, so a fetched request and a pushed one are read
  alike.

  `state` is the stored state, except that an `outgoing` request past its
  deadline reads `expired` (derived, never stored: no timer has to fire
  for the state to be right). An `incoming` one past its deadline is never
  rendered: it is no longer listed, and the session's sweep deletes it.
  `expires_at` is the deadline of a pending request (`incoming`,
  `outgoing`, `expired`), and `null` on an answer (`accepted`, `refused`),
  which waits until a client has shown it. `at` is when the request
  entered its state.
  """
  alias Grappa.E2eRequests
  alias Grappa.E2eRequests.Request

  @type wire_state :: :incoming | :outgoing | :accepted | :refused | :expired

  @type request :: %{
          required(:id) => pos_integer(),
          required(:peer) => String.t(),
          required(:state) => wire_state(),
          required(:payload) => String.t() | nil,
          required(:at) => String.t(),
          required(:expires_at) => String.t() | nil
        }

  @typedoc "The body of `GET /networks/:network_id/e2e/requests`, oldest first."
  @type requests_response :: %{requests: [request()]}

  @typedoc "The body of `POST /networks/:network_id/e2e/requests` (202)."
  @type request_response :: %{request: request()}

  @typedoc """
  A request was created or changed state, pushed on the subject's user
  topic so every device of the account follows along.
  """
  @type e2e_request_payload :: %{kind: :e2e_request, network: String.t(), request: request()}

  @typedoc """
  A request is gone: accepted or refused on one device, dismissed,
  cancelled here or by the peer, or expired. Every device drops it.
  """
  @type e2e_request_gone_payload :: %{kind: :e2e_request_gone, network: String.t(), id: pos_integer()}

  @doc "One request, as of `now` (which decides `expired`)."
  @spec request(Request.t(), DateTime.t()) :: request()
  def request(%Request{} = r, %DateTime{} = now) do
    %{
      id: r.id,
      peer: r.peer,
      state: if(E2eRequests.expired?(r, now), do: :expired, else: r.state),
      payload: r.payload,
      at: DateTime.to_iso8601(r.updated_at),
      expires_at: iso8601(E2eRequests.expires_at(r))
    }
  end

  @doc "The `{requests}` body of a fetch."
  @spec requests_response([Request.t()], DateTime.t()) :: requests_response()
  def requests_response(requests, now) when is_list(requests), do: %{requests: Enum.map(requests, &request(&1, now))}

  @doc "The `{request}` body of an ask."
  @spec request_response(Request.t(), DateTime.t()) :: request_response()
  def request_response(%Request{} = r, now), do: %{request: request(r, now)}

  @doc "The user-topic push for a request created or changed."
  @spec request_payload(String.t(), Request.t(), DateTime.t()) :: e2e_request_payload()
  def request_payload(network_slug, %Request{} = r, now) when is_binary(network_slug),
    do: %{kind: :e2e_request, network: network_slug, request: request(r, now)}

  @doc "The user-topic push for a request that is gone."
  @spec gone_payload(String.t(), Request.t()) :: e2e_request_gone_payload()
  def gone_payload(network_slug, %Request{id: id}) when is_binary(network_slug) and is_integer(id),
    do: %{kind: :e2e_request_gone, network: network_slug, id: id}

  @spec iso8601(DateTime.t() | nil) :: String.t() | nil
  defp iso8601(nil), do: nil
  defp iso8601(%DateTime{} = at), do: DateTime.to_iso8601(at)
end
