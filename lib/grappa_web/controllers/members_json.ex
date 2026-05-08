defmodule GrappaWeb.MembersJSON do
  @moduledoc """
  Wire shape: `%{members: [%{nick: String.t(), modes: [String.t()]}]}`.
  Already in mIRC sort order (`Grappa.Session.list_members/3` does the
  sort); this view is pure pass-through.

  W4: the per-member shape is owned by `Grappa.Session.list_members/3`
  — `[%{nick:, modes:}]`. Re-mapping each entry into `%{"nick" =>,
  "modes" =>}` (the pre-W4 form) duplicated that contract here; Jason
  serializes atom-keyed maps to JSON string keys natively, so the only
  thing this view contributes is the `:members` envelope.
  """

  alias Grappa.Session

  @doc "Render the per-channel members list."
  @spec index(%{members: [Session.member()]}) :: %{members: [Session.member()]}
  def index(%{members: members}), do: %{members: members}
end
