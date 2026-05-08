import { createEffect, createRoot, on } from "solid-js";
import { token } from "./auth";

// Factory wrapping the duplicated identity-rotation cleanup pattern.
//
// dup-A3 (codebase architecture audit 2026-05-08): nine cic per-channel
// /per-network signal stores hand-rolled the same boilerplate:
//
//   const exports_ = createRoot(() => {
//     const [signal, setSignal] = createSignal(initial);
//     createEffect(
//       on(token, (t, prev) => {
//         if (prev != null && t !== prev) setSignal(initial);
//       }),
//     );
//     return { signal, ...verbs };
//   });
//
// The duplicated bits — `createRoot`, the `on(token)` wiring, the
// `prev != null && t !== prev` filter — live here once. Each call site
// owns ITS signals (and any mutable Sets / cursor ints / etc.) and
// registers cleanup callbacks via `onIdentityChange`. Reuse the verb
// (the cleanup registration mechanism), not the noun (per-store state
// shape stays heterogeneous).
//
// The `prev != null && t !== prev` filter masks BOTH the initial run
// (`prev === undefined` — Solid fires on(token) once at registration)
// AND the cold-start login (`prev === null`, t = "tokA"). Only the two
// real transitions trigger cleanup:
//   - logout: prev = "tokA", t = null
//   - rotation: prev = "tokA", t = "tokB"
//
// A1 invariant ("on(token) registers FIRST before any verb fires"):
// `build` runs BEFORE the createEffect registers, so any synchronous
// state writes inside `build` happen pre-cleanup-arm. The factory
// preserves the pre-A3 ordering — no behavior change at call sites.

export function identityScopedStore<T>(
  build: (onIdentityChange: (reset: () => void) => void) => T,
): T {
  return createRoot(() => {
    const resets: Array<() => void> = [];
    const result = build((reset) => resets.push(reset));
    createEffect(
      on(token, (t, prev) => {
        if (prev != null && t !== prev) {
          for (const r of resets) r();
        }
      }),
    );
    return result;
  });
}
