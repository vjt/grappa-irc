defmodule Grappa.PushTest do
  @moduledoc """
  Context tests for `Grappa.Push` — Web Push subscription persistence.
  Covers create / list / get / delete / delete_dead / touch_last_used
  + the cross-user isolation boundary on `get_for_user/2`.

  `async: true` — each test uses a distinct user via the fixture, so
  Repo sandbox isolation is sufficient.
  """
  use Grappa.DataCase, async: true

  alias Grappa.{Accounts, Push}
  alias Grappa.Push.Subscription

  # Inline fixture mirroring the project convention (no ExMachina factory).
  defp user_fixture do
    name = "push-user-#{System.unique_integer([:positive])}"
    {:ok, user} = Accounts.create_user(%{name: name, password: "correct horse battery staple"})
    user
  end

  defp valid_attrs(opts \\ []) do
    base = %{
      endpoint: Keyword.get(opts, :endpoint, "https://fcm.googleapis.com/wp/abc#{System.unique_integer([:positive])}"),
      p256dh_key:
        Keyword.get(
          opts,
          :p256dh_key,
          "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM="
        ),
      auth_key: Keyword.get(opts, :auth_key, "tBHItJI5svbpez7KI4CCXg=="),
      user_agent: Keyword.get(opts, :user_agent, "Mozilla/5.0 (Linux) Firefox/124.0")
    }

    # #181 — optional `:supersedes` control key (a prior endpoint the
    # create should prune). Not a schema field; the context pops it.
    case Keyword.get(opts, :supersedes) do
      nil -> base
      supersedes -> Map.put(base, :supersedes, supersedes)
    end
  end

  describe "create/2" do
    test "inserts a new subscription with valid attrs" do
      user = user_fixture()
      assert {:ok, %Subscription{} = sub} = Push.create({:user, user.id}, valid_attrs())
      assert sub.user_id == user.id
      assert is_binary(sub.endpoint)
      assert is_binary(sub.p256dh_key)
      assert is_binary(sub.auth_key)
      assert sub.user_agent == "Mozilla/5.0 (Linux) Firefox/124.0"
      assert is_nil(sub.last_used_at)
    end

    test "user_agent is optional (nil persists cleanly)" do
      user = user_fixture()
      attrs = Map.delete(valid_attrs(), :user_agent)
      assert {:ok, %Subscription{user_agent: nil}} = Push.create({:user, user.id}, attrs)
    end

    test "missing endpoint returns validation error" do
      user = user_fixture()
      attrs = Map.delete(valid_attrs(), :endpoint)
      assert {:error, %Ecto.Changeset{errors: errors}} = Push.create({:user, user.id}, attrs)
      assert {"can't be blank", _} = errors[:endpoint]
    end

    test "rejects endpoint exceeding 2048-byte cap" do
      user = user_fixture()
      attrs = valid_attrs(endpoint: "https://x/" <> String.duplicate("a", 3000))
      assert {:error, %Ecto.Changeset{errors: errors}} = Push.create({:user, user.id}, attrs)
      assert errors[:endpoint] != nil
    end

    test "duplicate (user_id, endpoint) returns unique-constraint error on :endpoint" do
      user = user_fixture()
      attrs = valid_attrs(endpoint: "https://example.com/push/dupe-target")
      assert {:ok, _} = Push.create({:user, user.id}, attrs)
      assert {:error, %Ecto.Changeset{errors: errors}} = Push.create({:user, user.id}, attrs)
      # `error_key: :endpoint` on the unique_constraint routes the
      # error to the field cic actually cares about (the endpoint URL),
      # not to the first field of the index list (`:user_id`).
      assert {"has already been taken", _} = errors[:endpoint]
    end

    test "different users may share the same endpoint URL" do
      # Hypothetical: two users on the same physical device. Spec
      # doesn't enforce 1:1 user/endpoint, only 1:1
      # (user, endpoint).
      a = user_fixture()
      b = user_fixture()
      attrs = valid_attrs(endpoint: "https://example.com/push/shared")
      assert {:ok, _} = Push.create({:user, a.id}, attrs)
      assert {:ok, _} = Push.create({:user, b.id}, attrs)
    end

    test "last_used_at cannot be supplied via create attrs (server-controlled)" do
      # B1 review H1 close: `last_used_at` must NOT be in the cast
      # allowlist — otherwise a caller could supply an arbitrary
      # timestamp on insert, contradicting `touch_last_used/1`'s
      # contract that the field is server-controlled.
      user = user_fixture()

      attrs =
        Map.put(
          valid_attrs(),
          :last_used_at,
          DateTime.add(DateTime.utc_now(), -86_400, :second)
        )

      assert {:ok, sub} = Push.create({:user, user.id}, attrs)
      assert is_nil(sub.last_used_at)
    end
  end

  describe "create/2 — supersede prior endpoint (#181 churn dedup)" do
    # #181: a client silently drops its browser subscription (iOS SW-swap
    # / storage eviction) WITHOUT unsubscribing, so the push service keeps
    # 2xx-ing the dead endpoint → no 410 → the server prune never fires and
    # the row lingers as a ghost. The deterministic, SAFE reconciliation is
    # client-authoritative: on re-subscribe the client names the exact prior
    # endpoint it is replacing (`:supersedes`), and the server deletes THAT
    # subject-scoped row atomically with the insert. Never keys on subject /
    # user_agent (a user can own two identical-UA devices — proven in prod).
    test "deletes the superseded endpoint for the same subject before inserting" do
      user = user_fixture()
      {:ok, old} = Push.create({:user, user.id}, valid_attrs(endpoint: "https://push.example/OLD"))

      attrs = valid_attrs(endpoint: "https://push.example/NEW", supersedes: "https://push.example/OLD")

      assert {:ok, new} = Push.create({:user, user.id}, attrs)

      assert [%Subscription{endpoint: "https://push.example/NEW", id: new_id}] =
               Push.list_for_subject({:user, user.id})

      assert new_id == new.id
      assert Grappa.Repo.get(Subscription, old.id) == nil
    end

    test "supersede is subject-scoped — never deletes another subject's identical endpoint" do
      a = user_fixture()
      b = user_fixture()
      {:ok, b_row} = Push.create({:user, b.id}, valid_attrs(endpoint: "https://push.example/SHARED"))

      attrs = valid_attrs(endpoint: "https://push.example/A-NEW", supersedes: "https://push.example/SHARED")

      assert {:ok, _} = Push.create({:user, a.id}, attrs)

      # `a` cannot supersede a device it doesn't own — `b`'s row survives.
      assert Grappa.Repo.get(Subscription, b_row.id) != nil
    end

    test "absent :supersedes leaves existing rows untouched" do
      user = user_fixture()
      {:ok, keep} = Push.create({:user, user.id}, valid_attrs(endpoint: "https://push.example/KEEP"))
      {:ok, _} = Push.create({:user, user.id}, valid_attrs(endpoint: "https://push.example/ALSO"))

      assert length(Push.list_for_subject({:user, user.id})) == 2
      assert Grappa.Repo.get(Subscription, keep.id) != nil
    end

    test "superseding a non-existent endpoint still inserts (idempotent)" do
      user = user_fixture()

      attrs = valid_attrs(endpoint: "https://push.example/FRESH", supersedes: "https://push.example/GHOST")

      assert {:ok, _} = Push.create({:user, user.id}, attrs)

      assert [%Subscription{endpoint: "https://push.example/FRESH"}] =
               Push.list_for_subject({:user, user.id})
    end

    test ":supersedes equal to the new endpoint keeps the replay-422 contract" do
      # When the endpoint did NOT rotate, the same-endpoint re-subscribe
      # must still surface as the unique-constraint replay (cic reads it
      # as "already subscribed, refresh cache") — the supersede must NOT
      # self-delete the row it is about to (re)insert.
      user = user_fixture()
      {:ok, _} = Push.create({:user, user.id}, valid_attrs(endpoint: "https://push.example/SAME"))

      attrs = valid_attrs(endpoint: "https://push.example/SAME", supersedes: "https://push.example/SAME")

      assert {:error, %Ecto.Changeset{errors: errors}} = Push.create({:user, user.id}, attrs)
      assert {"has already been taken", _} = errors[:endpoint]
      assert length(Push.list_for_subject({:user, user.id})) == 1
    end
  end

  describe "list_for_user/1" do
    test "returns empty list for a user with no subscriptions" do
      assert Push.list_for_subject({:user, user_fixture().id}) == []
    end

    test "returns subscriptions newest-first" do
      user = user_fixture()
      {:ok, first} = Push.create({:user, user.id}, valid_attrs(endpoint: "https://example.com/push/first"))
      Process.sleep(2)
      {:ok, second} = Push.create({:user, user.id}, valid_attrs(endpoint: "https://example.com/push/second"))

      [a, b] = Push.list_for_subject({:user, user.id})
      assert a.id == second.id
      assert b.id == first.id
    end

    test "scopes to the queried user" do
      a = user_fixture()
      b = user_fixture()
      {:ok, _} = Push.create({:user, a.id}, valid_attrs(endpoint: "https://example.com/push/a"))
      {:ok, _} = Push.create({:user, b.id}, valid_attrs(endpoint: "https://example.com/push/b"))

      [only] = Push.list_for_subject({:user, a.id})
      assert only.user_id == a.id
    end
  end

  describe "get_for_user/2" do
    test "returns the subscription when it belongs to the user" do
      user = user_fixture()
      {:ok, sub} = Push.create({:user, user.id}, valid_attrs())
      assert {:ok, fetched} = Push.get_for_subject({:user, user.id}, sub.id)
      assert fetched.id == sub.id
    end

    test "returns :not_found for cross-user IDs" do
      a = user_fixture()
      b = user_fixture()
      {:ok, sub_a} = Push.create({:user, a.id}, valid_attrs())
      assert {:error, :not_found} = Push.get_for_subject({:user, b.id}, sub_a.id)
    end

    test "returns :not_found for unknown UUIDs" do
      user = user_fixture()
      assert {:error, :not_found} = Push.get_for_subject({:user, user.id}, Ecto.UUID.generate())
    end
  end

  describe "delete/1" do
    test "removes the subscription" do
      user = user_fixture()
      {:ok, sub} = Push.create({:user, user.id}, valid_attrs())
      assert {:ok, _} = Push.delete(sub)
      assert Push.list_for_subject({:user, user.id}) == []
    end
  end

  describe "delete_dead/1" do
    test "deletes the subscription matching the endpoint" do
      user = user_fixture()

      {:ok, _} =
        Push.create({:user, user.id}, valid_attrs(endpoint: "https://example.com/push/will-die"))

      assert {1, nil} = Push.delete_dead("https://example.com/push/will-die")
      assert Push.list_for_subject({:user, user.id}) == []
    end

    test "is idempotent for unknown endpoints" do
      assert {0, nil} = Push.delete_dead("https://example.com/push/never-existed")
    end

    test "leaves other subscriptions untouched" do
      user = user_fixture()
      {:ok, _} = Push.create({:user, user.id}, valid_attrs(endpoint: "https://example.com/push/keep"))
      {:ok, _} = Push.create({:user, user.id}, valid_attrs(endpoint: "https://example.com/push/dead"))
      assert {1, nil} = Push.delete_dead("https://example.com/push/dead")
      [remaining] = Push.list_for_subject({:user, user.id})
      assert remaining.endpoint == "https://example.com/push/keep"
    end
  end

  describe "touch_last_used/1" do
    test "sets last_used_at to a fresh timestamp" do
      user = user_fixture()
      {:ok, sub} = Push.create({:user, user.id}, valid_attrs())
      assert is_nil(sub.last_used_at)
      assert {:ok, touched} = Push.touch_last_used(sub)
      assert %DateTime{} = touched.last_used_at
    end

    test "advances last_used_at on a second call" do
      user = user_fixture()
      {:ok, sub} = Push.create({:user, user.id}, valid_attrs())
      {:ok, first} = Push.touch_last_used(sub)
      Process.sleep(2)
      {:ok, second} = Push.touch_last_used(first)
      assert DateTime.compare(second.last_used_at, first.last_used_at) == :gt
    end
  end

  describe "user CASCADE delete" do
    test "subscriptions vanish when the owning user is deleted" do
      user = user_fixture()
      {:ok, sub} = Push.create({:user, user.id}, valid_attrs())
      Grappa.Repo.delete!(user)
      assert Grappa.Repo.get(Subscription, sub.id) == nil
    end
  end

  # ---------------------------------------------------------------------------
  # subscription_clear_all_for_user/1
  # ---------------------------------------------------------------------------

  describe "subscription_clear_all_for_user/1" do
    test "deletes every push_subscription for the user_id" do
      user = user_fixture()
      other = user_fixture()

      {:ok, _} =
        Push.create({:user, user.id}, valid_attrs(endpoint: "https://a.example/push/clr-1"))

      {:ok, _} =
        Push.create({:user, user.id}, valid_attrs(endpoint: "https://b.example/push/clr-2"))

      {:ok, _} =
        Push.create({:user, other.id}, valid_attrs(endpoint: "https://c.example/push/clr-3"))

      assert :ok = Push.subscription_clear_all_for_user(user.id)

      assert Push.list_for_subject({:user, user.id}) == []

      assert [%Subscription{endpoint: "https://c.example/push/clr-3"}] =
               Push.list_for_subject({:user, other.id})
    end

    test "is idempotent when user has no subscriptions" do
      user = user_fixture()
      assert :ok = Push.subscription_clear_all_for_user(user.id)
    end
  end
end
