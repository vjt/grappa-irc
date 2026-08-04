// #717 — bounded transport for the three boot-critical GETs.
//
// The CRT splash gates on `user` → `networks` → `channelsBySlug` (lib/networks.ts),
// fed by `me()`, `listNetworks()` and `listChannels()`. Before this, none of the
// three carried a timeout, an abort or a retry: one stalled request left the
// splash up indefinitely with no way out but force-killing the app — the #717
// report from an installed Android/Firefox PWA.
//
// This module owns the TRANSPORT half only. It cannot be the whole fix, and the
// distinction matters: bounding a hang converts it into a REJECTION, and a
// rejected boot resource re-throws on every read, which froze the UI just as
// hard. `BootErrorBoundary.tsx` catches that. Retry absorbs the transient
// failure; the boundary catches the terminal one.
//
// Scoped to the boot three ON PURPOSE. api.ts has ~100 `fetch` call sites and no
// central wrapper; funnelling all of them through a retrying helper is a
// different, much larger change, and most of them are user-initiated actions
// where a silent retry is wrong (a failed PATCH should report, not re-send).
// "Boot-critical GET" is a real category: idempotent, unattended, and the only
// thing standing between the user and a usable app.
//
// WHAT IS RETRIED: a rejected `fetch` — DNS failure, connection refused, TLS
// failure, the abort from our own timeout. That is the class where trying again
// can plausibly work, and it covers the #193 door (the server restarting under
// us refuses the connection). An HTTP RESPONSE is never retried whatever its
// status: the server answered, the caller's `!res.ok` arm owns it, and 401
// already has its own path (on401 → clear token → /login). Re-sending on a 503
// would also turn a struggling server into a thundering herd of reloading PWAs.

/** Per-attempt ceiling. Exceeding it aborts THAT attempt, not the whole boot. */
export const BOOT_FETCH_TIMEOUT_MS = 8_000;

/** Backoff before attempt 2 and attempt 3. Its length defines the retry count. */
export const BOOT_FETCH_BACKOFF_MS: readonly number[] = [500, 2_000];

/** Total attempts — the first, plus one per backoff step. */
export const BOOT_FETCH_ATTEMPTS = BOOT_FETCH_BACKOFF_MS.length + 1;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GET a boot-critical resource with a per-attempt timeout and bounded retry.
 *
 * Resolves with the `Response` for ANY completed request, including error
 * statuses — status handling stays with the caller. "Completed" means the body
 * arrived too, not just the headers. Rejects with the last transport error once
 * the attempts are exhausted.
 */
export async function bootFetch(
  path: string,
  // `signal` is EXCLUDED rather than merged: this function owns the abort, and
  // a plain `RequestInit` would advertise a `signal` that the spread below
  // silently overwrites. No caller needs one today; the type says so instead
  // of letting the next one find out at runtime.
  init: Omit<RequestInit, "signal">,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt < BOOT_FETCH_ATTEMPTS; attempt++) {
    // OUTSIDE the try, deliberately. On a runtime without
    // `AbortSignal.timeout` this raises a TypeError, and inside the try it
    // would be counted as a transport failure — retried three times and then
    // reported as "the network is down" on a box whose network is fine.
    // A missing platform API is a hard failure and must read like one.
    //
    // A FRESH signal per attempt: reusing one would let attempt 1's expiry
    // abort attempt 2 the moment it started — a retry that can never win.
    const signal = AbortSignal.timeout(BOOT_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(path, { ...init, signal });
      // The budget must cover the BODY too. `fetch` resolves at the headers
      // while the signal stays live on the `Response`, and every caller reads
      // the body (`res.json()`) after this function has returned — so a body
      // still streaming at the deadline used to abort out there, where the
      // retry loop could not see it: a boot that failed and never retried.
      // Draining a clone pulls that read INSIDE the attempt, which both makes
      // the abort retryable and leaves the returned `Response` fully buffered,
      // so the caller's own read can no longer be cut by our signal.
      await res.clone().arrayBuffer();
      return res;
    } catch (error) {
      lastError = error;
      const backoff = BOOT_FETCH_BACKOFF_MS[attempt];
      if (backoff === undefined) break;
      await sleep(backoff);
    }
  }

  throw lastError;
}
