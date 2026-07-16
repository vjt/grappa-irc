defmodule Grappa.SubjectSearch.Result do
  @moduledoc """
  #257 — one row of the admin subject-search tagged union.

  A subject is either a `:user` (operator account) or a `:visitor`
  (self-service, multi-network) — the established `Grappa.Subject` XOR.
  `id` is the STABLE key (user id / visitor id), NEVER the nick: a visitor
  is multi-network, so its nick is not a stable identity key (#257). On
  select, cic stores this `{type, id}` verbatim into the vhost-grant body,
  where it maps 1:1 onto `{subject_type, subject_id}`.

  `network` disambiguates a multi-network visitor ("network - nickname"
  display); it is `nil` for a user (an account has no single network — we
  do not fabricate one). `nick` is the account name for a user, the
  per-network credential nick for a visitor.
  """

  @enforce_keys [:type, :id, :nick]
  defstruct [:type, :id, :network, :nick]

  @type t :: %__MODULE__{
          type: :user | :visitor,
          id: Ecto.UUID.t(),
          network: String.t() | nil,
          nick: String.t()
        }
end
