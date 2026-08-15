defmodule Grappa.TestSupport.SubjectProvisionTest do
  @moduledoc """
  Unit tests for `Grappa.TestSupport.SubjectProvision` — the #1078
  per-spec subject orchestrator behind `POST /admin/test/subject`.

  The happy path ends in a live upstream IRC session and is covered by
  the e2e suite, which has one. What is covered HERE is everything that
  can be asserted without an upstream, and in particular the property
  that makes this verb safe to call 660 times a run: **a provision that
  fails leaves no user row behind**. A half-provisioned subject would
  sit in `/admin/users` and `/admin/sessions` for the rest of the run
  and silently change what every later spec observes there — the exact
  class of cross-spec residue #1078 is about.

  A network fixture has no servers bound, so `SessionPlan.resolve/1`
  cannot build a plan and the settle step fails fast. That is the lever
  used to reach the rollback path without an upstream.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{Accounts, Networks, ReadCursor, Repo, ScrollbackHelpers}
  alias Grappa.TestSupport.SubjectProvision

  defp params(name, slug, overrides) do
    Map.merge(
      %{
        name: name,
        password: "provision-test-password",
        network_slug: slug,
        nick: name,
        autojoin_channels: ["#bofh"],
        seed: [%{name: "#bofh", seed_count: 3, seed_sender: "seed-bot"}]
      },
      overrides
    )
  end

  defp unique_name, do: "prov#{System.unique_integer([:positive])}"

  describe "provision!/1" do
    test "an unknown network slug fails before anything is created" do
      name = unique_name()

      assert {:error, {:network_not_found, "no-such-net"}} =
               SubjectProvision.provision!(params(name, "no-such-net", %{}))

      assert Accounts.get_user_by_name(name) == nil
    end

    test "a name already taken fails as a changeset, leaving the incumbent alone" do
      incumbent = user_fixture(name: unique_name())
      network = network_fixture()

      assert {:error, {:user_invalid, %Ecto.Changeset{}}} =
               SubjectProvision.provision!(params(incumbent.name, network.slug, %{}))

      # The incumbent is still there — the failed provision did not roll
      # back somebody else's user on a name collision.
      assert %Accounts.User{id: id} = Accounts.get_user_by_name(incumbent.name)
      assert id == incumbent.id
    end

    test "a settle failure rolls the whole subject back — no user, no credential" do
      name = unique_name()
      # No server bound to this network → SessionPlan.resolve/1 fails →
      # the settle step errors without ever reaching an upstream.
      network = network_fixture()

      assert {:error, {:reconnect_failed, slug, _}} =
               SubjectProvision.provision!(params(name, network.slug, %{}))

      assert slug == network.slug
      assert Accounts.get_user_by_name(name) == nil
    end
  end

  describe "teardown!/1" do
    test "an unknown name is reported, not swallowed" do
      assert {:error, :user_not_found} = SubjectProvision.teardown!("nobody-by-that-name")
    end

    test "a case-variant spelling of the name tears down the same subject (#1353)" do
      # This resolves the account the same way every other account reader
      # does: the name is an identity key, so the teardown a spec asks for
      # cannot depend on how the harness capitalised it.
      user = user_fixture(name: unique_name())
      typed = String.upcase(user.name)
      refute typed == user.name

      assert :ok = SubjectProvision.teardown!(typed)
      assert Accounts.get_user_by_name(user.name) == nil
    end

    test "removes the user, its credential and everything keyed to it" do
      user = user_fixture(name: unique_name())
      network = network_fixture()

      {:ok, _} =
        Networks.Credentials.bind_credential(user, network, %{
          nick: "prov-nick",
          auth_method: :none,
          autojoin_channels: ["#bofh"],
          connection_state: :parked
        })

      {:ok, message} =
        ScrollbackHelpers.insert(%{
          user_id: user.id,
          network_id: network.id,
          channel: "#bofh",
          server_time: 1,
          kind: :privmsg,
          sender: "seed-bot",
          body: "seed line #1"
        })

      {:ok, _} = ReadCursor.set({:user, user.id}, network.id, "#bofh", message.id)

      assert :ok = SubjectProvision.teardown!(user.name)

      assert Accounts.get_user_by_name(user.name) == nil
      assert Networks.Credentials.get_credential(user, network) == {:error, :not_found}
      # The FK cascade is what makes "fresh by construction" true — if it
      # ever stops taking the subject's rows with the subject, a torn-down
      # spec's scrollback outlives it and #1078 comes back by another door.
      assert Repo.get(Grappa.Scrollback.Message, message.id) == nil
      assert ReadCursor.get({:user, user.id}, network.id, "#bofh") == nil
    end
  end
end
