import { describe, expect, it } from "vitest";
import {
  describeMismatch,
  type Infer,
  validate,
  validateDetailed,
  type WireNode,
} from "../lib/wireValidate";

// Every `validateDetailed` case below reads the mismatch off a REJECTED walk,
// so a helper that fails loudly on an accepted one keeps a broken schema from
// reading as a passing assertion on `undefined`.
function mismatchOf<const N extends WireNode>(node: N, raw: unknown) {
  const out = validateDetailed(node, raw);
  if (out.ok) throw new Error(`expected a mismatch, but the payload validated: ${raw}`);
  return out.mismatch;
}

// #429 — the interpreter for the generated wire schemas. These pin the
// grammar itself; the shapes it is pointed at live in `wireSchema.ts` and are
// pinned by the differential corpus in `wireNarrowAdminCorpus.test.ts`.

describe("validate — scalars", () => {
  it("accepts a string for 's' and rejects every other JSON type", () => {
    expect(validate("s", "x")).toBe("x");
    expect(validate("s", 1)).toBeNull();
    expect(validate("s", null)).toBeNull();
    expect(validate("s", true)).toBeNull();
    expect(validate("s", {})).toBeNull();
  });

  it("accepts a number for 'i', including 0 and negatives", () => {
    expect(validate("i", 0)).toBe(0);
    expect(validate("i", -3)).toBe(-3);
    expect(validate("i", "3")).toBeNull();
  });

  it("accepts a boolean for 'b'", () => {
    expect(validate("b", false)).toBe(false);
    expect(validate("b", "false")).toBeNull();
  });

  it("accepts only null for 'z'", () => {
    expect(validate("z", null)).toBeNull();
    expect(validate("z", "")).toBeNull();
  });

  it("passes anything through for 'x' (the server's own term())", () => {
    expect(validate("x", { anything: [1] })).toEqual({ anything: [1] });
    expect(validate("x", null)).toBeNull();
  });
});

describe("validate — literals and closed sets", () => {
  it("accepts exactly the literal", () => {
    expect(validate({ l: "joined" }, "joined")).toBe("joined");
    expect(validate({ l: "joined" }, "Joined")).toBeNull();
  });

  it("accepts only members of a closed set", () => {
    const node = { e: ["a", "b"] } as const;
    expect(validate(node, "b")).toBe("b");
    expect(validate(node, "c")).toBeNull();
    expect(validate(node, 1)).toBeNull();
  });
});

describe("validate — containers", () => {
  it("rejects the whole array when one element is malformed", () => {
    expect(validate({ a: "s" }, ["a", "b"])).toEqual(["a", "b"]);
    expect(validate({ a: "s" }, ["a", 2])).toBeNull();
    expect(validate({ a: "s" }, "a")).toBeNull();
  });

  it("validates every value of a record", () => {
    expect(validate({ r: "i" }, { a: 1 })).toEqual({ a: 1 });
    expect(validate({ r: "i" }, { a: "1" })).toBeNull();
    expect(validate({ r: "i" }, [])).toBeNull();
  });

  // issue 2453 — a record's keys are data (a nick, a window), and
  // `constructor` and `__proto__` are valid ones; "bob" runs first as the control.
  it.each(["bob", "constructor", "__proto__"])(
    "keeps the entry under %s, its value a scalar or an object",
    (key) => {
      const scalars = validate({ r: "i" }, JSON.parse(`{"${key}": 1, "carol": 2}`));
      const objects = validate({ r: { o: { n: "i" } } }, JSON.parse(`{"${key}": {"n": 1}}`));

      expect(Object.entries(scalars ?? {})).toEqual([
        [key, 1],
        ["carol", 2],
      ]);
      expect(Object.entries(objects ?? {})).toEqual([[key, { n: 1 }]]);
    },
  );

  it("requires a tuple to match arity and member types", () => {
    const node = { p: ["s", "i"] } as const;
    expect(validate(node, ["a", 1])).toEqual(["a", 1]);
    expect(validate(node, ["a", 1, 2])).toBeNull();
    expect(validate(node, ["a"])).toBeNull();
  });

  it("takes the first union arm that matches", () => {
    const node = { u: ["s", "z"] } as const;
    expect(validate(node, "a")).toBe("a");
    expect(validate(node, null)).toBeNull();
    expect(validate(node, 1)).toBeNull();
  });
});

