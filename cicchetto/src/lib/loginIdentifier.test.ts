import { describe, expect, it } from "vitest";
import { classifyLoginIdentifier } from "./loginIdentifier";

// #204 foolproof-login — ON-SUBMIT identifier classification (vjt override:
// NO as-typed rewriting; validate/sanitize only when the user hits Connect).
//
// Two branches keyed on the presence of "@":
//   * contains "@"  → treat as an EMAIL, validate naively.
//   * no "@"        → treat as a NICKNAME: trim edges, substitute internal
//                     whitespace runs with "_" (the issue's headline
//                     example: `my nick` → `my_nick`), strip characters
//                     outside the server's allowed nick set
//                     (Grappa.IRC.Identifier @nick_regex), cap 30 chars,
//                     and reject an empty result or an illegal first char
//                     (digit / dash) with foolproof copy — surfacing the
//                     rule client-side instead of letting the server 400
//                     with a raw `malformed_nick` token.
//
// The classifier is a PURE function so the form can call it at submit time
// and both vitest (here) and the Login component test exercise the same
// single source of truth for the rule.

describe("classifyLoginIdentifier — email branch", () => {
  it("accepts a plain valid email, preserving the trimmed value", () => {
    expect(classifyLoginIdentifier("alice@example.com")).toEqual({
      kind: "email",
      value: "alice@example.com",
    });
  });

  it("trims surrounding whitespace on an email", () => {
    expect(classifyLoginIdentifier("  alice@example.com  ")).toEqual({
      kind: "email",
      value: "alice@example.com",
    });
  });

  it("rejects an @-bearing value with no dotted domain", () => {
    const r = classifyLoginIdentifier("alice@localhost");
    expect(r.kind).toBe("invalid");
  });

  it("rejects an @-bearing value with no local part", () => {
    expect(classifyLoginIdentifier("@example.com").kind).toBe("invalid");
  });

  it("treats any @-bearing value as an email (never falls back to nick)", () => {
    // The whole point of the `@` discriminator: a user typing an email
    // must NOT have the `@`/`.` stripped as if it were a nick.
    const r = classifyLoginIdentifier("bob@a.b");
    expect(r.kind).toBe("email");
  });
});

describe("classifyLoginIdentifier — nick branch", () => {
  it("passes a clean nick through unchanged, preserving case", () => {
    expect(classifyLoginIdentifier("Alice")).toEqual({ kind: "nick", value: "Alice" });
  });

  it("substitutes an internal space with an underscore (issue headline example)", () => {
    expect(classifyLoginIdentifier("my nick")).toEqual({ kind: "nick", value: "my_nick" });
  });

  it("collapses a run of internal whitespace to a single underscore", () => {
    expect(classifyLoginIdentifier("a   b")).toEqual({ kind: "nick", value: "a_b" });
  });

  it("trims leading/trailing whitespace before sanitizing", () => {
    expect(classifyLoginIdentifier("  bob  ")).toEqual({ kind: "nick", value: "bob" });
  });

  it("strips characters outside the server's allowed nick set", () => {
    // `!` and `,` are not in @nick_regex; `[ ] \\ ` ^ { | } _ -` are.
    expect(classifyLoginIdentifier("John!Doe,")).toEqual({ kind: "nick", value: "JohnDoe" });
  });

  it("keeps the IRC-special nick characters that bahamut permits", () => {
    expect(classifyLoginIdentifier("[a]b|c^")).toEqual({ kind: "nick", value: "[a]b|c^" });
  });

  it("caps the sanitized nick at 30 characters", () => {
    const long = "a".repeat(40);
    const r = classifyLoginIdentifier(long);
    expect(r.kind).toBe("nick");
    if (r.kind === "nick") expect(r.value).toHaveLength(30);
  });

  it("rejects a nick that starts with a digit (server first-char rule)", () => {
    expect(classifyLoginIdentifier("123abc").kind).toBe("invalid");
  });

  it("rejects a nick that starts with a dash", () => {
    expect(classifyLoginIdentifier("-abc").kind).toBe("invalid");
  });

  it("rejects a value that sanitizes to empty", () => {
    expect(classifyLoginIdentifier("!!!").kind).toBe("invalid");
  });

  it("rejects blank input", () => {
    expect(classifyLoginIdentifier("   ").kind).toBe("invalid");
  });
});
