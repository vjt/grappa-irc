defmodule Grappa.SubjectSearch.AdminWire do
  @moduledoc """
  Operator-facing JSON wire shape for the #257 subject-search autocomplete.
  Sibling of `Grappa.Vhosts.AdminWire`; explicit per-field projection (no
  wildcard `Map.take/2`) so a future field is a deliberate edit here.

  The closed-set `:type` atom is stringified to `"user"` / `"visitor"` so
  it matches the vhost-grant body's `subject_type` 1:1 — cic mirrors the
  tag, it originates no state.
  """
  alias Grappa.SubjectSearch.Result

  @type result_json :: %{
          type: String.t(),
          id: String.t(),
          network: String.t() | nil,
          nick: String.t()
        }

  @doc "Renders a search `Result` to the admin JSON shape."
  @spec result_to_admin_json(Result.t()) :: result_json()
  def result_to_admin_json(%Result{type: type, id: id, network: network, nick: nick})
      when type in [:user, :visitor] do
    %{type: Atom.to_string(type), id: id, network: network, nick: nick}
  end
end
