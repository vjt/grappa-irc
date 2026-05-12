defmodule GrappaWeb.MembersJSON do
  @moduledoc """
  Wire shape: `%{members: [%{nick: String.t(), modes: [String.t()]}]}`.
  Already in mIRC sort order (`Grappa.Session.list_members/3` does the
  sort); this view is pure pass-through.

  W4 (pre-bucket-D): the per-member shape was a context-internal type
  returned directly here, with no wire module — the REST envelope
  and the Channel `members_seeded` event each constructed their own
  `members:` map without a shared per-row source. Today a future
  shape change to `Session.member()` (struct wrapping, extra fields)
  would silently leak Elixir-internals across two surfaces AND
  re-introduce the CP15 B6 fastlane crash class.

  Bucket D (codebase review 2026-05-12 web/S3+S4): the per-member
  shape moves into `Grappa.Session.Wire.member/1`; this view +
  `Session.Wire.members_seeded/3` both delegate so REST + Channel
  agree on a single per-row contract. Envelope wrappers stay
  surface-specific (REST returns just `members`; Channel keeps the
  `kind/network/channel/members` event envelope).
  """

  alias Grappa.Session
  alias Grappa.Session.Wire

  @doc "Render the per-channel members list."
  @spec index(%{members: [Session.member()]}) :: Wire.members_index_payload()
  def index(%{members: members}), do: Wire.members_index(members)
end