describe("validate — objects", () => {
  const node = {
    o: { kind: { l: "ping" }, count: "i", note: "s" },
    q: ["note"],
  } as const;

  it("accepts the declared shape", () => {
    expect(validate(node, { kind: "ping", count: 1, note: "hi" })).toEqual({
      kind: "ping",
      count: 1,
      note: "hi",
    });
  });

  it("accepts an omitted optional key and omits it from the result", () => {
    const out = validate(node, { kind: "ping", count: 1 });
    expect(out).toEqual({ kind: "ping", count: 1 });
    expect(out && "note" in out).toBe(false);
  });

  it("rejects an omitted REQUIRED key", () => {
    expect(validate(node, { kind: "ping", note: "hi" })).toBeNull();
  });

  it("rejects an optional key that is present but wrong-typed", () => {
    expect(validate(node, { kind: "ping", count: 1, note: 7 })).toBeNull();
  });

  it("drops an undeclared key instead of rejecting (additive-only, #447)", () => {
    expect(validate(node, { kind: "ping", count: 1, tomorrows_field: "x" })).toEqual({
      kind: "ping",
      count: 1,
    });
  });

  it("rejects a non-object, an array, and null", () => {
    expect(validate(node, "ping")).toBeNull();
    expect(validate(node, [])).toBeNull();
    expect(validate(node, null)).toBeNull();
  });

  it("rejects a nested object whose inner field is malformed", () => {
    const nested = { o: { inner: { o: { n: "i" } } } } as const;
    expect(validate(nested, { inner: { n: 1 } })).toEqual({ inner: { n: 1 } });
    expect(validate(nested, { inner: { n: "1" } })).toBeNull();
  });
});

describe("Infer", () => {
  it("derives the same shape the schema validates (compile-time)", () => {
    const node = {
      o: { kind: { l: "ping" }, tags: { a: "s" }, slug: { u: ["s", "z"] }, note: "s" },
      q: ["note"],
    } as const;

    // If `Infer` and the interpreter disagreed, one of these two assignments
    // would not compile — that is the whole point of the type.
    const shaped: Infer<typeof node> = {
      kind: "ping",
      tags: ["a"],
      slug: null,
    };
    const parsed = validate(node, shaped);
    expect(parsed).toEqual(shaped);
  });

  it("accepts a union schema as a discriminated union", () => {
    const node = {
      u: [{ o: { kind: { l: "a" }, n: "i" } }, { o: { kind: { l: "b" }, s: "s" } }],
    } as const;

    const parsed = validate(node, { kind: "b", s: "x" });
    expect(parsed).toEqual({ kind: "b", s: "x" });
    if (parsed !== null && parsed.kind === "b") {
      expect(parsed.s).toBe("x");
    }
    expect(validate(node, { kind: "a", n: "1" })).toBeNull();
  });
});

// Issue 2199 — the second door. `validate` answers "does it match"; this one
// answers "why not", because the REST boundary THROWS and a throw that cannot
// name the field is unactionable for whoever hits it in the field.
describe("validateDetailed — the matching half", () => {
  it("hands back the same value `validate` does, under an ok flag", () => {
    const node = { o: { a: "s" } } as const;
    const out = validateDetailed(node, { a: "x" });
    expect(out).toEqual({ ok: true, value: { a: "x" } });
    expect(out.ok ? out.value : null).toEqual(validate(node, { a: "x" }));
  });

  it("drops an undeclared key exactly as `validate` does (additive-only, #447)", () => {
    const node = { o: { a: "s" } } as const;
    const out = validateDetailed(node, { a: "x", tomorrows_field: 1 });
    expect(out).toEqual({ ok: true, value: { a: "x" } });
  });
});

