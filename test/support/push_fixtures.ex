defmodule Grappa.PushFixtures do
  @moduledoc """
  Push subscription rows written straight to the table, past
  `Grappa.Push.Subscription.changeset/2`.

  Two reasons a delivery test needs that, and neither is a shortcut:

    * `Bypass` serves plain `http` on loopback, and the changeset refuses
      both since #2401. The sender still has to deliver to whatever the
      table holds, so its tests write the row the way the table can hold
      it.
    * Rows saved before #2401 were never checked. The send-time policy
      exists for them, and its tests need such a row to refuse.

  Anything testing what a CLIENT may register goes through
  `Grappa.Push.create/2`, never through here.
  """
  use Boundary,
    top_level?: true,
    deps: [Grappa.Push, Grappa.Repo, Grappa.Subject]

  alias Grappa.Push.Subscription
  alias Grappa.{Repo, Subject}

  @doc "Inserts a `push_subscriptions` row for `subject` from raw `attrs`, unvalidated. Raises on a DB constraint."
  @spec stored_subscription!(Subject.t(), map()) :: Subscription.t()
  def stored_subscription!({_, _} = subject, attrs) when is_map(attrs) do
    Subscription
    |> struct!(Subject.put_subject_id(attrs, subject))
    |> Repo.insert!()
  end
end
