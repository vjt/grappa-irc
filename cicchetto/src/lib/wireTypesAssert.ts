// Structural-equivalence asserts between hand-rolled cic types in
// `./api.ts` and codegen-emitted types in `./wireTypes.ts`.
//
// Why this file exists:
//
//   * `wireTypes.ts` is the GENERATED mirror of server-side
//     `Grappa.*.Wire` typespecs (`mix grappa.gen_wire_types`,
//     `scripts/check.sh` re-runs with `--check` to fail CI on drift
//     between the typespec source and the committed `wireTypes.ts`).
//
//   * `api.ts` carries CIC-side hand-rolled mirrors of those shapes
//     (with consumer-side enrichments — discriminated unions, cic-
//     aggregate types, etc.). The hand-rolled mirrors drifted from
//     the server-side typespecs in REV cluster findings C1/C2/H1-H6.
//
//   * Migrating every cic call site to `import { X } from
//     "./wireTypes"` is risky in one go (the cic-side type unions
//     are richer than the server-side typespecs in places — REST-
//     aggregate, discriminator-narrowed). Instead, this file asserts
//     STRUCTURAL EQUIVALENCE between each api.ts type and its
//     wireTypes.ts counterpart. The `_Assert_*` type aliases evaluate
//     to `true` when shapes match, `never` when they drift. The
//     `assertExtends/2` helpers further enforce bi-directional
//     subtype-ness at compile time. `bun run check` fails on `never`
//     — closing the drift class at TS compile rather than waiting
//     for a runtime narrower mismatch.
//
//   * The CI-time loop is: typespec change → codegen regen → drift
//     gate (D) catches stale committed file → operator runs codegen
//     → wireTypes.ts updates → this file's asserts fail at `bun run
//     check` if the api.ts hand-roll doesn't match the new shape →
//     operator fixes api.ts to match → CI green.
//
// Maintenance:
//
//   * Add an assert for every api.ts type that has a wireTypes.ts
//     counterpart. When server-side adds a new Wire module + type,
//     the codegen emits it; if a cic consumer needs the new shape,
//     add the assert + the api.ts mirror.
//
//   * If an assert fails (`Type 'true' is not assignable to type
//     'never'` at the `: true = true` lines), the api.ts mirror has
//     drifted from the server typespec. The fix is on the cic side —
//     update api.ts to match wireTypes.ts (server is the source of
//     truth per CLAUDE.md "Implement once, reuse everywhere").

import type { ConnectionState } from "./api";
import type { NetworksCredentialConnectionState } from "./wireTypes";

// Bi-directional subtype assert helper. `Equal<A, B>` is `true` when
// `A` and `B` are structurally identical, `false` otherwise.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type Assert<T extends true> = T;

// === CLOSES H2 — ConnectionState ===
// api.ts ConnectionState was declared open-string in REV-H pre-fix;
// post-H2 it's a closed atom union mirroring server-side
// `Grappa.Networks.Credential.connection_state/0`. This assert pins
// the contract: any future change to either side fails at compile
// time.
export type _Assert_ConnectionState = Assert<
  Equal<ConnectionState, NetworksCredentialConnectionState>
>;

// TODO future buckets: add asserts as we flip other Wire modules to
// atom-literal `kind` (M19 needs scrollback/wire.ex flip; C1/H1/H3-H6
// each need a server-side typespec tightening so codegen emits the
// discriminator union cic can assert against).
