// The REST error type, in a module of its own so it can be imported by a
// caller that must narrow on it — and, crucially, so no `vi.mock("…/api")`
// factory has to remember to keep it.
//
// #2409 — `scrollback.ts` narrows a failed fetch with `err instanceof
// ApiError` to tell a 400 (a verdict on the target, latched) from a transient
// failure. While the class lived in `api.ts`, every suite that replaced that
// module wholesale with a hand-written factory had to re-export it, and 39 of
// them did not: the import was `undefined`, `instanceof undefined` threw a
// TypeError inside the fetch's catch, and the failures surfaced as unhandled
// errors in suites that had nothing to do with the change. One file moved
// instead of 39 mocks edited — and the next narrowing caller inherits the fix
// rather than the trap.
//
// `api.ts` still RE-EXPORTS this class (`export { ApiError } from
// "./apiError"`), so every existing `import { ApiError } from "./api"` keeps
// working and keeps referring to THIS one class — a re-export is the same
// object, not a copy, so `instanceof` agrees across both import paths. New
// code that narrows should import from here.

/**
 * A non-2xx REST answer, decoded from the server's `{error: "<token>"}`
 * envelope (see `readError` in `api.ts`).
 *
 * `status` is the HTTP code, `code` the wire token (`"invalid_channel"`,
 * `"rate_limited"`, …), and `info` the envelope's sibling fields (a `limit`, a
 * `retry_after`, the field that failed validation). Callers narrow with
 * `instanceof ApiError` and then read `code`/`status`; `friendlyApiError`
 * turns the pair into the sentence the operator reads.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly info: Record<string, unknown>;

  constructor(status: number, code: string, info: Record<string, unknown> = {}) {
    super(`${status} ${code}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.info = info;
  }
}
