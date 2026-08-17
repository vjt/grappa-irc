import type { WindowState } from "./windowState";

// #1402 A3 — the window-state VOCABULARY, split from the live store.
//
// `ComposeBox` and `Sidebar` each carried a byte-identical
// `new Set(["failed", "kicked", "parked"])` typed `Set<string>`, which accepts
// any string and ties neither copy to the server's set. One definition, typed
// against `WindowState`, makes a member that stops being a server state a tsc
// error here.
//
// It does NOT live in `windowState.ts` with the type it constrains, and the
// reason is measured rather than aesthetic: that module builds a Solid module
// root at import time (via `selection.ts`), so three suites — Sidebar,
// ComposeBox, Shell — replace it wholesale with `vi.mock`. Importing a real
// constant from it forces every one of those mocks to either restate the set
// (the copy this deletes, reborn in test land) or call `importOriginal`, which
// drags the real module's import-time side effects through their other partial
// mocks. This module imports `WindowState` as a TYPE, which is erased, so it
// has no runtime edge to the store and nothing needs to mock it.
//
// `invited` is absent by #902: an unanswered invite is announced by the top
// banner, so no sidebar row carries that state to grey out.
export const NOT_JOINED_STATES: ReadonlySet<WindowState> = new Set<WindowState>([
  "failed",
  "kicked",
  "parked",
]);
