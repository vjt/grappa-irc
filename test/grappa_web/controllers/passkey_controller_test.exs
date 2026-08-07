defmodule GrappaWeb.PasskeyControllerTest do
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures
  import Ecto.Query

  alias Grappa.Accounts.{Passkey, Session, TOTP, TOTPRecoveryCode, User, WebAuthn}
  alias Grappa.RateLimit.FailureWindow
  alias Grappa.{Repo, WebAuthnCeremony}
  alias Grappa.Repo.BusyRetry
  alias GrappaWeb.PasskeyOrigin

  defp passwordless_user do
    {user, password} = user_fixture_with_password()
    session = session_fixture(user)

    Repo.insert!(
      Passkey.changeset(%Passkey{}, %{
        user_id: user.id,
        credential_id: :crypto.strong_rand_bytes(16),
        public_key: CBOR.encode(%{1 => 2, 3 => -7}),
        name: "phone"
      })
    )

    {:ok, :passwordless} =
      WebAuthn.set_mode(user, :passwordless, session.id, Grappa.Accounts.prepare_recovery_codes())

    {Repo.get!(User, user.id), password}
  end

  # #742 — the four routes that actually verify a ceremony had no test at
  # all, so a forged assertion reaching `mint_session/2` would have been
  # invisible. `WebAuthnCeremony` signs for real; every route here is
  # driven twice, once with the signature it was given and once with one
  # bit of it flipped.
  describe "ceremony verification over the wire" do
    @ceremony_origin "https://irc.example"

    setup do
      # The ceremony signs for a fixed origin, so the RP origin the server
      # asserts has to be that one and not whatever the Endpoint derives.
      PasskeyOrigin.put_test_origin(@ceremony_origin)
      on_exit(fn -> PasskeyOrigin.put_test_origin(nil) end)

      # `/auth/passkeys/options` counts EVERY call against a per-IP window
      # shared by the whole module, so a ceremony test that opens one must
      # hand the bucket back or it eats the throttle test's budget.
      on_exit(fn -> FailureWindow.clear(:passkey_login_options, "127.0.0.1") end)

      {user, password} = user_fixture_with_password()

      %{
        user: user,
        password: password,
        session: session_fixture(user),
        authenticator: WebAuthnCeremony.new_authenticator(:crypto.strong_rand_bytes(16))
      }
    end

    test "POST /me/passkeys/registration stores the credential a ceremony signed", ctx do
      options =
        json_response(
          post(authed(ctx.session), "/me/passkeys/registration/options", %{
            "password" => ctx.password,
            "name" => "phone"
          }),
          200
        )

      params = registration_params(ctx, options, @ceremony_origin)

      body = json_response(post(authed(ctx.session), "/me/passkeys/registration", params), 201)

      assert body["name"] == "phone"
      assert Repo.aggregate(Passkey, :count, :id) == 1
    end

    test "POST /me/passkeys/registration refuses a ceremony signed for another origin", ctx do
      options =
        json_response(
          post(authed(ctx.session), "/me/passkeys/registration/options", %{
            "password" => ctx.password,
            "name" => "phone"
          }),
          200
        )

      params = registration_params(ctx, options, "https://phish.example")

      assert json_response(post(authed(ctx.session), "/me/passkeys/registration", params), 401) ==
               %{"error" => "invalid_two_factor"}

      assert Repo.aggregate(Passkey, :count, :id) == 0
    end

    test "POST /auth/passkeys/verify mints a bearer for a signed assertion", ctx do
      register_credential(ctx)
      arm_mode(ctx, :passwordless)

      options =
        build_conn()
        |> post("/auth/passkeys/options", %{"identifier" => ctx.user.name})
        |> json_response(200)

      params = assertion_params(ctx, options, 1)
      body = build_conn() |> post("/auth/passkeys/verify", params) |> json_response(200)

      assert is_binary(body["token"])
    end

    test "POST /auth/passkeys/verify refuses an assertion with a mutated signature", ctx do
      register_credential(ctx)
      arm_mode(ctx, :passwordless)

      options =
        build_conn()
        |> post("/auth/passkeys/options", %{"identifier" => ctx.user.name})
        |> json_response(200)

      params = WebAuthnCeremony.tamper_signature(assertion_params(ctx, options, 1))

      assert build_conn() |> post("/auth/passkeys/verify", params) |> json_response(401) ==
               %{"error" => "invalid_two_factor"}
    end

    test "POST /auth/passkeys/second-factor refuses an assertion with a mutated signature", ctx do
      register_credential(ctx)
      arm_mode(ctx, :second_factor)

      {:ok, options} =
        WebAuthn.begin_authentication(
          Repo.get!(User, ctx.user.id),
          :second_factor,
          %{ip: "127.0.0.1", client_id: nil},
          @ceremony_origin,
          %{}
        )

      params = assertion_params(ctx, stringify(options), 1)

      assert build_conn() |> post("/auth/passkeys/second-factor", params) |> json_response(200)

      assert build_conn()
             |> post("/auth/passkeys/second-factor", WebAuthnCeremony.tamper_signature(params))
             |> json_response(401) == %{"error" => "invalid_two_factor"}
    end

    test "POST /me/passkeys/mode refuses a mode change whose signature was mutated", ctx do
      register_credential(ctx)

      options =
        json_response(
          post(authed(ctx.session), "/me/passkeys/mode/options", %{
            "password" => ctx.password,
            "mode" => "second_factor"
          }),
          200
        )

      params = WebAuthnCeremony.tamper_signature(assertion_params(ctx, options, 1))

      assert json_response(post(authed(ctx.session), "/me/passkeys/mode", params), 401) ==
               %{"error" => "invalid_two_factor"}

      assert Repo.get!(User, ctx.user.id).passkey_mode == :disabled
    end

    # #831 — #768 wrapped both ceremony writes in `Repo.BusyRetry` and put a
    # `:db_unavailable` clause ahead of each catch-all, but could only pin the
    # DELETE at the wire: reaching these two needs a ceremony, and nothing in
    # the suite could sign one. `WebAuthnCeremony` can (#742), so the contract
    # is provable now. Without the clause the degrade falls into the
    # `:invalid_two_factor` catch-all and a saturated writer is reported as a
    # bad authenticator — a lie the user answers by retrying a ceremony that
    # cannot succeed.
    test "POST /me/passkeys/registration behind a saturated writer is a 503, not a refused credential", ctx do
      options =
        json_response(
          post(authed(ctx.session), "/me/passkeys/registration/options", %{
            "password" => ctx.password,
            "name" => "phone"
          }),
          200
        )

      params = registration_params(ctx, options, @ceremony_origin)

      BusyRetry.inject_transient_faults(10_000)
      conn = post(authed(ctx.session), "/me/passkeys/registration", params)
      BusyRetry.inject_transient_faults(0)

      assert json_response(conn, 503) == %{"error" => "db_unavailable"}
      assert Repo.aggregate(Passkey, :count, :id) == 0
    end

    # The fault is aimed PAST the assertion, and that is the whole point of the
    # test. #815 wrapped the sign-counter commit inside `authenticate/3`, which
    # made it the FIRST retried write this route performs — so an
    # arm-everything fault degrades there and the request never reaches
    # `set_mode/4` at all. The test would stay green and quietly stop proving
    # the clause it was written for. `fire_on: 2` rides out the counter commit
    # and fires on the mode transaction; the advanced counter is what proves it
    # landed there, since a degrade at check 1 leaves the counter at zero.
    test "POST /me/passkeys/mode behind a saturated writer is a 503, not a refused assertion", ctx do
      passkey = register_credential(ctx)

      options =
        json_response(
          post(authed(ctx.session), "/me/passkeys/mode/options", %{
            "password" => ctx.password,
            "mode" => "second_factor"
          }),
          200
        )

      params = assertion_params(ctx, options, 1)

      # Bound to a variable, never `self()` inside the closure: `on_exit` runs
      # in its OWN process, so the closure would disarm the wrong pid and leave
      # this one armed for whoever inherits it.
      test_pid = self()
      BusyRetry.arm_faults(test_pid, 10_000, fire_on: 2)
      on_exit(fn -> BusyRetry.disarm_faults(test_pid) end)
      conn = post(authed(ctx.session), "/me/passkeys/mode", params)
      BusyRetry.disarm_faults(test_pid)

      assert json_response(conn, 503) == %{"error" => "db_unavailable"}
      assert Repo.get!(User, ctx.user.id).passkey_mode == :disabled
      assert Repo.get!(Passkey, passkey.id).sign_count == 1
    end

    # #815 — the assertion routes reach a write of their own: the sign-counter
    # commit inside `authenticate/3`. Wrapped, it degrades, and both actions
    # closed on `_ -> {:error, :invalid_two_factor}` — a 401 telling the holder
    # of a perfectly good passkey that their authenticator was rejected. These
    # two pin the honest answer at the wire, and pin it SEPARATELY because
    # `login_verify/2` and `second_factor_verify/2` are two `case`s: fixing one
    # leaves the other lying.
    test "POST /auth/passkeys/verify behind a saturated writer is a 503, not a refused assertion", ctx do
      passkey = register_credential(ctx)
      arm_mode(ctx, :passwordless)

      options =
        build_conn()
        |> post("/auth/passkeys/options", %{"identifier" => ctx.user.name})
        |> json_response(200)

      params = assertion_params(ctx, options, 1)

      BusyRetry.inject_transient_faults(10_000)
      conn = post(build_conn(), "/auth/passkeys/verify", params)
      BusyRetry.inject_transient_faults(0)

      assert json_response(conn, 503) == %{"error" => "db_unavailable"}
      assert Repo.get!(Passkey, passkey.id).sign_count == 0
    end

    test "POST /auth/passkeys/second-factor behind a saturated writer is a 503, not a refused assertion", ctx do
      passkey = register_credential(ctx)
      arm_mode(ctx, :second_factor)

      {:ok, options} =
        WebAuthn.begin_authentication(
          Repo.get!(User, ctx.user.id),
          :second_factor,
          %{ip: "127.0.0.1", client_id: nil},
          @ceremony_origin,
          %{}
        )

      params = assertion_params(ctx, stringify(options), 1)

      BusyRetry.inject_transient_faults(10_000)
      conn = post(build_conn(), "/auth/passkeys/second-factor", params)
      BusyRetry.inject_transient_faults(0)

      assert json_response(conn, 503) == %{"error" => "db_unavailable"}
      assert Repo.get!(Passkey, passkey.id).sign_count == 0
    end

    defp authed(session),
      do: put_req_header(build_conn(), "authorization", "Bearer #{session.id}")

    defp stringify(%{challenge_id: id, public_key: %{challenge: challenge}}),
      do: %{"challenge_id" => id, "public_key" => %{"challenge" => challenge}}

    defp registration_params(ctx, options, origin) do
      WebAuthnCeremony.registration_params(
        ctx.authenticator,
        options["challenge_id"],
        options["public_key"]["challenge"],
        origin
      )
    end

    defp assertion_params(ctx, options, sign_count) do
      WebAuthnCeremony.assertion_params(
        ctx.authenticator,
        options["challenge_id"],
        options["public_key"]["challenge"],
        @ceremony_origin,
        sign_count
      )
    end

    defp register_credential(ctx) do
      Repo.insert!(
        Passkey.changeset(%Passkey{}, %{
          user_id: ctx.user.id,
          credential_id: ctx.authenticator.credential_id,
          public_key: CBOR.encode(WebAuthnCeremony.cose_key(ctx.authenticator)),
          name: "phone"
        })
      )
    end

    defp arm_mode(ctx, mode) do
      codes = if mode == :passwordless, do: Grappa.Accounts.prepare_recovery_codes(), else: []
      {:ok, ^mode} = WebAuthn.set_mode(ctx.user, mode, ctx.session.id, codes)
    end
  end

  test "login_options is throttled even while it keeps succeeding", %{conn: conn} do
    # The abuse is challenge ALLOCATION, and the cheapest way to allocate
    # is to keep succeeding — so a failures-only window would never see
    # this traffic. Every 200 has to count against the bucket too.
    {user, _} = passwordless_user()
    on_exit(fn -> FailureWindow.clear(:passkey_login_options, "127.0.0.1") end)

    for _ <- 1..30 do
      assert conn |> post("/auth/passkeys/options", %{"identifier" => user.name}) |> Map.get(:status) == 200
    end

    assert conn
           |> post("/auth/passkeys/options", %{"identifier" => user.name})
           |> json_response(429) == %{"error" => "too_many_attempts"}
  end

  test "recovery throttling survives respelling the identifier", %{conn: conn} do
    # find_user/1 folds an email to its local part, so these all resolve to
    # ONE account. Keying the window on the wire string handed the attacker
    # a fresh bucket per spelling.
    {user, _} = passwordless_user()

    on_exit(fn ->
      FailureWindow.clear(:passkey_recovery, "127.0.0.1")
      FailureWindow.clear(:passkey_recovery, {"127.0.0.1", user.id})
    end)

    spellings = Stream.cycle([user.name, "#{user.name}@a.aa", "#{user.name}@b.bb"])

    for identifier <- Enum.take(spellings, 10) do
      post(conn, "/auth/passkeys/recover", %{
        "identifier" => identifier,
        "recovery_code" => "wrongwrongwrongwrongwrongw"
      })
    end

    assert conn
           |> post("/auth/passkeys/recover", %{
             "identifier" => "#{user.name}@c.cc",
             "recovery_code" => "wrongwrongwrongwrongwrongw"
           })
           |> json_response(429) == %{"error" => "too_many_attempts"}
  end

  # All three windows in this controller shut in silence. They emit the
  # event the mode-1 door has always emitted, told apart by `door` +
  # `scope`. Each is driven to ONE attempt short of its limit through the
  # production counter, so the crossing is the request under test and not
  # the twenty-nine that set it up.
  @window_ms :timer.minutes(15)
  @wrong_code "wrongwrongwrongwrongwrongw"

  defp seed_failures(bucket, key, n) do
    for _ <- 1..n, do: FailureWindow.record_failure(bucket, key, @window_ms)
    :ok
  end

  defp watch_admin_events do
    :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Grappa.PubSub.Topic.admin_events())
  end

  test "the recovery per-account key names its own crossing", %{conn: conn} do
    {user, _} = passwordless_user()

    clear = fn ->
      FailureWindow.clear(:passkey_recovery, "127.0.0.1")
      FailureWindow.clear(:passkey_recovery, {"127.0.0.1", user.id})
    end

    clear.()
    on_exit(clear)

    seed_failures(:passkey_recovery, {"127.0.0.1", user.id}, 9)
    watch_admin_events()

    assert conn
           |> post("/auth/passkeys/recover", %{"identifier" => user.name, "recovery_code" => @wrong_code})
           |> json_response(401) == %{"error" => "invalid_two_factor"}

    assert_receive %Phoenix.Socket.Broadcast{
                     topic: "grappa:admin:events",
                     payload: %{
                       kind: :login_throttled,
                       door: :passkey_recovery,
                       scope: :ip_account,
                       source_ip: "127.0.0.1",
                       failures: 10
                     }
                   },
                   500
  end

  test "the recovery address ceiling names its own crossing", %{conn: conn} do
    clear = fn -> FailureWindow.clear(:passkey_recovery, "127.0.0.1") end
    clear.()
    on_exit(clear)

    # An identifier that resolves to no account charges the ceiling and
    # nothing else — the per-account key is never even formed, so only the
    # ceiling can be what crossed.
    seed_failures(:passkey_recovery, "127.0.0.1", 29)
    watch_admin_events()

    assert conn
           |> post("/auth/passkeys/recover", %{"identifier" => "nobody-here", "recovery_code" => @wrong_code})
           |> json_response(401) == %{"error" => "invalid_two_factor"}

    assert_receive %Phoenix.Socket.Broadcast{
                     topic: "grappa:admin:events",
                     payload: %{
                       kind: :login_throttled,
                       door: :passkey_recovery,
                       scope: :ip,
                       source_ip: "127.0.0.1",
                       failures: 30
                     }
                   },
                   500
  end

  test "challenge-allocation abuse names its own crossing", %{conn: conn} do
    {user, _} = passwordless_user()
    clear = fn -> FailureWindow.clear(:passkey_login_options, "127.0.0.1") end
    clear.()
    on_exit(clear)

    # This window counts every call, not every failure, so the crossing
    # request is a 200. The signal has to fire on a door that is SUCCEEDING.
    seed_failures(:passkey_login_options, "127.0.0.1", 29)
    watch_admin_events()

    assert conn |> post("/auth/passkeys/options", %{"identifier" => user.name}) |> Map.get(:status) == 200

    assert_receive %Phoenix.Socket.Broadcast{
                     topic: "grappa:admin:events",
                     payload: %{
                       kind: :login_throttled,
                       door: :passkey_login_options,
                       scope: :ip,
                       source_ip: "127.0.0.1",
                       failures: 30
                     }
                   },
                   500
  end

  test "passwordless mode rejects password and accepts a one-shot recovery code", %{conn: conn} do
    {user, password} = user_fixture_with_password()
    secret = TOTP.new_enrollment(user, "Grappa test").secret
    now = System.system_time(:second)
    {:ok, code} = TOTP.code_at(secret, now)
    {:ok, [recovery | _]} = TOTP.confirm_enrollment(user, secret, code, now)

    User
    |> where([u], u.id == ^user.id)
    |> Repo.update_all(set: [passkey_mode: :passwordless])

    rejected = post(conn, "/auth/login", %{"identifier" => user.name, "password" => password})
    assert json_response(rejected, 401) == %{"error" => "invalid_credentials"}

    body =
      conn
      |> post("/auth/passkeys/recover", %{"identifier" => user.name, "recovery_code" => recovery})
      |> json_response(200)

    assert is_binary(body["token"])

    replay = post(conn, "/auth/passkeys/recover", %{"identifier" => user.name, "recovery_code" => recovery})
    assert json_response(replay, 401) == %{"error" => "invalid_two_factor"}
  end

  test "recovery checkpoint does not activate passwordless or persist codes", %{conn: conn} do
    {user, password} = user_fixture_with_password()
    session = session_fixture(user)

    prepared =
      conn
      |> put_req_header("authorization", "Bearer #{session.id}")
      |> post("/me/passkeys/passwordless/recovery", %{"password" => password})
      |> json_response(200)

    assert length(prepared["recovery_codes"]) == 10
    assert is_binary(prepared["recovery_token"])
    assert Repo.get!(User, user.id).passkey_mode == :disabled
    assert Repo.aggregate(TOTPRecoveryCode, :count, :id) == 0
    assert is_nil(Repo.get!(Session, session.id).revoked_at)
  end

  # The checkpoint token carries the not-yet-armed recovery codes so the
  # server need not store them before the ceremony commits. A SIGNED token
  # is tamper-proof but not secret — its payload is plain base64 — so the
  # codes would be readable by anything the token passes through.
  test "the recovery checkpoint token does not carry the codes in the clear", %{conn: conn} do
    {user, password} = user_fixture_with_password()
    session = session_fixture(user)

    prepared =
      conn
      |> put_req_header("authorization", "Bearer #{session.id}")
      |> post("/me/passkeys/passwordless/recovery", %{"password" => password})
      |> json_response(200)

    readable = decoded_segments(prepared["recovery_token"])

    for code <- prepared["recovery_codes"] do
      refute readable =~ code
    end
  end

  # Everything a bearer of the token can read without a key: the token
  # itself plus each of its base64url segments decoded. A signed token
  # yields its whole term-encoded payload here; an encrypted one yields
  # ciphertext.
  defp decoded_segments(token) do
    decoded =
      token
      |> String.split(".")
      |> Enum.map_join(" ", fn segment ->
        case Base.url_decode64(segment, padding: false) do
          {:ok, raw} -> raw
          :error -> segment
        end
      end)

    decoded <> token
  end

  # A mode change is proved with a passkey assertion, so an account holding
  # no passkey cannot start one. That is a plain conflict with the account's
  # state and the caller can act on it — but nothing mapped the error, so it
  # fell out of the FallbackController as an unhandled clause and the door
  # answered a 500. Reachable with two lines of client: create an account,
  # ask for second_factor before registering anything.
  test "asking for a ceremony with no passkey registered is a conflict, not a crash", %{conn: conn} do
    {user, password} = user_fixture_with_password()
    session = session_fixture(user)

    response =
      conn
      |> put_req_header("authorization", "Bearer #{session.id}")
      |> post("/me/passkeys/mode/options", %{"password" => password, "mode" => "second_factor"})

    assert json_response(response, 409) == %{"error" => "passkey_not_configured"}
  end

  # A bearer alone must never be enough to change HOW an account
  # authenticates, so every one of these doors re-asks for the password. The
  # check was open-coded four times over and not one of the four had a test
  # behind it — this pins all of them at once, before they are folded into a
  # single door.
  describe "password re-authentication" do
    setup %{conn: conn} do
      {user, password} = user_fixture_with_password()
      session = session_fixture(user)

      passkey =
        Repo.insert!(
          Passkey.changeset(%Passkey{}, %{
            user_id: user.id,
            credential_id: <<9, 9, 9>>,
            public_key: CBOR.encode(%{1 => 2, 3 => -7}),
            name: "phone"
          })
        )

      %{conn: conn, user: user, password: password, session: session, passkey: passkey}
    end

    test "every privileged passkey verb refuses the wrong password", ctx do
      wrong = ctx.password <> "-nope"

      requests = [
        {:post, "/me/passkeys/registration/options", %{"password" => wrong, "name" => "phone"}},
        {:post, "/me/passkeys/mode/options", %{"password" => wrong, "mode" => "second_factor"}},
        {:post, "/me/passkeys/passwordless/recovery", %{"password" => wrong}},
        {:delete, "/me/passkeys/#{ctx.passkey.id}", %{"password" => wrong}}
      ]

      for {verb, path, params} <- requests do
        conn =
          ctx.conn
          |> recycle()
          |> put_req_header("authorization", "Bearer #{ctx.session.id}")

        response = dispatch(conn, GrappaWeb.Endpoint, verb, path, params)

        assert json_response(response, 401) == %{"error" => "invalid_credentials"},
               "#{verb} #{path} accepted a wrong password"
      end

      assert Repo.aggregate(Passkey, :count, :id) == 1
    end

    test "the right password gets past the door it guards", ctx do
      response =
        ctx.conn
        |> put_req_header("authorization", "Bearer #{ctx.session.id}")
        |> post("/me/passkeys/passwordless/recovery", %{"password" => ctx.password})

      assert length(json_response(response, 200)["recovery_codes"]) == 10
    end
  end

  # The column stores the mode as one of a closed set of atoms; the wire has
  # always spelled it out in full, and `cicchetto/src/lib/api.ts` types the
  # three spellings literally. Nothing else pinned that, so the encoding was
  # free to drift the moment the storage type changed.
  test "every mode reaches the wire in the spelling the client types", %{conn: conn} do
    {user, _} = user_fixture_with_password()
    session = session_fixture(user)

    for {mode, wire} <- [{:disabled, "disabled"}, {:second_factor, "second_factor"}, {:passwordless, "passwordless"}] do
      user |> Ecto.Changeset.change(passkey_mode: mode) |> Repo.update!()

      body =
        conn
        |> recycle()
        |> put_req_header("authorization", "Bearer #{session.id}")
        |> get("/me/passkeys")
        |> json_response(200)

      assert body["mode"] == wire
    end
  end

  # #768 — DELETE is the one passkey write a test can drive end-to-end without
  # forging a WebAuthn ceremony, so it is where the 500-vs-503 contract gets
  # pinned at the wire. `verify_password/2` ahead of it is pure Argon2 and
  # touches no BusyRetry op, so the injected fault can only land on the delete.
  test "deleting a passkey behind a saturated writer is a 503, not a 500", %{conn: conn} do
    {user, password} = user_fixture_with_password()
    session = session_fixture(user)

    passkey =
      Repo.insert!(
        Passkey.changeset(%Passkey{}, %{
          user_id: user.id,
          credential_id: <<9, 9, 9>>,
          public_key: CBOR.encode(%{1 => 2, 3 => -7}),
          name: "phone"
        })
      )

    BusyRetry.inject_transient_faults(10_000)

    conn =
      conn
      |> put_req_header("authorization", "Bearer #{session.id}")
      |> delete("/me/passkeys/#{passkey.id}", %{"password" => password})

    assert json_response(conn, 503) == %{"error" => "db_unavailable"}

    BusyRetry.inject_transient_faults(0)
    assert Repo.aggregate(Passkey, :count, :id) == 1
  end

  test "last passkey can be deleted after returning to password login", %{conn: conn} do
    {user, password} = user_fixture_with_password()
    session = session_fixture(user)

    passkey =
      Repo.insert!(
        Passkey.changeset(%Passkey{}, %{
          user_id: user.id,
          credential_id: <<1, 2, 3>>,
          public_key: CBOR.encode(%{1 => 2, 3 => -7}),
          name: "phone"
        })
      )

    assert {:ok, :passwordless} =
             WebAuthn.set_mode(user, :passwordless, session.id, Grappa.Accounts.prepare_recovery_codes())

    blocked =
      conn
      |> put_req_header("authorization", "Bearer #{session.id}")
      |> delete("/me/passkeys/#{passkey.id}", %{"password" => password})

    assert json_response(blocked, 409) == %{"error" => "passkey_required"}

    passwordless_user = Repo.get!(User, user.id)
    assert {:ok, :disabled} = WebAuthn.set_mode(passwordless_user, :disabled, session.id, [])

    conn = put_req_header(recycle(conn), "authorization", "Bearer #{session.id}")
    assert response(delete(conn, "/me/passkeys/#{passkey.id}", %{"password" => password}), 204)
    assert Repo.aggregate(Passkey, :count, :id) == 0
  end
end
