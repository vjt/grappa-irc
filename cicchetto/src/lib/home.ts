import { createMemo, createRoot, createSignal } from "solid-js";
import type { HomeData, HomeNetworkRow, MeResponse } from "./api";
import { user } from "./networks";

// UX-4 bucket B — HomePane data signal.
//
// Two consumers:
//   * cold-load — `user()` (the /me resource) carries `home_data` on
//     login. The `homeDataFromMe` memo projects it out so HomePane reads
//     a single reactive signal rather than reaching into the
//     subject envelope discriminator at every render.
//   * live updates — `userTopic.ts` dispatches the
//     `home_network_state_changed` typed event into
//     `patchHomeNetwork`, which mutates the live override signal
//     in-place. The memo prefers the live override when present
//     (last-write-wins) so a stale /me cache cannot overwrite a
//     subsequent broadcast.
//
// Identity-scoped — when `user()` flips (logout → null, login → new
// envelope) the live override resets. Mirror of the same
// "createRoot at module load" pattern used by `networks.ts`,
// `readCursor.ts`, `adminEvents.ts`.
//
// Discriminator:
//   * `user() === null`                            → `null`     (logged out)
//   * `user().kind === "visitor"`                  → `null`     (visitor home = cic-only help)
//   * `user().kind === "user" && home_data unset`  → `null`     (legacy /me predating bucket B; ignore)
//   * `user().kind === "user" && home_data set`    → `HomeData` (registered home)
//
// HomePane branches on the result: `null` → render `HomePaneVisitor`
// when the user is a visitor, render nothing if logged out;
// non-null → render `HomePaneRegistered`.

const exports = createRoot(() => {
  // Live overrides keyed by slug. Patches from typed events land here;
  // `homeData` overlays them on top of the /me envelope.
  const [overrides, setOverrides] = createSignal<Record<string, HomeNetworkRow>>({});

  // Reset the live override map whenever the subject changes — a fresh
  // /me envelope is authoritative.
  let lastSubjectId: string | null = null;
  const subjectId = (): string | null => {
    const m = user();
    if (!m) return null;
    return `${m.kind}:${m.id}`;
  };

  const homeData = createMemo<HomeData | null>(() => {
    const m: MeResponse | null | undefined = user();
    const sid = subjectId();
    if (sid !== lastSubjectId) {
      lastSubjectId = sid;
      // Drop the override map on subject flip. queueMicrotask defers
      // the set so the memo's own read of `overrides()` returns the
      // pre-flip value for this run; the next run sees the cleared map.
      // (Direct set inside a memo would Solid-warn about cyclic writes.)
      queueMicrotask(() => setOverrides({}));
    }
    if (!m) return null;
    if (m.kind === "visitor") return null;
    if (!m.home_data) return null;
    const live = overrides();
    if (Object.keys(live).length === 0) return m.home_data;
    // Overlay live patches on the envelope rows by slug. Unknown slugs
    // (broadcast for a network not in the cold-load envelope — e.g.
    // bound mid-session in a future bucket) are dropped: a future bucket
    // can append on a `credential_bound` event; today's contract is
    // "patch only what's already in /me".
    const merged = m.home_data.networks.map((row) => live[row.slug] ?? row);
    return { networks: merged };
  });

  const patchHomeNetwork = (row: HomeNetworkRow): void => {
    setOverrides((prev) => ({ ...prev, [row.slug]: row }));
  };

  return { homeData, patchHomeNetwork };
});

export const homeData = exports.homeData;
export const patchHomeNetwork = exports.patchHomeNetwork;
