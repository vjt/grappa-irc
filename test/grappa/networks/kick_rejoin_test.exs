defmodule Grappa.Networks.KickRejoinTest do
  @moduledoc """
  Issue 2657 — the credential half of the kick-rejoin opt-in: the two
  columns, the narrow changeset, the context verb and its live-session
  bridge, and the boot snapshot the session plan carries. What a session
  does with the setting is `Grappa.Session.KickRejoinSessionTest`.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Networks.{Credential, Credentials, SessionPlan}
  alias Grappa.PubSub.Topic

  # The defaults are the migration's, read back through the database: a
  # credential bound with no word about kicks must come back OFF with ZNC's
  # 10 s delay, for every subject that existed before this column did.
  test "a freshly bound credential reads back opted out, with a 10 s delay" do
    {_, _, cred} = user_with_credential(6667, %{})

    reloaded = reload_credential(cred)

    assert reloaded.kick_rejoin == false
    assert reloaded.kick_rejoin_delay_seconds == 10
    assert Credential.kick_rejoin_snapshot(reloaded) == :off
  end

  describe "kick_rejoin_changeset/2" do
    test "accepts every delay of the closed set" do
      for delay <- Credential.kick_rejoin_delays() do
        cs = Credential.kick_rejoin_changeset(%Credential{}, %{kick_rejoin: true, kick_rejoin_delay_seconds: delay})
        assert cs.valid?, "expected #{delay} to be a valid delay"
      end
    end

    test "the closed set is the ruling's four delays" do
      assert Credential.kick_rejoin_delays() == [0, 10, 30, 60]
    end

    test "rejects a delay outside the closed set" do
      cs = Credential.kick_rejoin_changeset(%Credential{}, %{kick_rejoin: true, kick_rejoin_delay_seconds: 5})

      refute cs.valid?
      assert "is invalid" in errors_on(cs).kick_rejoin_delay_seconds
    end

    test "rejects an explicit nil in either field" do
      for field <- [:kick_rejoin, :kick_rejoin_delay_seconds] do
        cs = Credential.kick_rejoin_changeset(%Credential{}, %{field => nil})

        refute cs.valid?, "expected a nil #{field} to be rejected"
        assert "can't be blank" in errors_on(cs)[field]
      end
    end

    test "rejects a non-boolean opt-in" do
      cs = Credential.kick_rejoin_changeset(%Credential{}, %{kick_rejoin: "maybe"})

      refute cs.valid?
      assert "is invalid" in errors_on(cs).kick_rejoin
    end
  end

  describe "kick_rejoin_snapshot/1" do
    test "an opted-in credential carries its delay" do
      assert Credential.kick_rejoin_snapshot(%Credential{kick_rejoin: true, kick_rejoin_delay_seconds: 30}) ==
               {:on, 30}
    end

    test "an opted-out credential carries no delay, whatever the column holds" do
      assert Credential.kick_rejoin_snapshot(%Credential{kick_rejoin: false, kick_rejoin_delay_seconds: 0}) == :off
    end
  end

  describe "Credentials.update_kick_rejoin/2" do
    test "persists both fields and tells the live session over the settings bridge" do
      {user, network, cred} = user_with_credential(6667, %{})
      network_id = network.id
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user_settings(user.name))

      assert {:ok, updated} = Credentials.update_kick_rejoin(cred, %{kick_rejoin: true, kick_rejoin_delay_seconds: 0})

      assert updated.kick_rejoin == true
      assert updated.kick_rejoin_delay_seconds == 0
      assert reload_credential(cred).kick_rejoin == true
      assert_receive {:credential_kick_rejoin_changed, ^network_id, {:on, 0}}
    end

    test "switching it off keeps the delay in the row and tells the session :off" do
      {user, network, cred} = user_with_credential(6667, %{})
      network_id = network.id
      {:ok, cred} = Credentials.update_kick_rejoin(cred, %{kick_rejoin: true, kick_rejoin_delay_seconds: 60})
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user_settings(user.name))

      assert {:ok, _} = Credentials.update_kick_rejoin(cred, %{kick_rejoin: false})

      assert reload_credential(cred).kick_rejoin_delay_seconds == 60
      assert_receive {:credential_kick_rejoin_changed, ^network_id, :off}
    end

    test "an invalid delay writes nothing and tells nobody" do
      {user, _, cred} = user_with_credential(6667, %{})
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user_settings(user.name))

      assert {:error, %Ecto.Changeset{}} =
               Credentials.update_kick_rejoin(cred, %{kick_rejoin: true, kick_rejoin_delay_seconds: 7})

      assert reload_credential(cred).kick_rejoin == false
      refute_receive {:credential_kick_rejoin_changed, _, _}, 50
    end

    test "a visitor credential's change reaches the visitor's bridge" do
      {visitor, network} = visitor_with_network(6667)
      network_id = network.id
      {:ok, cred} = Credentials.get_visitor_credential(visitor.id, network.id)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.user_settings(Grappa.Subject.label({:visitor, visitor.id})))

      assert {:ok, _} = Credentials.update_kick_rejoin(cred, %{kick_rejoin: true, kick_rejoin_delay_seconds: 10})

      assert_receive {:credential_kick_rejoin_changed, ^network_id, {:on, 10}}
    end
  end

  describe "the session plan" do
    test "carries the credential's kick-rejoin snapshot" do
      {user, network, cred} = user_with_credential(6667, %{})
      {:ok, _} = Credentials.update_kick_rejoin(cred, %{kick_rejoin: true, kick_rejoin_delay_seconds: 30})

      {:ok, plan} = SessionPlan.resolve(Credentials.get_credential!(user, network))

      assert plan.restored_kick_rejoin == {:on, 30}
    end

    test "carries :off for a credential that never opted in" do
      {user, network, _} = user_with_credential(6667, %{})

      {:ok, plan} = SessionPlan.resolve(Credentials.get_credential!(user, network))

      assert plan.restored_kick_rejoin == :off
    end
  end
end
