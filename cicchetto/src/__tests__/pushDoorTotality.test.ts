import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// issue 2738 — ONE door for client→server pushes. Every phoenix `.push(` in
// lib/socket.ts sits inside `pushWithReply` (the request that is owed an
// answer, and settles on its deadline whatever happens) or
// `pushFireAndForget` (the named few nobody awaits). A helper that hand-rolls
// its own `new Promise` around `.push(` is the coin flip the issue names: 26
// of 30 had come up without a `timeout` arm, and their callers hung forever.
//
// Scope, so nobody reads more into a green than it says: this reads
// lib/socket.ts only, the one module that creates channels. `joinUser` /
// `joinChannel` hand their `Channel` out, and a push made on one elsewhere is
// not seen here — there is none today.
//
// The three join chains (`joinUser`, `joinChannel`, `joinAdminEvents`) use
// `.join()`, not `.push(`, so they need no exception.

const DOORS = ["pushWithReply", "pushFireAndForget"] as const;

// Line comments and block comments out, so prose that says `.push(` does not
// count. A block comment keeps its newlines so line numbers stay true. String
// contents are left alone; socket.ts has no `.push(` in one.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ""))
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

// [start, end) of a top-level `function <name>(` body, by brace matching, or
// null when socket.ts has no such function.
function functionBody(src: string, name: string): [number, number] | null {
  const decl = src.search(new RegExp(`function ${name}\\b`));
  if (decl < 0) return null;
  const open = src.indexOf("{", src.indexOf(")", decl));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return [open, i + 1];
  }
  throw new Error(`unbalanced braces in function ${name}`);
}

describe("issue 2738 — lib/socket.ts pushes only through its two doors", () => {
  const src = stripComments(readFileSync("src/lib/socket.ts", "utf8"));
  const bodies = DOORS.map((d) => functionBody(src, d)).filter((b) => b !== null);

  it("every .push( lies inside pushWithReply or pushFireAndForget", () => {
    const strays: string[] = [];
    for (const m of src.matchAll(/\.push\(/g)) {
      const at = m.index;
      if (bodies.some(([s, e]) => at >= s && at < e)) continue;
      const line = src.slice(0, at).split("\n").length;
      strays.push(`socket.ts:${line}: ${src.split("\n")[line - 1]?.trim()}`);
    }
    expect(strays).toEqual([]);
  });

  it("both doors exist, and each pushes exactly once", () => {
    expect(bodies).toHaveLength(DOORS.length);
    for (const [s, e] of bodies) {
      expect(src.slice(s, e).match(/\.push\(/g)?.length).toBe(1);
    }
  });
});