describe("validateDetailed — where the payload diverged", () => {
  it("names the empty path for a root that is the wrong type at all", () => {
    expect(mismatchOf({ o: { a: "s" } }, "nope")).toEqual({
      path: "",
      expected: "object",
      got: "string",
    });
  });

  it("names a top-level key", () => {
    expect(mismatchOf({ o: { a: "s" } }, { a: 1 })).toEqual({
      path: "a",
      expected: "string",
      got: "number",
    });
  });

  it("names a nested key with a dotted path", () => {
    const node = { o: { outer: { o: { inner: "i" } } } } as const;
    expect(mismatchOf(node, { outer: { inner: "1" } })).toEqual({
      path: "outer.inner",
      expected: "number",
      got: "string",
    });
  });

  it("names the INDEX of the offending array element", () => {
    const node = { o: { rows: { a: { o: { n: "i" } } } } } as const;
    expect(mismatchOf(node, { rows: [{ n: 1 }, { n: 2 }, { n: "3" }] })).toEqual({
      path: "rows[2].n",
      expected: "number",
      got: "string",
    });
  });

  it("names a record key, bracket-quoting one that is not an identifier", () => {
    const node = { r: "i" } as const;
    expect(mismatchOf(node, { plain_key: "x" }).path).toBe("plain_key");
    // Record keys are channel names and nicks on this wire, so the common
    // case is exactly the one a bare dot would render ambiguously.
    expect(mismatchOf(node, { "#grappa": "x" }).path).toBe('["#grappa"]');
  });

  it("names the tuple position", () => {
    const node = { p: ["s", "i"] } as const;
    expect(mismatchOf(node, ["a", "b"])).toEqual({
      path: "[1]",
      expected: "number",
      got: "string",
    });
  });

  it("reports an ABSENT required key at the key, not at its parent", () => {
    const node = { o: { outer: { o: { inner: "b" } } } } as const;
    expect(mismatchOf(node, { outer: {} })).toEqual({
      path: "outer.inner",
      expected: "boolean",
      got: "absent",
    });
  });

  it("says nothing about an OPTIONAL key that is absent", () => {
    const node = { o: { a: "s", note: "s" }, q: ["note"] } as const;
    expect(validateDetailed(node, { a: "x" })).toEqual({ ok: true, value: { a: "x" } });
  });

  it("prints the declared members of a closed set, never the received value", () => {
    const m = mismatchOf({ e: ["parked", "connected"] }, "hunter2");
    expect(m.expected).toBe('one of "parked" | "connected"');
    expect(m.got).toBe("string");
    // The SCHEMA is ours and is printed; the PAYLOAD is not ours and is not.
    expect(JSON.stringify(m)).not.toContain("hunter2");
  });

  it("prints the declared literal, never the received value", () => {
    const m = mismatchOf({ l: "user" }, "s3cret");
    expect(m.expected).toBe('the literal "user"');
    expect(JSON.stringify(m)).not.toContain("s3cret");
  });

  it("distinguishes null, an array and a plain object in `got`", () => {
    expect(mismatchOf("s", null).got).toBe("null");
    expect(mismatchOf("s", []).got).toBe("array");
    expect(mismatchOf("s", {}).got).toBe("object");
    expect(mismatchOf("s", undefined).got).toBe("undefined");
  });
});

describe("validateDetailed — unions report the arm that got furthest", () => {
  // The generated unions lead each arm with its `kind` literal (`S_MeJSONMeJson`
  // is exactly this shape), so the arms the payload never meant to be die at
  // depth 1 while the intended one dies at the real fault. Reporting the
  // union itself would answer "one of 2 variants" for every `/me` in the
  // field — true, and useless, which is the defect issue 2199 is about.
  const node = {
    u: [
      { o: { kind: { l: "user" }, home: { o: { rows: { a: "s" } } } } },
      { o: { kind: { l: "visitor" }, incognito: "b" } },
    ],
  } as const;

  it("reports the DEEPEST failure, not the last arm tried", () => {
    expect(mismatchOf(node, { kind: "user", home: { rows: ["a", 2] } })).toEqual({
      path: "home.rows[1]",
      expected: "string",
      got: "number",
    });
  });

  it("still reports the deepest arm when the deep one is not the last", () => {
    expect(mismatchOf(node, { kind: "visitor", incognito: "yes" })).toEqual({
      path: "incognito",
      expected: "boolean",
      got: "string",
    });
  });

  it("falls back to the union itself when no arm gets past the root", () => {
    expect(mismatchOf(node, 42)).toEqual({
      path: "",
      expected: "one of 2 variants",
      got: "number",
    });
  });

  it("does not let a failed arm shadow a later sibling's real failure", () => {
    // `a` succeeds through its SECOND arm, having already recorded a rejection
    // for the first. If that record survived, `b`'s genuine failure would be
    // reported at `a`'s path — green machinery pointing at the wrong field.
    const sibling = { o: { a: { u: ["i", "s"] }, b: "b" } } as const;
    expect(mismatchOf(sibling, { a: "x", b: 1 })).toEqual({
      path: "b",
      expected: "boolean",
      got: "number",
    });
  });
});

describe("describeMismatch", () => {
  it("renders a path, what was declared, and what arrived", () => {
    expect(
      describeMismatch({
        path: "home_data.networks[0].recoverable",
        expected: "boolean",
        got: "absent",
      }),
    ).toBe("home_data.networks[0].recoverable: expected boolean, got absent");
  });

  it("names the root explicitly rather than rendering an empty path", () => {
    expect(describeMismatch({ path: "", expected: "object", got: "string" })).toBe(
      "(root): expected object, got string",
    );
  });
});

describe("WireNode", () => {
  it("types every arm of the grammar the codegen emits", () => {
    const nodes: WireNode[] = [
      "s",
      "i",
      "b",
      "x",
      "z",
      { l: "k" },
      { e: ["a"] },
      { a: "s" },
      { r: "s" },
      { p: ["s"] },
      { u: ["s", "z"] },
      { o: { a: "s" }, q: ["a"] },
    ];
    expect(nodes).toHaveLength(12);
  });
});
