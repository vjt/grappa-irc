defmodule Grappa.Accounts.ClientTokenTest do
  @moduledoc """
  GH #1196 — the per-client token at the context boundary: what it is,
  how long it lives, and who it answers to.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.{Accounts, Repo}
  alias Grappa.Accounts.{Session, TOTP, WebAuthn, Wire}

  @thirty_days 30 * 24 * 3600
  @rfc_secret "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

  defp idle_for(%Session{} = session, seconds) do
    session
    |> Ecto.Changeset.change(last_seen_at: DateTime.add(DateTime.utc_now(), -seconds, :second))
    |> Repo.update!()
  end

  defp client_token(user, label) do
    {:ok, session} = Accounts.create_client_token(user, label, "203.0.113.9", "weechat", [])
    session
  end

  describe "create_client_token/5" do
    test "mints a :client row whose id is the bearer and stores the label" do
      user = user_fixture()

      session = client_token(user, "laptop weechat")

      assert session.kind == :client
      assert session.label == "laptop weechat"
      assert {:ok, %Session{id: id}} = Accounts.authenticate(session.id)
      assert id == session.id
    end

    test "trims the label and refuses a blank or control-character one" do
      user = user_fixture()

      assert {:ok, %Session{label: "phone"}} =
               Accounts.create_client_token(user, "  phone  ", nil, nil, [])

      assert {:error, %Ecto.Changeset{} = blank} =
               Accounts.create_client_token(user, "   ", nil, nil, [])

      assert %{label: ["can't be blank"]} = errors_on(blank)

      assert {:error, %Ecto.Changeset{} = control} =
               Accounts.create_client_token(user, "we" <> <<0x07>> <> "chat", nil, nil, [])

      assert %{label: ["must not contain control characters"]} = errors_on(control)
    end

    test "refuses to mint past the per-account cap" do
      user = user_fixture()

      for n <- 1..20, do: client_token(user, "client #{n}")

      assert {:error, :client_token_cap_reached} =
               Accounts.create_client_token(user, "one too many", nil, nil, [])

      # The cap counts LIVE tokens, so revoking one makes room again —
      # otherwise an account that cycles devices would wedge permanently.
      :ok = Accounts.revoke_client_token(user, Session.handle(hd(Accounts.list_client_tokens(user))))

      assert {:ok, %Session{}} = Accounts.create_client_token(user, "replacement", nil, nil, [])
    end

    test "a web session may not carry a label" do
      user = user_fixture()

      assert {:error, %Ecto.Changeset{} = cs} =
               %Session{}
               |> Session.changeset(%{
                 user_id: user.id,
                 created_at: DateTime.utc_now(),
                 last_seen_at: DateTime.utc_now(),
                 label: "pretending to be a client"
               })
               |> Repo.insert()

      assert %{label: ["is only valid on a client token"]} = errors_on(cs)
    end
  end

  describe "lifecycle" do
    test "a client token idle for a month still authenticates" do
      user = user_fixture()
      token = user |> client_token("fortnight away") |> idle_for(@thirty_days)

      assert {:ok, %Session{kind: :client}} = Accounts.authenticate(token.id)
    end

    test "a web session idle for a month does not — the exemption did not widen" do
      user = user_fixture()
      web = user |> session_fixture() |> idle_for(@thirty_days)

      assert {:error, :expired} = Accounts.authenticate(web.id)
    end

    test "the idle reaper sweeps the web session and spares the client token" do
      user = user_fixture()
      token = user |> client_token("survivor") |> idle_for(@thirty_days)
      web = user |> session_fixture() |> idle_for(@thirty_days)

      assert {:ok, 1} = Accounts.delete_expired_sessions()

      assert Repo.get(Session, token.id)
      refute Repo.get(Session, web.id)
    end

    test "revoking kills it" do
      user = user_fixture()
      token = client_token(user, "compromised")

      :ok = Accounts.revoke_client_token(user, Session.handle(token))

      assert {:error, :revoked} = Accounts.authenticate(token.id)
      assert Accounts.list_client_tokens(user) == []
    end

    test "a whole-account sweep takes the client tokens with it" do
      # The revoke-EVERY-session door (admin password rotation, operator
      # recovery) draws no line at `kind`: nobody proved they hold the
      # account, so every derived credential goes. Contrast the
      # revoke-every-OTHER-session door below, which spares them.
      user = user_fixture()
      token = client_token(user, "issued before the reset")

      :ok = Accounts.revoke_sessions_for_user(user)

      assert {:error, :revoked} = Accounts.authenticate(token.id)
    end
  end

  # GH #1284. `revoke_other_sessions_for_user!/2` swept by `user_id` alone,
  # so arming TOTP killed the very credential #1196 exists to keep alive —
  # silently, with a 401 the operator could not tell from a wrong password.
  # Each test pins BOTH halves: the token survives AND the browser bearer
  # still dies, because a filter that revoked nothing would pass on the
  # first assertion alone.
  describe "the revoke-other-sessions sweep spares client tokens" do
    test "arming TOTP" do
      user = user_fixture()
      current = session_fixture(user)
      other = session_fixture(user)
      token = client_token(user, "bicchierino bridge")
      now = 1_700_000_000
      {:ok, code} = TOTP.code_at(@rfc_secret, now)

      assert {:ok, _} = Accounts.confirm_totp_enrollment(user, current.id, @rfc_secret, code, now)

      assert {:ok, %Session{kind: :client}} = Accounts.authenticate(token.id)
      assert {:error, :revoked} = Accounts.authenticate(other.id)
      assert {:ok, %Session{}} = Accounts.authenticate(current.id)
    end

    test "disabling TOTP" do
      {user, password} = user_fixture_with_password()
      armed = arm(user)
      current = session_fixture(armed)
      other = session_fixture(armed)
      token = client_token(armed, "bicchierino bridge")

      assert {:ok, _} = Accounts.disable_totp(armed, current.id, password)

      assert {:ok, %Session{kind: :client}} = Accounts.authenticate(token.id)
      assert {:error, :revoked} = Accounts.authenticate(other.id)
    end

    test "changing passkey mode" do
      user = user_fixture()
      current = session_fixture(user)
      other = session_fixture(user)
      token = client_token(user, "bicchierino bridge")

      assert {:ok, :second_factor} = WebAuthn.set_mode(user, :second_factor, current.id, [])

      assert {:ok, %Session{kind: :client}} = Accounts.authenticate(token.id)
      assert {:error, :revoked} = Accounts.authenticate(other.id)
    end

    # The other side of the ruling: the recovery door is reached by an
    # operator, not by a proven account holder, so it keeps burning every
    # credential. It is a DIFFERENT function (`revoke_sessions_for_user!/1`,
    # no `other`) and the `kind` filter must not reach it.
    test "but operator recovery still burns them" do
      user = user_fixture()
      armed = arm(user)
      token = client_token(armed, "bicchierino bridge")

      assert {:ok, _} = Accounts.reset_totp(armed.name)

      assert {:error, :revoked} = Accounts.authenticate(token.id)
    end
  end

  defp arm(user) do
    now = 1_700_000_000
    {:ok, code} = TOTP.code_at(@rfc_secret, now)
    {:ok, _} = TOTP.confirm_enrollment(user, @rfc_secret, code, now)
    Accounts.get_user!(user.id)
  end

  describe "authenticate_client_token/5" do
    test "resolves the account's own live token and records where it was used" do
      user = user_fixture(name: "vjt-tok")
      token = client_token(user, "irssi")

      assert {:ok, {resolved_user, session}} =
               Accounts.authenticate_client_token(
                 "vjt-tok",
                 token.id,
                 "198.51.100.7",
                 "irssi/1.4",
                 client_id: nil
               )

      assert resolved_user.id == user.id
      assert session.ip == "198.51.100.7"
      assert session.user_agent == "irssi/1.4"
    end

    test "refuses a web bearer presented as a token" do
      user = user_fixture(name: "vjt-web")
      web = session_fixture(user)

      assert {:error, :no_match} =
               Accounts.authenticate_client_token("vjt-web", web.id, nil, nil, [])
    end

    test "refuses another account's token" do
      owner = user_fixture(name: "owner")
      other = user_fixture(name: "other")
      token = client_token(owner, "owner's laptop")

      assert {:error, :no_match} =
               Accounts.authenticate_client_token(other.name, token.id, nil, nil, [])
    end

    test "refuses a revoked token, and anything that is not a token at all" do
      user = user_fixture(name: "vjt-rev")
      token = client_token(user, "gone")
      :ok = Accounts.revoke_client_token(user, Session.handle(token))

      assert {:error, :no_match} =
               Accounts.authenticate_client_token("vjt-rev", token.id, nil, nil, [])

      assert {:error, :no_match} =
               Accounts.authenticate_client_token("vjt-rev", "not-a-uuid", nil, nil, [])

      assert {:error, :no_match} =
               Accounts.authenticate_client_token("vjt-rev", Ecto.UUID.generate(), nil, nil, [])
    end
  end

  describe "handle addressing" do
    test "the wire shape publishes the handle and never the secret" do
      user = user_fixture()
      token = client_token(user, "phone")

      json = Wire.client_token_to_json(token)

      refute Map.has_key?(json, :id)
      refute json |> Map.values() |> Enum.member?(token.id)
      assert json.handle == Session.handle(token)
      assert json.label == "phone"
      assert json.ip == "203.0.113.9"
    end

    test "revoking by another account's handle is a miss, not a kill switch" do
      owner = user_fixture()
      other = user_fixture()
      token = client_token(owner, "owner's")

      assert {:error, :not_found} = Accounts.revoke_client_token(other, Session.handle(token))
      assert {:ok, %Session{}} = Accounts.authenticate(token.id)
    end
  end
end
