// issue 2430 — loads the vodozemac binding on first use.
//
// The binding is ~290 KB of WebAssembly that only end-to-end encryption
// needs, so it is not in the boot bundle: the first caller pays one dynamic
// import and one fetch of the hashed `.wasm` asset (precached by the service
// worker, see vite.config.ts), and every later caller shares that promise.
// The bytes are vendored (`scripts/wasm.sh` rebuilds and checks them).

import type * as Binding from "./vodozemac/vodozemac_binding";

/** The binding module, initialised. */
export type Olm = typeof Binding;

let loading: Promise<Olm> | undefined;

async function load(): Promise<Olm> {
  const [binding, wasm] = await Promise.all([
    import("./vodozemac/vodozemac_binding"),
    import("./vodozemac/vodozemac_binding_bg.wasm?url"),
  ]);
  await binding.default({ module_or_path: wasm.default });
  return binding;
}

/** The initialised binding. A failed load is forgotten, so the next call tries again. */
export function loadOlm(): Promise<Olm> {
  loading ??= load().catch((err: unknown) => {
    loading = undefined;
    throw err;
  });
  return loading;
}
