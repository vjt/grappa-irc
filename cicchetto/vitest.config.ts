import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

// SolidJS components compile to fine-grained reactive primitives — vitest
// needs the same `vite-plugin-solid` transform the dev server uses, or
// JSX in tests is parsed as plain React and signal updates don't fire.
//
// `environment: "jsdom"` gives DOM globals (document, localStorage,
// fetch shim via undici) so component tests + the auth signal store
// (which side-effects to localStorage) run unmodified. `setupTests.ts`
// installs jest-dom matchers.
export default defineConfig({
  plugins: [solid()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/setupTests.ts"],
    // `e2e/fixtures/**/*.test.ts` — the e2e peer/page fixtures are their
    // own package (e2e/package.json, playwright-only), but the pieces of
    // them that carry LOGIC rather than driver calls are unit-testable and
    // worth testing here (#806). Matched on `.test.ts` alone, never
    // `.spec.ts`: `e2e/tests/*.spec.ts` are playwright specs and must not
    // be picked up by vitest.
    include: ["src/**/*.{test,spec}.{ts,tsx}", "e2e/fixtures/**/*.test.ts"],
  },
  resolve: {
    conditions: ["development", "browser"],
  },
});
