// #954 — "did this document go away while my request was in the air?"
//
// A POST aborted because the tab is being destroyed is NOT the same failure as
// a 4xx, a refused connection or a dead Wi-Fi: the server may already own the
// message. The rejection cannot tell them apart — `fetch` rejects with the
// same `TypeError: Failed to fetch` for a DNS death, a CORS refusal, a
// vanished server AND a destroyed document. Matching on that string would
// silently swallow real send failures, which is the opposite of what #954
// asks for. So the discriminator is not the error at all: it is a
// document-lifecycle event, owned here.
//
// A COUNTER, NOT A BOOLEAN — the part that is easy to get wrong twice:
//
//   * `pagehide` also fires on bfcache entry and iOS PWA freeze, and those
//     documents come BACK. A latched flag would stay true for the rest of
//     their life and start dropping genuine send failures.
//   * Clearing that flag on `pageshow` does not fix it: a frozen document's
//     in-flight fetch rejects on the THAW, i.e. after `pageshow` has already
//     cleared the flag, so the one case this exists for would read false.
//
// Comparing the epoch ACROSS a flight asks the only question the caller has —
// "did a teardown land between the dispatch and the rejection" — and is immune
// to both. Monotonic, never reset: only differences are ever read.
//
// `visibilitychange` is deliberately NOT a trigger. A backgrounded tab keeps
// its fetches, so a hidden document whose send fails is failing for an
// ordinary reason and owes the operator their text back.
//
// Self-arming at import rather than an `install*` a composition root calls:
// the epoch has to be live before the first Enter can be, and there is no
// uninstall path worth having for a listener that dies with the document.
// `main.tsx` registers its own `pagehide` / `beforeunload` pair for the S3.3
// away-hint — the same seam, an unrelated payload; two listeners on one event
// are independent, and moving this one there would make it forgettable.
//
// Both events, for the reason main.tsx gives: `pagehide` is the modern one and
// the only one that fires reliably on mobile, `beforeunload` is the legacy
// fallback for WebViews that lack it. Double-firing is free — the epoch is
// read as "changed", never as a count of anything.

let epoch = 0;

/**
 * How many document teardowns this document has observed.
 *
 * Meaningless on its own: sample it before a request, compare after, and a
 * difference means the document was torn down (or frozen) while the request
 * was in flight. See `documentTornDownSince`.
 */
export function documentTeardownEpoch(): number {
  return epoch;
}

/**
 * Was there a teardown since `epoch` was sampled?
 *
 * The predicate every caller wants, spelled once so no site re-derives it as a
 * bare `!==` and gets the direction wrong.
 */
export function documentTornDownSince(sampled: number): boolean {
  return epoch !== sampled;
}

if (typeof window !== "undefined") {
  const bump = (): void => {
    epoch += 1;
  };
  window.addEventListener("pagehide", bump);
  window.addEventListener("beforeunload", bump);
}
