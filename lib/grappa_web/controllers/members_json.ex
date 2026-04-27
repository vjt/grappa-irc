defmodule GrappaWeb.MembersJSON do
  @moduledoc """
  Wire shape: `%{"members" => [%{"nick" => String.t(), "modes" => [String.t()]}]}`.
  Already in mIRC sort order (`Session.list_members/3` does the sort);
  this view is pure pass-through.
  """

  @doc "Render the per-channel members list."
  @spec index(%{members: [%{nick: String.t(), modes: [String.t()]}]}) :: %{
          required(String.t()) => [%{required(String.t()) => term()}]
        }
  def index(%{members: members}) do
    %{
      "members" =>
        Enum.map(members, fn %{nick: nick, modes: modes} ->
          %{"nick" => nick, "modes" => modes}
        end)
    }
  end
end
