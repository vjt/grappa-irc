defmodule Grappa.Visitors.WireTest do
  @moduledoc """
  Tests for `Grappa.Visitors.Wire` — the public JSON shape for
  `Grappa.Visitors.Visitor` rows.

  CRITICAL invariant: neither `visitor_to_json/1` nor
  `visitor_to_credential_json/1` may include `:password_encrypted`
  (the AES-GCM-on-disk column whose Cloak `:load` callback decrypts
  the upstream NickServ password into memory at row-fetch time).
  `redact: true` on the schema only protects `inspect/1` and Logger;
  `Jason.encode!/1` walks struct fields directly.

  Same risk class as `Grappa.Networks.Wire` was created to prevent.
  """
  use ExUnit.Case, async: true

  alias Grappa.Visitors.{Visitor, Wire}

  defp build_visitor(opts \\ []) do
    expires_at =
      Keyword.get(opts, :expires_at, DateTime.add(DateTime.utc_now(), 86_400, :second))

    %Visitor{
      id: Keyword.get(opts, :id, "11111111-1111-1111-1111-111111111111"),
      nick: Keyword.get(opts, :nick, "vjt"),
      ident: Keyword.get(opts, :ident, nil),
      realname: Keyword.get(opts, :realname, nil),
      network_slug: Keyword.get(opts, :network_slug, "azzurra"),
      password_encrypted: Keyword.get(opts, :password_encrypted, nil),
      expires_at: expires_at,
      ip: Keyword.get(opts, :ip, "192.0.2.1"),
      inserted_at: DateTime.utc_now(),
      updated_at: DateTime.utc_now()
    }
  end

  describe "visitor_to_credential_json/1" do
    test "renders the credential-exchange shape (id, nick, ident, realname, network_slug, registered)" do
      v = build_visitor(ident: "grp", realname: "Real Name")
      json = Wire.visitor_to_credential_json(v)

      assert json == %{
               id: v.id,
               nick: "vjt",
               ident: "grp",
               realname: "Real Name",
               network_slug: "azzurra",
               registered: false
             }
    end

    test "registered mirrors password_encrypted presence (#126 cic detach/disconnect gate)" do
      assert Wire.visitor_to_credential_json(build_visitor(password_encrypted: nil)).registered ==
               false

      assert Wire.visitor_to_credential_json(build_visitor(password_encrypted: <<1, 2, 3>>)).registered ==
               true
    end

    test "EXCLUDES :password_encrypted even when set" do
      v = build_visitor(password_encrypted: <<1, 2, 3, 4>>)
      json = Wire.visitor_to_credential_json(v)

      refute Map.has_key?(json, :password_encrypted)
      refute Map.has_key?(json, :password)
    end

    test "EXCLUDES :ip + :inserted_at + :updated_at + :expires_at" do
      v = build_visitor()
      json = Wire.visitor_to_credential_json(v)

      refute Map.has_key?(json, :ip)
      refute Map.has_key?(json, :inserted_at)
      refute Map.has_key?(json, :updated_at)
      refute Map.has_key?(json, :expires_at)
    end
  end

  describe "visitor_to_json/1" do
    test "renders the full profile shape (id, nick, ident, realname, network_slug, expires_at, registered)" do
      v = build_visitor(ident: "grp", realname: "Real Name")
      json = Wire.visitor_to_json(v)

      assert json == %{
               id: v.id,
               nick: "vjt",
               ident: "grp",
               realname: "Real Name",
               network_slug: "azzurra",
               expires_at: v.expires_at,
               registered: false
             }
    end

    test "ident + realname are nil when unset (defaults not baked into the wire)" do
      json = Wire.visitor_to_json(build_visitor())
      assert json.ident == nil
      assert json.realname == nil
    end

    test "registered mirrors password_encrypted presence (#126 cic detach/disconnect gate)" do
      assert Wire.visitor_to_json(build_visitor(password_encrypted: nil)).registered == false

      assert Wire.visitor_to_json(build_visitor(password_encrypted: <<9, 9>>)).registered == true
    end

    test "EXCLUDES :password_encrypted even when set" do
      v = build_visitor(password_encrypted: <<1, 2, 3, 4>>)
      json = Wire.visitor_to_json(v)

      refute Map.has_key?(json, :password_encrypted)
      refute Map.has_key?(json, :password)
    end

    test "EXCLUDES :ip + :inserted_at + :updated_at" do
      v = build_visitor()
      json = Wire.visitor_to_json(v)

      refute Map.has_key?(json, :ip)
      refute Map.has_key?(json, :inserted_at)
      refute Map.has_key?(json, :updated_at)
    end
  end

  describe "leak-defense parity with Networks.Wire" do
    test "neither fn ever includes password_encrypted across the same input" do
      v = build_visitor(password_encrypted: <<1, 2, 3, 4, 5, 6, 7, 8>>)

      cred_json = Wire.visitor_to_credential_json(v)
      full_json = Wire.visitor_to_json(v)

      for json <- [cred_json, full_json] do
        refute Map.has_key?(json, :password_encrypted)
        refute Map.has_key?(json, :password)
        refute json |> Map.values() |> Enum.member?(<<1, 2, 3, 4, 5, 6, 7, 8>>)
      end
    end
  end
end
