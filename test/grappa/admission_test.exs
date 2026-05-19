defmodule Grappa.AdmissionTest do
  @moduledoc """
  Verb-level tests for Grappa.Admission.check_capacity/1. Covers
  each cap dimension and the bypass paths (Bootstrap flows skip
  client-cap because no client_id).
  """
  use Grappa.DataCase, async: false

  alias Grappa.{Admission, AdmissionStateHelpers, Repo, SessionRegistry}
  alias Grappa.Admission.Captcha.{Disabled, HCaptcha, Turnstile}
  alias Grappa.Admission.{Config, NetworkCircuit}
  alias Grappa.Networks.Network
  alias Grappa.Session.Server, as: SessionServer

  setup do
    AdmissionStateHelpers.reset_network_circuit()

    # network_with_server/1 requires :port (Keyword.fetch!) and returns
    # a {Network.t(), Server.t()} tuple — pin both at the test boundary.
    {network, _} = Grappa.AuthFixtures.network_with_server(port: 6_667)
    {:ok, network: network}
  end

  describe "check_capacity/1 — network circuit gate" do
    test "open circuit short-circuits with {:network_circuit_open, retry_after}",
         %{network: net} do
      for _ <- 1..NetworkCircuit.threshold() do
        :ok = NetworkCircuit.record_failure(net.id)
      end

      _ = :sys.get_state(NetworkCircuit)

      input = %{
        network_id: net.id,
        client_id: "44c2ab8a-cb38-4960-b92a-a7aefb190386",
        flow: :login_fresh,
        requesting_subject: nil
      }

      # Task 5: tuple shape carries retry_after seconds. Bare atom no
      # longer occurs at runtime — FallbackController emits Retry-After
      # header from the integer payload.
      assert {:error, {:network_circuit_open, retry_after}} =
               Admission.check_capacity(input)

      assert is_integer(retry_after) and retry_after >= 0
    end
  end

  describe "check_capacity/1 — network total cap" do
    test "nil cap = uncapped", %{network: net} do
      input = %{
        network_id: net.id,
        client_id: "44c2ab8a-cb38-4960-b92a-a7aefb190386",
        flow: :login_fresh,
        requesting_subject: nil
      }

      assert :ok = Admission.check_capacity(input)
    end

    test "visitor cap exceeded by visitor session → :visitor_cap_exceeded",
         %{network: net} do
      # U-2: subject-aware split. Visitor flow consults
      # max_concurrent_visitor_sessions; the registry counts live
      # visitor sessions only. Hand-registered key MUST go through
      # `Server.registry_key/2` + correct subject shape so the
      # production match-spec actually matches.
      {:ok, net} =
        net
        |> Network.changeset(%{max_concurrent_visitor_sessions: 1})
        |> Repo.update()

      {:ok, _} =
        Registry.register(
          SessionRegistry,
          SessionServer.registry_key({:visitor, "fake-vid"}, net.id),
          nil
        )

      input = %{
        network_id: net.id,
        client_id: "44c2ab8a-cb38-4960-b92a-a7aefb190386",
        flow: :login_fresh,
        requesting_subject: nil
      }

      assert {:error, :visitor_cap_exceeded} = Admission.check_capacity(input)
    end

    test "user cap exceeded by user session → :user_cap_exceeded",
         %{network: net} do
      # U-2: user flow consults max_concurrent_user_sessions; only
      # `{:user, _}` registry entries count toward it.
      {:ok, net} =
        net
        |> Network.changeset(%{max_concurrent_user_sessions: 1})
        |> Repo.update()

      {:ok, _} =
        Registry.register(
          SessionRegistry,
          SessionServer.registry_key({:user, "fake-uid"}, net.id),
          nil
        )

      input = %{
        network_id: net.id,
        client_id: "44c2ab8a-cb38-4960-b92a-a7aefb190386",
        flow: :patch_network_connect,
        requesting_subject: nil
      }

      assert {:error, :user_cap_exceeded} = Admission.check_capacity(input)
    end

    test "visitor cap full does NOT block user flow", %{network: net} do
      # U-2: caps are independent per subject_kind. A visitor cap
      # exhausted by visitor sessions must not reject a user-flow
      # admission check.
      {:ok, net} =
        net
        |> Network.changeset(%{
          max_concurrent_visitor_sessions: 1,
          max_concurrent_user_sessions: 5
        })
        |> Repo.update()

      {:ok, _} =
        Registry.register(
          SessionRegistry,
          SessionServer.registry_key({:visitor, "fake-vid"}, net.id),
          nil
        )

      input = %{
        network_id: net.id,
        client_id: "44c2ab8a-cb38-4960-b92a-a7aefb190386",
        flow: :patch_network_connect,
        requesting_subject: nil
      }

      assert :ok = Admission.check_capacity(input)
    end

    test "user cap full does NOT block visitor flow", %{network: net} do
      # U-2: mirror — user cap exhausted does not reject a visitor.
      {:ok, net} =
        net
        |> Network.changeset(%{
          max_concurrent_visitor_sessions: 5,
          max_concurrent_user_sessions: 1
        })
        |> Repo.update()

      {:ok, _} =
        Registry.register(
          SessionRegistry,
          SessionServer.registry_key({:user, "fake-uid"}, net.id),
          nil
        )

      input = %{
        network_id: net.id,
        client_id: "44c2ab8a-cb38-4960-b92a-a7aefb190386",
        flow: :login_fresh,
        requesting_subject: nil
      }

      assert :ok = Admission.check_capacity(input)
    end

    test "user cap nil = uncapped (matches visitor nil semantics)",
         %{network: net} do
      {:ok, net} =
        net
        |> Network.changeset(%{max_concurrent_user_sessions: nil})
        |> Repo.update()

      input = %{
        network_id: net.id,
        client_id: "44c2ab8a-cb38-4960-b92a-a7aefb190386",
        flow: :patch_network_connect,
        requesting_subject: nil
      }

      assert :ok = Admission.check_capacity(input)
    end
  end

  describe "check_capacity/1 — Bootstrap paths skip client cap" do
    test ":bootstrap_user with nil client_id is :ok", %{network: net} do
      input = %{
        network_id: net.id,
        client_id: nil,
        flow: :bootstrap_user,
        requesting_subject: nil
      }

      assert :ok = Admission.check_capacity(input)
    end

    test ":bootstrap_visitor with nil client_id is :ok", %{network: net} do
      input = %{
        network_id: net.id,
        client_id: nil,
        flow: :bootstrap_visitor,
        requesting_subject: nil
      }

      assert :ok = Admission.check_capacity(input)
    end
  end

  describe "check_capacity/1 — client cap subject-aware (UD5.B)" do
    # UD5.B: a device (client_id) holding a session for subject S₁ must NOT
    # contribute to the client-cap accounting for subject S₂ when S₁ and S₂
    # are different subject_kinds (visitor vs user). The production filter
    # is `Admission.count_subjects_for_client_on_network/3` which uses two
    # disjoint clauses (visitor JOINs visitors, user JOINs credentials) so
    # cross-subject contamination is structurally impossible.
    #
    # The bucket exists because U-2 incidentally shipped UD5.B's behaviour
    # without explicit coverage of the cross-subject independence invariant
    # (`network_cap` independence was tested but `client_cap` was not). U-4
    # closes that gap. If a future refactor merges the two clauses into a
    # single OR-join, these tests fire.
    # Module attributes are file-scoped in Elixir, so this name is
    # ud5b-prefixed to avoid silent shadowing if a future sibling test
    # outside this describe references `@client_id`.
    @ud5b_client_id "a5000000-0000-4000-8000-000000000044"

    test "visitor session on client_id X does NOT block user login on same client_id",
         %{network: net} do
      # max_per_client = 1: the tightest cap. A visitor session occupying
      # the slot must NOT make a user-flow `check_capacity` fail when
      # querying for the same client_id.
      {:ok, net} =
        net
        |> Network.changeset(%{max_per_client: 1})
        |> Repo.update()

      # Stand up a visitor row pinned to this network's slug + an
      # accounts_session bound to (visitor, client_id) — this is the row
      # `count_subjects_for_client_on_network/3` (visitor clause) would
      # count, but the user clause (which we're about to exercise) joins
      # against `credentials` so it cannot see this row.
      {:ok, visitor} =
        Grappa.Visitors.find_or_provision_anon("ud5b-vis", net.slug, "1.2.3.4")

      {:ok, _} =
        Grappa.Accounts.create_session(
          {:visitor, visitor.id},
          "1.2.3.4",
          "ua",
          client_id: @ud5b_client_id
        )

      input = %{
        network_id: net.id,
        client_id: @ud5b_client_id,
        flow: :patch_network_connect,
        requesting_subject: nil
      }

      assert :ok = Admission.check_capacity(input)
    end

    test "user session on client_id X does NOT block visitor login on same client_id",
         %{network: net} do
      # Mirror: a user session occupying the slot must NOT block a fresh
      # visitor login from the same device. Exercises the visitor clause
      # against a populated user row.
      {:ok, net} =
        net
        |> Network.changeset(%{max_per_client: 1})
        |> Repo.update()

      user = Grappa.AuthFixtures.user_fixture(name: "ud5b-user-#{System.unique_integer([:positive])}")
      _ = Grappa.AuthFixtures.credential_fixture(user, net)

      {:ok, _} =
        Grappa.Accounts.create_session(
          {:user, user.id},
          "1.2.3.4",
          "ua",
          client_id: @ud5b_client_id
        )

      input = %{
        network_id: net.id,
        client_id: @ud5b_client_id,
        flow: :login_fresh,
        requesting_subject: nil
      }

      assert :ok = Admission.check_capacity(input)
    end

    test "visitor session on client_id X DOES block another visitor login on same client_id",
         %{network: net} do
      # Same-subject saturation — sanity check that the subject-aware
      # filter still REJECTS legit same-bucket overflow. Without this
      # test, a regression that always returned :ok from the visitor
      # clause would slip past the cross-subject independence tests.
      {:ok, net} =
        net
        |> Network.changeset(%{max_per_client: 1})
        |> Repo.update()

      {:ok, visitor} =
        Grappa.Visitors.find_or_provision_anon("ud5b-vis-block", net.slug, "1.2.3.4")

      {:ok, _} =
        Grappa.Accounts.create_session(
          {:visitor, visitor.id},
          "1.2.3.4",
          "ua",
          client_id: @ud5b_client_id
        )

      input = %{
        network_id: net.id,
        client_id: @ud5b_client_id,
        flow: :login_fresh,
        requesting_subject: nil
      }

      assert {:error, :client_cap_exceeded} = Admission.check_capacity(input)
    end

    test "revoked visitor session on client_id X does NOT count toward cap",
         %{network: net} do
      # UD5.A composition with UD5.B: after logout (revoke_session sets
      # revoked_at), the device's slot must free. The `is_nil(revoked_at)`
      # filter in both count clauses is the load-bearing predicate.
      {:ok, net} =
        net
        |> Network.changeset(%{max_per_client: 1})
        |> Repo.update()

      {:ok, visitor} =
        Grappa.Visitors.find_or_provision_anon("ud5b-revoked", net.slug, "1.2.3.4")

      {:ok, vsession} =
        Grappa.Accounts.create_session(
          {:visitor, visitor.id},
          "1.2.3.4",
          "ua",
          client_id: @ud5b_client_id
        )

      :ok = Grappa.Accounts.revoke_session(vsession.id)

      input = %{
        network_id: net.id,
        client_id: @ud5b_client_id,
        flow: :login_fresh,
        requesting_subject: nil
      }

      assert :ok = Admission.check_capacity(input)
    end

    test "two sessions for SAME visitor count as 1 (DISTINCT clause; cap=N>1 path)",
         %{network: net} do
      # Reviewer R1 MED-1: the production query uses `count(s.visitor_id,
      # :distinct)`, so multiple accounts_sessions for the same subject
      # collapse to 1 toward the cap. A regression that drops `:distinct`
      # (turning the count into `count(s.id)`) would silently start
      # counting same-subject duplicates as N — none of the cap=1
      # single-session tests above would catch it because they each have
      # exactly one row. This test exercises BOTH the cap=N>1 path AND
      # the DISTINCT predicate at once.
      {:ok, net} =
        net
        |> Network.changeset(%{max_per_client: 2})
        |> Repo.update()

      {:ok, visitor1} =
        Grappa.Visitors.find_or_provision_anon("ud5b-distinct-1", net.slug, "1.2.3.4")

      # Two browser tabs / two devices = two accounts_sessions on same
      # visitor_id. Distinct count must still see this as 1.
      {:ok, _} =
        Grappa.Accounts.create_session(
          {:visitor, visitor1.id},
          "1.2.3.4",
          "ua-tab-1",
          client_id: @ud5b_client_id
        )

      {:ok, _} =
        Grappa.Accounts.create_session(
          {:visitor, visitor1.id},
          "1.2.3.4",
          "ua-tab-2",
          client_id: @ud5b_client_id
        )

      # A second DIFFERENT visitor on same client_id under cap=2 must be
      # admitted: distinct count is 1 (visitor1's two rows collapse),
      # plus the new candidate = 2, which is == cap (>= is the rejection
      # predicate). The candidate is NOT yet counted (admission checks
      # BEFORE spawn), so count(1) >= cap(2) is false → :ok.
      input = %{
        network_id: net.id,
        client_id: @ud5b_client_id,
        flow: :login_fresh,
        requesting_subject: nil
      }

      assert :ok = Admission.check_capacity(input)
    end

    test "requesting subject's own session does NOT count toward its own cap (UX-5 BC)",
         %{network: net} do
      # UX-5 bucket BC (2026-05-19): the cap blocks DIFFERENT subjects on
      # the same device, NEVER the requesting subject's own pre-existing
      # session. T32 park then immediate /connect repro: vjt's browser
      # holds an accounts_session under client_id X; X-button parks the
      # IRC session; vjt PATCHes /connect from same device → the cap was
      # COUNTING vjt's own session against him, so 1 >= 1 → 503. Bug
      # fired for first-PATCH-from-logged-in-user too; T32 was just the
      # most visible path. Fix: `capacity_input.requesting_subject` is
      # excluded from the count.
      {:ok, net} =
        net
        |> Network.changeset(%{max_per_client: 1})
        |> Repo.update()

      user = Grappa.AuthFixtures.user_fixture(name: "ux5bc-self-#{System.unique_integer([:positive])}")
      _ = Grappa.AuthFixtures.credential_fixture(user, net)

      {:ok, _} =
        Grappa.Accounts.create_session(
          {:user, user.id},
          "1.2.3.4",
          "ua",
          client_id: @ud5b_client_id
        )

      input = %{
        network_id: net.id,
        client_id: @ud5b_client_id,
        flow: :patch_network_connect,
        requesting_subject: {:user, user.id}
      }

      assert :ok = Admission.check_capacity(input)
    end

    test "requesting subject's own session DOES count when requesting_subject is nil (Case 1 semantics)",
         %{network: net} do
      # Login Case 1 (fresh anon provision) carries `requesting_subject:
      # nil` because there is no prior subject. The cap must still count
      # whatever live sessions the device holds for the network — pre-
      # fix semantics for the unknown-subject path. This test is the
      # nil-branch sanity check; the `visitor session ... DOES block
      # ANOTHER visitor login` test above covers the cross-subject path.
      {:ok, net} =
        net
        |> Network.changeset(%{max_per_client: 1})
        |> Repo.update()

      {:ok, visitor} =
        Grappa.Visitors.find_or_provision_anon("ux5bc-nil-prior", net.slug, "1.2.3.4")

      {:ok, _} =
        Grappa.Accounts.create_session(
          {:visitor, visitor.id},
          "1.2.3.4",
          "ua",
          client_id: @ud5b_client_id
        )

      input = %{
        network_id: net.id,
        client_id: @ud5b_client_id,
        flow: :login_fresh,
        requesting_subject: nil
      }

      assert {:error, :client_cap_exceeded} = Admission.check_capacity(input)
    end

    test "requesting subject's own session does NOT block visitor login-existing path (UX-5 BC, visitor mirror)",
         %{network: net} do
      # Mirror of the user path. Visitor login_existing (Case 2 password,
      # Case 3 anon token) MUST not be blocked by the visitor's own
      # pre-existing accounts_session on the same device. Pre-fix this
      # silently failed Case 2/3 admission whenever max_per_client=1 and
      # the visitor was already logged in elsewhere on the same device.
      {:ok, net} =
        net
        |> Network.changeset(%{max_per_client: 1})
        |> Repo.update()

      {:ok, visitor} =
        Grappa.Visitors.find_or_provision_anon("ux5bc-vis-self", net.slug, "1.2.3.4")

      {:ok, _} =
        Grappa.Accounts.create_session(
          {:visitor, visitor.id},
          "1.2.3.4",
          "ua",
          client_id: @ud5b_client_id
        )

      input = %{
        network_id: net.id,
        client_id: @ud5b_client_id,
        flow: :login_existing,
        requesting_subject: {:visitor, visitor.id}
      }

      assert :ok = Admission.check_capacity(input)
    end

    test "self-exclusion does NOT leak across subject_kinds (cross-clause disjointness)",
         %{network: net} do
      # The visitor + user count clauses are disjoint joins. A user-flow
      # admission carrying `requesting_subject: {:user, _}` must not
      # accidentally exclude visitor rows (and vice versa) — that would
      # silently weaken the cap. Standing up BOTH a visitor session AND
      # a user-with-matching-credential row under the same client_id is
      # not a normal scenario (the visitor/user clauses each only see
      # their own subject_kind's rows), but the test is a regression
      # guard against a future refactor that merges the clauses.
      {:ok, net} =
        net
        |> Network.changeset(%{max_per_client: 1})
        |> Repo.update()

      # Visitor row + accounts_session on the same client_id: contributes
      # to the visitor clause only.
      {:ok, _} =
        Grappa.Visitors.find_or_provision_anon("ux5bc-cross-vis", net.slug, "1.2.3.4")

      # User flow, no user-row noise: count should be 0, self-exclusion
      # is a no-op here, cap admits.
      user = Grappa.AuthFixtures.user_fixture(name: "ux5bc-cross-#{System.unique_integer([:positive])}")
      _ = Grappa.AuthFixtures.credential_fixture(user, net)

      input = %{
        network_id: net.id,
        client_id: @ud5b_client_id,
        flow: :patch_network_connect,
        requesting_subject: {:user, user.id}
      }

      assert :ok = Admission.check_capacity(input)
    end

    test "visitor on different network's slug does NOT count toward current network's cap",
         %{network: net} do
      # Reviewer R1 MED-2: the visitor clause filters on
      # `v.network_slug == ^slug` — a regression that drops this join
      # filter would let any visitor on the same client_id (regardless
      # of which network they're pinned to) count toward this network's
      # cap. None of the prior tests stand up a cross-network noise row.
      {:ok, net} =
        net
        |> Network.changeset(%{max_per_client: 1})
        |> Repo.update()

      # Noise: a visitor pinned to a DIFFERENT network, same client_id.
      # Must not count toward `net`'s admission decision below.
      {other_net, _} =
        Grappa.AuthFixtures.network_with_server(
          port: 6_668,
          slug: "ud5b-other-#{System.unique_integer([:positive])}"
        )

      {:ok, other_visitor} =
        Grappa.Visitors.find_or_provision_anon("ud5b-other", other_net.slug, "1.2.3.4")

      {:ok, _} =
        Grappa.Accounts.create_session(
          {:visitor, other_visitor.id},
          "1.2.3.4",
          "ua",
          client_id: @ud5b_client_id
        )

      # Admission decision for `net` under same client_id: cap=1,
      # count for THIS network is 0 (the other_visitor row's
      # network_slug doesn't match), so :ok.
      input = %{
        network_id: net.id,
        client_id: @ud5b_client_id,
        flow: :login_fresh,
        requesting_subject: nil
      }

      assert :ok = Admission.check_capacity(input)
    end
  end

  describe "verify_captcha/2 — Disabled provider" do
    test "always returns :ok" do
      assert :ok = Admission.verify_captcha("any-token", "1.2.3.4")
      assert :ok = Admission.verify_captcha(nil, nil)
      assert :ok = Admission.verify_captcha("", "1.2.3.4")
    end
  end

  # ---------------------------------------------------------------------------
  # captcha_provider_wire/0 — delegates to configured impl's wire_name/0
  # ---------------------------------------------------------------------------

  describe "captcha_provider_wire/0" do
    @pt_key {Config, :config}

    setup do
      original_pt = :persistent_term.get(@pt_key, :__unset__)
      original_env = Application.get_env(:grappa, :admission)

      on_exit(fn ->
        case original_pt do
          :__unset__ -> :persistent_term.erase(@pt_key)
          cfg -> :persistent_term.put(@pt_key, cfg)
        end

        if is_nil(original_env),
          do: Application.delete_env(:grappa, :admission),
          else: Application.put_env(:grappa, :admission, original_env)
      end)

      :ok
    end

    test "returns wire_name from configured impl module" do
      Config.put_test_config(%Config{
        captcha_provider: Turnstile,
        captcha_secret: "stub",
        captcha_site_key: "stub",
        turnstile_endpoint: "https://stub",
        hcaptcha_endpoint: "https://stub"
      })

      assert Admission.captcha_provider_wire() == "turnstile"

      Config.put_test_config(%Config{
        captcha_provider: HCaptcha,
        captcha_secret: "stub",
        captcha_site_key: "stub",
        turnstile_endpoint: "https://stub",
        hcaptcha_endpoint: "https://stub"
      })

      assert Admission.captcha_provider_wire() == "hcaptcha"

      Config.put_test_config(%Config{
        captcha_provider: Disabled,
        captcha_secret: nil,
        captcha_site_key: nil,
        turnstile_endpoint: "https://stub",
        hcaptcha_endpoint: "https://stub"
      })

      assert Admission.captcha_provider_wire() == "disabled"
    end
  end

  # ---------------------------------------------------------------------------
  # Telemetry — capacity_reject event
  # ---------------------------------------------------------------------------

  defp attach_reject_event do
    id = "admission-test-reject-#{System.unique_integer([:positive])}"
    test_pid = self()

    :ok =
      :telemetry.attach(
        id,
        [:grappa, :admission, :capacity, :reject],
        fn name, measurements, metadata, pid ->
          send(pid, {:telemetry, name, measurements, metadata})
        end,
        test_pid
      )

    on_exit(fn -> :telemetry.detach(id) end)
    id
  end

  describe "check_capacity/1 — telemetry capacity_reject events" do
    test "emits :capacity, :reject when circuit open", %{network: net} do
      attach_reject_event()

      for _ <- 1..NetworkCircuit.threshold() do
        :ok = NetworkCircuit.record_failure(net.id)
      end

      _ = :sys.get_state(NetworkCircuit)

      input = %{
        network_id: net.id,
        client_id: "44c2ab8a-cb38-4960-b92a-a7aefb190386",
        flow: :login_fresh,
        requesting_subject: nil
      }

      assert {:error, {:network_circuit_open, _}} = Admission.check_capacity(input)

      net_id = net.id

      assert_receive {:telemetry, [:grappa, :admission, :capacity, :reject], %{},
                      %{
                        flow: :login_fresh,
                        error: {:network_circuit_open, _},
                        network_id: ^net_id,
                        client_id: "44c2ab8a-cb38-4960-b92a-a7aefb190386"
                      }},
                     500
    end

    test "emits :capacity, :reject when network cap exceeded", %{network: net} do
      attach_reject_event()

      {:ok, capped_net} =
        net
        |> Network.changeset(%{max_concurrent_visitor_sessions: 1})
        |> Repo.update()

      {:ok, _} =
        Registry.register(
          SessionRegistry,
          SessionServer.registry_key({:visitor, "fake-vid"}, capped_net.id),
          nil
        )

      input = %{
        network_id: capped_net.id,
        client_id: "11111111-2222-4333-8444-555555555555",
        flow: :login_fresh,
        requesting_subject: nil
      }

      assert {:error, :visitor_cap_exceeded} = Admission.check_capacity(input)

      net_id = capped_net.id

      assert_receive {:telemetry, [:grappa, :admission, :capacity, :reject], %{},
                      %{
                        flow: :login_fresh,
                        error: :visitor_cap_exceeded,
                        network_id: ^net_id,
                        client_id: "11111111-2222-4333-8444-555555555555"
                      }},
                     500
    end

    test "does NOT emit :capacity, :reject on :ok", %{network: net} do
      attach_reject_event()

      input = %{
        network_id: net.id,
        client_id: "99999999-aaaa-4bbb-8ccc-dddddddddddd",
        flow: :login_fresh,
        requesting_subject: nil
      }

      assert :ok = Admission.check_capacity(input)

      refute_receive {:telemetry, [:grappa, :admission, :capacity, :reject], _, _}, 100
    end
  end

  describe "live_counts_for_network/1 — U-3 admin wire projection" do
    # U-3 (Web M3): SessionRegistry is process-global and async tests
    # in other modules can register `{:session, {subject, network_id}, ...}`
    # entries against the same auto-increment id sqlite hands back
    # inside their own sandbox connection (sqlite reuses id=1 for the
    # first row in every per-test sandbox). Reading via the `net.id`
    # from the shared fixture would observe cross-test residue. Use
    # synthetic high integers per test that no factory would ever
    # produce — `live_counts_for_network/1` accepts any integer
    # (no DB lookup required).
    #
    # Test pid registrations auto-clean on pid exit, but the link-based
    # cleanup propagates asynchronously, which can leave `SessionRegistry`
    # non-empty briefly between tests and trip the 15s
    # `reset_session_supervisor` poll in sibling test suites (see
    # `project_network_circuit_ets_leak`). Every test that hand-
    # registers entries here uses `register_for_test/2` so the
    # `on_exit` synchronously unregisters before the next test runs.
    test "returns zeros for a network with no live sessions" do
      synthetic_network_id = unique_synthetic_network_id()
      assert Admission.live_counts_for_network(synthetic_network_id) == %{visitors: 0, users: 0}
    end

    test "counts visitor + user sessions independently" do
      synthetic_network_id = unique_synthetic_network_id()
      register_for_test({:visitor, "vid-a"}, synthetic_network_id)
      register_for_test({:visitor, "vid-b"}, synthetic_network_id)
      register_for_test({:user, "uid-c"}, synthetic_network_id)

      assert Admission.live_counts_for_network(synthetic_network_id) ==
               %{visitors: 2, users: 1}
    end

    test "ignores sessions on other networks" do
      this_network = unique_synthetic_network_id()
      other_network = unique_synthetic_network_id()
      register_for_test({:visitor, "vid-x"}, other_network)

      assert Admission.live_counts_for_network(this_network) == %{visitors: 0, users: 0}
    end
  end

  describe "live_counts_by_network/0 — U-3 bulk admin index projection" do
    # Web M3 (reviewer): the admin index path uses ONE Registry scan
    # for all networks instead of 2N scans. These tests pin (a)
    # round-trip parity with `live_counts_for_network/1`, (b) the
    # "no entry = caller defaults to zeros" contract, (c) correct
    # subject_kind tagging at the bulk-fan-out level.
    #
    # SessionRegistry is process-global; async tests elsewhere can
    # populate entries against autoincrement ids that overlap with our
    # fixture. Always scope assertions via `Map.get/3` against a
    # synthetic-unique id no factory uses + drain registrations
    # synchronously on `on_exit`.
    test "bulk projection has no entry for a freshly-minted network with no sessions" do
      synthetic_network_id = unique_synthetic_network_id()
      assert Map.get(Admission.live_counts_by_network(), synthetic_network_id) == nil
    end

    test "keys by network_id with subject-kind counts" do
      net_a = unique_synthetic_network_id()
      net_b = unique_synthetic_network_id()

      register_for_test({:visitor, "v1"}, net_a)
      register_for_test({:visitor, "v2"}, net_a)
      register_for_test({:user, "u1"}, net_a)
      register_for_test({:user, "u2"}, net_b)

      bulk = Admission.live_counts_by_network()

      assert Map.get(bulk, net_a) == %{visitors: 2, users: 1}
      assert Map.get(bulk, net_b) == %{visitors: 0, users: 1}
    end

    test "bulk projection agrees with per-row projection" do
      synthetic_network_id = unique_synthetic_network_id()
      register_for_test({:visitor, "v-row-a"}, synthetic_network_id)
      register_for_test({:user, "u-row-b"}, synthetic_network_id)

      per_row = Admission.live_counts_for_network(synthetic_network_id)
      bulk_row = Map.get(Admission.live_counts_by_network(), synthetic_network_id)

      assert per_row == bulk_row
    end
  end

  # 10_000_000 + unique offset → guaranteed beyond any factory's
  # sqlite autoincrement range within the suite. The atom-based key
  # construction in `Session.Server.registry_key/2` doesn't require
  # the id to map to an existing Network row.
  defp unique_synthetic_network_id, do: 10_000_000 + System.unique_integer([:positive])

  # Register a fake-session key under the current test pid AND queue
  # a synchronous `Registry.unregister/2` for it via `on_exit`. The
  # synchronous unregister beats the link-based async cleanup so
  # sibling test suites' `reset_session_supervisor` polls observe a
  # clean registry without the 15s `project_network_circuit_ets_leak`
  # timeout.
  defp register_for_test(subject_tag, network_id) do
    key = SessionServer.registry_key(subject_tag, network_id)
    {:ok, _} = Registry.register(SessionRegistry, key, nil)
    on_exit(fn -> _ = Registry.unregister(SessionRegistry, key) end)
  end
end
