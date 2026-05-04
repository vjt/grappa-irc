defmodule GrappaWeb.Subject do
  @moduledoc """
  Web-layer subject discriminator (M-web-1).

  `GrappaWeb.Plugs.Authn` assigns a single `:current_subject` tagged
  tuple carrying the loaded subject struct:

      {:user, %Grappa.Accounts.User{}} | {:visitor, %Grappa.Visitors.Visitor{}}

  This is the controller-side view: rich enough that consumers don't
  re-fetch and don't drift from a parallel `:current_user` /
  `:current_visitor` assign (which is what M-web-1 closes — the
  KeyError race when one is set and the other isn't).

  The Session / Scrollback boundary (`t:Grappa.Session.subject/0`) speaks
  the leaner `{:user, id} | {:visitor, id}` shape; controllers
  delegating downstream call `to_session/1` to convert.
  """

  alias Grappa.Accounts.User
  alias Grappa.Visitors.Visitor

  @typedoc "Web-layer subject — carries the loaded struct."
  @type t :: {:user, User.t()} | {:visitor, Visitor.t()}

  @doc """
  Convert a web-layer subject tuple to the Session/Scrollback boundary
  shape (`t:Grappa.Session.subject/0` — bare-id tuple).
  """
  @spec to_session(t()) :: Grappa.Session.subject()
  def to_session({:user, %User{id: id}}), do: {:user, id}
  def to_session({:visitor, %Visitor{id: id}}), do: {:visitor, id}
end
