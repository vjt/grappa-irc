defmodule GrappaWeb.PasskeyControllerTest do
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures
  import Ecto.Query

  alias Grappa.Accounts.{Passkey, Session, TOTP, TOTPRecoveryCode, User, WebAuthn}
  alias Grappa.RateLimit.FailureWindow
  alias Grappa.Repo

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

    Grappa.Repo.BusyRetry.inject_transient_faults(10_000)

    conn =
      conn
      |> put_req_header("authorization", "Bearer #{session.id}")
      |> delete("/me/passkeys/#{passkey.id}", %{"password" => password})

    assert json_response(conn, 503) == %{"error" => "db_unavailable"}

    Grappa.Repo.BusyRetry.inject_transient_faults(0)
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
