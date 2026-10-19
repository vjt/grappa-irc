// issue 2430 — the real vodozemac binding, instantiated synchronously for
// node. Production loads it through `lib/e2e/olm.ts` (a fetch of the hashed
// `.wasm` asset), which a unit test has no server for; the module is the same
// bytes either way.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Olm } from "../../lib/e2e/olm";
import * as binding from "../../lib/e2e/vodozemac/vodozemac_binding";

let ready = false;

export function olm(): Olm {
  if (!ready) {
    binding.initSync({
      module: readFileSync(
        resolve(process.cwd(), "src/lib/e2e/vodozemac/vodozemac_binding_bg.wasm"),
      ),
    });
    ready = true;
  }
  return binding;
}
