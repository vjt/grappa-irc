import "@testing-library/jest-dom/vitest";
import { cleanup } from "@solidjs/testing-library";
import { afterEach } from "vitest";

// Solid testing-library doesn't auto-cleanup like RTL; missing this leaks
// rendered DOM between tests and signals from a prior test keep firing
// effects against detached nodes — flaky failures.
afterEach(() => {
  cleanup();
  localStorage.clear();
});
