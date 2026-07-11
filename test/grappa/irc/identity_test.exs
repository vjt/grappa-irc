defmodule Grappa.IRC.IdentityTest do
  @moduledoc """
  #211 phase 2 — the shared IRC-registration identity tuple. These tests
  pin the extracted changeset verbs + value-level `effective_*` fallbacks
  that BOTH `Grappa.Networks.Credential` (user + visitor subjects) and the
  visitor write-path route through, so the #152 identity-field logic lives
  in ONE place instead of being pasted into two schemas.

  The verbs delegate to `Grappa.IRC.Identifier` primitives; these tests
  assert the changeset-level behaviour (what fires, on which key, with
  which message) — the primitive shape rules are pinned in
  `Grappa.IRC.IdentifierTest`.
  """
  use ExUnit.Case, async: true

  import Ecto.Changeset

  alias Grappa.IRC.Identity

  # A throwaway schemaless changeset carrying just the identity tuple —
  # exercises the shared verbs without depending on either real schema,
  # proving the extraction is schema-agnostic (the whole point).
  defp identity_changeset(attrs) do
    types = %{nick: :string, ident: :string, realname: :string}
    cast({%{}, types}, attrs, Map.keys(types))
  end

  describe "sanitize_ident/1" do
    test "strips a single leading tilde from a changed :ident (anti-spoof)" do
      cs = Identity.sanitize_ident(identity_changeset(%{ident: "~grp"}))
      assert get_change(cs, :ident) == "grp"
    end

    test "leaves a residual tilde so ~~evil sanitizes to ~evil (then fails validation)" do
      cs = Identity.sanitize_ident(identity_changeset(%{ident: "~~evil"}))
      assert get_change(cs, :ident) == "~evil"
    end

    test "is a no-op when :ident is not being changed" do
      cs = Identity.sanitize_ident(identity_changeset(%{nick: "vjt"}))
      assert get_change(cs, :ident) == nil
    end
  end

  describe "validate_nick/2 (validate_change callback)" do
    test "accepts a valid nick" do
      cs = validate_change(identity_changeset(%{nick: "vjt"}), :nick, &Identity.validate_nick/2)
      assert cs.valid?
    end

    test "rejects an invalid nick with the canonical message" do
      cs = validate_change(identity_changeset(%{nick: "-bad"}), :nick, &Identity.validate_nick/2)
      refute cs.valid?
      assert {"must be a valid IRC nickname", _} = cs.errors[:nick]
    end
  end

  describe "validate_ident/2 (validate_change callback)" do
    test "accepts a valid ident" do
      cs = validate_change(identity_changeset(%{ident: "grp_1"}), :ident, &Identity.validate_ident/2)
      assert cs.valid?
    end

    test "rejects an over-length / illegal ident with the canonical message" do
      cs = validate_change(identity_changeset(%{ident: "a@b"}), :ident, &Identity.validate_ident/2)
      refute cs.valid?
      assert {"must be a valid IRC ident", _} = cs.errors[:ident]
    end
  end

  describe "safe_line_token/2 (validate_change callback)" do
    test "accepts a free-form value with spaces (realname is trailing text)" do
      cs =
        validate_change(
          identity_changeset(%{realname: "Marcello B. — grappa"}),
          :realname,
          &Identity.safe_line_token/2
        )

      assert cs.valid?
    end

    test "rejects a value carrying CR/LF/NUL with the canonical message" do
      cs =
        validate_change(
          identity_changeset(%{realname: "evil\r\nQUIT"}),
          :realname,
          &Identity.safe_line_token/2
        )

      refute cs.valid?
      assert {"contains CR, LF, or NUL byte", _} = cs.errors[:realname]
    end
  end

  describe "effective_ident/2" do
    test "returns the ident when set" do
      assert Identity.effective_ident("grp", "vjt") == "grp"
    end

    test "falls back to nick when ident is nil" do
      assert Identity.effective_ident(nil, "vjt") == "vjt"
    end
  end

  describe "effective_sasl_user/2" do
    test "returns the sasl_user when set" do
      assert Identity.effective_sasl_user("acct", "vjt") == "acct"
    end

    test "falls back to nick when sasl_user is nil" do
      assert Identity.effective_sasl_user(nil, "vjt") == "vjt"
    end
  end

  describe "effective_realname/2 (fallback is a parameter, not two impls)" do
    test "returns the realname when set" do
      assert Identity.effective_realname("Real Name", "vjt") == "Real Name"
      assert Identity.effective_realname("Real Name", "Grappa Visitor") == "Real Name"
    end

    test "user subject falls back to nick" do
      assert Identity.effective_realname(nil, "vjt") == "vjt"
    end

    test "visitor subject falls back to the Grappa Visitor branding default" do
      assert Identity.effective_realname(nil, "Grappa Visitor") == "Grappa Visitor"
    end
  end
end
